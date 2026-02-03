-- Content360 Core API - S2 Migration
-- Adds: idempotency, AEJ holds, job columns for reservation/final usage

BEGIN;

-- 1) Idempotency table
CREATE TABLE IF NOT EXISTS c360_idempotency (
  client_id      INTEGER NOT NULL,
  idem_key       TEXT    NOT NULL,
  job_id         TEXT    NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (client_id, idem_key)
);

-- 2) AEJ holds (reservations)
CREATE TABLE IF NOT EXISTS c360_aej_holds (
  job_id         TEXT PRIMARY KEY,
  client_id      INTEGER NOT NULL,
  aej_estimated  INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'held',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_at    TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_c360_aej_holds_client_status
  ON c360_aej_holds (client_id, status);

-- 3) Jobs: add reservation + final + idempotency columns
ALTER TABLE c360_jobs
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS aej_estimated   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS aej_final       INTEGER NULL,
  ADD COLUMN IF NOT EXISTS error_text      TEXT NULL;

COMMIT;
