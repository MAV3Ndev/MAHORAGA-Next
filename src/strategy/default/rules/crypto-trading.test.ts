import { describe, expect, it, vi } from "vitest";
import type { ResearchResult } from "../../../core/types";
import { createAlpacaProviders } from "../../../providers/alpaca";
import { researchCrypto, runCryptoTrading } from "./crypto-trading";

vi.mock("../../../providers/alpaca", () => ({
  createAlpacaProviders: vi.fn(),
}));

describe("crypto trading", () => {
  it("retries malformed crypto research JSON and requests json_object output", async () => {
    vi.mocked(createAlpacaProviders).mockReturnValue({
      marketData: {
        getCryptoSnapshot: vi.fn(async () => ({
          latest_trade: { price: 65000 },
          daily_bar: { c: 66000 },
          prev_daily_bar: { c: 64000 },
        })),
      },
    } as never);

    const complete = vi
      .fn()
      .mockResolvedValueOnce({
        content: "<think>Still reasoning without a JSON object.</think>",
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      })
      .mockResolvedValueOnce({
        content:
          '{"verdict":"BUY","confidence":0.72,"entry_quality":"good","reasoning":"Momentum is constructive.","red_flags":[],"catalysts":["Trend strength"]}',
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      });

    const result = await researchCrypto(
      {
        env: {} as never,
        config: {
          llm_model: "test-model",
          min_analyst_confidence: 0.6,
          crypto_momentum_threshold: 2,
        },
        llm: { complete } as never,
        log: () => {},
        trackLLMCost: () => 0,
        sleep: async () => {},
        broker: {} as never,
        state: {} as never,
        signals: [],
        positionEntries: {},
      } as never,
      "BTC/USD",
      3,
      0.6
    );

    expect(result).toMatchObject({
      symbol: "BTC/USD",
      verdict: "BUY",
      confidence: 0.72,
      entry_quality: "good",
    });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[0]?.[0]).toMatchObject({
      response_format: { type: "json_object" },
    });
  });

  it("parses crypto research JSON after reasoning text", async () => {
    vi.mocked(createAlpacaProviders).mockReturnValue({
      marketData: {
        getCryptoSnapshot: vi.fn(async () => ({
          latest_trade: { price: 65000 },
          daily_bar: { c: 66000 },
          prev_daily_bar: { c: 64000 },
        })),
      },
    } as never);

    const complete = vi.fn(async () => ({
      content:
        '<think>The setup is constructive but needs validation.</think>\n{"verdict":"BUY","confidence":0.72,"entry_quality":"good","reasoning":"Momentum is constructive.","red_flags":[],"catalysts":["Trend strength"]}',
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    }));

    const result = await researchCrypto(
      {
        env: {} as never,
        config: {
          llm_model: "MiniMax-M3",
          min_analyst_confidence: 0.6,
          crypto_momentum_threshold: 2,
        },
        llm: { complete } as never,
        log: () => {},
        trackLLMCost: () => 0,
        sleep: async () => {},
        broker: {} as never,
        state: {} as never,
        signals: [],
        positionEntries: {},
      } as never,
      "BTC/USD",
      3,
      0.6
    );

    expect(result).toMatchObject({
      symbol: "BTC/USD",
      verdict: "BUY",
      confidence: 0.72,
      entry_quality: "good",
    });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("returns no crypto research after repeated malformed LLM responses", async () => {
    vi.mocked(createAlpacaProviders).mockReturnValue({
      marketData: {
        getCryptoSnapshot: vi.fn(async () => null),
      },
    } as never);

    const result = await researchCrypto(
      {
        env: {} as never,
        config: {
          llm_model: "test-model",
          min_analyst_confidence: 0.6,
          crypto_momentum_threshold: 2,
        },
        llm: {
          complete: vi.fn(async () => ({
            content: "<think>Still reasoning without a JSON object.</think>",
            usage: { prompt_tokens: 10, completion_tokens: 20 },
          })),
        } as never,
        log: () => {},
        trackLLMCost: () => 0,
        sleep: async () => {},
        broker: {} as never,
        state: {} as never,
        signals: [],
        positionEntries: {},
      } as never,
      "BTC/USD",
      3,
      0.6
    );

    expect(result).toBeNull();
  });

  it("rejects truncated crypto research verdicts", async () => {
    vi.mocked(createAlpacaProviders).mockReturnValue({
      marketData: {
        getCryptoSnapshot: vi.fn(async () => null),
      },
    } as never);

    const complete = vi.fn(async () => ({
      content:
        '{"verdict":"SK","confidence":0.7,"entry_quality":"fair","reasoning":"Looks incomplete.","red_flags":[],"catalysts":[]}',
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    }));

    const result = await researchCrypto(
      {
        env: {} as never,
        config: {
          llm_model: "test-model",
          min_analyst_confidence: 0.6,
          crypto_momentum_threshold: 2,
        },
        llm: { complete } as never,
        log: () => {},
        trackLLMCost: () => 0,
        sleep: async () => {},
        broker: {} as never,
        state: {} as never,
        signals: [],
        positionEntries: {},
      } as never,
      "BTC/USD",
      3,
      0.6
    );

    expect(result).toBeNull();
    expect(complete).toHaveBeenCalledTimes(3);
  });

  it("treats compact crypto position symbols as already held", async () => {
    const buy = vi.fn(async () => ({ submitted: true }));

    const ctx = {
      config: {
        crypto_enabled: true,
        crypto_symbols: ["BTC/USD", "ETH/USD"],
        crypto_take_profit_pct: 10,
        crypto_stop_loss_pct: 5,
        min_analyst_confidence: 0.6,
        position_size_pct_of_cash: 10,
        risk_per_trade_pct: 0.75,
        crypto_max_position_value: 1000,
      },
      signals: [
        {
          symbol: "BTC/USD",
          isCrypto: true,
          sentiment: 0.4,
          momentum: 3,
        },
      ],
      llm: null,
      log: () => {},
      trackLLMCost: () => 0,
      sleep: async () => {},
      broker: {
        buy,
        sell: vi.fn(async () => true),
        getAccount: vi.fn(async () => ({ cash: 10000, buying_power: 10000 })),
      },
      state: {
        get: () => undefined,
        set: () => {},
      },
    } as never;

    await runCryptoTrading(ctx, [
      {
        symbol: "BTCUSD",
        asset_class: "crypto",
        avg_entry_price: 100,
        current_price: 100,
        market_value: 1000,
        unrealized_pl: 0,
      },
    ] as never);

    expect(buy).not.toHaveBeenCalled();
  });

  it("does not rebuy crypto while a submitted buy is still pending", async () => {
    const buy = vi.fn(async () => ({ submitted: true }));
    const cachedResearch: ResearchResult = {
      symbol: "POL/USD",
      verdict: "BUY",
      confidence: 0.75,
      entry_quality: "good",
      reasoning: "Momentum is constructive.",
      red_flags: [],
      catalysts: ["Trend strength"],
      timestamp: Date.now(),
    };
    const state: Record<string, unknown> = {
      cryptoPendingBuys: { POLUSD: Date.now() },
      "cryptoResearch_POL/USD": cachedResearch,
    };

    const ctx = {
      config: {
        crypto_enabled: true,
        crypto_symbols: ["POL/USD"],
        crypto_take_profit_pct: 10,
        crypto_stop_loss_pct: 5,
        min_analyst_confidence: 0.6,
        position_size_pct_of_cash: 25,
        risk_per_trade_pct: 0.75,
        crypto_max_position_value: 5000,
      },
      signals: [
        {
          symbol: "POL/USD",
          isCrypto: true,
          sentiment: 0.4,
          momentum: 3,
        },
      ],
      llm: null,
      log: () => {},
      trackLLMCost: () => 0,
      sleep: async () => {},
      broker: {
        buy,
        sell: vi.fn(async () => true),
        getAccount: vi.fn(async () => ({ cash: 10000, buying_power: 10000 })),
      },
      state: {
        get: (key: string) => state[key],
        set: (key: string, value: unknown) => {
          state[key] = value;
        },
      },
      positionEntries: {},
    } as never;

    await runCryptoTrading(ctx, [] as never);

    expect(buy).not.toHaveBeenCalled();
  });

  it("promotes cached WAIT crypto research when confidence is actionable", async () => {
    const buy = vi.fn(async () => ({ submitted: true }));
    const positionEntries: Record<string, ResearchResult | unknown> = {};
    const cachedResearch: ResearchResult = {
      symbol: "BTC/USD",
      verdict: "WAIT",
      confidence: 0.6,
      entry_quality: "fair",
      reasoning: "Momentum is constructive and pullbacks are shallow.",
      red_flags: [],
      catalysts: ["Strong trend"],
      timestamp: Date.now(),
    };

    const ctx = {
      config: {
        crypto_enabled: true,
        crypto_symbols: ["BTC/USD", "ETH/USD"],
        crypto_take_profit_pct: 10,
        crypto_stop_loss_pct: 5,
        min_analyst_confidence: 0.6,
        position_size_pct_of_cash: 25,
        risk_per_trade_pct: 0.75,
        crypto_max_position_value: 5000,
      },
      signals: [
        {
          symbol: "BTC/USD",
          isCrypto: true,
          sentiment: 0.4,
          momentum: 3,
        },
      ],
      llm: null,
      log: () => {},
      trackLLMCost: () => 0,
      sleep: async () => {},
      broker: {
        buy,
        sell: vi.fn(async () => true),
        getAccount: vi.fn(async () => ({ cash: 10000, buying_power: 10000 })),
      },
      state: {
        get: (key: string) => (key === "cryptoResearch_BTC/USD" ? cachedResearch : undefined),
        set: () => {},
      },
      positionEntries,
    } as never;

    await runCryptoTrading(ctx, [] as never);

    expect(buy).toHaveBeenCalledWith(
      "BTC/USD",
      1500,
      "Crypto momentum (promoted WAIT): Momentum is constructive and pullbacks are shallow."
    );
    expect(positionEntries["BTC/USD"]).toBeTruthy();
    expect(positionEntries.BTCUSD).toBe(positionEntries["BTC/USD"]);
  });

  it("blocks blacklisted crypto entries", async () => {
    const buy = vi.fn(async () => ({ submitted: true }));
    const cachedResearch: ResearchResult = {
      symbol: "AVAX/USD",
      verdict: "BUY",
      confidence: 0.8,
      entry_quality: "good",
      reasoning: "Momentum is constructive.",
      red_flags: [],
      catalysts: [],
      timestamp: Date.now(),
    };
    const state: Record<string, unknown> = { "cryptoResearch_AVAX/USD": cachedResearch };

    await runCryptoTrading(
      {
        config: {
          crypto_enabled: true,
          crypto_symbols: ["BTC/USD", "AVAX/USD"],
          crypto_blacklist: ["AVAX/USD"],
          crypto_take_profit_pct: 10,
          crypto_stop_loss_pct: 5,
          crypto_btc_min_momentum: 2,
          crypto_max_consecutive_losses: 2,
          crypto_reentry_cooldown_hours: 24,
          min_analyst_confidence: 0.6,
          position_size_pct_of_cash: 25,
          risk_per_trade_pct: 0.75,
          crypto_max_position_value: 5000,
        },
        signals: [
          { symbol: "AVAX/USD", isCrypto: true, sentiment: 0.5, momentum: 5 },
          { symbol: "BTC/USD", isCrypto: true, sentiment: 0.4, momentum: 3 },
        ],
        llm: null,
        log: () => {},
        broker: {
          buy,
          sell: vi.fn(async () => true),
          getAccount: vi.fn(async () => ({ buying_power: 10000 })),
        },
        state: {
          get: (key: string) => state[key],
          set: (key: string, value: unknown) => {
            state[key] = value;
          },
        },
        positionEntries: {},
      } as never,
      []
    );

    expect(buy).not.toHaveBeenCalled();
  });

  it("blocks altcoin entries when BTC momentum is weak", async () => {
    const buy = vi.fn(async () => ({ submitted: true }));
    const cachedResearch: ResearchResult = {
      symbol: "ETH/USD",
      verdict: "BUY",
      confidence: 0.8,
      entry_quality: "good",
      reasoning: "Momentum is constructive.",
      red_flags: [],
      catalysts: [],
      timestamp: Date.now(),
    };
    const state: Record<string, unknown> = { "cryptoResearch_ETH/USD": cachedResearch };

    await runCryptoTrading(
      {
        config: {
          crypto_enabled: true,
          crypto_symbols: ["BTC/USD", "ETH/USD"],
          crypto_blacklist: [],
          crypto_take_profit_pct: 10,
          crypto_stop_loss_pct: 5,
          crypto_btc_min_momentum: 2,
          crypto_max_consecutive_losses: 2,
          crypto_reentry_cooldown_hours: 24,
          min_analyst_confidence: 0.6,
          position_size_pct_of_cash: 25,
          risk_per_trade_pct: 0.75,
          crypto_max_position_value: 5000,
        },
        signals: [
          { symbol: "ETH/USD", isCrypto: true, sentiment: 0.5, momentum: 4 },
          { symbol: "BTC/USD", isCrypto: true, sentiment: 0.2, momentum: 1 },
        ],
        llm: null,
        log: () => {},
        broker: {
          buy,
          sell: vi.fn(async () => true),
          getAccount: vi.fn(async () => ({ buying_power: 10000 })),
        },
        state: {
          get: (key: string) => state[key],
          set: (key: string, value: unknown) => {
            state[key] = value;
          },
        },
        positionEntries: {},
      } as never,
      []
    );

    expect(buy).not.toHaveBeenCalled();
  });

  it("blocks entries during cooldown and after the configured loss streak", async () => {
    const buy = vi.fn(async () => ({ submitted: true }));
    const state: Record<string, unknown> = {
      cryptoReentryCooldowns: { "BTC/USD": Date.now() + 60_000 },
      cryptoLossStreaks: { "BTC/USD": 2 },
    };

    await runCryptoTrading(
      {
        config: {
          crypto_enabled: true,
          crypto_symbols: ["BTC/USD"],
          crypto_blacklist: [],
          crypto_take_profit_pct: 10,
          crypto_stop_loss_pct: 5,
          crypto_max_consecutive_losses: 2,
          crypto_reentry_cooldown_hours: 24,
          min_analyst_confidence: 0.6,
          position_size_pct_of_cash: 25,
          risk_per_trade_pct: 0.75,
          crypto_max_position_value: 5000,
        },
        signals: [{ symbol: "BTC/USD", isCrypto: true, sentiment: 0.5, momentum: 4 }],
        llm: null,
        log: () => {},
        broker: {
          buy,
          sell: vi.fn(async () => true),
          getAccount: vi.fn(async () => ({ buying_power: 10000 })),
        },
        state: {
          get: (key: string) => state[key],
          set: (key: string, value: unknown) => {
            state[key] = value;
          },
        },
        positionEntries: {},
      } as never,
      []
    );

    expect(buy).not.toHaveBeenCalled();
  });

  it("applies the trailing stop to crypto positions", async () => {
    const sell = vi.fn(async () => true);
    const state: Record<string, unknown> = {
      cryptoTrailingStates: {
        "BTC/USD": { active: true, highPrice: 110, stopPrice: 106.15 },
      },
    };

    await runCryptoTrading(
      {
        config: {
          crypto_enabled: true,
          crypto_symbols: ["BTC/USD"],
          crypto_blacklist: [],
          crypto_take_profit_pct: 10,
          crypto_stop_loss_pct: 5,
          crypto_reentry_cooldown_hours: 24,
          crypto_max_consecutive_losses: 2,
          trailing_stop_enabled: true,
          trailing_stop_pct: 3.5,
          trailing_stop_activation_pct: 5,
          dynamic_tp_enabled: false,
        },
        signals: [],
        llm: null,
        log: () => {},
        broker: {
          buy: vi.fn(async () => ({ submitted: true })),
          sell,
        },
        state: {
          get: (key: string) => state[key],
          set: (key: string, value: unknown) => {
            state[key] = value;
          },
        },
        positionEntries: {
          "BTC/USD": {
            symbol: "BTC/USD",
            entry_time: Date.now() - 60_000,
            entry_price: 100,
            entry_sentiment: 0.5,
            entry_social_volume: 1,
            entry_sources: ["crypto"],
            entry_reason: "momentum",
            peak_price: 110,
            peak_sentiment: 0.5,
          },
        },
      } as never,
      [
        {
          symbol: "BTCUSD",
          asset_class: "crypto",
          avg_entry_price: 100,
          current_price: 104,
          market_value: 1040,
          unrealized_pl: 40,
        },
      ] as never
    );

    expect(sell).toHaveBeenCalledWith("BTCUSD", expect.stringContaining("Trailing stop hit"));
  });
});
