import { describe, expect, it, vi } from "vitest";
import type { ResearchResult, Signal } from "../../core/types";
import type { Account, Position } from "../types";
import { analyzeSignalsWithJev, buildJevAnalystRequest, mapJevAnalystAnswers } from "./analyst";
import { type SystemOneResponse, TypeSafeClient } from "./client";

const NOW = 1_800_000_000_000;

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    symbol: "AAPL",
    source: "reddit_stocks",
    source_detail: "post",
    sentiment: 0.8,
    raw_sentiment: 0.8,
    volume: 10,
    freshness: 1,
    source_weight: 0.9,
    reason: "bullish post",
    timestamp: NOW,
    ...overrides,
  };
}

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: "acc",
    account_number: "1",
    status: "ACTIVE",
    currency: "USD",
    cash: 50_000,
    buying_power: 100_000,
    regt_buying_power: 100_000,
    daytrading_buying_power: 100_000,
    equity: 100_000,
    last_equity: 100_000,
    long_market_value: 0,
    short_market_value: 0,
    portfolio_value: 100_000,
    pattern_day_trader: false,
    trading_blocked: false,
    transfers_blocked: false,
    account_blocked: false,
    multiplier: "4",
    shorting_enabled: false,
    maintenance_margin: 0,
    initial_margin: 0,
    daytrade_count: 0,
    created_at: "2026-01-01",
    ...overrides,
  };
}

function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    asset_id: "a1",
    symbol: "TSLA",
    exchange: "NASDAQ",
    asset_class: "us_equity",
    avg_entry_price: 200,
    qty: 10,
    side: "long",
    market_value: 2100,
    cost_basis: 2000,
    unrealized_pl: 100,
    unrealized_plpc: 0.05,
    unrealized_intraday_pl: 20,
    unrealized_intraday_plpc: 0.01,
    current_price: 210,
    lastday_price: 205,
    change_today: 0.02,
    ...overrides,
  };
}

function makeResearch(overrides: Partial<ResearchResult> = {}): ResearchResult {
  return {
    symbol: "AAPL",
    verdict: "BUY",
    confidence: 0.85,
    entry_quality: "good",
    reasoning: "Strong catalyst and sentiment",
    red_flags: [],
    catalysts: ["earnings beat"],
    timestamp: NOW,
    ...overrides,
  };
}

const CONFIG = {
  min_sentiment_score: 0.3,
  max_positions: 20,
  max_position_value: 15_000,
  take_profit_pct: 10,
  stop_loss_pct: 5,
  llm_min_hold_minutes: 30,
};

describe("buildJevAnalystRequest", () => {
  it("aggregates signals into candidates with one choice and one size question each", () => {
    const { state, questions, candidates } = buildJevAnalystRequest({
      signals: [
        makeSignal({ symbol: "AAPL", sentiment: 0.9 }),
        makeSignal({ symbol: "AAPL", source: "stocktwits", sentiment: 0.7 }),
        makeSignal({ symbol: "TSLA", sentiment: 0.6 }),
        makeSignal({ symbol: "WEAK", sentiment: 0.05 }),
      ],
      positions: [makePosition({ symbol: "TSLA" })],
      account: makeAccount(),
      research: { AAPL: makeResearch() },
      positionEntries: {},
      config: CONFIG,
      now: NOW,
    });

    // WEAK filtered out (avgSentiment 0.05 < 0.3 * 0.5)
    expect(candidates.map((c) => c.symbol)).toEqual(["AAPL", "TSLA"]);
    expect(candidates[0]?.avgSentiment).toBeCloseTo(0.8);
    expect(candidates[1]?.held).toBe(true);

    expect(Object.keys(questions).sort()).toEqual(["action_0", "action_1", "size_0", "size_1"]);
    expect(questions.action_0?.type).toBe("choice");
    expect(questions.action_0?.instructions).toContain("AAPL");
    expect(questions.size_0?.type).toBe("score");
    expect(questions.size_0?.criteria).toHaveLength(3);

    const candidateState = (state.candidates as Array<{ symbol: string; research: unknown }>)[0];
    expect(candidateState?.symbol).toBe("AAPL");
    expect(candidateState?.research).toMatchObject({ verdict: "BUY", entry_quality: "good" });
  });

  it("marks candidates without research as null in state", () => {
    const { state } = buildJevAnalystRequest({
      signals: [makeSignal({ symbol: "MSFT" })],
      positions: [],
      account: makeAccount(),
      research: {},
      positionEntries: {},
      config: CONFIG,
      now: NOW,
    });

    const candidateState = (state.candidates as Array<{ symbol: string; research: unknown }>)[0];
    expect(candidateState?.research).toBeNull();
  });
});

describe("mapJevAnalystAnswers", () => {
  const candidates = [
    { symbol: "AAPL", avgSentiment: 0.8, sources: ["reddit_stocks"], count: 1, held: false },
    { symbol: "TSLA", avgSentiment: 0.6, sources: ["stocktwits"], count: 1, held: true },
  ];

  it("maps choice answers to recommendations with probabilities as confidence", () => {
    const result = mapJevAnalystAnswers(candidates, {
      action_0: {
        type: "choice",
        choice: "BUY",
        probabilities: { BUY: 0.72, SELL: 0.08, HOLD: 0.2 },
        confidence: 0.66,
      },
      size_0: {
        type: "score",
        score: 1.4,
        legend: { "0": "small", "1": "standard", "2": "large" },
        probabilities: { "0": 0.1, "1": 0.6, "2": 0.3 },
        confidence: 0.5,
      },
      action_1: {
        type: "choice",
        choice: "HOLD",
        probabilities: { BUY: 0.1, SELL: 0.3, HOLD: 0.6 },
        confidence: 0.5,
      },
    });

    expect(result.recommendations).toHaveLength(2);
    expect(result.recommendations[0]).toMatchObject({
      action: "BUY",
      symbol: "AAPL",
      confidence: 0.72,
      suggested_size_pct: 20, // round(1.4) → level 1 → 20%
    });
    expect(result.recommendations[1]).toMatchObject({
      action: "HOLD",
      symbol: "TSLA",
      confidence: 0.6,
    });
    expect(result.recommendations[1]?.suggested_size_pct).toBeUndefined();
    expect(result.market_summary).toContain("1 BUY");
  });

  it("flags high-conviction non-HOLD choices", () => {
    const result = mapJevAnalystAnswers(candidates, {
      action_0: {
        type: "choice",
        choice: "BUY",
        probabilities: { BUY: 0.85, SELL: 0.05, HOLD: 0.1 },
        confidence: 0.8,
      },
      action_1: {
        type: "choice",
        choice: "HOLD",
        probabilities: { BUY: 0.2, SELL: 0.2, HOLD: 0.6 },
        confidence: 0.5,
      },
    });

    expect(result.high_conviction).toEqual(["AAPL"]);
  });

  it("treats unexpected choice values as HOLD and skips missing answers", () => {
    const result = mapJevAnalystAnswers(candidates, {
      action_0: {
        type: "choice",
        choice: "SHORT",
        probabilities: { SHORT: 0.9 },
        confidence: 0.9,
      },
      // action_1 missing
    });

    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0]?.action).toBe("HOLD");
  });
});

describe("analyzeSignalsWithJev", () => {
  it("sends one systemone request and tracks usage", async () => {
    const response: SystemOneResponse = {
      model: "jev-latest",
      answers: {
        action_0: {
          type: "choice",
          choice: "BUY",
          probabilities: { BUY: 0.9, SELL: 0.02, HOLD: 0.08 },
          confidence: 0.86,
        },
        size_0: {
          type: "score",
          score: 2,
          legend: { "0": "s", "1": "m", "2": "l" },
          probabilities: { "0": 0, "1": 0, "2": 1 },
          confidence: 1,
        },
      },
      usage: { input_tokens: 500, output_tokens: 60 },
    };

    const client = new TypeSafeClient({ apiKey: "ts-test" });
    const spy = vi.spyOn(client, "systemOne").mockResolvedValueOnce(response);

    const result = await analyzeSignalsWithJev(client, {
      signals: [makeSignal({ symbol: "AAPL" })],
      positions: [],
      account: makeAccount(),
      research: { AAPL: makeResearch() },
      positionEntries: {},
      config: CONFIG,
      now: NOW,
    });

    expect(spy).toHaveBeenCalledOnce();
    const request = spy.mock.calls[0]?.[0];
    expect(request?.questions.action_0?.type).toBe("choice");
    expect(result.model).toBe("jev-latest");
    expect(result.usage.input_tokens).toBe(500);
    expect(result.recommendations[0]).toMatchObject({ action: "BUY", symbol: "AAPL", suggested_size_pct: 30 });
    expect(result.high_conviction).toEqual(["AAPL"]);
  });

  it("returns empty result without calling the API when no candidates qualify", async () => {
    const client = new TypeSafeClient({ apiKey: "ts-test" });
    const spy = vi.spyOn(client, "systemOne");

    const result = await analyzeSignalsWithJev(client, {
      signals: [makeSignal({ symbol: "WEAK", sentiment: 0.01 })],
      positions: [],
      account: makeAccount(),
      research: {},
      positionEntries: {},
      config: CONFIG,
      now: NOW,
    });

    expect(spy).not.toHaveBeenCalled();
    expect(result.recommendations).toEqual([]);
    expect(result.usage.input_tokens).toBe(0);
  });
});
