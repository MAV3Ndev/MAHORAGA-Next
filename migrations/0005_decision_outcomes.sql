CREATE TABLE decision_outcomes (
  decision_id TEXT PRIMARY KEY REFERENCES trade_decisions(id),
  symbol TEXT NOT NULL,
  decision_at TEXT NOT NULL,
  source TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  confidence REAL,
  baseline_price REAL,
  baseline_at TEXT,
  t1_return REAL,
  t5_return REAL,
  t20_return REAL,
  features_json TEXT,
  label_status TEXT NOT NULL,
  labeled_at TEXT NOT NULL
);

CREATE INDEX idx_decision_outcomes_at ON decision_outcomes(decision_at);
CREATE INDEX idx_decision_outcomes_symbol ON decision_outcomes(symbol);
CREATE INDEX idx_decision_outcomes_status ON decision_outcomes(label_status);
