import type { GetMarketsDto } from "./client/types.gen";
import type { LegConfig } from "./config";

/**
 * Resolve the market a leg trades on.
 *
 * Priority: explicit MARKET_ID > explicit SYMBOL > ALIAS.
 *
 * When the leg targets a HIP-3 builder venue (marketPrefix set, e.g. `km` for
 * Kinetiq or `xyz` for trade.xyz), only markets whose baseSymbol starts with
 * `<prefix>:` are considered, and alias `SPCX` resolves to `<prefix>:SPCX`.
 * Without a prefix, ALIAS matches the baseSymbol exactly (case-insensitive) or
 * as a `deployer:ALIAS` suffix (so alias `SPCX` finds `xyz:SPCX` on Hyperliquid).
 */
export function resolveMarket(
  allMarkets: GetMarketsDto[],
  leg: LegConfig,
  alias: string,
): GetMarketsDto {
  const prefix = leg.marketPrefix?.toLowerCase() ?? null;
  const onVenue = allMarkets.filter((m) => {
    if (m.exchange !== leg.exchange) return false;
    return prefix ? m.baseSymbol.toLowerCase().startsWith(`${prefix}:`) : true;
  });
  if (onVenue.length === 0) {
    throw new Error(
      prefix
        ? `No "${prefix}:*" markets found on ${leg.exchange} for venue "${leg.name}". ` +
          `Check the builder prefix and that your account has access to ${leg.exchange}.`
        : `No markets returned for exchange "${leg.name}". ` +
          `Check that the exchange name is valid and your account has access to it.`,
    );
  }

  if (leg.marketId) {
    const market = onVenue.find((m) => String(m.id) === leg.marketId);
    if (!market) throw new Error(`Market id=${leg.marketId} not found on ${leg.name}`);
    if (!market.open) throw new Error(`Market id=${leg.marketId} on ${leg.name} is closed`);
    return market;
  }

  if (leg.symbol) {
    const symbol = leg.symbol.toLowerCase();
    const candidates = onVenue.filter((m) => {
      if (!m.open) return false;
      const base = m.baseSymbol.toLowerCase();
      // A prefixed venue accepts the symbol with or without its prefix (SPCX ≡ km:SPCX).
      return base === symbol || (prefix !== null && base === `${prefix}:${symbol}`);
    });
    if (candidates.length === 0) {
      throw new Error(`Symbol "${leg.symbol}" not found or closed on ${leg.name}`);
    }
    if (candidates.length > 1) {
      const ids = candidates.map((m) => m.id).join(", ");
      throw new Error(
        `Symbol "${leg.symbol}" is ambiguous on ${leg.name} (ids: ${ids}); set ${leg.role.toUpperCase()}_MARKET_ID`,
      );
    }
    return candidates[0]!;
  }

  const a = alias.toLowerCase();
  const candidates = onVenue.filter((m) => {
    if (!m.open) return false;
    const base = m.baseSymbol.toLowerCase();
    if (prefix !== null) return base === `${prefix}:${a}`;
    return base === a || base.endsWith(`:${a}`);
  });
  if (candidates.length === 0) {
    throw new Error(
      `Alias "${alias}" matches no open market on ${leg.name}; ` +
        `set ${leg.role.toUpperCase()}_SYMBOL explicitly`,
    );
  }
  if (candidates.length > 1) {
    const names = candidates.map((m) => `${m.baseSymbol} (id=${m.id})`).join(", ");
    throw new Error(
      `Alias "${alias}" is ambiguous on ${leg.name}: ${names}; ` +
        `set ${leg.role.toUpperCase()}_SYMBOL or ${leg.role.toUpperCase()}_MARKET_ID`,
    );
  }
  return candidates[0]!;
}

/**
 * The `asset` field used in order/leverage requests. Aster expects the market id
 * (e.g. BTCUSDT); other exchanges expect the baseSymbol.
 */
export function assetFor(exchange: string, market: GetMarketsDto): string {
  return exchange === "aster" ? String(market.id) : market.baseSymbol;
}
