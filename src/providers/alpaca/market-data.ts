import type { Bar, BarsParams, MarketDataProvider, Quote, Snapshot } from "../types";
import type { AlpacaClient } from "./client";

interface AlpacaBarsResponse {
  bars: Record<string, AlpacaBar[]>;
  next_page_token?: string;
}

interface AlpacaBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  n: number;
  vw: number;
}

interface AlpacaLatestBarsResponse {
  bars: Record<string, AlpacaBar>;
}

interface AlpacaQuotesResponse {
  quotes: Record<string, AlpacaQuote>;
}

interface AlpacaQuote {
  ap: number;
  as: number;
  bp: number;
  bs: number;
  t: string;
}

interface AlpacaSnapshotsResponse {
  [symbol: string]: AlpacaSnapshot;
}

interface AlpacaSnapshot {
  latestTrade: {
    p: number;
    s: number;
    t: string;
  };
  latestQuote: AlpacaQuote;
  minuteBar: AlpacaBar;
  dailyBar: AlpacaBar;
  prevDailyBar: AlpacaBar;
}

interface AlpacaCryptoSnapshotsResponse {
  snapshots: Record<string, AlpacaSnapshot>;
}

function parseBar(raw: AlpacaBar): Bar {
  return {
    t: raw.t,
    o: raw.o,
    h: raw.h,
    l: raw.l,
    c: raw.c,
    v: raw.v,
    n: raw.n,
    vw: raw.vw,
  };
}

function parseQuote(symbol: string, raw: AlpacaQuote): Quote {
  return {
    symbol,
    bid_price: raw.bp,
    bid_size: raw.bs,
    ask_price: raw.ap,
    ask_size: raw.as,
    timestamp: raw.t,
  };
}

function parseSnapshot(symbol: string, raw: AlpacaSnapshot): Snapshot {
  return {
    symbol,
    latest_trade: {
      price: raw.latestTrade.p,
      size: raw.latestTrade.s,
      timestamp: raw.latestTrade.t,
    },
    latest_quote: parseQuote(symbol, raw.latestQuote),
    minute_bar: parseBar(raw.minuteBar),
    daily_bar: parseBar(raw.dailyBar),
    prev_daily_bar: parseBar(raw.prevDailyBar),
  };
}

export class AlpacaMarketDataProvider implements MarketDataProvider {
  constructor(private client: AlpacaClient) {}

  async getBars(symbol: string, timeframe: string, params?: BarsParams): Promise<Bar[]> {
    const requestedLimit = params?.limit ?? 1000;
    const collected: Bar[] = [];
    let pageToken = params?.page_token;

    for (let page = 0; page < 10 && collected.length < requestedLimit; page += 1) {
      const response = await this.client.dataRequest<AlpacaBarsResponse>("GET", "/v2/stocks/bars", {
        symbols: symbol,
        timeframe,
        start: params?.start,
        end: params?.end,
        limit: Math.min(requestedLimit - collected.length, 10_000),
        adjustment: params?.adjustment,
        feed: params?.feed,
        page_token: pageToken,
      });

      if (!response?.bars) break;
      const bars = response.bars[symbol] ?? response.bars[symbol.toUpperCase()] ?? [];
      collected.push(...bars.map(parseBar));
      if (!response.next_page_token || bars.length === 0) break;
      pageToken = response.next_page_token;
    }

    return collected.slice(0, requestedLimit);
  }

  async getCryptoBars(symbol: string, timeframe: string, params?: BarsParams): Promise<Bar[]> {
    const requestedLimit = params?.limit ?? 1000;
    const collected: Bar[] = [];
    let pageToken = params?.page_token;
    for (let page = 0; page < 10 && collected.length < requestedLimit; page += 1) {
      const response = await this.client.dataRequest<AlpacaBarsResponse>("GET", "/v1beta3/crypto/us/bars", {
        symbols: symbol,
        timeframe,
        start: params?.start,
        end: params?.end,
        limit: Math.min(requestedLimit - collected.length, 10_000),
        page_token: pageToken,
      });
      const bars = response?.bars?.[symbol] ?? response?.bars?.[symbol.toUpperCase()] ?? [];
      collected.push(...bars.map(parseBar));
      if (!response?.next_page_token || bars.length === 0) break;
      pageToken = response.next_page_token;
    }
    return collected.slice(0, requestedLimit);
  }

  async getLatestBar(symbol: string): Promise<Bar> {
    const response = await this.client.dataRequest<AlpacaLatestBarsResponse>("GET", "/v2/stocks/bars/latest", {
      symbols: symbol,
    });

    const bar = response.bars[symbol] ?? response.bars[symbol.toUpperCase()];
    if (!bar) {
      throw new Error(`No bar data for ${symbol}`);
    }
    return parseBar(bar);
  }

  async getLatestBars(symbols: string[]): Promise<Record<string, Bar>> {
    const response = await this.client.dataRequest<AlpacaLatestBarsResponse>("GET", "/v2/stocks/bars/latest", {
      symbols: symbols.join(","),
    });

    const result: Record<string, Bar> = {};
    for (const [symbol, bar] of Object.entries(response.bars)) {
      result[symbol] = parseBar(bar);
    }
    return result;
  }

  async getQuote(symbol: string): Promise<Quote> {
    const response = await this.client.dataRequest<AlpacaQuotesResponse>("GET", "/v2/stocks/quotes/latest", {
      symbols: symbol,
    });

    const quote = response.quotes[symbol] ?? response.quotes[symbol.toUpperCase()];
    if (!quote) {
      throw new Error(`No quote data for ${symbol}`);
    }
    return parseQuote(symbol, quote);
  }

  async getQuotes(symbols: string[]): Promise<Record<string, Quote>> {
    const response = await this.client.dataRequest<AlpacaQuotesResponse>("GET", "/v2/stocks/quotes/latest", {
      symbols: symbols.join(","),
    });

    const result: Record<string, Quote> = {};
    for (const [symbol, quote] of Object.entries(response.quotes)) {
      result[symbol] = parseQuote(symbol, quote);
    }
    return result;
  }

  async getSnapshot(symbol: string): Promise<Snapshot> {
    const response = await this.client.dataRequest<AlpacaSnapshotsResponse>("GET", "/v2/stocks/snapshots", {
      symbols: symbol,
    });

    if (!response) {
      throw new Error(`No snapshot data for ${symbol} (market may be closed)`);
    }

    const snapshot = response[symbol] ?? response[symbol.toUpperCase()];
    if (!snapshot) {
      throw new Error(`No snapshot data for ${symbol} (market may be closed)`);
    }
    return parseSnapshot(symbol, snapshot);
  }

  async getCryptoSnapshot(symbol: string): Promise<Snapshot> {
    const response = await this.client.dataRequest<AlpacaCryptoSnapshotsResponse>(
      "GET",
      "/v1beta3/crypto/us/snapshots",
      { symbols: symbol }
    );

    const snapshot = response?.snapshots?.[symbol] ?? response?.snapshots?.[symbol.toUpperCase()];
    if (!snapshot) {
      throw new Error(`No crypto snapshot data for ${symbol}`);
    }
    return parseSnapshot(symbol, snapshot);
  }

  async getSnapshots(symbols: string[]): Promise<Record<string, Snapshot>> {
    const response = await this.client.dataRequest<AlpacaSnapshotsResponse>("GET", "/v2/stocks/snapshots", {
      symbols: symbols.join(","),
    });

    const result: Record<string, Snapshot> = {};
    for (const [symbol, snapshot] of Object.entries(response)) {
      result[symbol] = parseSnapshot(symbol, snapshot);
    }
    return result;
  }
}

export function createAlpacaMarketDataProvider(client: AlpacaClient): AlpacaMarketDataProvider {
  return new AlpacaMarketDataProvider(client);
}
