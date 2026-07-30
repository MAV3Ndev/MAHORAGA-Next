import { describe, expect, it } from "vitest";
import { normalizeResearchAnalysis } from "./research-validation";

describe("research validation", () => {
  it("normalizes valid research analysis", () => {
    expect(
      normalizeResearchAnalysis(
        "QUBT",
        {
          verdict: " buy ",
          confidence: 0.72,
          entry_quality: " Good ",
          reasoning: "Risk/reward is actionable.",
          red_flags: [],
          catalysts: ["Confirmed catalyst"],
          recommended_entry_zone: "Pullback near support",
          stop_loss_pct: 8,
          take_profit_pct: 18,
        },
        { sentiment: 0.66 }
      )
    ).toMatchObject({
      symbol: "QUBT",
      verdict: "BUY",
      confidence: 0.72,
      entry_quality: "good",
      reasoning: "Risk/reward is actionable.",
      red_flags: [],
      catalysts: ["Confirmed catalyst"],
      sentiment: 0.66,
      recommended_entry_zone: "Pullback near support",
      stop_loss_pct: 8,
      take_profit_pct: 18,
    });
  });

  it("rejects truncated verdicts", () => {
    expect(() =>
      normalizeResearchAnalysis("QUBT", {
        verdict: "SK",
        confidence: 0.7,
        entry_quality: "fair",
        reasoning: "Incomplete verdict.",
        red_flags: [],
        catalysts: [],
      })
    ).toThrow("Invalid research verdict");
  });

  it("rejects missing reasoning", () => {
    expect(() =>
      normalizeResearchAnalysis("QUBT", {
        verdict: "SKIP",
        confidence: 0.7,
        entry_quality: "fair",
        reasoning: "",
        red_flags: [],
        catalysts: [],
      })
    ).toThrow("Invalid research reasoning");
  });
});
