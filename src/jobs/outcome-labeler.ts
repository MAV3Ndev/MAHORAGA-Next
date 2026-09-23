/**
 * Forward-return labeling for trade decisions.
 *
 * Every decision row in `trade_decisions` (submitted, blocked, filtered,
 * recorded — including counterfactuals) gets labeled with the symbol's
 * forward returns at fixed horizons (T+1/T+5/T+20 trading days) computed
 * from Alpaca daily bars. Baseline convention:
 *   - the decision row's recorded `price` when present,
 *   - otherwise the close of the daily bar covering the decision timestamp
 *     ("same-day close"; ranking convention — it never uses future data as
 *     an input feature, it only defines the return's starting point).
 *
 * Idempotent: outcomes are upserted; partial rows are re-labeled until all
 * horizons are filled or the data window is exhausted.
 */
import type { Env } from "../env.d";
import { createAlpacaProviders } from "../providers/alpaca";
import type { AlpacaMarketDataProvider } from "../providers/alpaca/market-data";
import type { Bar } from "../providers/types";
import { createD1Client } from "../storage/d1/client";
import {
  queryUnlabeledDecisions,
  type UnlabeledDecisionRow,
  upsertDecisionOutcome,
} from "../storage/d1/queries/decision-outcomes";
import { createR2Client } from "../storage/r2/client";

const DAY_MS = 24 * 60 * 60 * 1000;
/** ~20 trading days in calendar days; beyond this a missing T+20 is a data gap, not pending. */
const T20_EXPECTED_MS = 28 * DAY_MS;

export interface ForwardReturns {
  baseline_price: number;
  baseline_at: string;
  t1_return: number | null;
  t5_return: number | null;
  t20_return: number | null;
}

/**
 * Forward returns from a daily-bar series.
 * Baseline bar = last bar with t <= decision time (the decision-day close).
 * Returns null when no bar precedes the decision or baseline is invalid.
 */
export function computeForwardReturns(
  bars: Bar[],
  decisionAtIso: string,
  recordedPrice: number | null
): ForwardReturns | null {
  const decisionMs = Date.parse(decisionAtIso);
  if (!Number.isFinite(decisionMs) || bars.length === 0) return null;

  const sorted = [...bars].sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  let i0 = -1;
  for (let i = 0; i < sorted.length; i++) {
    if (Date.parse(sorted[i]!.t) <= decisionMs) i0 = i;
    else break;
  }
  if (i0 < 0) return null;

  const baselineBar = sorted[i0]!;
  const baseline = recordedPrice && recordedPrice > 0 ? recordedPrice : baselineBar.c;
  if (!Number.isFinite(baseline) || baseline <= 0) return null;

  const fwd = (offset: number): number | null => {
    const bar = sorted[i0 + offset];
    return bar ? (bar.c - baseline) / baseline : null;
  };

  return {
    baseline_price: baseline,
    baseline_at: baselineBar.t,
    t1_return: fwd(1),
    t5_return: fwd(5),
    t20_return: fwd(20),
  };
}

// ---------------------------------------------------------------------------
// Feature extraction
// ---------------------------------------------------------------------------

const ENTRY_QUALITY_SCORE: Record<string, number> = {
  excellent: 4,
  good: 3,
  fair: 2,
  poor: 1,
};

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function parseJsonObject(text: string | null | undefined): Record<string, unknown> | null {
  if (!text) return null;
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

/** Parse "jev: BUY=0.72 SELL=0.08 HOLD=0.20" style distributions from a reason string. */
export function parseJevDistribution(reason: string | null | undefined): Record<string, number> | null {
  if (!reason || !reason.startsWith("jev:")) return null;
  const out: Record<string, number> = {};
  const re = /([A-Z]+)=([0-9.]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(reason)) !== null) {
    const p = Number.parseFloat(match[2]!);
    if (Number.isFinite(p)) out[match[1]!] = p;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Extract numeric/categorical indicator features from a decision row and its
 * R2 snapshot. Missing data simply produces absent keys — the report only
 * evaluates features that are present.
 */
export function extractDecisionFeatures(
  row: { action: string; status: string; metadata_json?: string | null; reason?: string | null },
  snapshot: unknown
): Record<string, unknown> {
  const features: Record<string, unknown> = {};

  const metadata = parseJsonObject(row.metadata_json);
  if (typeof metadata?.reason === "string") features.gate_reason = metadata.reason;

  const rowJevDist = parseJevDistribution(row.reason);

  const snap = asRecord(snapshot);
  if (!snap) {
    if (rowJevDist) {
      const p = rowJevDist[row.action.toUpperCase()];
      if (p !== undefined) features.jev_prob_action = p;
    }
    return features;
  }

  if (typeof snap.engine === "string") features.analyst_engine = snap.engine;

  const signals = Array.isArray(snap.signals) ? snap.signals : [];
  if (signals.length > 0) {
    features.signal_count = signals.length;
    const sentiments = signals.map((s) => num(asRecord(s)?.sentiment)).filter((v): v is number => v !== null);
    const volumes = signals.map((s) => num(asRecord(s)?.volume)).filter((v): v is number => v !== null);
    if (sentiments.length) features.signal_sentiment = sentiments.reduce((a, b) => a + b, 0) / sentiments.length;
    if (volumes.length) features.signal_volume = volumes.reduce((a, b) => a + b, 0);
    const sources = new Set(signals.map((s) => asRecord(s)?.source_detail ?? asRecord(s)?.source).filter(Boolean));
    if (sources.size) features.sources_count = sources.size;
  }

  const social = asRecord(snap.social_snapshot);
  if (social) {
    const v = num(social.volume);
    const s = num(social.sentiment);
    if (v !== null) features.social_volume = v;
    if (s !== null) features.social_sentiment = s;
  }

  const z = asRecord(snap.social_zscore);
  if (z) {
    const vz = num(z.volume_z);
    const sz = num(z.sentiment_z);
    if (vz !== null) features.social_volume_z = vz;
    if (sz !== null) features.social_sentiment_z = sz;
  }

  const research = asRecord(snap.signal_research) ?? asRecord(snap.research);
  if (research) {
    const rc = num(research.confidence);
    if (rc !== null) features.research_confidence = rc;
    if (typeof research.entry_quality === "string") {
      features.entry_quality_score = ENTRY_QUALITY_SCORE[research.entry_quality] ?? null;
    }
    const rs = num(research.sentiment);
    if (rs !== null) features.research_sentiment = rs;
  }

  const rec = asRecord(snap.recommendation);
  if (rec) {
    const ac = num(rec.confidence);
    if (ac !== null) features.analyst_confidence = ac;
    if (typeof rec.action === "string") features.recommendation_action = rec.action;
  }

  // Jev probability for the action that was decided (parsed from the
  // "jev: BUY=0.72 ..." distribution string in the reasoning).
  const jevDist = parseJevDistribution(typeof rec?.reasoning === "string" ? rec.reasoning : null) ?? rowJevDist;
  if (jevDist) {
    const p = jevDist[row.action.toUpperCase()];
    if (p !== undefined) features.jev_prob_action = p;
  }

  const promptInputs = asRecord(snap.prompt_inputs);
  if (promptInputs) {
    const ps = num(promptInputs.sentiment);
    if (ps !== null) features.prompt_sentiment = ps;
    const pp = num(promptInputs.price);
    if (pp !== null) features.prompt_price = pp;
  }

  const technicals = asRecord(snap.technicals);
  if (technicals) {
    const rsi = num(technicals.rsi);
    if (rsi !== null) features.rsi = rsi;
    const rv = num(technicals.relative_volume);
    if (rv !== null) features.rel_volume = rv;
    const atr = num(technicals.atr);
    if (atr !== null) features.atr = atr;
  }

  const momentum = asRecord(snap.momentum);
  if (momentum) {
    const m1 = num(momentum.price_change_1h);
    if (m1 !== null) features.mom_1h = m1;
    const m24 = num(momentum.price_change_24h);
    if (m24 !== null) features.mom_24h = m24;
  }

  return features;
}

// ---------------------------------------------------------------------------
// Labeling job
// ---------------------------------------------------------------------------

export interface LabelOutcomeSummary {
  scanned: number;
  labeled: number;
  complete: number;
  partial: number;
  unavailable: number;
  symbols: number;
}

async function fetchDailyBars(
  marketData: AlpacaMarketDataProvider,
  symbol: string,
  startIso: string,
  endIso: string
): Promise<Bar[]> {
  const params = { start: startIso, end: endIso, limit: 400 };
  if (symbol.includes("/")) {
    return marketData.getCryptoBars(symbol, "1Day", params).catch(() => []);
  }
  const iex = await marketData.getBars(symbol, "1Day", { ...params, feed: "iex" }).catch(() => []);
  if (iex.length > 0) return iex;
  return marketData.getBars(symbol, "1Day", params).catch(() => []);
}

export async function labelDecisionOutcomes(
  env: Env,
  opts: { lookbackDays?: number; limit?: number } = {}
): Promise<LabelOutcomeSummary> {
  const db = createD1Client(env.DB);
  const rows = await queryUnlabeledDecisions(db, {
    lookbackDays: opts.lookbackDays ?? 90,
    limit: opts.limit ?? 300,
  });
  const summary: LabelOutcomeSummary = {
    scanned: rows.length,
    labeled: 0,
    complete: 0,
    partial: 0,
    unavailable: 0,
    symbols: 0,
  };
  if (rows.length === 0) return summary;

  const alpaca = createAlpacaProviders(env);
  const r2 = createR2Client(env.ARTIFACTS);
  const nowIso = new Date().toISOString();

  const bySymbol = new Map<string, UnlabeledDecisionRow[]>();
  for (const row of rows) {
    const key = row.symbol.toUpperCase();
    const arr = bySymbol.get(key) ?? [];
    arr.push(row);
    bySymbol.set(key, arr);
  }
  summary.symbols = bySymbol.size;

  for (const [symbol, symbolRows] of bySymbol) {
    const earliest = symbolRows.reduce((a, r) => (r.decision_at < a ? r.decision_at : a), symbolRows[0]!.decision_at);
    const startIso = new Date(Date.parse(earliest) - 3 * DAY_MS).toISOString();
    const bars = await fetchDailyBars(alpaca.marketData, symbol, startIso, nowIso);
    const lastBarMs = bars.length ? Math.max(...bars.map((b) => Date.parse(b.t))) : 0;

    for (const row of symbolRows) {
      const returns = computeForwardReturns(bars, row.decision_at, row.price);
      const decisionMs = Date.parse(row.decision_at);

      if (!returns) {
        await upsertDecisionOutcome(db, {
          decision_id: row.id,
          symbol,
          decision_at: row.decision_at,
          source: row.source,
          action: row.action,
          status: row.status,
          confidence: row.confidence,
          label_status: "unavailable",
        });
        summary.unavailable++;
        continue;
      }

      const t20Settled = returns.t20_return !== null || lastBarMs >= decisionMs + T20_EXPECTED_MS;
      const labelStatus = t20Settled ? "complete" : "partial";

      let features: Record<string, unknown> | null = null;
      if (row.existing_features_json) {
        features = null; // keep stored features (upsert COALESCEs)
      } else {
        const snapshot = row.snapshot_r2_key ? await r2.getJson(row.snapshot_r2_key).catch(() => null) : null;
        features = extractDecisionFeatures(row, snapshot);
      }

      await upsertDecisionOutcome(db, {
        decision_id: row.id,
        symbol,
        decision_at: row.decision_at,
        source: row.source,
        action: row.action,
        status: row.status,
        confidence: row.confidence,
        baseline_price: returns.baseline_price,
        baseline_at: returns.baseline_at,
        t1_return: returns.t1_return,
        t5_return: returns.t5_return,
        t20_return: returns.t20_return,
        features,
        label_status: labelStatus,
      });
      summary.labeled++;
      if (labelStatus === "complete") summary.complete++;
      else summary.partial++;
    }
  }

  return summary;
}
