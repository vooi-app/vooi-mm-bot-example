/**
 * Read-only preflight: validates the .env config against the live API without
 * placing any orders. Run with `bun run check` before starting the bot.
 *
 * Checks: token works, exchanges are reachable, both legs resolve to an open
 * market, accounts are funded.
 */

import { client } from "./src/client/client.gen";
import { exchangeControllerGetAccounts, exchangeControllerGetMarkets } from "./src/client/sdk.gen";
import { ALIAS, BASE_URL, BEARER_TOKEN, EXCHANGES, LEGS } from "./src/config";
import { assetFor, resolveMarket } from "./src/markets";

client.setConfig({ baseUrl: BASE_URL, headers: { Authorization: `Bearer ${BEARER_TOKEN}` } });

let failed = false;

function fail(msg: string): void {
  failed = true;
  console.error(`  ✗ ${msg}`);
}

console.log(`Preflight against ${BASE_URL}`);
console.log(
  `Venues: ${LEGS.map((l) => (l.name === l.exchange ? l.name : `${l.name}→${l.exchange}`)).join(", ")} | alias: ${ALIAS || "-"}\n`,
);

const { data: allMarkets, error: marketsErr, response: marketsRes } = await exchangeControllerGetMarkets({
  query: { exchanges: EXCHANGES },
} as never);

if (marketsErr || !allMarkets) {
  fail(
    `GET /exchange/markets failed (HTTP ${marketsRes?.status ?? "?"}): ${JSON.stringify(marketsErr ?? "no data")}`,
  );
  console.error(
    "    → check BEARER_TOKEN, and that every exchange name is supported by the API and enabled for your account",
  );
  process.exit(1);
}
console.log(`  ✓ markets: ${allMarkets.length} returned`);

for (const leg of LEGS) {
  try {
    const market = resolveMarket(allMarkets, leg, ALIAS);
    console.log(
      `  ✓ ${leg.role} (${leg.name}): ${market.baseSymbol}/${market.quoteSymbol} id=${market.id} asset=${assetFor(leg.exchange, market)} price=${market.price} maxLev=${market.maxLeverage}`,
    );
  } catch (e) {
    fail(`${leg.role} (${leg.name}): ${(e as Error).message}`);
  }
}

const { data: accounts, error: accErr } = await exchangeControllerGetAccounts({
  query: { exchanges: EXCHANGES },
} as never);

if (accErr || !accounts) {
  fail(`GET /exchange/accounts failed: ${JSON.stringify(accErr ?? "no data")}`);
} else {
  for (const leg of LEGS) {
    const acc = accounts.find((a) => a.exchange === leg.exchange);
    if (!acc) {
      fail(`${leg.exchange}: no account returned — is this exchange connected to your VOOI account?`);
    } else {
      const ok = Number(acc.availableMargin) > 0;
      console.log(
        `  ${ok ? "✓" : "✗"} ${leg.exchange} account: availableMargin=${acc.availableMargin} totalBalance=${acc.totalBalance}`,
      );
      if (!ok) failed = true;
    }
  }
}

console.log(failed ? "\nPreflight FAILED — fix the items above before starting the bot." : "\nPreflight OK — ready to run `bun start`.");
process.exit(failed ? 1 : 0);
