import type { ResearchResult } from "./types";

const RESEARCH_VERDICTS = ["BUY", "SKIP", "WAIT"] as const;
const ENTRY_QUALITIES = ["excellent", "good", "fair", "poor"] as const;

type ResearchVerdict = (typeof RESEARCH_VERDICTS)[number];
type EntryQuality = (typeof ENTRY_QUALITIES)[number];

export interface ResearchAnalysisPayload {
  verdict: unknown;
  confidence: unknown;
  entry_quality: unknown;
  reasoning: unknown;
  red_flags?: unknown;
  catalysts?: unknown;
  recommended_entry_zone?: unknown;
  stop_loss_pct?: unknown;
  take_profit_pct?: unknown;
}

function isResearchVerdict(value: unknown): value is ResearchVerdict {
  return typeof value === "string" && RESEARCH_VERDICTS.includes(value.trim().toUpperCase() as ResearchVerdict);
}

function isEntryQuality(value: unknown): value is EntryQuality {
  return typeof value === "string" && ENTRY_QUALITIES.includes(value.trim().toLowerCase() as EntryQuality);
}

function optionalStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Invalid research ${field}: expected string array`);
  }
  return value;
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid research ${field}: expected finite number`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`Invalid research ${field}: expected string`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeResearchAnalysis(
  symbol: string,
  payload: ResearchAnalysisPayload,
  extras: Pick<ResearchResult, "sentiment"> = {}
): ResearchResult {
  if (!isResearchVerdict(payload.verdict)) {
    throw new Error(`Invalid research verdict for ${symbol}: ${String(payload.verdict)}`);
  }
  if (typeof payload.confidence !== "number" || !Number.isFinite(payload.confidence)) {
    throw new Error(`Invalid research confidence for ${symbol}: ${String(payload.confidence)}`);
  }
  if (payload.confidence < 0 || payload.confidence > 1) {
    throw new Error(`Invalid research confidence for ${symbol}: ${payload.confidence}`);
  }
  if (!isEntryQuality(payload.entry_quality)) {
    throw new Error(`Invalid research entry_quality for ${symbol}: ${String(payload.entry_quality)}`);
  }
  if (typeof payload.reasoning !== "string" || payload.reasoning.trim().length === 0) {
    throw new Error(`Invalid research reasoning for ${symbol}: expected non-empty string`);
  }

  const recommendedEntryZone = optionalString(payload.recommended_entry_zone, "recommended_entry_zone");

  return {
    symbol,
    verdict: payload.verdict.trim().toUpperCase() as ResearchVerdict,
    confidence: payload.confidence,
    entry_quality: payload.entry_quality.trim().toLowerCase() as EntryQuality,
    reasoning: payload.reasoning.trim(),
    red_flags: optionalStringArray(payload.red_flags, "red_flags"),
    catalysts: optionalStringArray(payload.catalysts, "catalysts"),
    sentiment: extras.sentiment,
    timestamp: Date.now(),
    recommended_entry_zone: recommendedEntryZone,
    stop_loss_pct: optionalNumber(payload.stop_loss_pct, "stop_loss_pct"),
    take_profit_pct: optionalNumber(payload.take_profit_pct, "take_profit_pct"),
  };
}
