/**
 * Analyst prompt builder — batch signal analysis for trading decisions.
 */

import { type DecisionMemory, formatDecisionMemoryBlock } from "../../../core/decision-memory";
import type { Account, Position, ResearchResult, Signal } from "../../../core/types";
import type { AnalyzeSignalsPromptBuilder, PromptTemplate, StrategyContext } from "../../types";
import { getCryptoSymbolAliases, isCryptoSymbol } from "../helpers/crypto";

/**
 * Analyst prompt — analyze signals and current positions to generate
 * BUY/SELL/HOLD recommendations.
 */
export const analyzeSignalsPrompt: AnalyzeSignalsPromptBuilder = (
  signals: Signal[],
  positions: Position[],
  account: Account,
  ctx: StrategyContext
): PromptTemplate => {
  const aggregated = new Map<string, { symbol: string; sources: string[]; totalSentiment: number; count: number }>();
  for (const sig of signals) {
    if (!aggregated.has(sig.symbol)) {
      aggregated.set(sig.symbol, { symbol: sig.symbol, sources: [], totalSentiment: 0, count: 0 });
    }
    const agg = aggregated.get(sig.symbol)!;
    agg.sources.push(sig.source);
    agg.totalSentiment += sig.sentiment;
    agg.count++;
  }

  const signalCandidates = Array.from(aggregated.values())
    .map((a) => ({ ...a, avgSentiment: a.totalSentiment / a.count }))
    .filter((a) => a.avgSentiment >= ctx.config.min_sentiment_score * 0.5)
    .sort((a, b) => b.avgSentiment - a.avgSentiment)
    .slice(0, 10);

  const positionSymbols = new Set(
    positions.flatMap((p) =>
      isCryptoSymbol(p.symbol, ctx.config.crypto_symbols || []) ? getCryptoSymbolAliases(p.symbol) : [p.symbol]
    )
  );
  const candidates = [
    ...signalCandidates,
    ...positions
      .filter((position) => !signalCandidates.some((candidate) => candidate.symbol === position.symbol))
      .map((position) => ({ symbol: position.symbol, sources: [], totalSentiment: 0, count: 0, avgSentiment: 0 })),
  ];

  const researchMap = ctx.state.get<Record<string, ResearchResult>>("signalResearch") ?? {};
  const decisionMemory = ctx.state.get<DecisionMemory>("decisionMemory");
  const researchLines = candidates.map((c) => {
    const research = researchMap[c.symbol];
    const positionResearch = ctx.state.get<Record<string, { recommendation?: string; reasoning?: string }>>("positionResearch")?.[
      c.symbol
    ];
    if (!research && positionResearch) {
      return `- ${c.symbol}: POSITION ${positionResearch.recommendation ?? "UNKNOWN"} — ${(positionResearch.reasoning ?? "").slice(0, 160)}`;
    }
    if (!research) return `- ${c.symbol}: NO RESEARCH (BUY will be rejected — research required)`;
    return `- ${c.symbol}: ${research.verdict} (confidence ${research.confidence.toFixed(2)}, entry quality ${research.entry_quality}) — ${research.reasoning.slice(0, 160)}`;
  });
  const marketContextLines = candidates.map((candidate) => formatMarketContext(candidate.symbol, ctx));
  const marketRegime = ctx.state.get<Record<string, number | undefined>>("marketRegimeCache");
  const regimeLine = (symbol: "SPY" | "QQQ") => {
    const price = marketRegime?.[`${symbol.toLowerCase()}Price`];
    const sma20 = marketRegime?.[`${symbol.toLowerCase()}Sma20`];
    const sma50 = marketRegime?.[`${symbol.toLowerCase()}Sma50`];
    const pct = (reference: number | undefined) =>
      typeof price === "number" && typeof reference === "number" && reference !== 0
        ? `${(((price - reference) / reference) * 100).toFixed(2)}%`
        : "n/a";
    return `${symbol}: vs SMA20 ${pct(sma20)}, vs SMA50 ${pct(sma50)}`;
  };

  const user = `Current Time: ${new Date().toISOString()}

ACCOUNT STATUS:
- Equity: $${account.equity.toFixed(2)}
- Cash: $${account.cash.toFixed(2)}
- Buying Power: $${account.buying_power.toFixed(2)}
- Current Positions: ${positions.length}/${ctx.config.max_positions}

CURRENT POSITIONS:
${
  positions.length === 0
    ? "None"
    : positions
        .map((p) => {
          const entry = getPositionEntry(p.symbol, ctx);
          const holdMinutes = entry ? Math.round((Date.now() - entry.entry_time) / (1000 * 60)) : 0;
          const holdStr = holdMinutes >= 60 ? `${(holdMinutes / 60).toFixed(1)}h` : `${holdMinutes}m`;
          return `- ${p.symbol}: ${p.qty} shares, P&L: $${p.unrealized_pl.toFixed(2)} (${((p.unrealized_pl / (p.market_value - p.unrealized_pl)) * 100).toFixed(1)}%), held ${holdStr}`;
        })
        .join("\n")
}

TOP SENTIMENT CANDIDATES:
${candidates
  .map(
    (c) =>
      `- ${c.symbol}: avg sentiment ${(c.avgSentiment * 100).toFixed(0)}%, sources: ${c.sources.join(", ")}, ${positionSymbols.has(c.symbol) ? "[CURRENTLY HELD]" : "[NOT HELD]"}`
  )
  .join("\n")}

SIGNAL RESEARCH VERDICTS (from the per-symbol research stage):
${researchLines.join("\n")}

MARKET CONTEXT (technical indicators and price momentum):
${marketContextLines.join("\n")}
Broad market trend: ${regimeLine("SPY")}; ${regimeLine("QQQ")}

RAW SIGNALS (top 20):
${signals
  .slice(0, 20)
  .map((s) => `- ${s.symbol} (${s.source}): ${s.reason}`)
  .join("\n")}

TRADING RULES:
- Max position size: $${ctx.config.max_position_value}
- Take profit target: ${ctx.config.take_profit_pct}%
- Stop loss: ${ctx.config.stop_loss_pct}%
- Min confidence to trade: ${ctx.config.min_analyst_confidence}
- Confidence means confidence in the action choice, not a calibrated probability of profit or positive expected return.
- Min hold time before selling: ${ctx.config.llm_min_hold_minutes ?? 30} minutes
${decisionMemory ? `\n${formatDecisionMemoryBlock(decisionMemory)}\n` : ""}
Analyze and provide BUY/SELL/HOLD recommendations:`;

  return {
    system: `You are a senior trading analyst AI. Make the FINAL trading decisions based on social sentiment signals.

Rules:
- Only recommend BUY for symbols with strong conviction from multiple data points
- Do NOT recommend BUY for symbols whose research verdict is SKIP or missing — those orders are rejected automatically by the entry guard
- Recommend SELL only for positions that have been held long enough AND show deteriorating sentiment or major red flags
- Give positions time to develop - avoid selling too early just because gains are small
- Positions held less than 1-2 hours should generally be given more time unless hitting stop loss
- Consider the QUALITY of sentiment, not just quantity
- Use fresh, sufficiently complete technical and momentum data to judge entry timing; treat stale, limited-history, or missing data as unknown.
- Action confidence is not expected return. Prefer HOLD when current evidence does not support a positive risk-adjusted edge.
- Output valid JSON only

Response format:
{
  "recommendations": [
    { "action": "BUY"|"SELL"|"HOLD", "symbol": "TICKER", "confidence": 0.0-1.0, "action_probability": 0.0-1.0, "reasoning": "detailed reasoning", "suggested_size_pct": 10-30 }
  ],
  "market_summary": "overall market read and sentiment",
  "high_conviction_plays": ["symbols you feel strongest about"]
}`,
    user,
    model: ctx.config.llm_analyst_model,
    maxTokens: 1600,
  };
};

function formatMarketContext(symbol: string, ctx: StrategyContext): string {
  interface TechnicalContext {
    updated_at?: number;
    current_price?: number;
    rsi?: number;
    sma_20?: number;
    sma_50?: number;
    atr?: number;
    relative_volume?: number;
    daily_bars?: number;
    hourly_bars?: number;
  }
  interface MomentumContext {
    updated_at?: number;
    price_change_1h?: number;
    price_change_24h?: number;
  }

  const technical = ctx.state.get<Record<string, TechnicalContext>>("technicalDataCache")?.[symbol];
  const momentum = ctx.state.get<Record<string, MomentumContext>>("momentumDataCache")?.[symbol];
  const updateTimes = [technical?.updated_at, momentum?.updated_at].filter(
    (value): value is number => typeof value === "number" && value > 0
  );
  if (!technical && !momentum) return `- ${symbol}: unavailable`;

  const updatedAt = updateTimes.length ? Math.min(...updateTimes) : 0;
  const ageMinutes = Math.max(0, (Date.now() - updatedAt) / 60_000);
  const price = technical?.current_price;
  const pctFrom = (reference: number | undefined) =>
    typeof price === "number" && typeof reference === "number" && reference !== 0
      ? `${(((price - reference) / reference) * 100).toFixed(2)}%`
      : "n/a";
  const atrPct =
    typeof price === "number" && price > 0 && typeof technical?.atr === "number"
      ? `${((technical.atr / price) * 100).toFixed(2)}%`
      : "n/a";
  const dataQuality =
    technical?.daily_bars === undefined
      ? "price-only/unverified history"
      : technical.daily_bars >= 50
        ? `${technical.daily_bars} daily bars`
        : `limited history (${technical.daily_bars} daily bars)`;

  return [
    `- ${symbol}: cache ${ageMinutes <= 15 ? "fresh" : "stale"} (${ageMinutes.toFixed(1)}m old), ${dataQuality}`,
    `price ${typeof price === "number" ? `$${price.toFixed(2)}` : "n/a"}, RSI ${technical?.rsi?.toFixed(1) ?? "n/a"}`,
    `vs SMA20 ${pctFrom(technical?.sma_20)}, vs SMA50 ${pctFrom(technical?.sma_50)}, ATR ${atrPct}, relative volume ${technical?.relative_volume?.toFixed(2) ?? "n/a"}x`,
    `momentum 1h ${momentum?.price_change_1h?.toFixed(2) ?? "n/a"}%, 24h ${momentum?.price_change_24h?.toFixed(2) ?? "n/a"}%`,
  ].join("; ");
}

function getPositionEntry(symbol: string, ctx: StrategyContext) {
  const directMatch = ctx.positionEntries[symbol];
  if (directMatch) return directMatch;

  if (!isCryptoSymbol(symbol, ctx.config.crypto_symbols || [])) {
    return undefined;
  }

  for (const alias of getCryptoSymbolAliases(symbol)) {
    const candidate = ctx.positionEntries[alias];
    if (candidate) return candidate;
  }

  return undefined;
}
