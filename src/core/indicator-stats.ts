/**
 * Indicator effectiveness statistics — pure functions.
 *
 * Implements the evaluation framework for trade decisions:
 * - Spearman rank IC between a decision-time feature and forward returns
 * - Quantile return buckets (does the indicator order returns monotonically?)
 * - Confidence calibration (self-reported confidence vs realized returns)
 * - Counterfactual gate stats (what would blocked/filtered decisions have done?)
 *
 * No I/O here — callers supply labeled outcome samples.
 */

export interface OutcomeSample {
  decision_id: string;
  symbol: string;
  decision_at: string;
  source: string;
  action: string;
  status: string;
  confidence: number | null;
  t1_return: number | null;
  t5_return: number | null;
  t20_return: number | null;
  features: Record<string, unknown>;
}

export type Horizon = "t1_return" | "t5_return" | "t20_return";

export const HORIZONS: Horizon[] = ["t1_return", "t5_return", "t20_return"];

/**
 * Features evaluated for predictive power. Values are pulled from the
 * outcome row itself (`confidence`) or the extracted snapshot features.
 */
export const REPORT_FEATURES = [
  "confidence",
  "signal_count",
  "signal_sentiment",
  "signal_volume",
  "social_volume",
  "social_sentiment",
  "social_volume_z",
  "social_sentiment_z",
  "sources_count",
  "research_confidence",
  "entry_quality_score",
  "analyst_confidence",
  "jev_prob_action",
  "prompt_sentiment",
  "rsi",
  "mom_1h",
  "mom_24h",
  "rel_volume",
  "atr",
] as const;

export const MIN_IC_SAMPLE = 30;
export const MIN_QUANTILE_SAMPLE = 20;
export const MIN_BUCKET_SAMPLE = 10;

// ---------------------------------------------------------------------------
// Rank helpers
// ---------------------------------------------------------------------------

/** Average ranks (1..n) with ties sharing the mean rank. */
export function rankValues(values: number[]): number[] {
  const indexed = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1]!.v === indexed[i]!.v) j++;
    const avg = (i + 1 + j + 1) / 2;
    for (let k = i; k <= j; k++) ranks[indexed[k]!.i] = avg;
    i = j + 1;
  }
  return ranks;
}

export function pearsonCorrelation(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 2) return 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += x[i]!;
    sy += y[i]!;
  }
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i]! - mx;
    const dy = y[i]! - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  if (sxx === 0 || syy === 0) return 0;
  return sxy / Math.sqrt(sxx * syy);
}

/**
 * Spearman rank IC between paired feature values and returns.
 * Pairs with non-finite values are dropped before ranking.
 */
export function spearmanIC(pairs: Array<{ feature: number; ret: number }>): number {
  const clean = pairs.filter((p) => Number.isFinite(p.feature) && Number.isFinite(p.ret));
  if (clean.length < 3) return 0;
  return pearsonCorrelation(rankValues(clean.map((p) => p.feature)), rankValues(clean.map((p) => p.ret)));
}

// ---------------------------------------------------------------------------
// Quantile buckets
// ---------------------------------------------------------------------------

export interface QuantileBucket {
  index: number;
  feature_min: number;
  feature_max: number;
  n: number;
  mean_return: number;
  median_return: number;
  win_rate: number;
}

export function quantileBuckets(pairs: Array<{ feature: number; ret: number }>, bucketCount = 5): QuantileBucket[] {
  const clean = pairs
    .filter((p) => Number.isFinite(p.feature) && Number.isFinite(p.ret))
    .sort((a, b) => a.feature - b.feature);
  if (clean.length < MIN_QUANTILE_SAMPLE) return [];

  const buckets: QuantileBucket[] = [];
  const size = Math.floor(clean.length / bucketCount);
  if (size === 0) return [];

  for (let i = 0; i < bucketCount; i++) {
    const start = i * size;
    const end = i === bucketCount - 1 ? clean.length : start + size;
    const slice = clean.slice(start, end);
    if (slice.length === 0) continue;
    const rets = slice.map((p) => p.ret).sort((a, b) => a - b);
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const median =
      rets.length % 2 === 1 ? rets[(rets.length - 1) / 2]! : (rets[rets.length / 2 - 1]! + rets[rets.length / 2]!) / 2;
    buckets.push({
      index: i,
      feature_min: slice[0]!.feature,
      feature_max: slice[slice.length - 1]!.feature,
      n: slice.length,
      mean_return: mean,
      median_return: median,
      win_rate: rets.filter((r) => r > 0).length / rets.length,
    });
  }
  return buckets;
}

/** Fraction of adjacent bucket pairs where mean return increases — 1.0 = perfectly monotonic. */
export function monotonicityScore(buckets: QuantileBucket[]): number {
  if (buckets.length < 2) return 0;
  let increasing = 0;
  for (let i = 1; i < buckets.length; i++) {
    if (buckets[i]!.mean_return >= buckets[i - 1]!.mean_return) increasing++;
  }
  return increasing / (buckets.length - 1);
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

export interface CalibrationBucket {
  index: number;
  confidence_min: number;
  confidence_max: number;
  n: number;
  mean_confidence: number;
  mean_return: number;
  win_rate: number;
}

/** Fixed-width confidence buckets (0-0.2, 0.2-0.4, ..., 0.8-1.0). */
export function calibrationBuckets(
  pairs: Array<{ confidence: number; ret: number }>,
  bucketCount = 5
): CalibrationBucket[] {
  const clean = pairs.filter((p) => Number.isFinite(p.confidence) && Number.isFinite(p.ret));
  if (clean.length === 0) return [];

  const buckets: Array<{ confidence: number; ret: number }[]> = Array.from({ length: bucketCount }, () => []);
  for (const p of clean) {
    const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor(p.confidence * bucketCount)));
    buckets[idx]!.push(p);
  }

  return buckets.map((slice, i) => {
    const rets = slice.map((p) => p.ret);
    const mean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
    return {
      index: i,
      confidence_min: i / bucketCount,
      confidence_max: (i + 1) / bucketCount,
      n: slice.length,
      mean_confidence: slice.length ? slice.reduce((a, p) => a + p.confidence, 0) / slice.length : 0,
      mean_return: mean,
      win_rate: rets.length ? rets.filter((r) => r > 0).length / rets.length : 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Report assembly
// ---------------------------------------------------------------------------

export interface IndicatorICResult {
  feature: string;
  horizon: Horizon;
  n: number;
  ic: number;
  sufficient_sample: boolean;
}

export interface QuantileResult {
  feature: string;
  horizon: Horizon;
  buckets: QuantileBucket[];
  monotonicity: number;
}

export interface SourceBreakdown {
  source: string;
  n: number;
  buys: number;
  sells: number;
  submitted: number;
  blocked_or_filtered: number;
  mean_t1: number | null;
  mean_t5: number | null;
  confidence_ic_t1: number | null;
}

export interface GateBreakdown {
  gate: string;
  action: string;
  n: number;
  mean_t1: number | null;
  mean_t5: number | null;
  win_rate_t1: number | null;
}

export interface CalibrationResult {
  engine: string;
  horizon: Horizon;
  buckets: CalibrationBucket[];
  n: number;
}

export interface IndicatorReport {
  generated_at: string;
  window_days: number;
  labeled_decisions: number;
  min_ic_sample: number;
  ic: IndicatorICResult[];
  quantiles: QuantileResult[];
  calibration: CalibrationResult[];
  by_source: SourceBreakdown[];
  gates: GateBreakdown[];
}

function directionSign(action: string): number {
  const a = action.toUpperCase();
  if (a === "SELL") return -1;
  if (a === "BUY") return 1;
  return 0; // SKIP/WAIT/recorded — not direction-adjusted
}

function numericFeature(sample: OutcomeSample, name: string): number | null {
  const raw = name === "confidence" ? sample.confidence : sample.features[name];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function featureRetPairs(
  samples: OutcomeSample[],
  feature: string,
  horizon: Horizon,
  directionAdjusted: boolean
): Array<{ feature: number; ret: number }> {
  const pairs: Array<{ feature: number; ret: number }> = [];
  for (const s of samples) {
    const f = numericFeature(s, feature);
    const r = s[horizon];
    if (f === null || r === null) continue;
    const dir = directionAdjusted ? directionSign(s.action) : 1;
    if (directionAdjusted && dir === 0) continue;
    pairs.push({ feature: f, ret: r * dir });
  }
  return pairs;
}

function mean(values: Array<number | null>): number | null {
  const nums = values.filter((v): v is number => v !== null && Number.isFinite(v));
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}

export function buildIndicatorReport(samples: OutcomeSample[], opts: { days: number; now?: Date }): IndicatorReport {
  const directional = samples.filter((s) => directionSign(s.action) !== 0);

  const ic: IndicatorICResult[] = [];
  const quantiles: QuantileResult[] = [];
  for (const feature of REPORT_FEATURES) {
    for (const horizon of HORIZONS) {
      const pairs = featureRetPairs(directional, feature, horizon, true);
      if (pairs.length === 0) continue;
      ic.push({
        feature,
        horizon,
        n: pairs.length,
        ic: spearmanIC(pairs),
        sufficient_sample: pairs.length >= MIN_IC_SAMPLE,
      });
      if (horizon === "t5_return") {
        const buckets = quantileBuckets(pairs, 5);
        if (buckets.length >= 3) {
          quantiles.push({ feature, horizon, buckets, monotonicity: monotonicityScore(buckets) });
        }
      }
    }
  }

  const calibration: CalibrationResult[] = [];
  const engines = new Map<string, OutcomeSample[]>();
  for (const s of directional) {
    const engine = typeof s.features.analyst_engine === "string" ? s.features.analyst_engine : s.source;
    const bucket = engines.get(engine) ?? [];
    bucket.push(s);
    engines.set(engine, bucket);
  }
  for (const [engine, rows] of engines) {
    for (const horizon of HORIZONS) {
      const pairs = rows
        .filter((s) => s.confidence !== null && s[horizon] !== null)
        .map((s) => ({ confidence: s.confidence as number, ret: (s[horizon] as number) * directionSign(s.action) }));
      if (pairs.length >= MIN_QUANTILE_SAMPLE) {
        calibration.push({ engine, horizon, buckets: calibrationBuckets(pairs, 5), n: pairs.length });
      }
    }
  }

  const bySource = new Map<string, OutcomeSample[]>();
  for (const s of samples) {
    const arr = bySource.get(s.source) ?? [];
    arr.push(s);
    bySource.set(s.source, arr);
  }
  const by_source: SourceBreakdown[] = [...bySource.entries()].map(([source, rows]) => {
    const dir = rows.filter((s) => directionSign(s.action) !== 0);
    return {
      source,
      n: rows.length,
      buys: rows.filter((s) => s.action.toUpperCase() === "BUY").length,
      sells: rows.filter((s) => s.action.toUpperCase() === "SELL").length,
      submitted: rows.filter((s) => s.status === "submitted").length,
      blocked_or_filtered: rows.filter((s) => s.status === "blocked" || s.status === "filtered").length,
      mean_t1: mean(dir.map((s) => (s.t1_return === null ? null : s.t1_return * directionSign(s.action)))),
      mean_t5: mean(dir.map((s) => (s.t5_return === null ? null : s.t5_return * directionSign(s.action)))),
      confidence_ic_t1:
        featureRetPairs(dir, "confidence", "t1_return", true).length >= 3
          ? spearmanIC(featureRetPairs(dir, "confidence", "t1_return", true))
          : null,
    };
  });

  const gateGroups = new Map<string, OutcomeSample[]>();
  for (const s of samples) {
    if (s.status !== "blocked" && s.status !== "filtered") continue;
    const gate = typeof s.features.gate_reason === "string" ? s.features.gate_reason : "unknown";
    const key = `${gate}|${s.action.toUpperCase()}`;
    const arr = gateGroups.get(key) ?? [];
    arr.push(s);
    gateGroups.set(key, arr);
  }
  const gates: GateBreakdown[] = [...gateGroups.entries()]
    .map(([key, rows]) => {
      const parts = key.split("|");
      const gate = parts[0]!;
      const action = parts[1]!;
      const dir = directionSign(action);
      const adj = (r: number | null) => (r === null ? null : r * dir);
      const t1 = rows.map((s) => adj(s.t1_return)).filter((v): v is number => v !== null);
      return {
        gate,
        action,
        n: rows.length,
        mean_t1: mean(rows.map((s) => adj(s.t1_return))),
        mean_t5: mean(rows.map((s) => adj(s.t5_return))),
        win_rate_t1: t1.length ? t1.filter((r) => r > 0).length / t1.length : null,
      };
    })
    .sort((a, b) => b.n - a.n);

  return {
    generated_at: (opts.now ?? new Date()).toISOString(),
    window_days: opts.days,
    labeled_decisions: samples.length,
    min_ic_sample: MIN_IC_SAMPLE,
    ic,
    quantiles,
    calibration,
    by_source,
    gates,
  };
}
