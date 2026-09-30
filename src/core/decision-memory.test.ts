import { describe, expect, it } from "vitest";
import { aggregateSymbolTrackRecords, type DecisionMemory, formatDecisionMemoryBlock } from "./decision-memory";
import type { OutcomeSample } from "./indicator-stats";

function sample(over: Partial<OutcomeSample>): OutcomeSample {
  return {
    decision_id: "d1",
    symbol: "AAA",
    decision_at: "2026-09-20T14:00:00Z",
    source: "analyst_recommendation",
    action: "BUY",
    status: "submitted",
    confidence: 0.7,
    t1_return: null,
    t5_return: null,
    t20_return: null,
    features: {},
    ...over,
  };
}

describe("aggregateSymbolTrackRecords", () => {
  it("direction-adjusts returns for SELL rows", () => {
    const records = aggregateSymbolTrackRecords([
      sample({ symbol: "AAA", action: "BUY", t1_return: 0.02, t5_return: 0.1 }),
      sample({ symbol: "AAA", action: "BUY", t1_return: 0.04, t5_return: 0.2 }),
      sample({ symbol: "BBB", action: "SELL", t1_return: -0.03, t5_return: -0.08 }),
    ]);
    expect(records.AAA?.evaluations).toBe(2);
    expect(records.AAA?.avg_t1).toBeCloseTo(0.03);
    // SELL with price falling -3% is a +3% outcome for the decision
    expect(records.BBB?.avg_t1).toBeCloseTo(0.03);
    expect(records.BBB?.avg_t5).toBeCloseTo(0.08);
  });

  it("ignores non-directional rows and tracks recency", () => {
    const records = aggregateSymbolTrackRecords([
      sample({ symbol: "AAA", action: "WAIT" }),
      sample({ symbol: "AAA", action: "BUY", decision_at: "2026-09-21T14:00:00Z", t1_return: 0.01 }),
      sample({ symbol: "AAA", action: "BUY", decision_at: "2026-09-22T14:00:00Z", t1_return: -0.01 }),
    ]);
    expect(records.AAA?.evaluations).toBe(2);
    expect(records.AAA?.win_rate_t1).toBeCloseTo(0.5);
    expect(records.AAA?.last_decision_at).toBe("2026-09-22T14:00:00Z");
  });
});

describe("formatDecisionMemoryBlock", () => {
  const memory: DecisionMemory = {
    generated_at: "2026-09-24T00:00:00Z",
    window_days: 90,
    closed_trades: {
      count: 7,
      wins: 1,
      losses: 6,
      win_rate: 1 / 7,
      avg_pnl_pct: -1.7,
      recent: [
        { symbol: "VKTX", pnl_pct: -4.5, reason: "Stop loss triggered", at: "x" },
        { symbol: "GOOGL", pnl_pct: 0.1, reason: "Trailing stop", at: "y" },
      ],
    },
    symbols: {
      GOOGL: {
        evaluations: 12,
        buys: 12,
        sells: 0,
        avg_t1: 0.014,
        avg_t5: 0.093,
        win_rate_t1: 0.92,
        last_action: "BUY",
        last_decision_at: "z",
      },
    },
    gate_lessons: [
      { gate: "insufficient_evidence", action: "BUY", n: 13, mean_t1: -0.074, mean_t5: null, win_rate_t1: 0 },
    ],
    feature_lessons: [{ feature: "mom_24h", horizon: "t1_return", ic: 0.45, n: 40 }],
  };

  it("renders all sections with sample sizes", () => {
    const block = formatDecisionMemoryBlock(memory);
    expect(block).toContain("LEARNED CONTEXT");
    expect(block).toContain("7 exits");
    expect(block).toContain("VKTX -4.5%");
    expect(block).toContain("GOOGL: 12 evals");
    expect(block).toContain("mom_24h: IC +0.45");
    expect(block).toContain("insufficient_evidence BUY: n=13");
  });

  it("renders a usable block even when empty", () => {
    const empty: DecisionMemory = {
      generated_at: "x",
      window_days: 90,
      closed_trades: { count: 0, wins: 0, losses: 0, win_rate: 0, avg_pnl_pct: null, recent: [] },
      symbols: {},
      gate_lessons: [],
      feature_lessons: [],
    };
    const block = formatDecisionMemoryBlock(empty);
    expect(block).toContain("LEARNED CONTEXT");
    expect(block).not.toContain("Recent closed trades");
  });
});
