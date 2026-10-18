import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { D1Client } from "../client";
import { queryUnlabeledDecisions } from "./decision-outcomes";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

describe("queryUnlabeledDecisions (SQLite)", () => {
  let sqlite: ReturnType<typeof createDatabase>;
  let db: D1Client;

  function createDatabase() {
    return new DatabaseSync(":memory:");
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T05:00:00Z"));
    sqlite = createDatabase();
    sqlite.exec("CREATE TABLE trades (id TEXT PRIMARY KEY); CREATE TABLE trade_journal (id TEXT PRIMARY KEY);");
    sqlite.exec(readFileSync("migrations/0004_trade_decision_logs.sql", "utf8"));
    sqlite.exec(readFileSync("migrations/0005_decision_outcomes.sql", "utf8"));
    db = {
      execute: async (sql: string, params: any[]) => sqlite.prepare(sql).all(...params),
    } as unknown as D1Client;
  });

  afterEach(() => {
    sqlite.close();
    vi.useRealTimers();
  });

  function seed(id: string, action: string, decisionAt: string, labelStatus?: string, labeledAt = "2026-10-06T05:00:00Z") {
    sqlite.prepare(`INSERT INTO trade_decisions (id, cycle_id, decision_at, source, symbol, action, status)
      VALUES (?, 'cycle', ?, 'signal_research', 'AAPL', ?, 'recorded')`).run(id, decisionAt, action);
    if (labelStatus) {
      sqlite.prepare(`INSERT INTO decision_outcomes (decision_id, symbol, decision_at, source, action, status, label_status, labeled_at)
        VALUES (?, 'AAPL', ?, 'signal_research', ?, 'recorded', ?, ?)`).run(id, decisionAt, action, labelStatus, labeledAt);
    }
  }

  it("labels oldest unseen WAIT and SKIP before newer BUY decisions", async () => {
    seed("wait", "WAIT", "2026-10-01T15:00:00Z");
    seed("skip", "SKIP", "2026-10-02T15:00:00Z");
    seed("buy", "BUY", "2026-10-03T15:00:00Z");
    const rows = await queryUnlabeledDecisions(db, { limit: 2 });
    expect(rows.map((row) => row.id)).toEqual(["wait", "skip"]);
  });

  it("retries recent T+1/T+5 and holiday-delayed T+20 rows without a 28-day cutoff", async () => {
    seed("recent", "WAIT", "2026-10-05T15:00:00Z", "partial");
    seed("holiday", "SKIP", "2026-09-07T15:00:00Z", "partial");
    const rows = await queryUnlabeledDecisions(db);
    expect(rows.map((row) => row.id).sort()).toEqual(["holiday", "recent"]);
  });

  it("does not retry twice on the same UTC day, including ISO and SQLite timestamps", async () => {
    seed("iso", "WAIT", "2026-10-01T15:00:00Z", "partial", "2026-10-07T01:00:00Z");
    seed("sqlite", "SKIP", "2026-10-01T15:00:00Z", "partial", "2026-10-07 01:00:00");
    expect(await queryUnlabeledDecisions(db)).toEqual([]);
  });

  it("ages missing symbols out by decision time even after repeated failed labeling", async () => {
    seed("stale", "SKIP", "2026-09-01T15:00:00Z", "unavailable");
    seed("transient", "WAIT", "2026-10-05T15:00:00Z", "unavailable");
    seed("done", "BUY", "2026-10-01T15:00:00Z", "complete");
    const rows = await queryUnlabeledDecisions(db);
    expect(rows.map((row) => row.id)).toEqual(["transient"]);
  });

  it("gives retries a turn during an unseen backlog and rotates attempted retries", async () => {
    for (let i = 1; i <= 4; i++) seed(`new-${i}`, "WAIT", `2026-10-0${i}T15:00:00Z`);
    seed("retry", "SKIP", "2026-09-01T15:00:00Z", "partial", "2026-10-05T05:00:00Z");
    const rows = await queryUnlabeledDecisions(db, { limit: 2 });
    expect(rows.map((row) => row.id)).toEqual(["new-1", "retry"]);
    sqlite.prepare("UPDATE decision_outcomes SET labeled_at = ? WHERE decision_id = 'retry'").run(new Date().toISOString());
    const next = await queryUnlabeledDecisions(db, { limit: 2 });
    expect(next.map((row) => row.id)).toEqual(["new-1", "new-2"]);
  });
});
