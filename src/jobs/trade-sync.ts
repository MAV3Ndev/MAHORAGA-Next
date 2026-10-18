import type { AlpacaProviders } from "../providers/alpaca";
import type { D1Client } from "../storage/d1/client";
import { getUnfinishedTrades, markTradeSyncAttempt, updateTradeStatus } from "../storage/d1/queries/trades";

const TRADE_SYNC_BATCH_SIZE = 100;

export interface TradeSyncSummary {
  scanned: number;
  updated: number;
}

function finiteNumber(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function syncRecentTradeStatuses(db: D1Client, alpaca: AlpacaProviders): Promise<TradeSyncSummary> {
  const trades = await getUnfinishedTrades(db, TRADE_SYNC_BATCH_SIZE);
  let updated = 0;

  await Promise.all(
    trades.map(async (trade) => {
      try {
        const order = await alpaca.trading.getOrder(trade.alpaca_order_id);
        const filledQty = finiteNumber(order.filled_qty);
        const filledAvgPrice = finiteNumber(order.filled_avg_price);
        if (
          trade.status === order.status &&
          (filledQty ?? null) === trade.filled_qty &&
          (filledAvgPrice ?? null) === trade.filled_avg_price
        ) {
          await markTradeSyncAttempt(db, trade.id);
          return;
        }

        // COALESCE in updateTradeStatus preserves a partial fill even when a
        // final canceled response omits one of the fill fields.
        await updateTradeStatus(db, trade.id, order.status, filledQty, filledAvgPrice);
        updated++;
      } catch {
        // One deleted/invalid broker order must not prevent other trades from
        // syncing. Rotate this row so repeated failures cannot starve others.
        await markTradeSyncAttempt(db, trade.id).catch(() => undefined);
      }
    })
  );

  return { scanned: trades.length, updated };
}
