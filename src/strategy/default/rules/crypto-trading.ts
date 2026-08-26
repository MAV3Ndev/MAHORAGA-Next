/**
 * Crypto trading rules — momentum-based crypto entry/exit via Alpaca.
 *
 * These are standalone helpers used by the core harness for crypto-specific logic.
 * The main selectEntries/selectExits handle stocks; crypto has its own flow
 * because it trades 24/7 outside of market hours.
 */

import { normalizeResearchAnalysis } from "../../../core/research-validation";
import type { Position, PositionEntry, ResearchResult, Signal, SocialSnapshotCacheEntry } from "../../../core/types";
import { parseLlmJsonObject } from "../../../lib/llm-json";
import { createAlpacaProviders } from "../../../providers/alpaca";
import type { StrategyContext } from "../../types";
import { getCryptoSymbolAliases, isCryptoSymbol, normalizeCryptoSymbol } from "../helpers/crypto";
import { checkAdvancedExits, getTrailingStopState, type TrailingStopState } from "./advanced-exits";
import { computeRiskSizedNotional } from "./risk-sizing";

const MAX_RETRIES = 3;
const CRYPTO_PENDING_BUY_TTL_MS = 15 * 60 * 1000;

type CryptoCooldowns = Record<string, number>;
type CryptoLossStreaks = Record<string, number>;
type CryptoTrailingStates = Record<string, TrailingStopState>;

function getPendingCryptoBuys(ctx: StrategyContext): Record<string, number> {
  return ctx.state.get<Record<string, number>>("cryptoPendingBuys") ?? {};
}

function prunePendingCryptoBuys(ctx: StrategyContext, pendingBuys: Record<string, number>, now: number): Set<string> {
  const activeAliases = new Set<string>();
  const nextPendingBuys: Record<string, number> = {};

  for (const [symbol, timestamp] of Object.entries(pendingBuys)) {
    if (!Number.isFinite(timestamp) || now - timestamp >= CRYPTO_PENDING_BUY_TTL_MS) continue;

    nextPendingBuys[symbol] = timestamp;
    for (const alias of getCryptoSymbolAliases(symbol)) {
      activeAliases.add(alias);
    }
  }

  ctx.state.set("cryptoPendingBuys", nextPendingBuys);
  return activeAliases;
}

function rememberPendingCryptoBuy(ctx: StrategyContext, symbol: string, now: number): void {
  const pendingBuys = getPendingCryptoBuys(ctx);
  for (const alias of getCryptoSymbolAliases(symbol)) {
    pendingBuys[alias] = now;
  }
  ctx.state.set("cryptoPendingBuys", pendingBuys);
}

function getCryptoCooldowns(ctx: StrategyContext): CryptoCooldowns {
  return ctx.state.get<CryptoCooldowns>("cryptoReentryCooldowns") ?? {};
}

function getCryptoLossStreaks(ctx: StrategyContext): CryptoLossStreaks {
  return ctx.state.get<CryptoLossStreaks>("cryptoLossStreaks") ?? {};
}

function getCryptoTrailingStates(ctx: StrategyContext): CryptoTrailingStates {
  return ctx.state.get<CryptoTrailingStates>("cryptoTrailingStates") ?? {};
}

function getPositionEntry(ctx: StrategyContext, symbol: string): PositionEntry | undefined {
  return getCryptoSymbolAliases(symbol)
    .map((alias) => ctx.positionEntries?.[alias])
    .find((entry) => !!entry);
}

function isCryptoBlacklisted(ctx: StrategyContext, symbol: string): boolean {
  const normalized = normalizeCryptoSymbol(symbol);
  return (ctx.config.crypto_blacklist ?? []).some((item) => normalizeCryptoSymbol(item) === normalized);
}

function getCryptoCooldownUntil(ctx: StrategyContext, symbol: string, now: number): number | null {
  const cooldowns = getCryptoCooldowns(ctx);
  for (const alias of getCryptoSymbolAliases(symbol)) {
    const until = cooldowns[alias];
    if (!until) continue;
    if (until <= now) {
      delete cooldowns[alias];
      continue;
    }
    return until;
  }
  ctx.state.set("cryptoReentryCooldowns", cooldowns);
  return null;
}

function recordCryptoExit(ctx: StrategyContext, symbol: string, pnlPct: number, now: number): void {
  const cooldowns = getCryptoCooldowns(ctx);
  const lossStreaks = getCryptoLossStreaks(ctx);
  const normalized = normalizeCryptoSymbol(symbol);
  const previousStreak = lossStreaks[normalized] ?? 0;
  const nextStreak = pnlPct < 0 ? previousStreak + 1 : 0;
  const maxLosses = ctx.config.crypto_max_consecutive_losses ?? 2;
  const cooldownMultiplier = nextStreak >= maxLosses ? 3 : 1;
  const cooldownHours = ctx.config.crypto_reentry_cooldown_hours ?? 24;
  const cooldownUntil = now + cooldownHours * cooldownMultiplier * 60 * 60 * 1000;

  lossStreaks[normalized] = nextStreak;
  for (const alias of getCryptoSymbolAliases(symbol)) {
    cooldowns[alias] = cooldownUntil;
  }
  ctx.state.set("cryptoLossStreaks", lossStreaks);
  ctx.state.set("cryptoReentryCooldowns", cooldowns);
  ctx.log("Crypto", "reentry_cooldown_set", {
    symbol: normalized,
    pnl: pnlPct.toFixed(2),
    loss_streak: nextStreak,
    cooldown_until: cooldownUntil,
    cooldown_hours: cooldownHours * cooldownMultiplier,
  });
}

function clearCryptoTrailingState(ctx: StrategyContext, symbol: string): void {
  const trailingStates = getCryptoTrailingStates(ctx);
  for (const alias of getCryptoSymbolAliases(symbol)) delete trailingStates[alias];
  ctx.state.set("cryptoTrailingStates", trailingStates);
}

function isBitcoin(symbol: string): boolean {
  return normalizeCryptoSymbol(symbol) === "BTC/USD";
}

function parseResearchAnalysis(content: string): {
  verdict: "BUY" | "SKIP" | "WAIT";
  confidence: number;
  entry_quality: "excellent" | "good" | "fair" | "poor";
  reasoning: string;
  red_flags?: string[];
  catalysts?: string[];
} {
  return parseLlmJsonObject(content);
}

function trackCryptoPositionEntry(
  ctx: StrategyContext,
  signal: Signal,
  research: ResearchResult,
  reason: string
): void {
  const socialSnapshot = ctx.state.get<Record<string, SocialSnapshotCacheEntry>>("socialSnapshotCache") ?? {};
  const snapshotEntry = getCryptoSymbolAliases(signal.symbol)
    .map((alias) => socialSnapshot[alias])
    .find((entry) => !!entry);

  const entry: PositionEntry = {
    symbol: normalizeCryptoSymbol(signal.symbol),
    entry_time: Date.now(),
    entry_price: signal.price ?? 0,
    entry_sentiment: snapshotEntry?.sentiment ?? signal.sentiment,
    entry_social_volume: snapshotEntry?.volume ?? signal.volume ?? 0,
    entry_sources: snapshotEntry?.sources ?? [signal.source || "crypto"],
    entry_reason: reason,
    peak_price: signal.price ?? 0,
    peak_sentiment: snapshotEntry?.sentiment ?? signal.sentiment,
    recommended_entry_zone: research.recommended_entry_zone,
    recommended_stop_loss_pct: research.stop_loss_pct,
    recommended_take_profit_pct: research.take_profit_pct,
  };

  for (const alias of getCryptoSymbolAliases(signal.symbol)) {
    ctx.positionEntries[alias] = entry;
  }
}

/**
 * Research a crypto symbol for BUY/SKIP/WAIT verdict.
 * Includes retry logic for rate limit (429) errors.
 */
export async function researchCrypto(
  ctx: StrategyContext,
  symbol: string,
  momentum: number,
  sentiment: number
): Promise<ResearchResult | null> {
  ctx.log("Crypto", "research_start", { symbol, momentum, sentiment, has_llm: !!ctx.llm });

  if (!ctx.llm) {
    ctx.log("Crypto", "skipped_no_llm", { symbol, reason: "LLM Provider not configured" });
    return null;
  }

  const alpaca = createAlpacaProviders(ctx.env);
  const snapshot = await alpaca.marketData.getCryptoSnapshot(symbol).catch(() => null);
  const price = snapshot?.latest_trade?.price || 0;
  const dailyChange = snapshot
    ? ((snapshot.daily_bar.c - snapshot.prev_daily_bar.c) / snapshot.prev_daily_bar.c) * 100
    : 0;

  const prompt = `Should we BUY this cryptocurrency based on momentum and market conditions?

SYMBOL: ${symbol}
PRICE: $${price.toFixed(2)}
24H CHANGE: ${dailyChange.toFixed(2)}%
MOMENTUM SCORE: ${(momentum * 100).toFixed(0)}%
SENTIMENT: ${(sentiment * 100).toFixed(0)}% bullish

Evaluate if this is a good entry. Consider:
- Is the momentum sustainable or a trap?
- Any major news/events affecting this crypto?
- Risk/reward at current price level?

JSON response:
{
  "verdict": "BUY|SKIP|WAIT",
  "confidence": 0.0-1.0,
  "entry_quality": "excellent|good|fair|poor",
  "reasoning": "brief reason",
  "red_flags": ["any concerns"],
  "catalysts": ["positive factors"]
}`;

  let lastError: string | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await ctx.llm.complete({
        model: ctx.config.llm_model,
        messages: [
          {
            role: "system",
            content:
              "You are a crypto analyst. Be skeptical of FOMO, but do not miss clearly actionable momentum setups. Crypto is volatile, so reserve SKIP for weak or trap-like setups and use WAIT only when the thesis is constructive but the entry is still borderline. Output valid JSON only.",
          },
          { role: "user", content: prompt },
        ],
        max_tokens: 1500,
        temperature: 0.3,
        response_format: { type: "json_object" },
      });

      const usage = response.usage;
      if (usage) {
        ctx.trackLLMCost(ctx.config.llm_model, usage.prompt_tokens, usage.completion_tokens);
      }

      const content = response.content || "{}";

      ctx.log("Crypto", "research_raw_response", {
        symbol,
        content_preview: content.substring(0, 200),
        content_length: content.length,
      });
      let analysis: {
        verdict: unknown;
        confidence: unknown;
        entry_quality: unknown;
        reasoning: unknown;
        red_flags?: unknown;
        catalysts?: unknown;
      };

      try {
        analysis = parseResearchAnalysis(content);
        const result = normalizeResearchAnalysis(symbol, analysis);

        ctx.log("Crypto", "researched", {
          symbol,
          verdict: result.verdict,
          confidence: result.confidence,
          quality: result.entry_quality,
          attempt,
        });

        return result;
      } catch (parseError) {
        ctx.log("Crypto", "research_parse_error", {
          symbol,
          attempt,
          content_preview: content.substring(0, 100),
          content_length: content.length,
          error: String(parseError),
        });

        if (attempt < MAX_RETRIES - 1) {
          continue;
        }

        return null;
      }
    } catch (error) {
      lastError = String(error);
      const isRateLimit = lastError.includes("429") || lastError.includes("rate_limit");

      ctx.log("Crypto", "research_retry", {
        symbol,
        attempt,
        max_retries: MAX_RETRIES,
        is_rate_limit: isRateLimit,
        error: lastError.substring(0, 100),
      });

      if (isRateLimit && attempt < MAX_RETRIES - 1) {
        // Exponential backoff: 1s, 2s, 4s
        const backoffMs = Math.min(4000, 1000 * 2 ** attempt);
        await ctx.sleep(backoffMs);
        continue;
      }

      ctx.log("Crypto", "research_error", { symbol, error: lastError, attempt });
      return null;
    }
  }

  return null;
}

/**
 * Run crypto-specific trading loop: check exits, then entries.
 * Called from the core harness when crypto_enabled is true.
 */
export async function runCryptoTrading(ctx: StrategyContext, positions: Position[]): Promise<void> {
  if (!ctx.config.crypto_enabled) return;

  const cryptoPositions = positions.filter((p) => isCryptoSymbol(p.symbol, ctx.config.crypto_symbols || []));
  const heldCrypto = new Set(cryptoPositions.flatMap((p) => getCryptoSymbolAliases(p.symbol)));
  const pendingCrypto = prunePendingCryptoBuys(ctx, getPendingCryptoBuys(ctx), Date.now());
  const now = Date.now();
  const trailingStates = getCryptoTrailingStates(ctx);

  // Check exits
  for (const pos of cryptoPositions) {
    const plPct = (pos.unrealized_pl / (pos.market_value - pos.unrealized_pl)) * 100;
    const entry = getPositionEntry(ctx, pos.symbol);
    const existingTrailingState = getCryptoSymbolAliases(pos.symbol)
      .map((alias) => trailingStates[alias])
      .find((state) => !!state);
    const nextTrailingState = getTrailingStopState(
      pos,
      entry,
      {
        trailing_stop_enabled: ctx.config.trailing_stop_enabled ?? false,
        trailing_stop_pct: ctx.config.trailing_stop_pct ?? 3.5,
        trailing_stop_activation_pct: ctx.config.trailing_stop_activation_pct ?? 5,
      },
      existingTrailingState
    );
    for (const alias of getCryptoSymbolAliases(pos.symbol)) trailingStates[alias] = nextTrailingState;

    const advancedExit = checkAdvancedExits(
      pos,
      entry,
      getCryptoAtr(ctx, pos.symbol),
      {
        trailing_stop_enabled: ctx.config.trailing_stop_enabled ?? false,
        trailing_stop_pct: ctx.config.trailing_stop_pct ?? 3.5,
        trailing_stop_activation_pct: ctx.config.trailing_stop_activation_pct ?? 5,
        dynamic_tp_enabled: ctx.config.dynamic_tp_enabled ?? false,
        tp_atr_multiplier: ctx.config.tp_atr_multiplier ?? 3,
        tp_min_pct: ctx.config.tp_min_pct ?? 5,
        tp_max_pct: ctx.config.tp_max_pct ?? 25,
        dynamic_tp_fallback_pct: ctx.config.dynamic_tp_fallback_pct ?? ctx.config.crypto_take_profit_pct,
        stop_loss_pct: ctx.config.crypto_stop_loss_pct,
      },
      nextTrailingState
    );

    const shouldTakeProfit = plPct >= ctx.config.crypto_take_profit_pct && !advancedExit.shouldExit;
    if (advancedExit.shouldExit || shouldTakeProfit) {
      const reason = advancedExit.shouldExit ? advancedExit.reason : `Crypto take profit at +${plPct.toFixed(1)}%`;
      ctx.log("Crypto", advancedExit.shouldExit ? (advancedExit.exitType ?? "exit") : "take_profit", {
        symbol: pos.symbol,
        pnl: plPct.toFixed(2),
        reason,
      });
      const submitted = await ctx.broker.sell(pos.symbol, reason);
      if (submitted) {
        recordCryptoExit(ctx, pos.symbol, plPct, now);
        clearCryptoTrailingState(ctx, pos.symbol);
      }
    }
  }
  ctx.state.set("cryptoTrailingStates", trailingStates);

  // Check entries
  const maxCryptoPositions = Math.min(ctx.config.crypto_symbols?.length || 3, 3);
  if (cryptoPositions.length >= maxCryptoPositions) return;

  const cryptoSignals = ctx.signals
    .filter((s) => s.isCrypto)
    .filter((s) => !heldCrypto.has(s.symbol))
    .filter((s) => !pendingCrypto.has(s.symbol))
    .filter((s) => s.sentiment > 0)
    .sort((a, b) => (b.momentum || 0) - (a.momentum || 0));
  const btcSignal = ctx.signals.find((signal) => isBitcoin(signal.symbol));
  const minBtcMomentum = ctx.config.crypto_btc_min_momentum ?? 2;
  const maxLosses = ctx.config.crypto_max_consecutive_losses ?? 2;

  ctx.log("Crypto", "run_start", {
    total_signals: ctx.signals.length,
    crypto_signals: cryptoSignals.length,
    held_crypto: Array.from(heldCrypto),
    pending_crypto: Array.from(pendingCrypto),
    has_llm: !!ctx.llm,
    crypto_enabled: ctx.config.crypto_enabled,
  });

  const CRYPTO_RESEARCH_TTL_MS = 300_000;

  for (const signal of cryptoSignals.slice(0, 2)) {
    if (cryptoPositions.length >= maxCryptoPositions) break;

    if (isCryptoBlacklisted(ctx, signal.symbol)) {
      ctx.log("Crypto", "entry_blocked_blacklist", { symbol: signal.symbol });
      continue;
    }

    const cooldownUntil = getCryptoCooldownUntil(ctx, signal.symbol, now);
    if (cooldownUntil) {
      ctx.log("Crypto", "entry_blocked_reentry_cooldown", {
        symbol: signal.symbol,
        cooldown_until: cooldownUntil,
      });
      continue;
    }

    const normalizedSymbol = normalizeCryptoSymbol(signal.symbol);
    const lossStreaks = getCryptoLossStreaks(ctx);
    if ((lossStreaks[normalizedSymbol] ?? 0) >= maxLosses) {
      ctx.log("Crypto", "entry_blocked_loss_streak", {
        symbol: signal.symbol,
        loss_streak: lossStreaks[normalizedSymbol],
      });
      continue;
    }

    if (!isBitcoin(signal.symbol) && (!btcSignal || (btcSignal.momentum ?? -Infinity) < minBtcMomentum)) {
      ctx.log("Crypto", "entry_blocked_btc_trend", {
        symbol: signal.symbol,
        btc_momentum: btcSignal?.momentum ?? null,
        min_btc_momentum: minBtcMomentum,
      });
      continue;
    }

    const cachedResearch = ctx.state.get<ResearchResult>(`cryptoResearch_${signal.symbol}`);
    const cacheAge = cachedResearch ? Date.now() - cachedResearch.timestamp : null;
    // Cache is valid if: has cache AND (fresh OR not a failure)
    const isFailure = cachedResearch && cachedResearch.verdict === "SKIP" && cachedResearch.confidence < 0.2;
    const isCacheFresh = cachedResearch && cacheAge !== null && cacheAge < CRYPTO_RESEARCH_TTL_MS && !isFailure;

    ctx.log("Crypto", "research_cache_check", {
      symbol: signal.symbol,
      has_cache: !!cachedResearch,
      cache_age_ms: cacheAge,
      is_fresh: isCacheFresh,
      is_failure: isFailure,
      cached_verdict: cachedResearch?.verdict,
      cached_confidence: cachedResearch?.confidence,
    });

    let research: ResearchResult | null = cachedResearch ?? null;

    if (!cachedResearch || !isCacheFresh) {
      research = await researchCrypto(ctx, signal.symbol, signal.momentum || 0, signal.sentiment);
      // Only cache successful results (BUY or SKIP with reasonable confidence)
      if (research && (research.verdict === "BUY" || research.confidence >= 0.2)) {
        ctx.state.set(`cryptoResearch_${signal.symbol}`, research);
      }
    }

    const promotableWait = !!research && isPromotableCryptoWait(research, ctx);
    if (!research || (research.verdict !== "BUY" && !promotableWait)) {
      ctx.log("Crypto", "research_skip", {
        symbol: signal.symbol,
        verdict: research?.verdict || "NO_RESEARCH",
        confidence: research?.confidence || 0,
      });
      continue;
    }

    if (research.confidence < ctx.config.min_analyst_confidence) {
      ctx.log("Crypto", "low_confidence", { symbol: signal.symbol, confidence: research.confidence });
      continue;
    }

    if (promotableWait) {
      ctx.log("Crypto", "wait_promoted", {
        symbol: signal.symbol,
        confidence: research.confidence,
        quality: research.entry_quality,
      });
    }

    const account = await ctx.broker.getAccount();
    const sizing = computeRiskSizedNotional({
      buyingPower: account.buying_power,
      maxPositionValue: ctx.config.crypto_max_position_value,
      confidence: research.confidence,
      positionSizePctOfCash: ctx.config.position_size_pct_of_cash,
      riskPerTradePct: ctx.config.risk_per_trade_pct,
      stopLossPct: research.stop_loss_pct ?? ctx.config.crypto_stop_loss_pct,
      entryPrice: signal.price,
      atr: getCryptoAtr(ctx, signal.symbol),
    });
    const positionSize = Math.min(sizing.notional, ctx.config.crypto_max_position_value);

    if (positionSize < 10) {
      ctx.log("Crypto", "buy_skipped", { symbol: signal.symbol, reason: "Position too small" });
      continue;
    }

    const tradeReason = promotableWait
      ? `Crypto momentum (promoted WAIT): ${research.reasoning}`
      : `Crypto momentum: ${research.reasoning}`;
    const result = await ctx.broker.buy(signal.symbol, positionSize, tradeReason);
    if (result.submitted) {
      rememberPendingCryptoBuy(ctx, signal.symbol, Date.now());
      trackCryptoPositionEntry(ctx, signal, research, tradeReason);
      for (const alias of getCryptoSymbolAliases(signal.symbol)) {
        heldCrypto.add(alias);
      }
      cryptoPositions.push({ symbol: normalizeCryptoSymbol(signal.symbol) } as Position);
      break;
    }
    ctx.log("Crypto", "buy_blocked", {
      symbol: signal.symbol,
      reason: result.reason,
      ...(result.metadata ?? {}),
    });
  }
}

function getCryptoAtr(ctx: StrategyContext, symbol: string): number | undefined {
  const atrCache = ctx.state.get<Record<string, number>>("atrCache");
  for (const alias of getCryptoSymbolAliases(symbol)) {
    const atr = atrCache?.[alias];
    if (atr !== undefined) return atr;
  }
  return undefined;
}

function isPromotableCryptoWait(result: ResearchResult, ctx: StrategyContext): boolean {
  if (result.verdict !== "WAIT") return false;
  if (!["excellent", "good", "fair"].includes(result.entry_quality)) return false;
  if (result.red_flags.length > 1) return false;
  return result.confidence >= ctx.config.min_analyst_confidence;
}
