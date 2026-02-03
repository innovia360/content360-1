-- Content360 Core API - S2 Hotfix
-- Fixes: invalid input syntax for type integer: "<uuid>" during /v1/jobs/create
-- Cause: client_id columns were INTEGER but c360_clients.id is UUID/TEXT.
-- Approach: widen client_id columns to TEXT (safe for both uuid and int).

BEGIN;

DO $$
BEGIN
  -- c360_idempotency.client_id
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='c360_idempotency' AND column_name='client_id'
  ) THEN
    ALTER TABLE public.c360_idempotency
      ALTER COLUMN client_id TYPE TEXT USING client_id::text;
  END IF;

  -- c360_aej_holds.client_id
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='c360_aej_holds' AND column_name='client_id'
  ) THEN
    ALTER TABLE public.c360_aej_holds
      ALTER COLUMN client_id TYPE TEXT USING client_id::text;
  END IF;

  -- c360_jobs.client_id
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='c360_jobs' AND column_name='client_id'
  ) THEN
    ALTER TABLE public.c360_jobs
      ALTER COLUMN client_id TYPE TEXT USING client_id::text;
  END IF;

  -- c360_site_settings.client_id
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='c360_site_settings' AND column_name='client_id'
  ) THEN
    ALTER TABLE public.c360_site_settings
      ALTER COLUMN client_id TYPE TEXT USING client_id::text;
  END IF;

  -- c360_aej_logs.client_id
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='c360_aej_logs' AND column_name='client_id'
  ) THEN
    ALTER TABLE public.c360_aej_logs
      ALTER COLUMN client_id TYPE TEXT USING client_id::text;
  END IF;
END
$$;

COMMIT;
