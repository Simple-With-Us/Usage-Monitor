-- D1 schema for the expenses dashboard (expenses.jays.services).
--
-- This is a read cache of Usage Monitor's owner-expense ledger (the ledger
-- stays the system of record).  `category` is stored per row so a future
-- add/edit UI can override it without a migration.  Apply with:
--   wrangler d1 execute expenses-site --file workers/expenses-site/schema.sql

CREATE TABLE IF NOT EXISTS expenses (
  idempotency_key TEXT PRIMARY KEY,
  vendor TEXT NOT NULL,
  amount_usd REAL NOT NULL,
  occurred_at TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT,
  notes TEXT,
  confidence TEXT,
  category TEXT NOT NULL DEFAULT 'other',
  calendar_sort TEXT,
  synced_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_expenses_occurred ON expenses (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses (category);

CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Idempotency keys that must never render on the dashboard, even though they
-- still exist upstream.  Used for ledger rows that were posted in error
-- (double-posted receipts, superseded gross/discount/correction rows) and
-- later corrected at the display layer.  Sync skips these keys on every run.
CREATE TABLE IF NOT EXISTS suppressed_expenses (
  idempotency_key TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  suppressed_at TEXT NOT NULL
);
