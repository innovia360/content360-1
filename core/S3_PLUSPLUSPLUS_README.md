# Content360 Backend – S3+++ (Timeline + AEJ Console + OpenAI Degraded Toggle)

This package extends **S3++** with **S3+++** features **without breaking existing S0/S1/S2/S3/S3+ endpoints**.

## What's new

### 1) Job timeline events
- Migration: `migrations/S3_plusplus.sql`
- Table: `c360_job_events`
- Worker writes events:
  - `running`, `openai_call`, `openai_ok`, `fallback`, `done`, `error`
- API writes events:
  - `created`, `idempotent_hit`, `canceled`, `retry`

Endpoints:
- `GET /v1/admin/jobs/:id/events?limit=200`

### 2) AEJ console endpoints
- `GET /v1/admin/aej/holds?client_id=...&limit=100`
- `GET /v1/admin/aej/logs?client_id=...&job_id=...&limit=200`

### 3) Force degraded mode (OpenAI down simulation)
- Table: `c360_admin_flags`
- `GET /v1/admin/openai/degraded`
- `POST /v1/admin/openai/degraded` body: `{ "enabled": true|false }`

Worker respects the flag and will skip OpenAI call (deterministic fallback).

### 4) Admin UI updates
- `GET /v1/admin/ui`
  - Adds buttons: Job events / AEJ holds / AEJ logs
  - Adds force_degraded load/apply

## Install
1) Copy/merge the files into your backend folder (replace `index.js` + `worker.js`).
2) Run SQL migration in Postgres:

```sql
\i migrations/S3_plusplus.sql
```

3) Restart containers:

```bash
docker compose up -d --force-recreate content360-api content360-worker
```

## Notes
- Admin endpoints still require **HMAC headers** and `x-c360-admin-token`.
- Events logging is **best effort** and never blocks job execution.
