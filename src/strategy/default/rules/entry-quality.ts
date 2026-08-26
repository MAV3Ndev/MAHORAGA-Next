import type { AgentConfig, ResearchResult, Signal } from "../../../core/types";
import type { StrategyContext } from "../../types";
import type { TechnicalData } from "./entry-timing";

export interface EntryQualityEvidence {
  sourceCount: number;
  marketEvidenceSourceCount: number;
  catalystCount: number;
  priceChange1h?: number;
  priceChange24h?: number;
  trendConfirmed: boolean;
  momentumConfirmed: boolean;
  evidenceAxes: number;
}

export interface EntryQualityResult {
  allowed: boolean;
  reason?:
    | "insufficient_evidence"
    | "social_only"
    | "missing_catalyst"
    | "excessive_24h_move"
    | "excessive_1h_move"
    | "trend_confirmation_missing";
  evidence: EntryQualityEvidence;
}

const MARKET_EVIDENCE_SOURCES = new Set(["alpha_vantage", "gdelt", "sec_edgar"]);

export function evaluateEntryQualityForSymbol(ctx: StrategyContext, research: ResearchResult): EntryQualityResult {
  const technicalCache = ctx.state.get<Record<string, TechnicalData>>("technicalDataCache");
  const momentumCache =
    ctx.state.get<Record<string, { price_change_1h?: number; price_change_24h?: number }>>("momentumDataCache");
  const signal = ctx.signals.find((item) => item.symbol === research.symbol);
  const technical = technicalCache?.[research.symbol] ?? { current_price: signal?.price ?? 0 };

  return evaluateEntryQuality(
    research,
    ctx.signals.filter((item) => item.symbol === research.symbol),
    technical,
    momentumCache?.[research.symbol],
    ctx.config
  );
}

export function evaluateEntryQuality(
  research: ResearchResult,
  signals: Signal[],
  technical: TechnicalData,
  momentum: { price_change_1h?: number; price_change_24h?: number } | undefined,
  config: Pick<
    AgentConfig,
    | "entry_min_evidence_axes"
    | "entry_require_catalyst"
    | "entry_require_trend_confirmation"
    | "entry_max_price_change_24h_pct"
    | "entry_max_price_change_1h_pct"
  >
): EntryQualityResult {
  const sources = new Set(signals.map((signal) => signal.source));
  const sourceCount = sources.size;
  const marketEvidenceSourceCount = Array.from(sources).filter((source) => MARKET_EVIDENCE_SOURCES.has(source)).length;
  const catalystCount = research.catalysts.length;
  const trendConfirmed =
    technical.sma_20 !== undefined && technical.sma_50 !== undefined && technical.sma_20 > technical.sma_50;
  const momentumConfirmed =
    (momentum?.price_change_24h !== undefined && momentum.price_change_24h >= 0) ||
    (momentum?.price_change_1h !== undefined && momentum.price_change_1h >= 0);
  const evidence: EntryQualityEvidence = {
    sourceCount,
    marketEvidenceSourceCount,
    catalystCount,
    priceChange1h: momentum?.price_change_1h,
    priceChange24h: momentum?.price_change_24h,
    trendConfirmed,
    momentumConfirmed,
    evidenceAxes:
      Number(marketEvidenceSourceCount > 0) +
      Number(catalystCount > 0) +
      Number(trendConfirmed) +
      Number(momentumConfirmed),
  };

  if (evidence.marketEvidenceSourceCount === 0) {
    return { allowed: false, reason: "social_only", evidence };
  }
  if (config.entry_require_catalyst && evidence.catalystCount === 0) {
    return { allowed: false, reason: "missing_catalyst", evidence };
  }
  if (
    evidence.priceChange24h !== undefined &&
    Math.abs(evidence.priceChange24h) > config.entry_max_price_change_24h_pct
  ) {
    return { allowed: false, reason: "excessive_24h_move", evidence };
  }
  if (evidence.priceChange1h !== undefined && Math.abs(evidence.priceChange1h) > config.entry_max_price_change_1h_pct) {
    return { allowed: false, reason: "excessive_1h_move", evidence };
  }
  if (config.entry_require_trend_confirmation && !evidence.trendConfirmed) {
    return { allowed: false, reason: "trend_confirmation_missing", evidence };
  }
  if (evidence.evidenceAxes < config.entry_min_evidence_axes) {
    return { allowed: false, reason: "insufficient_evidence", evidence };
  }

  return { allowed: true, evidence };
}
