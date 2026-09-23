import { describe, expect, it } from "vitest";
import {
  buildIndicatorReport,
  calibrationBuckets,
  type OutcomeSample,
  pearsonCorrelation,
  quantileBuckets,
  rankValues,
  spearmanIC,
} from "./indicator-stats";

function sample(overrides: Partial<OutcomeSample>): OutcomeSample {
  return {
    decision_id: "d1",
    symbol: "AAPL",
    decision_at: "2025-01-10T15:00:00Z",
    source: "analyst_recommendation",
    action: "BUY",
    status: "submitted",
    confidence: 0.7,
    t1_return: 0.01,
    t5_return: 0.02,
    t20_return: null,
    features: {},
    ...overrides,
  };
}

describe("rankValues", () => {
  it("assigns average ranks for ties", () => {
    expect(rankValues([10, 20, 20, 40])).toEqual([1, 2.5, 2.5, 4]);
    expect(rankValues([5, 1, 3])).toEqual([3, 1, 2]);
  });
});

describe("pearsonCorrelation", () => {
  it("computes correlation", () => {
    expect(pearsonCorrelation([1, 2, 3], [2, 4, 6])).toBeCloseTo(1);
    expect(pearsonCorrelation([1, 2, 3], [6, 4, 2])).toBeCloseTo(-1);
    expect(pearsonCorrelation([1, 1, 1], [1, 2, 3])).toBe(0);
  });
});

describe("spearmanIC", () => {
  it("is 1 for perfectly monotonic data", () => {
    const pairs = [1, 2, 3, 4, 5].map((i) => ({ feature: i * 10, ret: i }));
    expect(spearmanIC(pairs)).toBeCloseTo(1);
  });

  it("is negative for inverted ranking", () => {
    const pairs = [1, 2, 3, 4, 5].map((i) => ({ feature: i, ret: 6 - i }));
    expect(spearmanIC(pairs)).toBeCloseTo(-1);
  });

  it("ignores non-finite pairs and needs >= 3 samples", () => {
    expect(
      spearmanIC([
        { feature: 1, ret: 1 },
        { feature: 2, ret: 2 },
      ])
    ).toBe(0);
    expect(
      spearmanIC([
        { feature: 1, ret: 1 },
        { feature: Number.NaN, ret: 5 },
        { feature: 2, ret: 2 },
        { feature: 3, ret: 3 },
      ])
    ).toBeCloseTo(1);
  });
});

describe("quantileBuckets", () => {
  it("splits sorted pairs into equal buckets with stats", () => {
    const pairs = Array.from({ length: 50 }, (_, i) => ({ feature: i, ret: i / 100 }));
    const buckets = quantileBuckets(pairs, 5);
    expect(buckets).toHaveLength(5);
    expect(buckets[0]!.n).toBe(10);
    expect(buckets[0]!.mean_return).toBeCloseTo(0.045);
    expect(buckets[4]!.mean_return).toBeCloseTo(0.445);
    expect(buckets[0]!.feature_min).toBe(0);
    expect(buckets[0]!.win_rate).toBe(0.9); // ret=0 is not a win
  });

  it("returns [] for insufficient samples", () => {
    expect(quantileBuckets([{ feature: 1, ret: 1 }], 5)).toEqual([]);
  });
});

describe("calibrationBuckets", () => {
  it("groups into fixed confidence bands", () => {
    const pairs = [
      { confidence: 0.1, ret: -0.02 },
      { confidence: 0.15, ret: -0.01 },
      { confidence: 0.9, ret: 0.05 },
      { confidence: 0.95, ret: 0.07 },
    ];
    const buckets = calibrationBuckets(pairs, 5);
    expect(buckets).toHaveLength(5);
    expect(buckets[0]!.n).toBe(2);
    expect(buckets[0]!.mean_return).toBeCloseTo(-0.015);
    expect(buckets[0]!.win_rate).toBe(0);
    expect(buckets[4]!.n).toBe(2);
    expect(buckets[4]!.win_rate).toBe(1);
  });
});

describe("buildIndicatorReport", () => {
  it("computes direction-adjusted IC for BUY and SELL", () => {
    // 40 decisions: feature increases; BUY returns rise with feature, SELL
    // returns fall (so direction-adjusted return rises for both).
    const samples: OutcomeSample[] = Array.from({ length: 40 }, (_, i) =>
      sample({
        decision_id: `b${i}`,
        action: i % 2 === 0 ? "BUY" : "SELL",
        confidence: i / 40,
        t1_return: i % 2 === 0 ? i / 100 : -i / 100,
        t5_return: i % 2 === 0 ? i / 100 : -i / 100,
      })
    );
    const report = buildIndicatorReport(samples, { days: 90, now: new Date("2025-02-01") });
    const confIc = report.ic.find((r) => r.feature === "confidence" && r.horizon === "t1_return");
    expect(confIc).toBeDefined();
    expect(confIc?.n).toBe(40);
    expect(confIc?.ic).toBeGreaterThan(0.9);
    expect(confIc?.sufficient_sample).toBe(true);
  });

  it("groups blocked/filtered decisions by gate_reason", () => {
    const samples = [
      sample({ decision_id: "g1", status: "blocked", t1_return: 0.03, features: { gate_reason: "max_positions" } }),
      sample({ decision_id: "g2", status: "blocked", t1_return: 0.04, features: { gate_reason: "max_positions" } }),
      sample({
        decision_id: "g3",
        status: "filtered",
        t1_return: -0.02,
        features: { gate_reason: "below_min_confidence" },
      }),
      sample({ decision_id: "g4", status: "submitted", t1_return: 0.01 }),
    ];
    const report = buildIndicatorReport(samples, { days: 90 });
    expect(report.gates).toHaveLength(2);
    const maxPos = report.gates.find((g) => g.gate === "max_positions");
    expect(maxPos?.n).toBe(2);
    expect(maxPos?.mean_t1).toBeCloseTo(0.035);
    expect(maxPos?.win_rate_t1).toBe(1);
    const belowConf = report.gates.find((g) => g.gate === "below_min_confidence");
    expect(belowConf?.mean_t1).toBeCloseTo(-0.02);
  });

  it("builds per-source stats and calibration per engine", () => {
    const samples = Array.from({ length: 40 }, (_, i) =>
      sample({
        decision_id: `s${i}`,
        source: i % 2 === 0 ? "strategy_entry" : "analyst_recommendation",
        confidence: i / 40,
        t1_return: i / 100 - 0.1,
        features: { analyst_engine: i % 2 === 0 ? "llm" : "jev" },
      })
    );
    const report = buildIndicatorReport(samples, { days: 90 });
    expect(report.by_source.map((s) => s.source).sort()).toEqual(["analyst_recommendation", "strategy_entry"]);
    const engines = report.calibration.map((c) => c.engine);
    expect(engines).toContain("jev");
    expect(engines).toContain("llm");
  });

  it("emits quantiles for t5 horizon when enough samples exist", () => {
    const samples = Array.from({ length: 60 }, (_, i) =>
      sample({ decision_id: `q${i}`, confidence: i / 60, t5_return: i / 1000 })
    );
    const report = buildIndicatorReport(samples, { days: 90 });
    const q = report.quantiles.find((r) => r.feature === "confidence" && r.horizon === "t5_return");
    expect(q).toBeDefined();
    expect(q?.buckets).toHaveLength(5);
    expect(q?.monotonicity).toBe(1);
  });
});
