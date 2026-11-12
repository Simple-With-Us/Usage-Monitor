import Foundation

/// Exact DDL from design §2.2.1 — do not invent columns.
enum MigrationV1 {
    static let version = 1

    static let statements: [String] = [
        """
        CREATE TABLE app_meta (
          key   TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL
        )
        """,
        """
        CREATE TABLE provider (
          id                   TEXT PRIMARY KEY NOT NULL,
          name                 TEXT NOT NULL,
          display_name         TEXT NOT NULL,
          type                 TEXT NOT NULL DEFAULT 'builtin',
          adapter_kind         TEXT NOT NULL,
          category             TEXT,
          is_active            INTEGER NOT NULL DEFAULT 1,
          refresh_interval_min INTEGER NOT NULL DEFAULT 60,
          label                TEXT,
          keychain_account_id  TEXT,
          non_secret_config_json TEXT,
          last_fetch_at        TEXT,
          last_fetch_error     TEXT,
          created_at           TEXT NOT NULL,
          updated_at           TEXT NOT NULL
        )
        """,
        "CREATE UNIQUE INDEX idx_provider_name ON provider(name)",
        """
        CREATE TABLE provider_plan (
          provider_id            TEXT PRIMARY KEY NOT NULL REFERENCES provider(id) ON DELETE CASCADE,
          billing_mode           TEXT NOT NULL DEFAULT 'manual',
          fixed_monthly_cost_usd REAL,
          monthly_budget_usd     REAL,
          monthly_request_limit  INTEGER,
          renewal_date           TEXT,
          billing_interval       TEXT DEFAULT 'monthly',
          notes                  TEXT,
          updated_at             TEXT NOT NULL
        )
        """,
        """
        CREATE TABLE usage_snapshot (
          id                    TEXT PRIMARY KEY NOT NULL,
          provider_id           TEXT NOT NULL REFERENCES provider(id) ON DELETE CASCADE,
          fetched_at            TEXT NOT NULL,
          balance               REAL,
          total_cost            REAL,
          fixed_cost_included_usd REAL,
          cost_window_start     TEXT,
          cost_window_end       TEXT,
          cost_scope            TEXT,
          cost_includes_unknown_fixed INTEGER NOT NULL DEFAULT 0,
          total_requests        INTEGER,
          credits               REAL,
          cost_coverage_caveat_code TEXT,
          cost_coverage_caveat_message TEXT,
          created_at            TEXT NOT NULL
        )
        """,
        "CREATE INDEX idx_snapshot_provider_fetched ON usage_snapshot(provider_id, fetched_at)",
        "CREATE INDEX idx_snapshot_fetched ON usage_snapshot(fetched_at)",
        """
        CREATE TABLE project (
          id                 TEXT PRIMARY KEY NOT NULL,
          name               TEXT NOT NULL,
          name_key           TEXT NOT NULL,
          description        TEXT,
          monthly_budget_usd REAL,
          created_at         TEXT NOT NULL,
          updated_at         TEXT NOT NULL
        )
        """,
        "CREATE UNIQUE INDEX idx_project_name_key ON project(name_key)",
        // subscription references project — create project first (already above)
        """
        CREATE TABLE subscription (
          id                        TEXT PRIMARY KEY NOT NULL,
          provider_id               TEXT NOT NULL REFERENCES provider(id) ON DELETE CASCADE,
          project_id                TEXT REFERENCES project(id) ON DELETE SET NULL,
          name                      TEXT NOT NULL,
          description               TEXT,
          cost_usd                  REAL NOT NULL,
          currency                  TEXT NOT NULL DEFAULT 'USD',
          interval                  TEXT NOT NULL DEFAULT 'monthly',
          interval_count            INTEGER NOT NULL DEFAULT 1,
          anchor_day                INTEGER,
          start_date                TEXT NOT NULL,
          current_period_start      TEXT NOT NULL,
          next_renewal_at           TEXT NOT NULL,
          last_charged_period_start TEXT,
          auto_renew                INTEGER NOT NULL DEFAULT 1,
          status                    TEXT NOT NULL DEFAULT 'active',
          canceled_at               TEXT,
          notes                     TEXT,
          created_at                TEXT NOT NULL,
          updated_at                TEXT NOT NULL
        )
        """,
        "CREATE INDEX idx_subscription_provider ON subscription(provider_id)",
        "CREATE INDEX idx_subscription_status_renewal ON subscription(status, next_renewal_at)",
        """
        CREATE TABLE subscription_charge (
          id               TEXT PRIMARY KEY NOT NULL,
          subscription_id  TEXT NOT NULL REFERENCES subscription(id) ON DELETE CASCADE,
          provider_id      TEXT NOT NULL REFERENCES provider(id) ON DELETE CASCADE,
          project_id       TEXT REFERENCES project(id) ON DELETE SET NULL,
          period_start     TEXT NOT NULL,
          period_end       TEXT NOT NULL,
          cost_usd         REAL NOT NULL,
          currency         TEXT NOT NULL DEFAULT 'USD',
          materialized_at  TEXT NOT NULL,
          UNIQUE (subscription_id, period_start)
        )
        """,
        "CREATE INDEX idx_charge_provider_period ON subscription_charge(provider_id, period_start)",
    ]
}
