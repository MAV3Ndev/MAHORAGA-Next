import { describe, expect, it } from "vitest";
import type { ResearchResult, Signal } from "../../../core/types";
import { DEFAULT_CONFIG } from "../config";
import { evaluateEntryQuality } from "./entry-quality";

const research: ResearchResult = {
  symbol: "NVDA",
  verdict: "BUY",
  confidence: 0.75,
  entry_quality: "good",
  reasoning: "Constructive setup.",
  red_flags: [],
  catalysts: ["Confirmed earnings catalyst"],
  timestamp: Date.now(),
};

function signal(source: string): Signal {
  return {
    symbol: "NVDA",
    source,
    source_detail: source,
    sentiment: 0.7,
    raw_sentiment: 0.6,
    volume: 20,
    freshness: 1,
    source_weight: 0.8,
    reason: "Bullish",
    timestamp: Date.now(),
  };
}

describe("evaluateEntryQuality", () => {
  const technical = { current_price: 210, sma_20: 205, sma_50: 195, rsi: 55 };
  const momentum = { price_change_1h: 0.8, price_change_24h: 3 };

  it("accepts a catalyst-backed uptrend with enough independent evidence", () => {
    const result = evaluateEntryQuality(
      research,
      [signal("stocktwits"), signal("alpha_vantage")],
      technical,
      momentum,
      DEFAULT_CONFIG
    );

    expect(result.allowed).toBe(true);
    expect(result.evidence.sourceCount).toBe(2);
    expect(result.evidence.marketEvidenceSourceCount).toBe(1);
    expect(result.evidence.trendConfirmed).toBe(true);
    expect(result.evidence.evidenceAxes).toBe(4);
  });

  it("rejects social-only candidates", () => {
    const result = evaluateEntryQuality(
      { ...research, catalysts: [] },
      [signal("stocktwits")],
      { current_price: 210 },
      undefined,
      DEFAULT_CONFIG
    );

    expect(result).toMatchObject({ allowed: false, reason: "social_only" });
  });

  it("rejects candidates without a concrete catalyst", () => {
    const result = evaluateEntryQuality(
      { ...research, catalysts: [] },
      [signal("stocktwits"), signal("alpha_vantage")],
      technical,
      momentum,
      DEFAULT_CONFIG
    );

    expect(result).toMatchObject({ allowed: false, reason: "missing_catalyst" });
  });

  it("rejects downtrends and excessive moves", () => {
    const signals = [signal("stocktwits"), signal("alpha_vantage")];
    expect(
      evaluateEntryQuality(research, signals, { ...technical, sma_20: 190 }, momentum, DEFAULT_CONFIG)
    ).toMatchObject({ allowed: false, reason: "trend_confirmation_missing" });
    expect(
      evaluateEntryQuality(research, signals, technical, { ...momentum, price_change_24h: 9 }, DEFAULT_CONFIG)
    ).toMatchObject({ allowed: false, reason: "excessive_24h_move" });
  });
});
