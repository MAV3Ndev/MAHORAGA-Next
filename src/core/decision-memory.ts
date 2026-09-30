/**
 * Decision memory — the agent's accumulated, measured experience.
 *
 * Builds a compact context block from two real data sources instead of
 * letting every analyst/research call run stateless:
 *   - `trade_decisions` submitted sells → realized P&L and exit reasons
 *   - `decision_outcomes` forward-return labels → per-symbol track records,
 *     gate counterfactuals ("what the blocked trades would have done"),
 *     and measured indicator ICs
 *
 * The memory is injected into the LLM analyst prompt, the Jev state JSON,
 * and the per-symbol research prompt, so judgments can condition on what
 * has actually worked rather than re-deriving everything from scratch.
 */
import type { D1Client } from "../storage/d1/client";
import { queryDecisionOutcomes } from "../storage/d1/queries/decision-outcomes";
import { queryTradeDecisions } from "../storage/d1/queries/trade-decisions";
import { buildIndicatorReport, type OutcomeSample } from "./indicator-stats";

export interface SymbolTrackRecord {
  evaluations: number;
  buys: number;
  sells: number;
  avg_t1: number | null;
  avg_t5: number | null;
  win_rate_t1: number | null;
  last_action: string | null;
  last_decision_at: string | null;
}

export interface RecentClosedTrade {
  symbol: string;
  pnl_pct: number | null;
  reason: string | null;
  at: string;
}

export interface GateLesson {
  gate: string;
  action: string;
  n: number;
  mean_t1: number | null;
  mean_t5: number | null;
  win_rate_t1: number | null;
}

export interface FeatureLesson {
  feature: string;
  horizon: string;
  ic: number;
  n: number;
}

export interface DecisionMemory {
  generated_at: string;
  window_days: number;
  closed_trades: {
    count: number;
    wins: number;
    losses: number;
    win_rate: number;
    avg_pnl_pct: number | null;
    recent: RecentClosedTrade[];
  };
  symbols: Record<string, SymbolTrackRecord>;
  gate_lessons: GateLesson[];
  feature_lessons: FeatureLesson[];
}

const MIN_GATE_LESSON_SAMPLE = 5;
const MIN_FEATURE_LESSON_IC = 0.1;
const MAX_SYMBOL_RECORDS = 30;

function directionSign(action: string): number {
  const a = action.toUpperCase();
  if (a === "SELL") return -1;
  if (a === "BUY") return 1;
  return 0;
}

function meanOrNull(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

/** Per-symbol forward-return track records from directional (BUY/SELL) outcome rows. */
export function aggregateSymbolTrackRecords(samples: OutcomeSample[]): Record<string, SymbolTrackRecord> {
  const bySymbol = new Map<string, OutcomeSample[]>();
  for (const s of samples) {
    if (directionSign(s.action) === 0) continue;
    const arr = bySymbol.get(s.symbol) ?? [];
    arr.push(s);
    bySymbol.set(s.symbol, arr);
  }

  const records = [...bySymbol.entries()]
    .map(([symbol, rows]) => {
      const dir = (s: OutcomeSample) => directionSign(s.action);
      const t1Adj = rows.filter((s) => s.t1_return !== null).map((s) => s.t1_return! * dir(s));
      const t5Adj = rows.filter((s) => s.t5_return !== null).map((s) => s.t5_return! * dir(s));
      const sorted = [...rows].sort((a, b) => b.decision_at.localeCompare(a.decision_at));
      const record: SymbolTrackRecord = {
        evaluations: rows.length,
        buys: rows.filter((s) => s.action.toUpperCase() === "BUY").length,
        sells: rows.filter((s) => s.action.toUpperCase() === "SELL").length,
        avg_t1: meanOrNull(t1Adj),
        avg_t5: meanOrNull(t5Adj),
        win_rate_t1: t1Adj.length ? t1Adj.filter((r) => r > 0).length / t1Adj.length : null,
        last_action: sorted[0]?.action ?? null,
        last_decision_at: sorted[0]?.decision_at ?? null,
      };
      return { symbol, record };
    })
    .sort((a, b) => b.record.evaluations - a.record.evaluations)
    .slice(0, MAX_SYMBOL_RECORDS);

  return Object.fromEntries(records.map(({ symbol, record }) => [symbol, record]));
}

export async function buildDecisionMemory(
  db: D1Client,
  opts: { days?: number; now?: Date } = {}
): Promise<DecisionMemory> {
  const days = opts.days ?? 90;
  const [outcomeRows, recentSells] = await Promise.all([
    queryDecisionOutcomes(db, { days, limit: 3000 }),
    queryTradeDecisions(db, { action: "SELL", status: "submitted", days: 30, limit: 15 }),
  ]);

  const samples: OutcomeSample[] = outcomeRows.map((row) => {
    let features: Record<string, unknown> = {};
    if (row.features_json) {
      try {
        const parsed = JSON.parse(row.features_json);
        if (parsed && typeof parsed === "object") features = parsed;
      } catch {
        // ignore malformed features
      }
    }
    return {
      decision_id: row.decision_id,
      symbol: row.symbol,
      decision_at: row.decision_at,
      source: row.source,
      action: row.action,
      status: row.status,
      confidence: row.confidence,
      t1_return: row.t1_return,
      t5_return: row.t5_return,
      t20_return: row.t20_return,
      features,
    };
  });

  const report = buildIndicatorReport(samples, { days, now: opts.now });

  const recent = recentSells.map((r) => ({
    symbol: r.symbol,
    pnl_pct: r.pnl_pct,
    reason: r.reason,
    at: r.decision_at,
  }));
  const pnls = recentSells.map((r) => r.pnl_pct).filter((p): p is number => p !== null && Number.isFinite(p));
  const wins = pnls.filter((p) => p > 0).length;

  return {
    generated_at: (opts.now ?? new Date()).toISOString(),
    window_days: days,
    closed_trades: {
      count: recentSells.length,
      wins,
      losses: pnls.filter((p) => p < 0).length,
      win_rate: pnls.length ? wins / pnls.length : 0,
      avg_pnl_pct: meanOrNull(pnls),
      recent,
    },
    symbols: aggregateSymbolTrackRecords(samples),
    gate_lessons: report.gates.filter((g) => g.n >= MIN_GATE_LESSON_SAMPLE).slice(0, 10),
    feature_lessons: report.ic
      .filter((r) => r.sufficient_sample && Math.abs(r.ic) >= MIN_FEATURE_LESSON_IC)
      .sort((a, b) => Math.abs(b.ic) - Math.abs(a.ic))
      .slice(0, 10)
      .map((r) => ({ feature: r.feature, horizon: r.horizon, ic: r.ic, n: r.n })),
  };
}

// ---------------------------------------------------------------------------
// Prompt formatting
// ---------------------------------------------------------------------------

/** t1/t5 forward returns are stored as decimals (0.02 = +2%). */
function pctDec(v: number | null | undefined): string {
  return v === null || v === undefined ? "n/a" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;
}

/** trade_decisions.pnl_pct is stored in percentage points (-4.5 = -4.5%). */
function pctPts(v: number | null | undefined): string {
  return v === null || v === undefined ? "n/a" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

/**
 * Compact text block for LLM prompts. Framed as measured evidence with
 * sample sizes so the model can weigh it appropriately.
 */
export function formatDecisionMemoryBlock(memory: DecisionMemory): string {
  const lines: string[] = [`LEARNED CONTEXT — measured outcomes over the last ${memory.window_days} days:`];

  const ct = memory.closed_trades;
  if (ct.count > 0) {
    lines.push(
      `Recent closed trades: ${ct.count} exits, ${(ct.win_rate * 100).toFixed(0)}% win rate, avg ${pctPts(ct.avg_pnl_pct)}`
    );
    for (const t of ct.recent.slice(0, 6)) {
      lines.push(`  - ${t.symbol} ${pctPts(t.pnl_pct)} (${(t.reason ?? "").slice(0, 60)})`);
    }
  }

  const trackRecords = Object.entries(memory.symbols).filter(([, r]) => r.evaluations >= 3);
  if (trackRecords.length > 0) {
    lines.push("Per-symbol track record (direction-adjusted forward returns of past decisions):");
    for (const [symbol, r] of trackRecords.slice(0, 10)) {
      lines.push(
        `  - ${symbol}: ${r.evaluations} evals (${r.buys}B/${r.sells}S), avg T+1 ${pctDec(r.avg_t1)}, avg T+5 ${pctDec(r.avg_t5)}`
      );
    }
  }

  if (memory.feature_lessons.length > 0) {
    lines.push("Measured indicator effectiveness (rank IC, direction-adjusted):");
    for (const f of memory.feature_lessons.slice(0, 6)) {
      const horizon = f.horizon === "t1_return" ? "T+1" : f.horizon === "t5_return" ? "T+5" : "T+20";
      lines.push(`  - ${f.feature}: IC ${f.ic >= 0 ? "+" : ""}${f.ic.toFixed(2)} @${horizon} (n=${f.n})`);
    }
  }

  const notableGates = memory.gate_lessons.filter((g) => g.mean_t1 !== null);
  if (notableGates.length > 0) {
    lines.push("Gate counterfactuals (would-be returns of blocked decisions — negative means the gate worked):");
    for (const g of notableGates.slice(0, 6)) {
      lines.push(
        `  - ${g.gate} ${g.action}: n=${g.n}, avg T+1 ${pctDec(g.mean_t1)}, avg T+5 ${pctDec(g.mean_t5)}, win ${g.win_rate_t1 !== null ? `${(g.win_rate_t1 * 100).toFixed(0)}%` : "n/a"}`
      );
    }
  }

  lines.push(
    "Use this history to calibrate conviction: repeat past mistakes only if the current evidence is materially different."
  );
  return lines.join("\n");
}
