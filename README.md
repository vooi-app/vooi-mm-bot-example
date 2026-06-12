# vooi-mm-bot

Delta-neutral market-making bot for perpetual futures on Hyperliquid, Lighter, Aster, Extended, trade.xyz, and Kinetiq — built on the [VOOI Perps API](https://perps-api.vooi.io).

> **Disclaimer**
>
> These examples are provided for educational purposes only. They are not financial advice and do not guarantee profit.
>
> They demonstrate how VOOI Ultra users can quickly prototype trading bots and agentic trading workflows using VOOI Perps API access available through VOOI Ultra.
>
> Testing does not make the bots risk-free. Trading bots can place real orders and interact with real funds. Review the code, configuration, strategy, and risk controls before running any bot with live capital.

## What this is

You pick two venues and an asset. The bot quotes a passive spread on one exchange, waits for a fill, then instantly hedges on the other — net exposure stays ~zero. Works with any pair of venues your VOOI account can reach: Hyperliquid, Lighter, Aster, Extended, Kinetiq, trade.xyz, or any HIP-3 builder deployment.

Useful if you want to capture spread on RWA perps (NVDA, SPCX, gold, S&P 500) or crypto perps across venues without running directional risk.

## How it works

Each cycle:

1. **Quote** — place a BUY and a SELL limit order around the mid price on the **primary** exchange, `±SPREAD_PERCENT` from the live price.
2. **Wait for a fill** — poll positions until one of the two limits fills (or `FILL_TIMEOUT_MS` expires → cancel and restart).
3. **Hedge** — cancel the remaining limit and open the opposite side with a market order on the **hedge** exchange. Net exposure is now ~zero.
4. **Close** — place reduce-only limit orders on both exchanges at the original spread prices.
5. **Settle** — as soon as either side closes (or `CLOSE_TIMEOUT_MS` expires), force-close whatever remains at market and print the cycle PnL.

On `SIGINT`/`SIGTERM` the bot cancels all of its orders and force-closes its positions before exiting. On startup it refuses to run if a leftover position exists on a configured market.

## Before you start

1. **Generate an API token** — go to [ultra.vooi.io/api-tokens](https://ultra.vooi.io/api-tokens) and create a token. This goes into `BEARER_TOKEN` in your `.env`.
2. **Fund your account** — deposit on at least two venues you plan to use (e.g. Hyperliquid + Lighter). Both legs need margin.
3. **Install Node** — the bot runs on [Node.js](https://nodejs.org) ≥ 18 (the npm scripts run TypeScript via [`tsx`](https://tsx.is)).

## Quickstart

Requires [Node.js](https://nodejs.org) ≥ 18.

```bash
cp .env.example .env   # fill in BEARER_TOKEN and pick exchanges/asset

npm install
npm start
```

Minimal `.env`:

```bash
BEARER_TOKEN=...            # your VOOI Perps API token
PRIMARY_EXCHANGE=extended   # passive limit orders here
HEDGE_EXCHANGE=kinetic      # market-order hedge here
ALIAS=SPCX                  # asset, resolved per exchange (see below)
SPREAD_PERCENT=0.001        # ±0.1% around mid
```

Start small: low `BALANCE_RATIO`, explicit `PRIMARY_LEVERAGE`/`HEDGE_LEVERAGE`, and a `MAX_CYCLE_TRADED_BASE` cap until you've watched a few cycles.

Two read-only helpers (no orders are ever placed by them):

```bash
npm run check          # preflight: validates token, venues, market resolution, balances
npm run markets        # what venues + builder prefixes your account can reach
npm run markets spcx   # find an asset across all venues (symbols, market ids, prices)
```

## Venue names: accepted values

`PRIMARY_EXCHANGE` and `HEDGE_EXCHANGE` accept (case-insensitive):

| Value | Kind | What it means |
|---|---|---|
| `aster` | API exchange | Aster |
| `extended` | API exchange | Extended |
| `hyperliquid` | API exchange | Hyperliquid, all markets including builder-prefixed ones |
| `lighter` | API exchange | Lighter |
| `kinetic` / `kinetiq` / `km` | builder venue | Kinetiq — Hyperliquid markets prefixed `km:` |
| `tradexyz` / `xyz` / `trade.xyz` | builder venue | trade.xyz — Hyperliquid markets prefixed `xyz:` |
| `hyperliquid:<prefix>` | builder venue (generic) | any HIP-3 deployer by its prefix, e.g. `hyperliquid:km` |

The authoritative list of API exchanges is whatever `GET /exchange/markets` returns for your account (new exchanges added by VOOI work here without code changes). The authoritative list of builder prefixes is whatever appears before `:` in Hyperliquid baseSymbols. Both are printed by `npm run markets`.

## Builder venues on Hyperliquid (Kinetiq, trade.xyz, …)

Some "exchanges" are not separate venues in the VOOI API — they are **HIP-3 builder deployments living inside Hyperliquid**. Their markets are regular Hyperliquid markets whose `baseSymbol` carries the builder's prefix: Kinetiq markets look like `km:GOLD`, `km:NVDA`; trade.xyz markets look like `xyz:SPCX`, `xyz:TSLA`.

The bot understands these as first-class venue names (see the table above), so `HEDGE_EXCHANGE=kinetic` just works: orders go to Hyperliquid, but only `km:*` markets are considered. With a builder venue selected, `ALIAS=SPCX` resolves to `<prefix>:SPCX` on that venue (e.g. `xyz:SPCX` for `tradexyz`) — you don't have to spell out the prefix in the alias or symbol. Both legs may even sit on different builder venues of the same underlying exchange (the bot tracks each leg by its own market and warns that they share one margin account).

To see which builder prefixes exist right now and how many markets each has, run `npm run markets` — it lists every prefix with the ready-to-paste venue name (`hyperliquid:km`, `hyperliquid:xyz`, …).

## Choosing markets: alias vs explicit symbols

The same asset has different symbols on different exchanges (SpaceX pre-IPO is `xyz:SPCX` on Hyperliquid, may be plain `SPCX` elsewhere). `ALIAS` handles this: on each exchange the bot picks the open market whose `baseSymbol` **equals the alias** or **ends with `:<alias>`** (HIP-3 builder markets), case-insensitive.

When the alias is missing or ambiguous on an exchange, the bot exits with an error telling you which override to set:

```bash
PRIMARY_SYMBOL=SPCX-USD     # exact baseSymbol on the primary exchange
HEDGE_SYMBOL=xyz:SPCX       # exact baseSymbol on the hedge exchange
PRIMARY_MARKET_ID=110076    # exact market id when one symbol has several markets
```

Where to look up symbols and market ids:

- `npm run markets <fragment>` — searches all venues your account can reach and prints `exchange`, `baseSymbol`, `id`, price and leverage (e.g. `npm run markets spcx`, `npm run markets btc`);
- the raw API: `GET /exchange/markets` with your bearer token — `baseSymbol` and `id` fields are exactly what `*_SYMBOL` / `*_MARKET_ID` expect;
- the VOOI app market list shows the same symbols.

## Configuration reference

All settings live in `.env` (see [.env.example](.env.example) for the full annotated list).

| Variable | Default | Meaning |
|---|---|---|
| `BEARER_TOKEN` | — (required) | VOOI Perps API token |
| `BASE_URL` | `https://perps-api.vooi.io` | API base URL |
| `PRIMARY_EXCHANGE` | — (required) | Venue for passive limit orders (API exchange or builder venue, see above) |
| `HEDGE_EXCHANGE` | — (required) | Venue for the market-order hedge |
| `ALIAS` | — | Cross-exchange asset alias (or set both `*_SYMBOL`s) |
| `PRIMARY_SYMBOL` / `HEDGE_SYMBOL` | from alias | Exact per-exchange baseSymbol override |
| `PRIMARY_MARKET_ID` / `HEDGE_MARKET_ID` | — | Exact market id override |
| `PRIMARY_LEVERAGE` / `HEDGE_LEVERAGE` | market max | Target leverage per leg |
| `MAX_LEVERAGE_CAP` | `100` | Hard cap on requested leverage |
| `SPREAD_PERCENT` | `0.001` | Half-spread of the passive quotes (fraction) |
| `BALANCE_RATIO` | `0.85` | Fraction of available margin used for sizing |
| `MIN_ORDER_NOTIONAL_USD` | `5` | Skip cycles below this order notional |
| `MARGIN_PREFLIGHT_BUFFER` | `1.12` | Required margin headroom before quoting |
| `FILL_TIMEOUT_MS` | `120000` | Max wait for the primary fill |
| `CLOSE_TIMEOUT_MS` | `30000` | Max wait for the close limits |
| `MAX_TRADED_BASE_PER_WINDOW` | off | Volume cap per rolling window (base units) |
| `VOLUME_PACE_WINDOW_MS` | `3600000` | Rolling window length |
| `MAX_CYCLE_TRADED_BASE` | off | Volume cap per cycle (base units) |
| `MIN_CYCLE_GAP_MS` | `0` | Pause between cycles |
| `BROKER_<EXCHANGE>_ID` / `_FEE_BPS` | VOOI defaults | Broker/builder attribution per exchange; empty id disables |
| `BOT_LOG` / `BOT_LOG_MIRROR` | `bot.log` / `1` | File log path / terminal echo |
| `API_ERROR_DEBUG_LOG` | `api-error-debug.jsonl` | Full request/response dumps on API errors |

## Observability

- Every console line is timestamped and appended to `bot.log`.
- Each API error writes one JSON line with the full request/response (auth redacted) to `api-error-debug.jsonl` — attach the relevant lines when reporting issues.
- After every cycle the bot prints PnL, effective cost in bps, cumulative volume and averages.

## Project layout (for humans and AI agents)

```
mm-bot.ts          # entry point: leverage setup, the 5-phase cycle loop, shutdown
check-config.ts    # `npm run check` — read-only preflight of the .env config
list-markets.ts    # `npm run markets [fragment]` — read-only venue/market discovery
src/config.ts      # all env parsing; leg config (primary/hedge); virtual venue map; broker extras
src/markets.ts     # alias/symbol/market-id → market resolution; per-exchange `asset` field
src/sse.ts         # SSE stream (prices, orders, positions) with reconnect/backoff
src/debug.ts       # API error logging helpers
src/logger.ts      # timestamped file+console logger
src/client/        # generated VOOI API client (@hey-api/openapi-ts) — do not edit by hand
```

Notes for agents working on this code:

- The exchange is intentionally a plain string end-to-end; only the generated client narrows it. Order/leverage bodies are cast `as never` at the call site so new exchanges work without regenerating. To refresh the client anyway: `npm run regen-client` (see `openapi-ts.config.ts`).
- Builder venues (Kinetiq, trade.xyz) are *virtual*: `VIRTUAL_EXCHANGES` in `src/config.ts` maps friendly names to `{exchange: "hyperliquid", prefix}`, and `resolveMarket()` narrows candidates to `prefix:*` baseSymbols. To support a new well-known deployer, add one line to that map; users can always reach it earlier via `hyperliquid:<prefix>`.
- Because two legs can share one API exchange, never key bot state by exchange alone: orders/positions are matched to a leg by `exchange + baseSymbol` (`legForItem`), and leverage is tracked per leg role.
- Aster quirk: the `asset` field in order/leverage requests is the market **id** (e.g. `BTCUSDT`); everywhere else it is the `baseSymbol`. This is encapsulated in `assetFor()` — keep it that way.
- Lighter quirk: every order needs a numeric `clientOrderId` — handled by `exchangeExtras()`.
- Anything the bot owns is identified by `exchange + baseSymbol` (`isOurs()`); it never touches positions or orders on other markets of the same account.
- The cycle loop is deliberately conservative: any error → cancel everything, close everything, sleep, retry.

## Related repos

- [**vooi-funding-bot-example**](https://github.com/vooi-app/vooi-funding-bot-example) — Delta-neutral funding arbitrage bot. Long one venue, short another, capture the spread.
- [**vooi-signals-bot-example**](https://github.com/vooi-app/vooi-signals-bot-example) — Telegram signals → LLM parser → VOOI API trade execution.
- [**vooi-mcp**](https://github.com/vooi-app/mcp) — MCP server for running perp strategies through Claude, Cursor, or any AI agent.

## Links

- API docs: [perps-api.vooi.io/docs](https://perps-api.vooi.io/docs)
- Get API access: [ultra.vooi.io/api-tokens](https://ultra.vooi.io/api-tokens)
- VOOI Ultra: [ultra.vooi.io](https://ultra.vooi.io)
- X: [@vooi_io](https://x.com/vooi_io)

## Safety

The bot trades with real funds and can lose money — spread too tight vs fees, slippage on force-closes, one leg failing. Test with a small balance first. Both legs must be funded; sizing is the minimum of what each side affords. Keep your `BEARER_TOKEN` secret — it controls your trading account. `.env`, logs and debug dumps are gitignored; never commit them.

## License

[MIT](LICENSE)
