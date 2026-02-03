# Content360 Backend – S3+ (Admin Control & Observability)

This release adds **S3** (admin observability) and **S3+** (advanced UX helpers) **without breaking** existing client flows.

## Admin Security
Admin endpoints require:
1) Standard HMAC auth (`x-c360-key`, `x-c360-sign`)
2) **Admin token** header: `x-c360-admin-token: <C360_ADMIN_TOKEN>`

Set env vars:
- `C360_ADMIN_TOKEN=...` (recommended)
- optionally: `C360_ADMIN_CLIENT_ID=...` (secondary gate)

## New Endpoints

### Health deps
`GET /v1/admin/health/deps`

Checks DB + Redis + queue connectivity + OpenAI (light ping).

### Jobs list
`GET /v1/admin/jobs?status=&client_id=&mode=&limit=&offset=`

### Job detail
`GET /v1/admin/jobs/:id`

Includes `request_json` and `result_json`.

### Jobs CSV export (S3+)
`GET /v1/admin/jobs/export.csv?status=&client_id=&mode=`

Returns a CSV stream.

### Cancel a job (S3+)
`POST /v1/admin/jobs/:id/cancel`

- Marks job as `canceled`
- Removes from BullMQ queue if possible
- Releases AEJ hold

Worker also honors `status=canceled` (skips execution and releases hold).

### Retry a job (S3+)
`POST /v1/admin/jobs/:id/retry`

- Resets status to `queued`
- Re-enqueues BullMQ job
- Re-holds AEJ if missing

### Idempotency lookup (S3+)
`GET /v1/admin/idempotency/:key`

Shows job_ids created for a given `idem_key`.

## Curl example (admin)

```bash
BODY='{}'
KEY='ck_...'
SECRET='cs_...'
SIGN=$(printf "%s" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')

curl -sS 'http://localhost:8080/v1/admin/health/deps' \
  -H 'Content-Type: application/json' \
  -H "x-c360-key: $KEY" \
  -H "x-c360-sign: $SIGN" \
  -H "x-c360-admin-token: $C360_ADMIN_TOKEN"
```
