import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";

/** Append-only log next to the project root (`BOT_LOG`, default `bot.log`). Every console line gets an ISO timestamp. */
const BOT_LOG = process.env.BOT_LOG ?? "bot.log";
const LOG_PATH = join(import.meta.dir, "..", BOT_LOG);
/** Set `BOT_LOG_MIRROR=0` to stop echoing to the terminal (file only). */
const LOG_MIRROR = process.env.BOT_LOG_MIRROR !== "0";

const orig = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

function formatArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return a.stack ?? a.message;
      if (typeof a === "object" && a !== null) {
        try {
          return JSON.stringify(a);
        } catch {
          return inspect(a, { depth: 8, colors: false, breakLength: 200 });
        }
      }
      return String(a);
    })
    .join(" ");
}

function writeLine(level: string, args: unknown[]): void {
  const line = `${new Date().toISOString()} [${level}] ${formatArgs(args)}\n`;
  try {
    appendFileSync(LOG_PATH, line, "utf8");
  } catch (e) {
    orig.error("[log] append failed:", e);
  }
}

export function installLogger(): void {
  console.log = (...args: unknown[]) => {
    writeLine("INFO", args);
    if (LOG_MIRROR) orig.log(...args);
  };
  console.warn = (...args: unknown[]) => {
    writeLine("WARN", args);
    if (LOG_MIRROR) orig.warn(...args);
  };
  console.error = (...args: unknown[]) => {
    writeLine("ERROR", args);
    if (LOG_MIRROR) orig.error(...args);
  };
  writeLine("INFO", [`[init] file log → ${LOG_PATH} (BOT_LOG, BOT_LOG_MIRROR=${LOG_MIRROR})`]);
}
