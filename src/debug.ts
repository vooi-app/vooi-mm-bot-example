import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { BASE_URL, EXCHANGES } from "./config";

/** Append-only JSON lines: full request/response on API errors (default next to the project root). */
const API_ERROR_DEBUG_LOG = process.env.API_ERROR_DEBUG_LOG?.trim()?.startsWith("/")
  ? process.env.API_ERROR_DEBUG_LOG.trim()
  : join(import.meta.dir, "..", process.env.API_ERROR_DEBUG_LOG?.trim() ?? "api-error-debug.jsonl");

export function apiBaseUrl(): string {
  return BASE_URL.replace(/\/$/, "");
}

export function buildAccountsDebugUrl(): string {
  const p = new URLSearchParams();
  for (const ex of EXCHANGES) p.append("exchanges", ex);
  return `${apiBaseUrl()}/exchange/accounts?${p.toString()}`;
}

export function buildMarketSettingsDebugUrl(exchange: string, asset: string): string {
  const u = new URL(`${apiBaseUrl()}/exchange/market-settings`);
  u.searchParams.set("exchange", exchange);
  u.searchParams.set("asset", asset);
  return u.toString();
}

function traceHeadersLine(response: Response | undefined): string {
  if (!response) return "";
  const keys = ["x-request-id", "cf-ray", "x-trace-id", "traceparent"] as const;
  const parts: string[] = [];
  for (const k of keys) {
    const v = response.headers.get(k);
    if (v) parts.push(`${k}=${v}`);
  }
  return parts.length ? ` ${parts.join(" ")}` : "";
}

export function logApiErr(scope: string, err: unknown, response?: Response): void {
  const detail = err !== null && typeof err === "object" ? JSON.stringify(err) : String(err);
  console.error(`[api] ${scope}:${traceHeadersLine(response)} ${detail}`);
}

function serializeErr(err: unknown): string | null {
  if (err === undefined || err === null) return null;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function redactResponseHeaders(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    const lk = k.toLowerCase();
    out[k] = lk === "authorization" || lk === "cookie" ? "***" : v;
  });
  return out;
}

/**
 * Persist one line of JSON to `API_ERROR_DEBUG_LOG` + stderr (pretty), for debugging.
 * Pass `responseBodyText` when the body was already consumed (e.g. prior `response.text()`).
 */
export async function dumpApiErrorDebug(
  context: string,
  input: {
    method: string;
    url: string;
    requestHeaders?: Record<string, string>;
    requestBody?: unknown;
    err?: unknown;
    response?: Response;
    responseBodyText?: string;
  },
): Promise<void> {
  let bodyText = input.responseBodyText ?? "";
  if (!bodyText && input.response) {
    try {
      bodyText = await input.response.clone().text();
    } catch {
      bodyText = "<failed to read response body>";
    }
  }
  const snapshot = {
    ts: new Date().toISOString(),
    context,
    request: {
      method: input.method,
      url: input.url,
      headers: input.requestHeaders ?? { "Content-Type": "application/json", Authorization: "Bearer ***" },
      body: input.requestBody ?? null,
    },
    response: {
      status: input.response?.status ?? 0,
      headers: input.response ? redactResponseHeaders(input.response) : {},
      bodyText: bodyText.slice(0, 500_000),
    },
    err: serializeErr(input.err),
  };
  console.error(`[api-error-debug] ${context}\n${JSON.stringify(snapshot, null, 2)}`);
  try {
    appendFileSync(API_ERROR_DEBUG_LOG, `${JSON.stringify(snapshot)}\n`, "utf8");
  } catch (e) {
    console.error("[api-error-debug] append failed:", e);
  }
}

export function debugLogPath(): string {
  return API_ERROR_DEBUG_LOG;
}
