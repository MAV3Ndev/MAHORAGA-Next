import { describe, expect, it } from "vitest";
import type { Bar } from "../providers/types";
import { computeForwardReturns, extractDecisionFeatures, parseJevDistribution } from "./outcome-labeler";

function bar(day: string, close: number): Bar {
  return { t: `${day}T05:00:00Z`, o: close, h: close, l: close, c: close, v: 1000, n: 10, vw: close };
}

const BARS: Bar[] = [
  bar("2025-01-06", 100), // Mon
  bar("2025-01-07", 110), // Tue
  bar("2025-01-08", 121), // Wed
  bar("2025-01-09", 115),
  bar("2025-01-10", 120),
  bar("2025-01-13", 132),
  bar("2025-01-14", 140),
  bar("2025-01-15", 130),
  bar("2025-01-16", 125),
  bar("2025-01-17", 128),
];

describe("computeForwardReturns", () => {
  it("uses the decision-day bar close as baseline", () => {
    const r = computeForwardReturns(BARS, "2025-01-07T15:00:00Z", null);
    expect(r?.baseline_price).toBe(110);
    expect(r?.baseline_at).toBe("2025-01-07T05:00:00Z");
    expect(r?.t1_return).toBeCloseTo((121 - 110) / 110);
    expect(r?.t5_return).toBeCloseTo((140 - 110) / 110);
    expect(r?.t20_return).toBeNull();
  });

  it("prefers the recorded decision price as baseline", () => {
    const r = computeForwardReturns(BARS, "2025-01-07T15:00:00Z", 105);
    expect(r?.baseline_price).toBe(105);
    expect(r?.t1_return).toBeCloseTo((121 - 105) / 105);
  });

  it("returns null when no bar precedes the decision", () => {
    expect(computeForwardReturns(BARS, "2025-01-05T12:00:00Z", null)).toBeNull();
    expect(computeForwardReturns([], "2025-01-07T15:00:00Z", null)).toBeNull();
    expect(computeForwardReturns(BARS, "not-a-date", null)).toBeNull();
  });

  it("handles unsorted bars and weekend decisions", () => {
    const shuffled = [...BARS].reverse();
    const r = computeForwardReturns(shuffled, "2025-01-11T12:00:00Z", null); // Saturday
    expect(r?.baseline_price).toBe(120); // Friday close
    expect(r?.t1_return).toBeCloseTo((132 - 120) / 120); // Monday
  });
});

describe("parseJevDistribution", () => {
  it("parses jev distribution strings", () => {
    expect(parseJevDistribution("jev: BUY=0.72 SELL=0.08 HOLD=0.20 (confidence 0.72)")).toEqual({
      BUY: 0.72,
      SELL: 0.08,
      HOLD: 0.2,
    });
    expect(parseJevDistribution("some free text")).toBeNull();
    expect(parseJevDistribution(null)).toBeNull();
  });
});

describe("extractDecisionFeatures", () => {
  it("extracts gate_reason from metadata", () => {
    const f = extractDecisionFeatures(
      { action: "BUY", status: "blocked", metadata_json: JSON.stringify({ reason: "max_positions" }) },
      null
    );
    expect(f.gate_reason).toBe("max_positions");
  });

  it("extracts features from a snapshot", () => {
    const snapshot = {
      engine: "jev",
      signals: [
        { sentiment: 0.6, volume: 10, source_detail: "stocktwits" },
        { sentiment: 0.2, volume: 5, source_detail: "reddit_stocks" },
      ],
      social_snapshot: { volume: 15, sentiment: 0.45 },
      social_zscore: { volume_z: 2.1, sentiment_z: 1.3 },
      signal_research: { confidence: 0.8, entry_quality: "good", sentiment: 0.5 },
      recommendation: { action: "BUY", confidence: 0.72, reasoning: "jev: BUY=0.72 SELL=0.08 HOLD=0.20" },
      prompt_inputs: { sentiment: 0.5, price: 123.4 },
      technicals: { rsi: 47, relative_volume: 1.8, atr: 2.2 },
      momentum: { price_change_1h: 0.5, price_change_24h: -1.2 },
    };
    const f = extractDecisionFeatures({ action: "BUY", status: "submitted" }, snapshot);
    expect(f.analyst_engine).toBe("jev");
    expect(f.signal_count).toBe(2);
    expect(f.signal_sentiment).toBeCloseTo(0.4);
    expect(f.signal_volume).toBe(15);
    expect(f.sources_count).toBe(2);
    expect(f.social_volume).toBe(15);
    expect(f.social_sentiment).toBeCloseTo(0.45);
    expect(f.social_volume_z).toBeCloseTo(2.1);
    expect(f.research_confidence).toBe(0.8);
    expect(f.entry_quality_score).toBe(3);
    expect(f.analyst_confidence).toBe(0.72);
    expect(f.jev_prob_action).toBeCloseTo(0.72);
    expect(f.prompt_sentiment).toBe(0.5);
    expect(f.rsi).toBe(47);
    expect(f.rel_volume).toBe(1.8);
    expect(f.mom_24h).toBe(-1.2);
  });

  it("parses jev probability for a SELL action from row reason", () => {
    const f = extractDecisionFeatures(
      { action: "SELL", status: "submitted", reason: "jev: BUY=0.10 SELL=0.65 HOLD=0.25" },
      null
    );
    expect(f.jev_prob_action).toBeCloseTo(0.65);
  });
});
