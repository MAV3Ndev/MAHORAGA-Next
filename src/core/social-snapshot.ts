import type { Signal, SocialHistoryEntry, SocialSnapshotCacheEntry } from "./types";

export type SocialSnapshot = Map<string, { volume: number; sentiment: number; sources: Set<string> }>;

const SOCIAL_HISTORY_BUCKET_MS = 5 * 60 * 1000;
const SOCIAL_HISTORY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function buildSocialSnapshot(signals: Signal[]): SocialSnapshot {
  const aggregated = new Map<string, { volume: number; sentimentNumerator: number; sources: Set<string> }>();

  for (const signal of signals) {
    if (!signal.symbol) continue;
    const volume = Number.isFinite(signal.volume) && signal.volume > 0 ? signal.volume : 1;

    let entry = aggregated.get(signal.symbol);
    if (!entry) {
      entry = { volume: 0, sentimentNumerator: 0, sources: new Set() };
      aggregated.set(signal.symbol, entry);
    }
    entry.volume += volume;
    entry.sentimentNumerator += (Number.isFinite(signal.sentiment) ? signal.sentiment : 0) * volume;
    entry.sources.add(signal.source_detail || signal.source);
  }

  const snapshot: SocialSnapshot = new Map();
  for (const [symbol, entry] of aggregated) {
    snapshot.set(symbol, {
      volume: entry.volume,
      sentiment: entry.volume > 0 ? entry.sentimentNumerator / entry.volume : 0,
      sources: entry.sources,
    });
  }
  return snapshot;
}

export function serializeSocialSnapshot(snapshot: SocialSnapshot): Record<string, SocialSnapshotCacheEntry> {
  const out: Record<string, SocialSnapshotCacheEntry> = {};
  for (const [symbol, entry] of snapshot) {
    out[symbol] = {
      volume: entry.volume,
      sentiment: entry.sentiment,
      sources: Array.from(entry.sources),
    };
  }
  return out;
}

export function pruneSocialHistoryInPlace(history: SocialHistoryEntry[], cutoffMs: number): void {
  if (history.length === 0) return;

  const pruned = history.filter((entry) => entry.timestamp >= cutoffMs);
  pruned.sort((a, b) => a.timestamp - b.timestamp);
  history.splice(0, history.length, ...pruned);
}

export function updateSocialHistoryFromSnapshot(
  socialHistory: Record<string, SocialHistoryEntry[]>,
  snapshot: SocialSnapshot,
  nowMs: number
): void {
  const cutoff = nowMs - SOCIAL_HISTORY_MAX_AGE_MS;

  const touchedSymbols = new Set<string>();
  for (const [symbol, snapshotEntry] of snapshot) {
    touchedSymbols.add(symbol);
    const history = socialHistory[symbol] ?? [];
    if (history.length > 1) history.sort((a, b) => a.timestamp - b.timestamp);
    const last = history[history.length - 1];

    if (last && nowMs - last.timestamp < SOCIAL_HISTORY_BUCKET_MS) {
      last.timestamp = nowMs;
      last.volume = snapshotEntry.volume;
      last.sentiment = snapshotEntry.sentiment;
    } else {
      history.push({ timestamp: nowMs, volume: snapshotEntry.volume, sentiment: snapshotEntry.sentiment });
    }

    pruneSocialHistoryInPlace(history, cutoff);
    if (history.length === 0) {
      delete socialHistory[symbol];
    } else {
      socialHistory[symbol] = history;
    }
  }

  for (const symbol of Object.keys(socialHistory)) {
    if (touchedSymbols.has(symbol)) continue;
    const history = socialHistory[symbol];
    if (!history || history.length === 0) {
      delete socialHistory[symbol];
      continue;
    }
    pruneSocialHistoryInPlace(history, cutoff);
    if (history.length === 0) {
      delete socialHistory[symbol];
    }
  }
}

export interface SocialZScores {
  volume_z: number | null;
  sentiment_z: number | null;
  samples: number;
}

const SOCIAL_ZSCORE_MIN_SAMPLES = 20;
const SOCIAL_ZSCORE_EXCLUDE_RECENT_MS = 15 * 60 * 1000;

/**
 * Z-score of the current social volume/sentiment vs the symbol's own
 * recent history (per-symbol normalization instead of a global absolute
 * threshold). Returns null scores when history is too short or degenerate.
 */
export function computeSocialZScores(
  history: SocialHistoryEntry[] | undefined,
  current: { volume: number; sentiment: number },
  nowMs: number
): SocialZScores {
  const past = (history ?? []).filter((entry) => entry.timestamp < nowMs - SOCIAL_ZSCORE_EXCLUDE_RECENT_MS);
  if (past.length < SOCIAL_ZSCORE_MIN_SAMPLES) {
    return { volume_z: null, sentiment_z: null, samples: past.length };
  }

  const zScore = (values: number[], v: number): number | null => {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, x) => a + (x - mean) * (x - mean), 0) / values.length;
    const sd = Math.sqrt(variance);
    return sd > 1e-9 ? (v - mean) / sd : null;
  };

  return {
    volume_z: zScore(
      past.map((e) => e.volume),
      current.volume
    ),
    sentiment_z: zScore(
      past.map((e) => e.sentiment),
      current.sentiment
    ),
    samples: past.length,
  };
}

export function getSocialSnapshotCache(params: {
  socialSnapshotCache: Record<string, SocialSnapshotCacheEntry>;
  socialSnapshotCacheUpdatedAt: number;
  signalCache: Signal[];
}): Record<string, SocialSnapshotCacheEntry> {
  if (params.socialSnapshotCacheUpdatedAt > 0) {
    return params.socialSnapshotCache;
  }

  return serializeSocialSnapshot(buildSocialSnapshot(params.signalCache));
}
