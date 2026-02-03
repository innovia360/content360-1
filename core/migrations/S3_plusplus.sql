-- Content360 Core API - S3+++ Migration
-- Adds: job events timeline + admin flags for force-degraded mode

BEGIN;

-- 1) Job events (timeline)
CREATE TABLE IF NOT EXISTS c360_job_events (
  id          BIGSERIAL PRIMARY KEY,
  job_id      TEXT NOT NULL,
  client_id   TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  message     TEXT NULL,
  meta        JSONB NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_c360_job_events_job_id_created ON c360_job_events(job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_c360_job_events_client_created ON c360_job_events(client_id, created_at DESC);

-- 2) Admin flags (e.g., force OpenAI degraded mode)
CREATE TABLE IF NOT EXISTS c360_admin_flags (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
