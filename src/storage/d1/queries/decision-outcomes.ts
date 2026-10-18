import { nowISO } from "../../../lib/utils";
import type { D1Client, DecisionOutcomeRow, TradeDecisionRow } from "../client";

export type DecisionOutcomeLabelStatus = "partial" | "complete" | "unavailable";

export interface UpsertDecisionOutcomeParams {
  decision_id: string;
  symbol: string;
  decision_at: string;
  source: string;
  action: string;
  status: string;
  confidence?: number | null;
  baseline_price?: number | null;
  baseline_at?: string | null;
  t1_return?: number | null;
  t5_return?: number | null;
  t20_return?: number | null;
  features?: Record<string, unknown> | null;
  label_status: DecisionOutcomeLabelStatus;
}

export async function upsertDecisionOutcome(db: D1Client, params: UpsertDecisionOutcomeParams): Promise<void> {
  await db.run(
    `INSERT INTO decision_outcomes (
      decision_id, symbol, decision_at, source, action, status, confidence,
      baseline_price, baseline_at, t1_return, t5_return, t20_return,
      features_json, label_status, labeled_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(decision_id) DO UPDATE SET
      baseline_price = excluded.baseline_price,
      baseline_at = excluded.baseline_at,
      t1_return = COALESCE(excluded.t1_return, decision_outcomes.t1_return),
      t5_return = COALESCE(excluded.t5_return, decision_outcomes.t5_return),
      t20_return = COALESCE(excluded.t20_return, decision_outcomes.t20_return),
      features_json = COALESCE(excluded.features_json, decision_outcomes.features_json),
      label_status = excluded.label_status,
      labeled_at = excluded.labeled_at`,
    [
      params.decision_id,
      params.symbol.toUpperCase(),
      params.decision_at,
      params.source,
      params.action,
      params.status,
      params.confidence ?? null,
      params.baseline_price ?? null,
      params.baseline_at ?? null,
      params.t1_return ?? null,
      params.t5_return ?? null,
      params.t20_return ?? null,
      params.features ? JSON.stringify(params.features) : null,
      params.label_status,
      nowISO(),
    ]
  );
}

/**
 * Decisions that still need (re-)labeling: never labeled, partially labeled
 * within the retention window, or rows whose horizon data may now be
 * available. Rows marked `unavailable` are only retried when fresh —
 * persistent missing data stops retrying after they go stale.
 */
export interface UnlabeledDecisionRow extends TradeDecisionRow {
  existing_features_json: string | null;
}

export async function queryUnlabeledDecisions(
  db: D1Client,
  params: { lookbackDays?: number; limit?: number } = {}
): Promise<UnlabeledDecisionRow[]> {
  const { lookbackDays = 90, limit = 300 } = params;
  const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
  const unavailableRetryCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const utcToday = new Date().toISOString().slice(0, 10);

  return db.execute<UnlabeledDecisionRow>(
    `WITH eligible AS (
       SELECT d.*, o.features_json AS existing_features_json,
         CASE WHEN o.decision_id IS NULL THEN 0 ELSE 1 END AS retry_group
       FROM trade_decisions d
       LEFT JOIN decision_outcomes o ON o.decision_id = d.id
       WHERE d.decision_at >= ?
         AND (
           o.decision_id IS NULL
           OR (o.label_status = 'partial' AND date(o.labeled_at) < date(?))
           OR (o.label_status = 'unavailable' AND d.decision_at >= ? AND date(o.labeled_at) < date(?))
         )
     ), ranked AS (
       SELECT eligible.*, ROW_NUMBER() OVER (
         PARTITION BY retry_group ORDER BY decision_at ASC, id ASC
       ) AS group_rank
       FROM eligible
     )
     SELECT * FROM ranked
     WHERE group_rank <= CASE
       WHEN EXISTS (SELECT 1 FROM eligible WHERE retry_group = 1)
         THEN MAX(1, ? / 2)
       ELSE ?
     END
     ORDER BY retry_group ASC, decision_at ASC, id ASC
     LIMIT ?`,
    [cutoff, utcToday, unavailableRetryCutoff, utcToday, limit, limit, limit]
  );
}

export async function queryDecisionOutcomes(
  db: D1Client,
  params: { days?: number; symbol?: string; limit?: number } = {}
): Promise<DecisionOutcomeRow[]> {
  const { days = 90, symbol, limit = 5000 } = params;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  if (symbol) {
    return db.execute<DecisionOutcomeRow>(
      `SELECT * FROM decision_outcomes
       WHERE decision_at >= ? AND symbol = ? AND label_status != 'unavailable'
       ORDER BY decision_at ASC LIMIT ?`,
      [cutoff, symbol.toUpperCase(), limit]
    );
  }

  return db.execute<DecisionOutcomeRow>(
    `SELECT * FROM decision_outcomes
     WHERE decision_at >= ? AND label_status != 'unavailable'
     ORDER BY decision_at ASC LIMIT ?`,
    [cutoff, limit]
  );
}

export async function countDecisionOutcomes(db: D1Client): Promise<number> {
  const row = await db.executeOne<{ n: number }>(`SELECT COUNT(*) as n FROM decision_outcomes`);
  return row?.n ?? 0;
}
