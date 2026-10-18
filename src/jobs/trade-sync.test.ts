import { createRequire } from "node:module";
import type { SQLInputValue } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import type { AlpacaProviders } from "../providers/alpaca";
import type { D1Client, TradeRow } from "../storage/d1/client";
import { getUnfinishedTrades } from "../storage/d1/queries/trades";
import { syncRecentTradeStatuses } from "./trade-sync";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

function trade(overrides: Partial<TradeRow> = {}): TradeRow {
  return {
    id: "trade-1",
    approval_id: null,
    alpaca_order_id: "alpaca-1",
    symbol: "AAPL",
    side: "buy",
    qty: 2,
    order_type: "market",
    limit_price: null,
    stop_price: null,
    status: "pending_new",
    filled_qty: null,
    filled_avg_price: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function order(overrides: Record<string, unknown> = {}) {
  return { id: "alpaca-1", status: "filled", filled_qty: "2", filled_avg_price: "150.25", ...overrides };
}

function provider(getOrder: ReturnType<typeof vi.fn>): AlpacaProviders {
  return { trading: { getOrder } } as unknown as AlpacaProviders;
}

function database(rows: TradeRow[]) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE trades (
    id TEXT PRIMARY KEY, alpaca_order_id TEXT, status TEXT, filled_qty REAL,
    filled_avg_price REAL, created_at TEXT, updated_at TEXT
  )`);
  const insert = sqlite.prepare("INSERT INTO trades VALUES (?, ?, ?, ?, ?, ?, ?)");
  for (const row of rows) {
    insert.run(row.id, row.alpaca_order_id, row.status, row.filled_qty, row.filled_avg_price, row.created_at, row.updated_at);
  }
  const db = {
    execute: async (sql: string, params: SQLInputValue[]) => sqlite.prepare(sql).all(...params),
    run: async (sql: string, params: SQLInputValue[]) => sqlite.prepare(sql).run(...params),
  } as unknown as D1Client;
  return { sqlite, db };
}

describe("syncRecentTradeStatuses", () => {
  it("reconciles an old unresolved order by its exact Alpaca ID", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const db = {
      execute: vi.fn().mockResolvedValue([trade({ updated_at: "2025-01-01T00:00:00.000Z" })]),
      run,
    } as unknown as D1Client;
    const getOrder = vi.fn().mockResolvedValue(order());

    const result = await syncRecentTradeStatuses(db, provider(getOrder));

    expect(result).toEqual({ scanned: 1, updated: 1 });
    expect(getOrder).toHaveBeenCalledWith("alpaca-1");
    expect(run.mock.calls[0]?.[1]).toEqual(["filled", 2, 150.25, expect.any(String), "trade-1"]);
  });

  it("isolates a failed lookup and rotates that trade", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const first = trade({ id: "failed", alpaca_order_id: "missing" });
    const second = trade({ id: "updated", alpaca_order_id: "present" });
    const db = { execute: vi.fn().mockResolvedValue([first, second]), run } as unknown as D1Client;
    const getOrder = vi.fn((id: string) =>
      id === "missing" ? Promise.reject(new Error("not found")) : Promise.resolve(order({ id }))
    );

    const result = await syncRecentTradeStatuses(db, provider(getOrder));

    expect(result).toEqual({ scanned: 2, updated: 1 });
    expect(run).toHaveBeenCalledWith("UPDATE trades SET updated_at = ? WHERE id = ?", [expect.any(String), "failed"]);
    expect(run).toHaveBeenCalledWith(expect.stringContaining("UPDATE trades SET status"), [
      "filled",
      2,
      150.25,
      expect.any(String),
      "updated",
    ]);
  });

  it("is idempotent when local status and fills already match", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const db = { execute: vi.fn().mockResolvedValue([trade({ status: "filled", filled_qty: 2, filled_avg_price: 150.25 })]), run } as unknown as D1Client;
    const getOrder = vi.fn().mockResolvedValue(order());

    const result = await syncRecentTradeStatuses(db, provider(getOrder));

    expect(result).toEqual({ scanned: 1, updated: 0 });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("UPDATE trades SET updated_at = ? WHERE id = ?", [
      expect.any(String),
      "trade-1",
    ]);
  });

  it("keeps resumable states eligible regardless of age and excludes terminal orders", async () => {
    const statuses = ["pending_new", "partially_filled", "done_for_day", "stopped", "suspended", "filled", "canceled", "expired", "replaced", "rejected"];
    const { sqlite, db } = database(statuses.map((status) => trade({ id: status, status })));
    try {
      const rows = await getUnfinishedTrades(db);
      expect(rows.map((row) => row.status).sort()).toEqual([
        "done_for_day", "partially_filled", "pending_new", "stopped", "suspended",
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("rotates unchanged open orders so the bounded batch reaches later rows", async () => {
    const rows = Array.from({ length: 101 }, (_, index) => trade({
      id: String(index).padStart(3, "0"),
      alpaca_order_id: `alpaca-${index}`,
      status: "new",
      filled_qty: 0,
    }));
    const { sqlite, db } = database(rows);
    const getOrder = vi.fn((id: string) => Promise.resolve(order({
      id, status: "new", filled_qty: "0", filled_avg_price: null,
    })));
    try {
      expect(await syncRecentTradeStatuses(db, provider(getOrder))).toEqual({ scanned: 100, updated: 0 });
      expect(getOrder).not.toHaveBeenCalledWith("alpaca-100");
      await syncRecentTradeStatuses(db, provider(getOrder));
      expect(getOrder).toHaveBeenCalledWith("alpaca-100");
      const persisted = sqlite.prepare("SELECT DISTINCT status, filled_qty, filled_avg_price FROM trades").all();
      expect(persisted).toEqual([{ status: "new", filled_qty: 0, filled_avg_price: null }]);
    } finally {
      sqlite.close();
    }
  });

  it("preserves partial fills when cancellation omits fill details and then stops polling", async () => {
    const { sqlite, db } = database([trade({ status: "partially_filled", filled_qty: 1, filled_avg_price: 150.25 })]);
    const getOrder = vi.fn().mockResolvedValue(order({ status: "canceled", filled_qty: null, filled_avg_price: null }));
    try {
      expect(await syncRecentTradeStatuses(db, provider(getOrder))).toEqual({ scanned: 1, updated: 1 });
      expect(sqlite.prepare("SELECT status, filled_qty, filled_avg_price FROM trades").get()).toEqual({
        status: "canceled", filled_qty: 1, filled_avg_price: 150.25,
      });
      expect(await syncRecentTradeStatuses(db, provider(getOrder))).toEqual({ scanned: 0, updated: 0 });
      expect(getOrder).toHaveBeenCalledTimes(1);
    } finally {
      sqlite.close();
    }
  });
});
