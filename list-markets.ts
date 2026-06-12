/**
 * Read-only discovery tool: what venues, builder prefixes and symbols your
 * VOOI account can reach. Needs only BEARER_TOKEN (and optionally BASE_URL).
 *
 *   bun run markets          # summary: exchanges + builder prefixes + market counts
 *   bun run markets spcx     # find markets whose baseSymbol or id contains "spcx"
 */

import { join } from "node:path";

import { config as loadEnv } from "dotenv";

import { client } from "./src/client/client.gen";
import { exchangeControllerGetMarkets } from "./src/client/sdk.gen";

loadEnv({ path: join(import.meta.dir, ".env"), override: true });

const token = process.env.BEARER_TOKEN;
if (!token) {
  console.error("BEARER_TOKEN is required in .env");
  process.exit(1);
}
const baseUrl = process.env.BASE_URL ?? "https://perps-api.vooi.io";
client.setConfig({ baseUrl, auth: () => token });

const { data: markets, error, response } = await exchangeControllerGetMarkets({});
if (error || !markets) {
  console.error(`GET /exchange/markets failed (HTTP ${response?.status ?? "?"}):`, JSON.stringify(error ?? "no data"));
  process.exit(1);
}

const filter = process.argv[2]?.toLowerCase();

if (filter) {
  const hits = markets.filter(
    (m) => m.baseSymbol.toLowerCase().includes(filter) || String(m.id).toLowerCase().includes(filter),
  );
  console.log(`Markets matching "${filter}" (${hits.length}):\n`);
  for (const m of hits) {
    console.log(
      `  ${m.exchange.padEnd(12)} ${m.baseSymbol.padEnd(16)} id=${String(m.id).padEnd(10)} ${m.open ? "open  " : "CLOSED"} price=${m.price} maxLev=${m.maxLeverage}`,
    );
  }
  if (hits.length === 0) console.log("  (nothing — try a shorter fragment)");
  process.exit(0);
}

const byExchange = new Map<string, typeof markets>();
for (const m of markets) {
  if (!byExchange.has(m.exchange)) byExchange.set(m.exchange, []);
  byExchange.get(m.exchange)!.push(m);
}

console.log(`Venues available to this account via ${baseUrl}:\n`);
for (const [exchange, list] of [...byExchange.entries()].sort()) {
  const open = list.filter((m) => m.open).length;
  console.log(`  ${exchange}: ${list.length} markets (${open} open)`);
  const prefixes = new Map<string, number>();
  for (const m of list) {
    const colon = m.baseSymbol.indexOf(":");
    if (colon > 0) {
      const p = m.baseSymbol.slice(0, colon);
      prefixes.set(p, (prefixes.get(p) ?? 0) + 1);
    }
  }
  for (const [p, n] of [...prefixes.entries()].sort()) {
    console.log(`    builder prefix "${p}:" — ${n} markets (use ${exchange}:${p} as the venue name)`);
  }
}
console.log(`\nTip: \`bun run markets <fragment>\` searches symbols, e.g. \`bun run markets spcx\`.`);
