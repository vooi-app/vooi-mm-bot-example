import { EventEmitter } from "node:events";

import { exchangeControllerCreateUpdatesToken } from "./client/sdk.gen";
import type { GetAccountDtoOutput, GetOrdersDto, GetPositionsDto, GetTradesDto } from "./client/types.gen";

export interface SSEMarketPrice {
  exchange: string;
  marketId: string;
  price: string;
  updatedAt: string;
}

interface SSEEvents {
  marketPrice: [SSEMarketPrice[]];
  account: [GetAccountDtoOutput];
  order: [GetOrdersDto[]];
  position: [GetPositionsDto[]];
  trade: [GetTradesDto[]];
  connected: [];
  disconnected: [];
  error: [Error];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Server-sent-events stream of prices/orders/positions from `GET /exchange/updates`. */
export class ExchangeUpdates extends EventEmitter<SSEEvents> {
  private abortController: AbortController | null = null;
  private reconnectDelay = 1000;
  private shouldReconnect = true;
  private sseParseFailCount = 0;
  private sseParseFailStreak = 0;

  constructor(
    private baseUrl: string,
    private token: string,
    private exchanges?: string[],
  ) {
    super();
  }

  connect(): void {
    this.shouldReconnect = true;
    this.startStream();
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.abortController?.abort();
    this.abortController = null;
  }

  private async startStream(): Promise<void> {
    try {
      const { data } = await exchangeControllerCreateUpdatesToken();
      if (!data) throw new Error("Failed to get SSE token");

      this.abortController = new AbortController();

      const exchangeParams = this.exchanges?.map((e) => `exchanges=${e}`).join("&");
      const url = `${this.baseUrl}/exchange/updates?token=${data.token}${exchangeParams ? `&${exchangeParams}` : ""}`;
      const safeUrl = url.replace(/token=[^&]+/, "token=***");
      console.log(`[SSE] Connecting to ${safeUrl}`);

      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${this.token}` },
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`SSE connection failed: ${response.status}`);
      }

      this.reconnectDelay = 1000;
      this.emit("connected");

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop()!;

        let batchParseFails = 0;
        for (const frame of frames) {
          if (!this.parseFrame(frame)) batchParseFails++;
        }
        if (batchParseFails > 0) {
          const delayMs = Math.min(2000, 80 * 2 ** Math.min(batchParseFails - 1, 6));
          console.warn(
            `[SSE] parse backoff ${delayMs}ms after ${batchParseFails} bad frame(s); totalParseFails=${this.sseParseFailCount}`,
          );
          await sleep(delayMs);
        }
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      this.emit("error", err as Error);
    }

    this.emit("disconnected");

    if (this.shouldReconnect) {
      const delay = this.reconnectDelay;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
      console.log(`[SSE] Reconnecting in ${delay}ms...`);
      await sleep(delay);
      if (this.shouldReconnect) await this.startStream();
    }
  }

  private parseFrame(frame: string): boolean {
    let eventType = "";
    let dataStr = "";

    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataStr += line.slice(5).trim();
      }
    }

    if (!eventType || !dataStr) return true;

    try {
      const data = JSON.parse(dataStr);
      this.sseParseFailStreak = 0;
      if (eventType !== "marketPrice") {
        const summary = Array.isArray(data) ? `(${data.length} items)` : "";
        console.log(`[SSE] event: ${eventType} ${summary}`);
      }
      this.emit(eventType as keyof SSEEvents, data);
      return true;
    } catch {
      this.sseParseFailCount++;
      this.sseParseFailStreak++;
      const preview = dataStr.length > 240 ? `${dataStr.slice(0, 240)}…` : dataStr;
      console.error(
        `[SSE] Failed to parse "${eventType}" total=${this.sseParseFailCount} streak=${this.sseParseFailStreak}: ${preview}`,
      );
      return false;
    }
  }
}

export function waitForFirstPrice(updates: ExchangeUpdates, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      updates.off("marketPrice", handler);
      reject(new Error("Timeout waiting for first price"));
    }, timeoutMs);

    function handler(): void {
      clearTimeout(timeout);
      updates.off("marketPrice", handler);
      resolve();
    }

    updates.on("marketPrice", handler);
  });
}
