/**
 * Jev analyst — batch signal adjudication via TypeSafe System One questions.
 *
 * Replaces the free-form LLM analyst prompt with per-candidate judgments:
 * one Choice question (BUY/SELL/HOLD) per candidate symbol, plus a speculative
 * Score question per candidate for position sizing that is only consumed when
 * the choice is BUY. All questions run in a single systemone request.
 */

import type { DecisionMemory } from "../../core/decision-memory";
import type { PositionEntry, ResearchResult, Signal } from "../../core/types";
import type { Account, Position } from "../types";
import {
  asChoiceAnswer,
  asScoreAnswer,
  type ChoiceQuestion,
  type JsonValue,
  type ScoreQuestion,
  type TypeSafeAnswer,
  type TypeSafeClient,
} from "./client";

export interface JevAnalystConfig {
  min_sentiment_score: number;
  max_positions: number;
  max_position_value: number;
  take_profit_pct: number;
  stop_loss_pct: number;
  llm_min_hold_minutes?: number;
}

export interface JevAnalystInput {
  signals: Signal[];
  positions: Position[];
  account: Account;
  research: Record<string, ResearchResult>;
  positionEntries: Record<string, PositionEntry>;
  marketContext?: Record<string, JevMarketContext>;
  marketRegime?: Record<string, unknown> | null;
  config: JevAnalystConfig;
  memory?: DecisionMemory;
  now?: number;
}

export interface JevMarketContext {
  updated_at: number;
  current_price?: number;
  rsi?: number;
  sma_20?: number;
  sma_50?: number;
  atr?: number;
  relative_volume?: number;
  daily_bars?: number;
  hourly_bars?: number;
  price_change_1h?: number;
  price_change_24h?: number;
  sector?: string;
}

export interface JevAnalystRecommendation {
  action: "BUY" | "SELL" | "HOLD";
  symbol: string;
  /** Model's self-reported confidence in its response, not the return probability. */
  confidence: number;
  /** Probability assigned to the selected BUY/SELL/HOLD choice. */
  action_probability: number;
  reasoning: string;
  suggested_size_pct?: number;
}

function percentFrom(value: number | undefined, reference: number | undefined): number | null {
  if (value === undefined || reference === undefined || reference === 0) return null;
  return Number((((value - reference) / reference) * 100).toFixed(2));
}

function summarizeMarketRegime(regime: Record<string, unknown> | null, key: "spy" | "qqq") {
  const price = regime?.[`${key}Price`];
  const sma20 = regime?.[`${key}Sma20`];
  const sma50 = regime?.[`${key}Sma50`];
  const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
  return {
    price_vs_sma_20_pct: isNumber(price) && isNumber(sma20) ? percentFrom(price, sma20) : null,
    price_vs_sma_50_pct: isNumber(price) && isNumber(sma50) ? percentFrom(price, sma50) : null,
  };
}

export interface JevAnalystResult {
  recommendations: JevAnalystRecommendation[];
  market_summary: string;
  high_conviction: string[];
  model: string;
  usage: { input_tokens: number; output_tokens: number };
}

const MAX_CANDIDATES = 10;
const HIGH_CONVICTION_THRESHOLD = 0.8;
const SIZE_LEVEL_TO_PCT = [10, 20, 30];

interface Candidate {
  symbol: string;
  avgSentiment: number;
  sources: string[];
  count: number;
  held: boolean;
}

function aggregateCandidates(signals: Signal[], minSentiment: number, heldSymbols: Set<string>): Candidate[] {
  const aggregated = new Map<string, { symbol: string; sources: string[]; totalSentiment: number; count: number }>();
  for (const sig of signals) {
    let agg = aggregated.get(sig.symbol);
    if (!agg) {
      agg = { symbol: sig.symbol, sources: [], totalSentiment: 0, count: 0 };
      aggregated.set(sig.symbol, agg);
    }
    agg.sources.push(sig.source);
    agg.totalSentiment += sig.sentiment;
    agg.count++;
  }

  const candidates = Array.from(aggregated.values())
    .map((a) => ({
      symbol: a.symbol,
      avgSentiment: a.totalSentiment / a.count,
      sources: a.sources,
      count: a.count,
      held: heldSymbols.has(a.symbol),
    }))
    .filter((a) => a.avgSentiment >= minSentiment * 0.5)
    .sort((a, b) => b.avgSentiment - a.avgSentiment)
    .slice(0, MAX_CANDIDATES);
  for (const symbol of heldSymbols) {
    if (!candidates.some((candidate) => candidate.symbol === symbol)) {
      candidates.push({ symbol, avgSentiment: 0, sources: [], count: 0, held: true });
    }
  }
  return candidates;
}

export function buildJevAnalystRequest(input: JevAnalystInput): {
  state: Record<string, unknown>;
  questions: Record<string, ChoiceQuestion | ScoreQuestion>;
  candidates: Candidate[];
} {
  const now = input.now ?? Date.now();
  const heldSymbols = new Set(input.positions.map((p) => p.symbol));
  const candidates = aggregateCandidates(input.signals, input.config.min_sentiment_score, heldSymbols);

  const state = {
    account: {
      equity: input.account.equity,
      cash: input.account.cash,
      buying_power: input.account.buying_power,
      open_positions: input.positions.length,
      max_positions: input.config.max_positions,
    },
    positions: input.positions.map((p) => {
      const entry = input.positionEntries[p.symbol];
      const costBasis = p.market_value - p.unrealized_pl;
      return {
        symbol: p.symbol,
        qty: p.qty,
        unrealized_pl: p.unrealized_pl,
        unrealized_plpc: costBasis > 0 ? (p.unrealized_pl / costBasis) * 100 : null,
        hold_minutes: entry ? Math.round((now - entry.entry_time) / 60_000) : null,
      };
    }),
    candidates: candidates.map((c) => {
      const research = input.research[c.symbol];
      const trackRecord = input.memory?.symbols[c.symbol];
      const market = input.marketContext?.[c.symbol];
      const marketAgeMinutes = market ? Math.max(0, (now - market.updated_at) / 60_000) : null;
      const currentPrice = market?.current_price;
      return {
        symbol: c.symbol,
        avg_sentiment: Number(c.avgSentiment.toFixed(3)),
        signal_count: c.count,
        sources: c.sources,
        currently_held: c.held,
        market_context: market
          ? {
              as_of: new Date(market.updated_at).toISOString(),
              cache_age_minutes: Number(marketAgeMinutes!.toFixed(1)),
              cache_freshness: marketAgeMinutes! <= 15 ? "fresh" : "stale",
              technical_data_quality:
                market.daily_bars === undefined
                  ? "price_only_or_unverified"
                  : market.daily_bars >= 50
                    ? "sufficient_history"
                    : "limited_history",
              daily_bars: market.daily_bars ?? null,
              hourly_bars: market.hourly_bars ?? null,
              current_price: currentPrice ?? null,
              rsi_14: market.rsi ?? null,
              price_vs_sma_20_pct: percentFrom(currentPrice, market.sma_20),
              price_vs_sma_50_pct: percentFrom(currentPrice, market.sma_50),
              atr_pct:
                currentPrice && market.atr !== undefined
                  ? Number(((market.atr / currentPrice) * 100).toFixed(2))
                  : null,
              relative_volume: market.relative_volume ?? null,
              momentum_1h_pct: market.price_change_1h ?? null,
              momentum_24h_pct: market.price_change_24h ?? null,
              sector: market.sector ?? null,
            }
          : null,
        research: research
          ? {
              verdict: research.verdict,
              confidence: research.confidence,
              entry_quality: research.entry_quality,
              reasoning: research.reasoning.slice(0, 240),
              red_flags: research.red_flags,
              catalysts: research.catalysts,
            }
          : null,
        track_record: trackRecord
          ? {
              evaluations: trackRecord.evaluations,
              avg_t1_return_pct: trackRecord.avg_t1 !== null ? Number((trackRecord.avg_t1 * 100).toFixed(2)) : null,
              avg_t5_return_pct: trackRecord.avg_t5 !== null ? Number((trackRecord.avg_t5 * 100).toFixed(2)) : null,
              win_rate_t1: trackRecord.win_rate_t1 !== null ? Number(trackRecord.win_rate_t1.toFixed(2)) : null,
            }
          : null,
      };
    }),
    memory: input.memory
      ? {
          window_days: input.memory.window_days,
          closed_trades_30d: {
            count: input.memory.closed_trades.count,
            win_rate: Number(input.memory.closed_trades.win_rate.toFixed(2)),
            avg_pnl_pct:
              input.memory.closed_trades.avg_pnl_pct !== null
                ? Number(input.memory.closed_trades.avg_pnl_pct.toFixed(2))
                : null,
          },
          // Top measured relationships — Jev sees what has actually predicted returns.
          feature_lessons: input.memory.feature_lessons.slice(0, 5).map((f) => ({
            feature: f.feature,
            horizon: f.horizon,
            ic: Number(f.ic.toFixed(3)),
            n: f.n,
          })),
          action_lessons: input.memory.action_lessons.slice(0, 8).map((lesson) => ({
            action: lesson.action,
            n: lesson.n,
            mean_t1_return_pct: lesson.mean_t1 !== null ? Number((lesson.mean_t1 * 100).toFixed(2)) : null,
            mean_t5_return_pct: lesson.mean_t5 !== null ? Number((lesson.mean_t5 * 100).toFixed(2)) : null,
            win_rate_t1: lesson.win_rate_t1 !== null ? Number(lesson.win_rate_t1.toFixed(2)) : null,
          })),
        }
      : null,
    market_regime: {
      spy: summarizeMarketRegime(input.marketRegime ?? null, "spy"),
      qqq: summarizeMarketRegime(input.marketRegime ?? null, "qqq"),
    },
    rules: {
      max_position_value: input.config.max_position_value,
      take_profit_pct: input.config.take_profit_pct,
      stop_loss_pct: input.config.stop_loss_pct,
      min_hold_minutes_before_sell: input.config.llm_min_hold_minutes ?? 30,
    },
  };

  const questions: Record<string, ChoiceQuestion | ScoreQuestion> = {};
  candidates.forEach((candidate, index) => {
    questions[`action_${index}`] = {
      type: "choice",
      instructions: `Decide the trading action for the candidate at \`candidates[${index}]\` (symbol ${candidate.symbol}). The candidate's \`market_context\` is the latest cached technical/momentum snapshot; treat stale, incomplete, or missing fields as unknown, not as confirmation. Compare the evidence with \`market_regime\`, the BUY/SELL research verdict, and the measured \`track_record\` / \`memory\`. Social sentiment alone is not an edge. Prefer HOLD when evidence is mixed, stale, or does not support positive expected return after risk. Choice probabilities describe preference among BUY/SELL/HOLD labels, not probability of profit or expected return.`,
      criteria: {
        BUY: "Open a new long position only when it is not currently held, research verdict is BUY, and current market evidence supports a favorable risk-adjusted entry rather than merely a likely BUY classification. Do not let sentiment quantity replace technical confirmation. A negative track_record requires materially stronger current evidence.",
        SELL: "Exit the currently held position. Appropriate only when the symbol is currently held and shows deteriorating sentiment, red flags, or hits the stop-loss/take-profit rules. Do not sell solely because gains are small; a strong positive track_record argues for patience.",
        HOLD: "Take no action on this symbol.",
      },
    };
    questions[`size_${index}`] = {
      type: "score",
      instructions: `If the decision for \`candidates[${index}]\` (symbol ${candidate.symbol}) were BUY, what position size is appropriate given conviction, research quality, and risk?`,
      criteria: [
        "Small position (~10% of the per-trade budget) — tentative or mixed evidence",
        "Standard position (~20% of the per-trade budget) — solid conviction",
        "Large position (~30% of the per-trade budget) — exceptional conviction with strong research and catalysts",
      ],
    };
  });

  return { state, questions, candidates };
}

export function mapJevAnalystAnswers(
  candidates: Candidate[],
  answers: Record<string, TypeSafeAnswer>
): Omit<JevAnalystResult, "model" | "usage"> {
  const recommendations: JevAnalystRecommendation[] = [];
  const highConviction: string[] = [];

  candidates.forEach((candidate, index) => {
    const answer = asChoiceAnswer(answers[`action_${index}`]);
    if (!answer) return;

    const action = (["BUY", "SELL", "HOLD"] as const).includes(answer.choice as "BUY" | "SELL" | "HOLD")
      ? (answer.choice as "BUY" | "SELL" | "HOLD")
      : "HOLD";
    const probability = answer.probabilities[answer.choice] ?? 0;
    const distribution = (["BUY", "SELL", "HOLD"] as const)
      .map((option) => `${option}=${(answer.probabilities[option] ?? 0).toFixed(2)}`)
      .join(" ");

    const rec: JevAnalystRecommendation = {
      action,
      symbol: candidate.symbol,
      confidence: answer.confidence,
      action_probability: probability,
      reasoning: `jev: ${distribution} (confidence ${answer.confidence.toFixed(2)})`,
    };

    if (action === "BUY") {
      const sizeAnswer = asScoreAnswer(answers[`size_${index}`]);
      if (sizeAnswer) {
        const level = Math.min(SIZE_LEVEL_TO_PCT.length - 1, Math.max(0, Math.round(sizeAnswer.score)));
        rec.suggested_size_pct = SIZE_LEVEL_TO_PCT[level];
      }
    }

    if (
      action !== "HOLD" &&
      probability >= HIGH_CONVICTION_THRESHOLD &&
      answer.confidence >= HIGH_CONVICTION_THRESHOLD
    ) {
      highConviction.push(candidate.symbol);
    }

    recommendations.push(rec);
  });

  const buys = recommendations.filter((r) => r.action === "BUY").length;
  const sells = recommendations.filter((r) => r.action === "SELL").length;
  const holds = recommendations.filter((r) => r.action === "HOLD").length;

  return {
    recommendations,
    market_summary: `Jev evaluated ${candidates.length} candidates: ${buys} BUY, ${sells} SELL, ${holds} HOLD.`,
    high_conviction: highConviction,
  };
}

export async function analyzeSignalsWithJev(client: TypeSafeClient, input: JevAnalystInput): Promise<JevAnalystResult> {
  const { state, questions, candidates } = buildJevAnalystRequest(input);
  if (candidates.length === 0) {
    return {
      recommendations: [],
      market_summary: "No candidates met the sentiment threshold",
      high_conviction: [],
      model: client.modelId,
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }

  const response = await client.systemOne({ state: state as JsonValue, questions });
  const mapped = mapJevAnalystAnswers(candidates, response.answers);

  return {
    ...mapped,
    model: response.model,
    usage: response.usage,
  };
}
