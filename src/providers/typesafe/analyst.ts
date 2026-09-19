/**
 * Jev analyst — batch signal adjudication via TypeSafe System One questions.
 *
 * Replaces the free-form LLM analyst prompt with per-candidate judgments:
 * one Choice question (BUY/SELL/HOLD) per candidate symbol, plus a speculative
 * Score question per candidate for position sizing that is only consumed when
 * the choice is BUY. All questions run in a single systemone request.
 */

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
  config: JevAnalystConfig;
  now?: number;
}

export interface JevAnalystRecommendation {
  action: "BUY" | "SELL" | "HOLD";
  symbol: string;
  confidence: number;
  reasoning: string;
  suggested_size_pct?: number;
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

  return Array.from(aggregated.values())
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
      return {
        symbol: c.symbol,
        avg_sentiment: Number(c.avgSentiment.toFixed(3)),
        signal_count: c.count,
        sources: c.sources,
        currently_held: c.held,
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
      };
    }),
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
      instructions: `Decide the trading action for the candidate at \`candidates[${index}]\` (symbol ${candidate.symbol}).`,
      criteria: {
        BUY: "Open a new long position. Appropriate only when the symbol is not currently held, research verdict is BUY with solid confidence and entry quality, and sentiment is strong across multiple sources.",
        SELL: "Exit the currently held position. Appropriate only when the symbol is currently held and shows deteriorating sentiment, red flags, or hits the stop-loss/take-profit rules. Do not sell solely because gains are small.",
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
      confidence: probability,
      reasoning: `jev: ${distribution} (confidence ${answer.confidence.toFixed(2)})`,
    };

    if (action === "BUY") {
      const sizeAnswer = asScoreAnswer(answers[`size_${index}`]);
      if (sizeAnswer) {
        const level = Math.min(SIZE_LEVEL_TO_PCT.length - 1, Math.max(0, Math.round(sizeAnswer.score)));
        rec.suggested_size_pct = SIZE_LEVEL_TO_PCT[level];
      }
    }

    if (action !== "HOLD" && probability >= HIGH_CONVICTION_THRESHOLD) {
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
