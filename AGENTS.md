# Agent Notes

## Trade Review Logs

トレード分析や改善提案にログが必要な場合は、ユーザーに起動中のエージェントから次のエンドポイントを叩いて JSON を取得してもらうこと:

When you need logs to analyze or improve trading behavior, ask the user to download the trade review log from the running agent:

```text
GET /agent/trade-review?days=90&limit=500&include_snapshots=true
```

The response includes indexed decision rows from D1 and, when requested, detailed R2 snapshots for recent decisions. Use this instead of Durable Object runtime logs for trade analysis.

From the dashboard/desktop UI, use the **Download Logs** action in the remote link controls, choose the export parameters, then download the JSON payload.

## Indicator Effectiveness Report

指標（confidence・sentiment・Zスコア等）と将来リターンの相関を評価する分析レポート:

```text
GET /agent/indicator-report?days=90
```

- `decision_outcomes` テーブルに T+1/T+5/T+20 の forward return をラベル付け（blocked/filtered を含む反実仮想も対象）。midnight cron (`0 5 * * *`) で日次ラベリングされる。
- `&refresh=true` を付けるとレポート生成前にその場でラベリングジョブを実行できる（`&refresh_limit=N`、最大200）。
- レスポンス: 特徴量ごとの Spearman IC、分位バケット（単調性スコア付き）、エンジン別（llm/jev）confidence キャリブレーション、ソース別統計、ゲート別反実仮想リターン。
- `sufficient_sample` が false の IC（n < 30）は参考値。閾値やゲートの変更は十分なサンプルが集まってから。
