import { describe, expect, it } from "vitest";
import type { Account } from "../../../core/types";
import type { StrategyContext } from "../../types";
import { analyzeSignalsPrompt } from "./analyst";

describe("analyzeSignalsPrompt", () => {
  it("includes market context freshness and clarifies confidence semantics", () => {
    const now = Date.now();
    const values: Record<string, unknown> = {
      technicalDataCache: {
        AAPL: {
          updated_at: now - 20 * 60_000,
          current_price: 190,
          rsi: 62,
          sma_20: 185,
          sma_50: 180,
          atr: 4,
          relative_volume: 1.4,
          daily_bars: 20,
          hourly_bars: 2,
        },
      },
      momentumDataCache: { AAPL: { updated_at: now - 20 * 60_000, price_change_1h: 0.5, price_change_24h: 2.1 } },
      marketRegimeCache: { spyPrice: 500, spySma20: 498, spySma50: 495 },
    };
    const ctx = {
      config: {
        min_sentiment_score: 0.3,
        crypto_symbols: [],
        max_positions: 10,
        max_position_value: 10_000,
        take_profit_pct: 10,
        stop_loss_pct: 5,
        min_analyst_confidence: 0.55,
        llm_min_hold_minutes: 30,
        llm_analyst_model: "test-model",
      },
      positionEntries: {},
      state: { get: (key: string) => values[key] },
    } as unknown as StrategyContext;
    const account = { equity: 100_000, cash: 50_000, buying_power: 100_000 } as Account;
    const prompt = analyzeSignalsPrompt(
      [
        {
          symbol: "AAPL",
          source: "reddit_stocks",
          source_detail: "post",
          sentiment: 0.8,
          raw_sentiment: 0.8,
          volume: 10,
          freshness: 1,
          source_weight: 1,
          reason: "positive catalyst",
          timestamp: now,
        },
      ],
      [],
      account,
      ctx
    );

    expect(prompt.user).toContain("AAPL: cache stale");
    expect(prompt.user).toContain("limited history (20 daily bars)");
    expect(prompt.user).toContain("vs SMA20 2.70%");
    expect(prompt.user).toContain("Broad market trend: SPY");
    expect(prompt.user).toContain("Confidence means confidence in the action choice");
    expect(prompt.system).toContain("Action confidence is not expected return");
  });
});
