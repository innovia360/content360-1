-- S3++++: clients management tables (safe)

CREATE TABLE IF NOT EXISTS c360_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  api_key TEXT NOT NULL UNIQUE,
  api_secret TEXT NOT NULL,
  quota_aej BIGINT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_c360_clients_active ON c360_clients(is_active);
