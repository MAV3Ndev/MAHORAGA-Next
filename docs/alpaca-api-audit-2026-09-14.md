# Alpaca API 呼び出し監査 (2026-09-14)

公式 Reference と `src/providers/alpaca` の呼び出しを照合した結果。公式 URL は Alpaca US docs の各 Reference ページ。

## 確認済みで一致

- Stock historical bars: `GET /v2/stocks/bars`（`symbols`, `timeframe`, `start/end`, `limit`, `feed`, `page_token`）。実装は既にこの形式へ修正済み。
- Latest multi-stock bars: `GET /v2/stocks/bars/latest`（`symbols`）。公式: https://docs.alpaca.markets/reference/stocklatestbars-1
- Latest multi-stock quotes: `GET /v2/stocks/quotes/latest`（`symbols`）。公式: https://docs.alpaca.markets/reference/stocklatestquotes-1
- Stock snapshots: `GET /v2/stocks/snapshots`（`symbols`）。公式: https://docs.alpaca.markets/reference/stocksnapshots-1
- Crypto bars: `GET /v1beta3/crypto/{loc}/bars`。`loc=us` と `symbols/timeframe/start/end/limit` は公式仕様。公式: https://docs.alpaca.markets/reference/cryptobars-1
- Crypto snapshots: `GET /v1beta3/crypto/{loc}/snapshots`（`symbols`）。公式: https://docs.alpaca.markets/reference/cryptosnapshots-1
- Trading API の account (`/v2/account`), positions (`/v2/positions`), orders (`/v2/orders`), clock (`/v2/clock`), calendar (`/v2/calendar`), assets (`/v2/assets/{symbol}`), portfolio history (`/v2/account/portfolio/history`) は公式パスと一致。
- Options snapshots のパス `/v1beta1/options/snapshots` は公式と一致。公式: https://docs.alpaca.markets/reference/optionsnapshots

## 不一致または修正が必要

### 1. 単一銘柄 latest bars/quotes/snapshot の非公式パス

`market-data.ts` の以下は、公式 Reference が提供する multi-symbol endpoint には存在しない単一銘柄パスです。

- `/v2/stocks/{symbol}/bars/latest`
- `/v2/stocks/{symbol}/quotes/latest`
- `/v2/stocks/{symbol}/snapshot`

公式はそれぞれ `/v2/stocks/bars/latest`, `/v2/stocks/quotes/latest`, `/v2/stocks/snapshots` を使い、`symbols=SYMBOL` をクエリで渡します。単一銘柄メソッドも multi endpoint を呼び、レスポンスの symbol キーを取り出す必要があります。

### 2. Crypto bars のページング未実装

公式 crypto bars レスポンスは `bars` と `next_page_token` を返し、`page_token` で継続取得します（Stock bars と同じページング契約）。`getCryptoBars` は一度の GET のみで `next_page_token` を無視するため、`limit` が大きい場合に履歴が欠落します。最大ページ数・要求 limit まで結合する実装が必要です。

### 3. Options contracts のページング未実装

`getContracts` は `page_token` を送信できますが、レスポンスの `next_page_token` を追跡しません。公式 `/v2/options/contracts` はページングレスポンス（`option_contracts`, `next_page_token`）のため、`getExpirations`/`getChain` が 1 ページ分しか見ない状態です。要求 limit までページを結合してください。

### 4. Options snapshots のページング未実装

公式 `/v1beta1/options/snapshots` のレスポンスには `snapshots` と `next_page_token` が含まれます（公式ページのレスポンス例）。現状 `getSnapshots` は一度だけ取得し、トークンを破棄しています。複数ページを追跡する必要があります。

## 参考（公式ドキュメント）

- Stock latest bars: https://docs.alpaca.markets/reference/stocklatestbars-1
- Stock latest quotes: https://docs.alpaca.markets/reference/stocklatestquotes-1
- Stock snapshots: https://docs.alpaca.markets/reference/stocksnapshots-1
- Crypto bars: https://docs.alpaca.markets/reference/cryptobars-1
- Crypto snapshots: https://docs.alpaca.markets/reference/cryptosnapshots-1
- Options snapshots: https://docs.alpaca.markets/reference/optionssnapshots
- Trading API overview: https://docs.alpaca.markets/reference/getaccount
