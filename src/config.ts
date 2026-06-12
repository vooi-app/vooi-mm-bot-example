import { join } from "node:path";

import { config as loadEnv } from "dotenv";
import Decimal from "decimal.js-light";

/** `.env` next to the project root wins over inherited shell env. */
loadEnv({ path: join(import.meta.dirname ?? import.meta.dir, "..", ".env"), override: true });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required in .env`);
  return value;
}

function optionalDecimal(name: string): Decimal | null {
  const raw = process.env[name]?.trim();
  return raw ? new Decimal(raw) : null;
}

/**
 * One leg of the strategy. `role` only affects behaviour:
 *  - primary: passive limit orders (maker side, earns the spread)
 *  - hedge:   market order on the opposite side once primary fills
 */
export interface LegConfig {
  role: "primary" | "hedge";
  /** Exchange name as written in .env (kinetic, tradexyz, hyperliquid:km, lighter, ...). Used in logs. */
  name: string;
  /** Exchange name as the VOOI API expects it (e.g. extended, hyperliquid, lighter, aster). */
  exchange: string;
  /**
   * HIP-3 builder prefix when the configured "exchange" is a builder venue on
   * Hyperliquid (e.g. `km` for Kinetiq, `xyz` for trade.xyz). Restricts market
   * resolution to baseSymbols starting with `<prefix>:`.
   */
  marketPrefix: string | null;
  /**
   * Explicit market baseSymbol on this exchange (e.g. `xyz:SPCX`). When empty,
   * the market is resolved from ALIAS (exact or HIP-3 `deployer:ALIAS` match).
   */
  symbol: string | null;
  /** Explicit market id on this exchange; disambiguates when one baseSymbol has several markets. */
  marketId: string | null;
  /** Target leverage; null = use the market's maxLeverage. */
  leverage: number | null;
}

/**
 * Friendly names for HIP-3 builder venues that live inside Hyperliquid.
 * Their markets are regular Hyperliquid markets whose baseSymbol carries the
 * builder prefix (`km:GOLD`, `xyz:SPCX`). Any other deployer can be addressed
 * without a mapping via the generic `hyperliquid:<prefix>` syntax.
 */
const VIRTUAL_EXCHANGES: Record<string, { exchange: string; prefix: string }> = {
  kinetic: { exchange: "hyperliquid", prefix: "km" },
  kinetiq: { exchange: "hyperliquid", prefix: "km" },
  km: { exchange: "hyperliquid", prefix: "km" },
  xyz: { exchange: "hyperliquid", prefix: "xyz" },
  tradexyz: { exchange: "hyperliquid", prefix: "xyz" },
  "trade.xyz": { exchange: "hyperliquid", prefix: "xyz" },
};

function parseExchangeName(raw: string): { name: string; exchange: string; marketPrefix: string | null } {
  const name = raw.trim().toLowerCase();
  const virtual = VIRTUAL_EXCHANGES[name];
  if (virtual) return { name, exchange: virtual.exchange, marketPrefix: virtual.prefix };
  const colon = name.indexOf(":");
  if (colon > 0) {
    return { name, exchange: name.slice(0, colon), marketPrefix: name.slice(colon + 1) || null };
  }
  return { name, exchange: name, marketPrefix: null };
}

function legFromEnv(role: "primary" | "hedge", prefix: string): LegConfig {
  const lev = process.env[`${prefix}_LEVERAGE`]?.trim();
  return {
    role,
    ...parseExchangeName(requireEnv(`${prefix}_EXCHANGE`)),
    symbol: process.env[`${prefix}_SYMBOL`]?.trim() || null,
    marketId: process.env[`${prefix}_MARKET_ID`]?.trim() || null,
    leverage: lev ? Number(lev) : null,
  };
}

export const BEARER_TOKEN = requireEnv("BEARER_TOKEN");
export const BASE_URL = process.env.BASE_URL ?? "https://perps-api.vooi.io";

/** Cross-exchange asset alias, e.g. SPCX. Per-leg SYMBOL overrides take precedence. */
export const ALIAS = (process.env.ALIAS ?? "").trim();

export const PRIMARY = legFromEnv("primary", "PRIMARY");
export const HEDGE = legFromEnv("hedge", "HEDGE");
export const LEGS = [PRIMARY, HEDGE] as const;
export const EXCHANGES = [...new Set(LEGS.map((l) => l.exchange))];

if (
  PRIMARY.exchange === HEDGE.exchange &&
  PRIMARY.marketPrefix === HEDGE.marketPrefix &&
  PRIMARY.symbol === HEDGE.symbol &&
  PRIMARY.marketId === HEDGE.marketId
) {
  throw new Error("PRIMARY and HEDGE must trade different venues or markets");
}
if (!ALIAS && (!PRIMARY.symbol || !HEDGE.symbol)) {
  throw new Error("Set ALIAS, or set both PRIMARY_SYMBOL and HEDGE_SYMBOL");
}

/** Half-spread for the passive limit orders, as a fraction (0.001 = 0.1%). */
export const SPREAD_PERCENT = new Decimal(process.env.SPREAD_PERCENT ?? "0.001");
/** Fraction of available margin used to size each cycle. */
export const BALANCE_RATIO = new Decimal(process.env.BALANCE_RATIO ?? "0.85");
/** Markets DTO has no minNotional; floor applied before placing limit orders. */
export const MIN_ORDER_NOTIONAL_USD = new Decimal(process.env.MIN_ORDER_NOTIONAL_USD?.trim() || "5");
/** Extra margin requirement multiplier checked before each cycle. */
export const MARGIN_PREFLIGHT_BUFFER = new Decimal(process.env.MARGIN_PREFLIGHT_BUFFER?.trim() || "1.12");
/** Cap on leverage the bot will request, even if the market allows more. */
export const MAX_LEVERAGE_CAP = Number(process.env.MAX_LEVERAGE_CAP ?? "100");

/** Rolling window for traded-base pacing (ms). Default 1 hour. */
export const VOLUME_PACE_WINDOW_MS = Number(process.env.VOLUME_PACE_WINDOW_MS ?? `${3_600_000}`);
/** Max sum of `2 * size` over the rolling window, in base units. Unset = disabled. */
export const MAX_TRADED_BASE_PER_WINDOW = optionalDecimal("MAX_TRADED_BASE_PER_WINDOW");
/** Max `2 * size` per successful cycle (base units). Unset = disabled. */
export const MAX_CYCLE_TRADED_BASE = optionalDecimal("MAX_CYCLE_TRADED_BASE");
/** Pause after every cycle (ms). */
export const MIN_CYCLE_GAP_MS = Number(process.env.MIN_CYCLE_GAP_MS ?? "0");

/** How long to wait for the primary limit order to fill before restarting the cycle (ms). */
export const FILL_TIMEOUT_MS = Number(process.env.FILL_TIMEOUT_MS ?? "120000");
/** How long to wait for the close limits before force-closing both legs at market (ms). */
export const CLOSE_TIMEOUT_MS = Number(process.env.CLOSE_TIMEOUT_MS ?? "30000");

// --- Broker attribution -----------------------------------------------------
// Defaults are VOOI's public broker/builder ids. Override per exchange with
// BROKER_<EXCHANGE>_ID / BROKER_<EXCHANGE>_FEE_BPS, or disable with BROKER_<EXCHANGE>_ID="".

interface BrokerConfig {
  id: string;
  feeBps: string;
}

const DEFAULT_BROKERS: Record<string, BrokerConfig> = {
  hyperliquid: { feeBps: "15", id: "0xbe622f92438ae55b12908b01eeace15d98ed1eec" },
  aster: { feeBps: "1.5", id: "0xBe622F92438AE55B12908B01eEACe15d98eD1EEC" },
  lighter: { feeBps: "150", id: "132230" },
};

export function brokerFor(exchange: string): BrokerConfig | null {
  const envKey = exchange.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const id = process.env[`BROKER_${envKey}_ID`];
  if (id !== undefined) {
    if (!id.trim()) return null;
    return { id: id.trim(), feeBps: process.env[`BROKER_${envKey}_FEE_BPS`]?.trim() || "0" };
  }
  return DEFAULT_BROKERS[exchange] ?? null;
}

const CLIENT_ORDER_PREFIX = "445";
const CLIENT_ORDER_SUFFIX = "544";

/** Lighter requires a numeric clientOrderId per order. */
function lighterClientOrderId(): string {
  return `${CLIENT_ORDER_PREFIX}${Math.floor(Math.random() * 100_000_000)}${CLIENT_ORDER_SUFFIX}`;
}

/** Per-exchange extra fields merged into every order body. */
export function exchangeExtras(exchange: string): Record<string, unknown> {
  const extras: Record<string, unknown> = {};
  const broker = brokerFor(exchange);
  if (broker) extras.broker = broker;
  if (exchange === "lighter") extras.clientOrderId = lighterClientOrderId();
  return extras;
}
