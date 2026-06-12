/**
 * vooi-mm-bot — delta-neutral market-making bot on the VOOI Perps API.
 *
 * Strategy, per cycle:
 *  1. Place a BUY and a SELL limit order around the mid price on the PRIMARY exchange.
 *  2. Wait for one of them to fill.
 *  3. Cancel the other and hedge the filled side with a market order on the HEDGE exchange.
 *  4. Place reduce-only limit orders to close both legs at the original spread prices.
 *  5. When one side closes (or on timeout), force-close whatever remains and start over.
 *
 * Exchanges, symbols and risk limits all come from `.env` — see `.env.example`.
 */

import Decimal from "decimal.js-light";

import { client } from "./src/client/client.gen";
import {
  exchangeControllerCancelOrder,
  exchangeControllerCreateOrder,
  exchangeControllerGetAccounts,
  exchangeControllerGetMarkets,
  exchangeControllerGetOpenOrders,
  exchangeControllerGetPositions,
  exchangeControllerSetLeverage,
} from "./src/client/sdk.gen";
import type { GetAccountDtoOutput, GetMarketsDto } from "./src/client/types.gen";
import {
  ALIAS,
  BALANCE_RATIO,
  BASE_URL,
  BEARER_TOKEN,
  CLOSE_TIMEOUT_MS,
  EXCHANGES,
  FILL_TIMEOUT_MS,
  HEDGE,
  LEGS,
  MARGIN_PREFLIGHT_BUFFER,
  MAX_CYCLE_TRADED_BASE,
  MAX_LEVERAGE_CAP,
  MAX_TRADED_BASE_PER_WINDOW,
  MIN_CYCLE_GAP_MS,
  MIN_ORDER_NOTIONAL_USD,
  PRIMARY,
  SPREAD_PERCENT,
  VOLUME_PACE_WINDOW_MS,
  exchangeExtras,
  type LegConfig,
} from "./src/config";
import {
  apiBaseUrl,
  buildAccountsDebugUrl,
  buildMarketSettingsDebugUrl,
  debugLogPath,
  dumpApiErrorDebug,
  logApiErr,
} from "./src/debug";
import { installLogger } from "./src/logger";
import { assetFor, resolveMarket } from "./src/markets";
import { ExchangeUpdates, waitForFirstPrice } from "./src/sse";

installLogger();

client.setConfig({ baseUrl: BASE_URL, auth: () => BEARER_TOKEN });

type Side = "buy" | "sell";

const ZERO = new Decimal(0);
const EXCHANGES_QUERY = { query: { exchanges: EXCHANGES } } as never;

/** A leg with its resolved market. */
interface Leg {
  cfg: LegConfig;
  /** Display name from .env (may be a builder venue like `kinetic`). */
  label: string;
  /** Exchange name sent to the API. */
  exchange: string;
  market: GetMarketsDto;
  /** baseSymbol on this exchange (`symbol` field in order requests). */
  symbol: string;
  /** `asset` field in order/leverage requests. */
  asset: string;
}

let primary!: Leg;
let hedge!: Leg;
let legs: Leg[] = [];

/**
 * The leg an order/position belongs to. Matched by exchange + baseSymbol because
 * two legs may share one API exchange (e.g. two builder venues on Hyperliquid).
 */
function legForItem(item: { exchange: string; baseSymbol: string }): Leg | undefined {
  return legs.find((l) => l.exchange === item.exchange && l.symbol === item.baseSymbol);
}

/** A position/order belongs to the bot when its exchange+baseSymbol matches one of the legs. */
function isOurs(item: { exchange: string; baseSymbol: string }): boolean {
  return legForItem(item) !== undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Leverage ---------------------------------------------------------------

/** Keyed by leg role, not exchange: two legs may share one API exchange. */
const leverageByRole = new Map<string, number>();

/** Current leverage from `GET /exchange/market-settings`. */
async function fetchMarketSettingsLeverage(
  exchange: string,
  asset: string,
): Promise<{ leverage: number | null; response: Response; raw: string }> {
  const u = new URL(`${apiBaseUrl()}/exchange/market-settings`);
  u.searchParams.set("exchange", exchange);
  u.searchParams.set("asset", asset);
  const response = await fetch(u, { headers: { Authorization: `Bearer ${BEARER_TOKEN}` } });
  const raw = await response.text();
  let leverage: number | null = null;
  try {
    const j = JSON.parse(raw) as { leverage?: number };
    if (j.leverage != null) leverage = Number(j.leverage);
  } catch {
    /* leave null */
  }
  return { leverage, response, raw };
}

function buildLeverageFallbackTargets(preferred: number): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  let x = Math.max(1, Math.floor(preferred));
  while (x >= 1 && out.length < 14) {
    if (!seen.has(x)) {
      out.push(x);
      seen.add(x);
    }
    if (x === 1) break;
    x = Math.max(1, Math.floor(x / 2));
  }
  return out;
}

async function setLeverageWithRetries(leg: Leg, preferred: number): Promise<void> {
  const { exchange, market, asset, label } = leg;
  for (const lev of buildLeverageFallbackTargets(preferred)) {
    const levBody = { exchange, leverage: lev, marketId: market.id, asset };
    const { error, response } = await exchangeControllerSetLeverage({ body: levBody as never });
    if (error) {
      logApiErr(`${label} SetLeverage(${lev})`, error, response);
      await dumpApiErrorDebug(`${label} SetLeverage(${lev})`, {
        method: "POST",
        url: `${apiBaseUrl()}/exchange/leverage`,
        requestBody: levBody,
        err: error,
        response,
      });
      continue;
    }
    const { leverage: levRead, response: gRes, raw } = await fetchMarketSettingsLeverage(exchange, asset);
    if (!gRes.ok || levRead == null) {
      logApiErr(`${label} market-settings(after set)`, { body: raw.slice(0, 400), status: gRes.status }, gRes);
    }
    const actual = levRead ?? lev;
    leverageByRole.set(leg.cfg.role, actual);
    console.log(`[init] ${label} leverage: target=${preferred} setAttempt=${lev} actual=${actual}`);
    return;
  }
  const { leverage: fbLev, response: fRes, raw } = await fetchMarketSettingsLeverage(exchange, asset);
  const actual = fbLev ?? 1;
  leverageByRole.set(leg.cfg.role, actual);
  if (!fRes.ok || fbLev == null) {
    logApiErr(`${label} market-settings(fallback)`, { body: raw.slice(0, 400), status: fRes.status }, fRes);
    await dumpApiErrorDebug(`${label} market-settings(fallback)`, {
      method: "GET",
      url: buildMarketSettingsDebugUrl(exchange, asset),
      err: { note: "fallback lev null or !ok", fbLev, ok: fRes.ok },
      response: fRes,
      responseBodyText: raw,
    });
  }
  console.warn(`[init] ${label} leverage: all SetLeverage attempts failed; using market-settings actual=${actual}`);
}

async function refreshLeverageSnapshots(): Promise<void> {
  for (const leg of legs) {
    const { leverage, response, raw } = await fetchMarketSettingsLeverage(leg.exchange, leg.asset);
    if (!response.ok || leverage == null) {
      logApiErr(
        `${leg.label} market-settings(refresh)`,
        { body: raw.slice(0, 400), status: response.status },
        response,
      );
      continue;
    }
    leverageByRole.set(leg.cfg.role, leverage);
  }
}

// --- Order management ---------------------------------------------------------

async function cancelOrders(types: Set<string>): Promise<void> {
  const { data: openOrders } = await exchangeControllerGetOpenOrders(EXCHANGES_QUERY);
  for (const order of openOrders ?? []) {
    if (!types.has(order.type)) continue;
    const leg = legForItem(order);
    if (!leg) continue;
    console.log(`[cancel] Canceling ${order.exchange} ${order.side} ${order.type} (${order.orderId})`);
    await exchangeControllerCancelOrder({
      body: {
        exchange: order.exchange,
        orderId: order.orderId,
        symbol: leg.symbol,
        asset: leg.asset,
      } as never,
    }).catch(() => {});
  }
}

async function forceCloseOpenPositions(scope: string, maxAttempts: number): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { data: positions } = await exchangeControllerGetPositions(EXCHANGES_QUERY);
    const openPos = (positions ?? []).filter((p) => isOurs(p) && p.size !== "0");
    if (openPos.length === 0) return;
    if (attempt > 0) console.log(`[${scope}] Retry #${attempt}: ${openPos.length} position(s) still open`);
    for (const pos of openPos) {
      const leg = legForItem(pos)!;
      const posSize = new Decimal(pos.size);
      const closeSide: Side = posSize.gt(0) ? "sell" : "buy";
      console.log(`[close] Force-closing ${pos.exchange}: ${closeSide} ${posSize.abs()} ${leg.symbol}`);
      const body = {
        exchange: pos.exchange,
        symbol: leg.symbol,
        asset: leg.asset,
        side: closeSide,
        size: posSize.abs().toString(),
        reduceOnly: true,
        ...exchangeExtras(pos.exchange),
      };
      const { error, response } = await exchangeControllerCreateOrder({ body: body as never });
      if (error) {
        console.error(`[close] Failed to close ${pos.exchange}:`, error);
        await dumpApiErrorDebug(`[close] ${scope} force-close ${pos.exchange}`, {
          method: "POST",
          url: `${apiBaseUrl()}/exchange/orders`,
          requestBody: body,
          err: error,
          response,
        });
      }
    }
    await sleep(2000);
  }
  console.error(`[${scope}] FAILED: positions still open after ${maxAttempts} retries!`);
}

async function cancelAllAndClose(): Promise<void> {
  await cancelOrders(new Set(["limit", "stopLoss", "takeProfit"]));
  await forceCloseOpenPositions("cancelAllAndClose", 5);
}

// --- State --------------------------------------------------------------------

let currentPrice = ZERO;
let isShuttingDown = false;
let cycleNumber = 0;
let cumulativePnl = ZERO;
let totalVolume = ZERO;
/** Successful-cycle traded base (`2 * size`) timestamps for the rolling pace window. */
const volumePaceLog: { t: number; baseVol: Decimal }[] = [];

interface CycleResult {
  cycle: number;
  durationSec: number;
  pnl: Decimal;
  costBps: Decimal;
  filledSize: Decimal;
}

const cycleHistory: CycleResult[] = [];

function printCycleSummary(c: CycleResult): void {
  const avgBps = cycleHistory.reduce((s, r) => s.plus(r.costBps), ZERO).div(cycleHistory.length);
  const avgDuration = cycleHistory.reduce((s, r) => s + r.durationSec, 0) / cycleHistory.length;

  console.log("");
  console.log(`  Cycle #${c.cycle}  |  ${c.durationSec.toFixed(0)}s  |  ${c.filledSize} ${primary.symbol}`);
  console.log(`  PnL: ${c.pnl.toFixed(4)} USD  (${c.costBps.toFixed(1)} bps)`);
  console.log(`  ---`);
  console.log(
    `  Cumulative: ${cumulativePnl.toFixed(4)} USD  |  Volume: ${totalVolume.toFixed(4)} ${primary.symbol}  |  Cycles: ${cycleHistory.length}`,
  );
  console.log(`  Avg: ${avgBps.toFixed(1)} bps  |  ${avgDuration.toFixed(0)}s/cycle`);
  console.log("");
}

function sumBalances(accounts: GetAccountDtoOutput[] | undefined): Decimal {
  if (!accounts) return ZERO;
  return accounts
    .filter((a) => EXCHANGES.includes(a.exchange))
    .reduce((sum, a) => sum.plus(a.availableMargin), ZERO);
}

// --- Volume pacing --------------------------------------------------------------

function pruneVolumePaceLog(now: number): void {
  const cutoff = now - VOLUME_PACE_WINDOW_MS;
  while (volumePaceLog.length > 0 && volumePaceLog[0]!.t < cutoff) {
    volumePaceLog.shift();
  }
}

function sumRecentTradedBase(now: number): Decimal {
  pruneVolumePaceLog(now);
  return volumePaceLog.reduce((s, e) => s.plus(e.baseVol), ZERO);
}

function recordSuccessfulCycleTradedBase(baseVol: Decimal): void {
  const now = Date.now();
  pruneVolumePaceLog(now);
  volumePaceLog.push({ t: now, baseVol });
}

/** Shrink unified size or wait until the rolling traded-base budget allows `2*size`. */
async function applyWindowTradedBaseCap(u: Decimal, price: Decimal): Promise<Decimal> {
  if (!MAX_TRADED_BASE_PER_WINDOW || MAX_TRADED_BASE_PER_WINDOW.lte(0)) return u;
  let cur = u;
  for (let guard = 0; guard < 10_000; guard++) {
    const now = Date.now();
    const used = sumRecentTradedBase(now);
    if (used.plus(cur.mul(2)).lte(MAX_TRADED_BASE_PER_WINDOW)) return cur;

    const room = MAX_TRADED_BASE_PER_WINDOW.minus(used);
    const oldest = volumePaceLog[0]?.t ?? now;
    const waitMs = Math.max(50, oldest + VOLUME_PACE_WINDOW_MS - now);

    if (room.lte(0)) {
      console.log(`[pace] window traded-base full (used=${used.toFixed(4)} ${primary.symbol}), sleep ${waitMs}ms`);
      await sleep(waitMs);
      continue;
    }

    const maxHalf = room.div(2).toDecimalPlaces(primary.market.baseDecimals, Decimal.ROUND_DOWN);
    if (maxHalf.lte(0) || maxHalf.mul(price).lt(MIN_ORDER_NOTIONAL_USD)) {
      console.log(`[pace] window room too small for min notional, sleep ${waitMs}ms`);
      await sleep(waitMs);
      continue;
    }

    const next = cur.lt(maxHalf) ? cur : maxHalf;
    if (next.eq(cur)) {
      console.log(`[pace] window cap cannot shrink further, sleep ${waitMs}ms`);
      await sleep(waitMs);
      continue;
    }
    console.log(`[pace] shrink for window cap: ${cur.toFixed()} -> ${next.toFixed()} ${primary.symbol}`);
    cur = next;
  }
  throw new Error("[pace] window traded-base cap exceeded iteration guard");
}

// --- Graceful shutdown ------------------------------------------------------------

function setupShutdown(updates: ExchangeUpdates): void {
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n[shutdown] Received ${signal}, cleaning up...`);

    try {
      await cancelAllAndClose();
    } catch (err) {
      console.error("[shutdown] Cleanup failed:", err);
    }

    updates.disconnect();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// --- Cycle -------------------------------------------------------------------------

async function runCycle(): Promise<void> {
  cycleNumber++;
  const cycleStart = Date.now();
  console.log(`\n${"=".repeat(50)}`);
  console.log(`--- Cycle #${cycleNumber} ---`);

  await cancelAllAndClose();

  const { data: accountsBefore } = await exchangeControllerGetAccounts(EXCHANGES_QUERY);
  const balanceBefore = sumBalances(accountsBefore);
  console.log(`Balance before: ${balanceBefore.toFixed(4)} USD`);

  const price = currentPrice;
  if (price.lte(0)) {
    console.log("No price yet, waiting...");
    await sleep(2000);
    return;
  }

  const primaryAccount = accountsBefore?.find((a) => a.exchange === primary.exchange);
  const hedgeAccount = accountsBefore?.find((a) => a.exchange === hedge.exchange);
  if (!primaryAccount || !hedgeAccount) {
    console.log("Missing account data, retrying...");
    await sleep(2000);
    return;
  }

  await refreshLeverageSnapshots();

  const primaryLeverage = leverageByRole.get("primary") ?? primary.market.maxLeverage;
  const hedgeLeverage = leverageByRole.get("hedge") ?? hedge.market.maxLeverage;

  // Size: min of what each exchange can afford with its leverage and balance ratio.
  const primaryMaxSize = new Decimal(primaryAccount.availableMargin)
    .mul(BALANCE_RATIO)
    .mul(primaryLeverage)
    .div(price)
    .toDecimalPlaces(primary.market.baseDecimals, Decimal.ROUND_DOWN);
  const hedgeMaxSize = new Decimal(hedgeAccount.availableMargin)
    .mul(BALANCE_RATIO)
    .mul(hedgeLeverage)
    .div(price)
    .toDecimalPlaces(hedge.market.baseDecimals, Decimal.ROUND_DOWN);

  let u = (primaryMaxSize.lt(hedgeMaxSize) ? primaryMaxSize : hedgeMaxSize).toDecimalPlaces(
    primary.market.baseDecimals,
    Decimal.ROUND_DOWN,
  );
  if (MAX_CYCLE_TRADED_BASE && MAX_CYCLE_TRADED_BASE.gt(0)) {
    const capHalf = MAX_CYCLE_TRADED_BASE.div(2).toDecimalPlaces(primary.market.baseDecimals, Decimal.ROUND_DOWN);
    if (u.gt(capHalf)) u = capHalf;
  }
  u = await applyWindowTradedBaseCap(u, price);
  const primarySize = u;
  const hedgeSize = u.toDecimalPlaces(hedge.market.baseDecimals, Decimal.ROUND_DOWN);

  if (primarySize.lte(0) || hedgeSize.lte(0)) {
    console.log("Computed size is 0, waiting 5s...");
    await sleep(5000);
    return;
  }

  const primarySizeStr = primarySize.toString();
  const hedgeSizeStr = hedgeSize.toString();

  // Preflight: fresh margin check on the primary exchange.
  const { data: accountsPre, error: preAccErr, response: preAccRes } =
    await exchangeControllerGetAccounts(EXCHANGES_QUERY);
  if (preAccErr || !accountsPre) {
    logApiErr("[pre] GetAccounts before Phase1", preAccErr ?? "no data", preAccRes);
    await dumpApiErrorDebug("[pre] GetAccounts before Phase1", {
      method: "GET",
      url: buildAccountsDebugUrl(),
      err: preAccErr ?? "no data",
      response: preAccRes,
    });
    await sleep(2000);
    return;
  }
  const primaryAccFresh = accountsPre.find((a) => a.exchange === primary.exchange);
  if (!primaryAccFresh) {
    console.log(`[pre] Missing ${primary.label} account after refresh`);
    await sleep(2000);
    return;
  }

  const estNotional = price.mul(primarySize);
  if (estNotional.lt(MIN_ORDER_NOTIONAL_USD)) {
    console.log(`[pre] Notional ${estNotional.toFixed(2)} USD < floor ${MIN_ORDER_NOTIONAL_USD}; skip`);
    await sleep(2000);
    return;
  }

  const marginNeed = estNotional.div(primaryLeverage).mul(MARGIN_PREFLIGHT_BUFFER);
  const avail = new Decimal(primaryAccFresh.availableMargin);
  if (avail.lt(marginNeed)) {
    console.log(
      `[pre] ${primary.label} margin: available=${avail.toFixed(4)} need≈${marginNeed.toFixed(4)} (notional=${estNotional.toFixed(2)} lev=${primaryLeverage}); wait 3s`,
    );
    await sleep(3000);
    return;
  }

  // --- PHASE 1: Place BUY + SELL limit orders on the PRIMARY exchange ---
  const buyPrice = price
    .mul(new Decimal(1).minus(SPREAD_PERCENT))
    .toDecimalPlaces(primary.market.priceDecimals, Decimal.ROUND_DOWN);
  const sellPrice = price
    .mul(new Decimal(1).plus(SPREAD_PERCENT))
    .toDecimalPlaces(primary.market.priceDecimals, Decimal.ROUND_UP);

  console.log(`[${primary.label}] Phase 1: BUY@${buyPrice} SELL@${sellPrice} size=${primarySizeStr}`);

  for (const side of ["buy", "sell"] as const) {
    const body: Record<string, unknown> = {
      exchange: primary.exchange,
      symbol: primary.symbol,
      asset: primary.asset,
      side,
      size: primarySizeStr,
      price: (side === "buy" ? buyPrice : sellPrice).toString(),
      ...exchangeExtras(primary.exchange),
    };
    const { error, response } = await exchangeControllerCreateOrder({ body: body as never });
    if (error) {
      logApiErr(`[${primary.label}] ${side} limit failed`, error, response);
      await dumpApiErrorDebug(`[${primary.label}] Phase1 ${side} limit`, {
        method: "POST",
        url: `${apiBaseUrl()}/exchange/orders`,
        requestBody: body,
        err: error,
        response,
      });
      if (side === "sell") await cancelOrders(new Set(["limit"]));
      return;
    }
  }

  // --- PHASE 2: Wait for one primary order to fill ---
  console.log(`[${primary.label}] Phase 2: Waiting for fill...`);
  const fillDeadline = Date.now() + FILL_TIMEOUT_MS;
  let fillSide: Side | null = null;

  while (Date.now() < fillDeadline && !isShuttingDown) {
    const { data: positions } = await exchangeControllerGetPositions(EXCHANGES_QUERY);
    const primaryPos = (positions ?? []).find(
      (p) => p.exchange === primary.exchange && p.baseSymbol === primary.symbol && p.size !== "0",
    );
    if (primaryPos) {
      fillSide = new Decimal(primaryPos.size).gt(0) ? "buy" : "sell";
      console.log(`[${primary.label}] Filled: ${fillSide} ${primaryPos.size}`);
      break;
    }
    await sleep(1500);
  }

  if (!fillSide) {
    console.log(`Timeout waiting for ${primary.label} fill, restarting...`);
    await cancelAllAndClose();
    return;
  }

  // --- PHASE 3: Cancel the remaining primary order + hedge at market ---
  console.log(`[phase3] Cancelling remaining ${primary.label} orders, hedging on ${hedge.label}`);
  await cancelOrders(new Set(["limit", "stopLoss", "takeProfit"]));

  const hedgeSide: Side = fillSide === "buy" ? "sell" : "buy";
  console.log(`[${hedge.label}] Market ${hedgeSide} size=${hedgeSizeStr}`);

  const hedgeBody = {
    exchange: hedge.exchange,
    symbol: hedge.symbol,
    asset: hedge.asset,
    side: hedgeSide,
    size: hedgeSizeStr,
    ...exchangeExtras(hedge.exchange),
  };
  const { error: hedgeErr, response: hedgeRes } = await exchangeControllerCreateOrder({
    body: hedgeBody as never,
  });
  if (hedgeErr) {
    logApiErr(`[${hedge.label}] Hedge market failed`, hedgeErr, hedgeRes);
    await dumpApiErrorDebug(`[${hedge.label}] Phase3 hedge market`, {
      method: "POST",
      url: `${apiBaseUrl()}/exchange/orders`,
      requestBody: hedgeBody,
      err: hedgeErr,
      response: hedgeRes,
    });
    await cancelAllAndClose();
    return;
  }
  console.log(`[${hedge.label}] Hedge success`);

  // --- PHASE 4: Place reduce-only limit close orders on BOTH exchanges ---
  // If we bought on primary → close by selling at sellPrice; the hedge sold → close by buying at buyPrice.
  const primaryCloseSide: Side = fillSide === "buy" ? "sell" : "buy";
  const hedgeCloseSide: Side = hedgeSide === "buy" ? "sell" : "buy";
  const primaryClosePrice = fillSide === "buy" ? sellPrice : buyPrice;
  const hedgeClosePrice = (fillSide === "buy" ? buyPrice : sellPrice).toDecimalPlaces(
    hedge.market.priceDecimals,
    fillSide === "buy" ? Decimal.ROUND_DOWN : Decimal.ROUND_UP,
  );

  console.log(
    `[phase4] Close orders: ${primary.label} ${primaryCloseSide}@${primaryClosePrice}, ${hedge.label} ${hedgeCloseSide}@${hedgeClosePrice}`,
  );

  const closeOrders = [
    {
      leg: primary,
      body: {
        exchange: primary.exchange,
        symbol: primary.symbol,
        asset: primary.asset,
        side: primaryCloseSide,
        size: primarySizeStr,
        price: primaryClosePrice.toString(),
        reduceOnly: true,
        ...exchangeExtras(primary.exchange),
      },
    },
    {
      leg: hedge,
      body: {
        exchange: hedge.exchange,
        symbol: hedge.symbol,
        asset: hedge.asset,
        side: hedgeCloseSide,
        size: hedgeSizeStr,
        price: hedgeClosePrice.toString(),
        reduceOnly: true,
        ...exchangeExtras(hedge.exchange),
      },
    },
  ];
  for (const { leg, body } of closeOrders) {
    const { error, response } = await exchangeControllerCreateOrder({ body: body as never });
    if (error) {
      logApiErr(`[${leg.label}] Close limit failed`, error, response);
      await dumpApiErrorDebug(`[${leg.label}] Phase4 close limit`, {
        method: "POST",
        url: `${apiBaseUrl()}/exchange/orders`,
        requestBody: body,
        err: error,
        response,
      });
    }
  }

  // --- PHASE 5: Wait for ANY close limit to fill, then force-close the other ---
  console.log("[phase5] Waiting for a close limit to fill...");
  const closeDeadline = Date.now() + CLOSE_TIMEOUT_MS;
  const initialOpenCount = 2;
  let closedCount = 0;

  while (Date.now() < closeDeadline && !isShuttingDown) {
    const { data: positions } = await exchangeControllerGetPositions(EXCHANGES_QUERY);
    const openPos = (positions ?? []).filter((p) => isOurs(p) && p.size !== "0");
    if (openPos.length === 0) {
      console.log("[phase5] All positions closed via limits!");
      closedCount = initialOpenCount;
      break;
    }
    if (openPos.length < initialOpenCount) {
      const remaining = openPos.map((p) => `${p.exchange}:${p.size}`).join(", ");
      console.log(`[phase5] One side closed! Remaining: ${remaining}. Force-closing rest...`);
      await cancelAllAndClose();
      closedCount = initialOpenCount;
      break;
    }
    console.log(
      `[phase5] ${openPos.length} position(s) still open, waiting... (price=${currentPrice}, elapsed=${((Date.now() - cycleStart) / 1000).toFixed(0)}s)`,
    );
    await sleep(2000);
  }

  if (closedCount < initialOpenCount) {
    console.log(`[phase5] Timeout (${CLOSE_TIMEOUT_MS / 1000}s), force-closing all...`);
    await cancelAllAndClose();
  }

  let balanceAfter = ZERO;
  for (let i = 0; i < 5; i++) {
    await sleep(1000);
    const { data: accountsAfter } = await exchangeControllerGetAccounts(EXCHANGES_QUERY);
    balanceAfter = sumBalances(accountsAfter);
    if (balanceAfter.gt(balanceBefore.mul(0.5))) break;
  }

  const cyclePnl = balanceAfter.minus(balanceBefore);
  cumulativePnl = cumulativePnl.plus(cyclePnl);
  const durationSec = (Date.now() - cycleStart) / 1000;
  const notional = primarySize.mul(price);
  totalVolume = totalVolume.plus(primarySize.mul(2));
  recordSuccessfulCycleTradedBase(primarySize.mul(2));
  const costBps = notional.gt(0) ? cyclePnl.neg().div(notional).mul(10000) : ZERO;

  const result: CycleResult = {
    cycle: cycleNumber,
    durationSec,
    pnl: cyclePnl,
    costBps,
    filledSize: primarySize,
  };
  cycleHistory.push(result);
  printCycleSummary(result);
}

// --- Main -----------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(
    `[init] vooi-mm-bot | alias=${ALIAS || "-"} | spread=${SPREAD_PERCENT} | primary=${PRIMARY.name} hedge=${HEDGE.name}`,
  );
  console.log(`[init] api-error-debug → ${debugLogPath()} (env API_ERROR_DEBUG_LOG to change path)`);
  if (MAX_TRADED_BASE_PER_WINDOW?.gt(0)) {
    console.log(
      `[init] pace: maxTradedBase/${(VOLUME_PACE_WINDOW_MS / 3_600_000).toFixed(2)}h=${MAX_TRADED_BASE_PER_WINDOW.toString()} (per-cycle +2×size)`,
    );
  }
  if (MAX_CYCLE_TRADED_BASE?.gt(0)) {
    console.log(`[init] pace: maxCycleTradedBase=${MAX_CYCLE_TRADED_BASE.toString()}`);
  }
  if (MIN_CYCLE_GAP_MS > 0) {
    console.log(`[init] pace: minCycleGapMs=${MIN_CYCLE_GAP_MS}`);
  }

  const { data: allMarkets, error: marketsErr, response: marketsRes } =
    await exchangeControllerGetMarkets(EXCHANGES_QUERY);
  if (marketsErr || !allMarkets) {
    logApiErr("GetMarkets", marketsErr ?? "no data", marketsRes);
    throw new Error(
      `Failed to fetch markets for [${EXCHANGES.join(", ")}]. ` +
        `Check BEARER_TOKEN and that these exchanges are enabled for your VOOI account.`,
    );
  }

  legs = LEGS.map((cfg) => {
    const market = resolveMarket(allMarkets, cfg, ALIAS);
    const leg: Leg = {
      cfg,
      label: cfg.name,
      exchange: cfg.exchange,
      market,
      symbol: market.baseSymbol,
      asset: assetFor(cfg.exchange, market),
    };
    const via = cfg.name === cfg.exchange ? cfg.exchange : `${cfg.name} (via ${cfg.exchange})`;
    console.log(
      `[init] ${cfg.role}=${via}: ${market.baseSymbol}/${market.quoteSymbol} id=${market.id} asset=${leg.asset} price=${market.price} priceDecimals=${market.priceDecimals} baseDecimals=${market.baseDecimals}`,
    );
    return leg;
  });
  primary = legs[0]!;
  hedge = legs[1]!;

  if (primary.exchange === hedge.exchange && String(primary.market.id) === String(hedge.market.id)) {
    throw new Error(
      `PRIMARY and HEDGE resolved to the same market (${primary.exchange} ${primary.symbol}); pick different venues or symbols`,
    );
  }
  if (primary.exchange === hedge.exchange) {
    console.warn(
      `[init] WARNING: both legs settle on ${primary.exchange} — they share one margin account, so sizing may overestimate what each leg can afford`,
    );
  }

  for (const leg of legs) {
    const preferred = leg.cfg.leverage ?? Math.min(leg.market.maxLeverage, MAX_LEVERAGE_CAP);
    await setLeverageWithRetries(leg, preferred);
  }

  await cancelAllAndClose();

  const { data: existingPositions } = await exchangeControllerGetPositions(EXCHANGES_QUERY);
  const leftover = existingPositions?.find((p) => isOurs(p) && p.size !== "0");
  if (leftover) {
    throw new Error(`Leftover position on ${leftover.exchange}: size=${leftover.size}. Close it first.`);
  }

  const updates = new ExchangeUpdates(BASE_URL, BEARER_TOKEN, EXCHANGES);
  updates.connect();

  updates.on("marketPrice", (prices) => {
    const mp = prices.find((p) => p.marketId === String(primary.market.id) && p.exchange === primary.exchange);
    if (mp) currentPrice = new Decimal(mp.price);
  });

  await waitForFirstPrice(updates);
  console.log(`[init] Live price: ${currentPrice}`);

  setupShutdown(updates);
  console.log("[init] Starting cycle loop...\n");

  while (!isShuttingDown) {
    try {
      await runCycle();
    } catch (err) {
      if (isShuttingDown) break;
      console.error("[cycle] Error:", err);

      try {
        await cancelAllAndClose();
      } catch (cleanupErr) {
        console.error("[cycle] Cleanup failed:", cleanupErr);
      }

      await sleep(5000);
    }
    if (MIN_CYCLE_GAP_MS > 0) await sleep(MIN_CYCLE_GAP_MS);
  }
}

main().catch((err) => {
  console.error("[bot] Fatal:", err);
  process.exit(1);
});
