/**
 * Per-trade exit thresholds.
 *
 * The research LLM recommends stop_loss_pct / take_profit_pct per symbol.
 * These helpers clamp its suggestions into a config-relative band — plus an
 * ATR floor for stops — so per-trade judgment can adapt to volatility without
 * ever breaking the portfolio-level risk envelope.
 */

// How far the LLM recommendation may deviate from the configured value.
const STOP_MIN_FACTOR = 0.5;
const STOP_MAX_FACTOR = 2;
const TP_MIN_FACTOR = 0.5;
const TP_MAX_FACTOR = 3;

// A stop tighter than ~1.5 ATR is noise-level on a volatile symbol.
const ATR_STOP_FLOOR_MULTIPLE = 1.5;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isValidRecommended(value: number | undefined | null): value is number {
  return value !== undefined && value !== null && Number.isFinite(value) && value > 0;
}

/**
 * Effective stop loss for a position: the recommended stop clamped to
 * [0.5×configured, 2×configured], with an ATR floor so high-volatility
 * symbols are not given a noise-level stop. Falls back to the configured
 * stop when no valid recommendation exists.
 */
export function getEffectiveStopLossPct(
  recommendedStopLossPct: number | undefined | null,
  configuredStopLossPct: number,
  atr?: number,
  entryPrice?: number
): number {
  const min = configuredStopLossPct * STOP_MIN_FACTOR;
  const max = configuredStopLossPct * STOP_MAX_FACTOR;
  let effective = isValidRecommended(recommendedStopLossPct)
    ? clamp(recommendedStopLossPct, min, max)
    : configuredStopLossPct;

  if (atr !== undefined && atr > 0 && entryPrice !== undefined && entryPrice > 0) {
    const atrFloorPct = (ATR_STOP_FLOOR_MULTIPLE * atr * 100) / entryPrice;
    effective = Math.max(effective, Math.min(atrFloorPct, max));
  }
  return effective;
}

/**
 * Effective take profit: the recommendation clamped to
 * [0.5×configured, 3×configured], falling back to the configured target.
 */
export function getEffectiveTakeProfitPct(
  recommendedTakeProfitPct: number | undefined | null,
  configuredTakeProfitPct: number
): number {
  if (!isValidRecommended(recommendedTakeProfitPct)) return configuredTakeProfitPct;
  return clamp(
    recommendedTakeProfitPct,
    configuredTakeProfitPct * TP_MIN_FACTOR,
    configuredTakeProfitPct * TP_MAX_FACTOR
  );
}
