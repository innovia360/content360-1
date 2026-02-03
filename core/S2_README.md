# Content360 Core API - S2 (Execution Hardening)

This release adds:
- Strict request payload validation for `POST /v1/jobs/create`
- Idempotency (supports `Idempotency-Key` or `x-idempotency-key`)
- AEJ quota pre-check + reservation (holds) to prevent over-quota job creation
- AEJ balance endpoint: `GET /v1/aej/balance`
- Worker finalization: release holds and persist `aej_final` / `error_text`

## 1) Apply DB migration

Run in Postgres:

```sql
\i migrations/S2.sql
```

### Hotfix (UUID client_id)

If you see this error in API logs during `POST /v1/jobs/create`:

`invalid input syntax for type integer: "<uuid>"`

it means your `c360_clients.id` (and therefore `client_id`) is UUID/TEXT while some tables still use INTEGER.
Apply the hotfix migration:

```sql
\i migrations/S2_fix_client_id.sql
```

## 2) Restart API & Worker

If docker-compose:

```bash
docker compose up -d --force-recreate content360-api content360-worker
```

## 3) Idempotency usage

Send header:

- `Idempotency-Key: <uuid>`

If the same key is repeated, the API returns the same `job_id` without creating a new job.

## 4) Quota behavior

If `consumed + held + estimate > monthly_quota_aej`, the API returns:

- HTTP 402
- `{ error: "quota_exceeded", aej_remaining, aej_needed, ... }`
