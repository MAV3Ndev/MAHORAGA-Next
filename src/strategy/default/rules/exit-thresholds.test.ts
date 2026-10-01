import { describe, expect, it } from "vitest";
import { getEffectiveStopLossPct, getEffectiveTakeProfitPct } from "./exit-thresholds";

describe("getEffectiveStopLossPct", () => {
  it("falls back to the configured stop without a recommendation", () => {
    expect(getEffectiveStopLossPct(undefined, 4)).toBe(4);
    expect(getEffectiveStopLossPct(null, 4)).toBe(4);
    expect(getEffectiveStopLossPct(0, 4)).toBe(4);
    expect(getEffectiveStopLossPct(-3, 4)).toBe(4);
    expect(getEffectiveStopLossPct(Number.NaN, 4)).toBe(4);
  });

  it("accepts a recommendation inside the band", () => {
    expect(getEffectiveStopLossPct(6, 4)).toBe(6);
    expect(getEffectiveStopLossPct(3, 4)).toBe(3);
  });

  it("clamps both tighter and wider recommendations", () => {
    // can widen up to 2x config (fixes the old tighten-only min() asymmetry)
    expect(getEffectiveStopLossPct(12, 4)).toBe(8);
    // can tighten to 0.5x config
    expect(getEffectiveStopLossPct(1, 4)).toBe(2);
  });

  it("applies an ATR floor so volatile symbols are not given a noise stop", () => {
    // price 100, atr 3 -> 1.5*3/100 = 4.5% floor, wider than the 4% config
    expect(getEffectiveStopLossPct(undefined, 4, 3, 100)).toBeCloseTo(4.5);
    // ATR floor caps at the max band (2x config = 8%)
    expect(getEffectiveStopLossPct(undefined, 4, 10, 100)).toBe(8);
    // low-vol symbol: ATR floor is below configured stop, so config wins
    expect(getEffectiveStopLossPct(undefined, 4, 1, 100)).toBe(4);
  });
});

describe("getEffectiveTakeProfitPct", () => {
  it("falls back to the configured target without a recommendation", () => {
    expect(getEffectiveTakeProfitPct(undefined, 10)).toBe(10);
    expect(getEffectiveTakeProfitPct(null, 10)).toBe(10);
    expect(getEffectiveTakeProfitPct(0, 10)).toBe(10);
  });

  it("clamps recommendations to [0.5x, 3x] config", () => {
    expect(getEffectiveTakeProfitPct(15, 10)).toBe(15);
    expect(getEffectiveTakeProfitPct(80, 10)).toBe(30);
    expect(getEffectiveTakeProfitPct(1, 10)).toBe(5);
  });
});
