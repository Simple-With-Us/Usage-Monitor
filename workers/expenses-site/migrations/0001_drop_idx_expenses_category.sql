-- Drops the index only the unused /api/expenses?category= filter could use.
-- Measured over 15 days: no category-filtered query ran, and the dashboard
-- filters in the browser.  Writing a row now costs one fewer row written.
-- idx_expenses_occurred stays: the dashboard read uses it to avoid a sort.
--
-- Apply by hand, like schema.sql (the deploy workflow does not touch schema):
--   wrangler d1 execute expenses-site --remote --file workers/expenses-site/migrations/0001_drop_idx_expenses_category.sql

DROP INDEX IF EXISTS idx_expenses_category;
