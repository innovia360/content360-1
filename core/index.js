/**
 * Content360 Core API (BullMQ enqueue-only) - UPDATED for S1-T3 (AEJ billing)
 * - Keeps existing auth: x-c360-key + x-c360-sign (HMAC-SHA256 over raw JSON body string)
 * - Adds: GET /v1/billing/me  (read-only)
 *
 * CommonJS module style to match existing runtime.
 */
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");
const { getQueue, redisConnection } = require("./queue");

const app = express();
app.use(helmet());
app.use(cors());
// IMPORTANT: capture RAW request body bytes for HMAC verification.
// If we stringify req.body (parsed object), we will NOT match the client's signature
// whenever encoding/order/unicode/ellipsis differ.
app.use(
  express.json({
    limit: "2mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf; // Buffer containing the exact bytes received
    },
  })
);

const PORT = Number(process.env.PORT || 8080);
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) console.error("[api] DATABASE_URL missing");

const pg = new Pool({ connectionString: DATABASE_URL });
const queue = getQueue();

/* ----------------------- S2 constants ----------------------- */
const ALLOWED_MODES = new Set(["quick_boost", "full_content", "ecom_catalog"]);
// Conservative AEJ estimates per item (reservation at job create).
// You can refine these numbers later using real token telemetry.
const AEJ_ESTIMATE_PER_ITEM = {
  quick_boost: 8, // analyse+decision+generation+application
  full_content: 12,
  ecom_catalog: 12,
};

function pickIdempotencyKey(req) {
  // Support common header variants.
  const k = req.headers["idempotency-key"] || req.headers["x-idempotency-key"];
  if (!k) return null;
  const s = String(k).trim();
  return s.length ? s.slice(0, 200) : null;
}

function validateCreatePayload(body) {
  const errors = [];
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    errors.push("body must be an object");
    return { ok: false, errors };
  }

  const allowedTop = new Set(["mode", "items"]);
  for (const k of Object.keys(body)) {
    if (!allowedTop.has(k)) errors.push(`unexpected top-level field: ${k}`);
  }

  const mode = String(body.mode || "").trim();
  if (!ALLOWED_MODES.has(mode)) errors.push(`invalid mode: ${mode || "(empty)"}`);

  const items = Array.isArray(body.items) ? body.items : null;
  if (!items || items.length < 1) errors.push("items_required");
  if (items && items.length > 50) errors.push("items_max_50");

  const allowedItem = new Set([
    "entity_type",
    "entity_id",
    "lang",
    "source_title",
    "source_excerpt",
  ]);

  if (items) {
    items.forEach((it, idx) => {
      if (!it || typeof it !== "object" || Array.isArray(it)) {
        errors.push(`items[${idx}] must be an object`);
        return;
      }
      for (const k of Object.keys(it)) {
        if (!allowedItem.has(k)) errors.push(`items[${idx}] unexpected field: ${k}`);
      }

      const et = String(it.entity_type || "").trim();
      const ei = String(it.entity_id || "").trim();
      const lang = String(it.lang || "").trim();
      const st = String(it.source_title || "").trim();
      const se = String(it.source_excerpt || "").trim();

      if (!["product", "page", "post"].includes(et)) errors.push(`items[${idx}] invalid entity_type: ${et || "(empty)"}`);
      if (!ei) errors.push(`items[${idx}] entity_id_required`);
      if (!lang || lang.length < 2 || lang.length > 10) errors.push(`items[${idx}] invalid lang: ${lang || "(empty)"}`);
      if (!st) errors.push(`items[${idx}] source_title_required`);
      if (!se) errors.push(`items[${idx}] source_excerpt_required`);
    });
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, mode, items };
}

function err(res, code, error) {
  return res.status(code).json({ ok: false, error });
}

/* ------------------------- S3+++ helpers -------------------------- */
async function logJobEvent({ job_id, client_id, event_type, message = null, meta = null }) {
  try {
    await pg.query(
      `INSERT INTO c360_job_events (job_id, client_id, event_type, message, meta, created_at)
       VALUES ($1,$2,$3,$4,$5,NOW())`,
      [String(job_id), String(client_id), String(event_type), message, meta]
    );
  } catch (e) {
    // Never block core flow for observability.
  }
}

async function setAdminFlag(key, value) {
  await pg.query(
    `INSERT INTO c360_admin_flags (key, value, updated_at)
     VALUES ($1,$2,NOW())
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
    [String(key), String(value)]
  );
}

async function getAdminFlag(key) {
  const r = await pg.query(`SELECT value FROM c360_admin_flags WHERE key=$1`, [String(key)]);
  return r.rows[0]?.value ?? null;
}

let cachedDegraded = { v: null, at: 0 };
async function isForceDegraded() {
  const now = Date.now();
  if (cachedDegraded.at && now - cachedDegraded.at < 5000) return cachedDegraded.v === "1";
  const v = await getAdminFlag("force_degraded");
  cachedDegraded = { v: v, at: now };
  return v === "1";
}


/* ------------------------- admin auth (S3) -------------------------- */
// Admin endpoints are protected by BOTH:
// 1) standard client auth (x-c360-key + x-c360-sign)
// 2) a server-side admin token header: x-c360-admin-token
// This avoids breaking any existing client flows and keeps admin features private.
const ADMIN_TOKEN = (process.env.C360_ADMIN_TOKEN || "").trim();

async function requireAdmin(req, res, next) {
  // Must already have req.client from authV1.
  if (!req.client) return err(res, 401, "missing_auth");

  // Primary gate: shared admin token.
  const tok = String(req.headers["x-c360-admin-token"] || "").trim();
  if (ADMIN_TOKEN && tok === ADMIN_TOKEN) return next();

  // Secondary gate (optional): allow a specific admin client id.
  const adminClientId = (process.env.C360_ADMIN_CLIENT_ID || "").trim();
  if (adminClientId && String(req.client.id) === adminClientId) return next();

  return err(res, 403, "admin_required");
}

function maskSecrets(obj) {
  // Shallow mask of common secret fields.
  if (!obj || typeof obj !== "object") return obj;
  const out = Array.isArray(obj) ? [...obj] : { ...obj };
  for (const k of Object.keys(out)) {
    const lk = k.toLowerCase();
    if (lk.includes("secret") || lk.includes("apikey") || lk.includes("api_key") || lk.includes("token")) {
      out[k] = "***";
    }
  }
  return out;
}

function toCsvRow(values) {
  const esc = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    const needs = /[\",\n\r]/.test(s);
    const q = s.replace(/\"/g, '""');
    return needs ? `"${q}"` : q;
  };
  return values.map(esc).join(",");
}


/* ------------------------- admin UI session (S3++++) -------------------------- */
// Browser-friendly admin UI auth: password-based session cookie.
// Does NOT change API behavior; adds parallel /v1/admin/ui/* routes.
// Env:
// - C360_ADMIN_PASSWORD (required for UI login)
// - C360_ADMIN_TOKEN (optional: allows ?t=TOKEN gate to open UI without login)
const ADMIN_PASSWORD = (process.env.C360_ADMIN_PASSWORD || "").trim();
const UI_SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const uiSessions = new Map(); // sid -> { expiresAt }

function parseCookies(req) {
  const h = String(req.headers.cookie || "");
  const out = {};
  h.split(";").forEach(part => {
    const i = part.indexOf("=");
    if (i === -1) return;
    const k = part.slice(0,i).trim();
    const v = part.slice(i+1).trim();
    if (!k) return;
    out[k] = decodeURIComponent(v);
  });
  return out;
}

function newSessionId() {
  return crypto.randomBytes(24).toString("hex");
}

function setSessionCookie(res, sid) {
  const secure = String(process.env.C360_COOKIE_SECURE || "").trim() === "1";
  const parts = [
    `c360_admin_sid=${encodeURIComponent(sid)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(UI_SESSION_TTL_MS/1000)}`
  ];
  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearSessionCookie(res) {
  const secure = String(process.env.C360_COOKIE_SECURE || "").trim() === "1";
  const parts = [
    "c360_admin_sid=",
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0"
  ];
  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function uiRequireLogin(req, res, next) {
  const t = String(req.query.t || "").trim();
  if (ADMIN_TOKEN && t && t === ADMIN_TOKEN) return next();

  const cookies = parseCookies(req);
  const sid = cookies["c360_admin_sid"];
  if (!sid) return err(res, 401, "missing_auth");
  const s = uiSessions.get(sid);
  if (!s) return err(res, 401, "missing_auth");
  if (Date.now() > s.expiresAt) {
    uiSessions.delete(sid);
    return err(res, 401, "session_expired");
  }
  return next();
}


/* ------------------------ admin helpers: cancel/retry ------------------------ */
async function cancelJob(jobId) {
  const r = await pg.query(`SELECT id, status, client_id FROM c360_jobs WHERE id=$1`, [jobId]);
  if (!r.rows.length) throw Object.assign(new Error("job_not_found"), { code: "job_not_found" });
  const job = r.rows[0];

  await pg.query(
    `UPDATE c360_jobs
       SET status='canceled', error_text=COALESCE(error_text,'canceled_by_admin'), finished_at=NOW(), updated_at=NOW()
     WHERE id=$1 AND status NOT IN ('done','error','canceled')`,
    [jobId]
  );

  try {
    const bj = await queue.getJob(jobId);
    if (bj) await bj.remove();
  } catch (_e) {}

  try {
    await pg.query(
      `UPDATE c360_aej_holds
         SET status='released', updated_at=NOW()
       WHERE job_id=$1 AND status='held'`,
      [jobId]
    );
  } catch (_e) {}

  await logJobEvent({ job_id: jobId, client_id: String(job.client_id), event_type: "canceled", message: "Canceled by admin", meta: {} });
  return { job_id: jobId, status: "canceled" };
}

async function retryJob(jobId) {
  const r = await pg.query(`SELECT id, client_id FROM c360_jobs WHERE id=$1`, [jobId]);
  if (!r.rows.length) throw Object.assign(new Error("job_not_found"), { code: "job_not_found" });
  const job = r.rows[0];

  await pg.query(
    `UPDATE c360_jobs
       SET status='queued', progress=0, error_text=NULL, result_json=NULL, updated_at=NOW(), finished_at=NULL
     WHERE id=$1`,
    [jobId]
  );

  await queue.add("run", { job_id: jobId }, { jobId, attempts: 3, backoff: { type: "exponential", delay: 2000 } });
  await logJobEvent({ job_id: jobId, client_id: String(job.client_id), event_type: "retry", message: "Retried by admin", meta: {} });
  return { job_id: jobId, status: "queued", retried: true };
}

/* ------------------------- auth (unchanged) -------------------------- */
async function authV1(req, res, next) {
  const apiKey = req.headers["x-c360-key"];
  const apiSign = req.headers["x-c360-sign"];
  if (!apiKey || !apiSign) return err(res, 401, "missing_auth");

  const r = await pg.query(
    `SELECT id, api_secret, status
     FROM c360_clients
     WHERE api_key=$1`,
    [apiKey]
  );

  if (!r.rows.length) return err(res, 401, "invalid_key");
  const client = r.rows[0];
  if (client.status !== "active") return err(res, 403, "client_inactive");

  // Signature over the EXACT request body bytes.
  // Fallback to JSON.stringify for backward compatibility if rawBody is unavailable.
  const rawBodyBuf = req.rawBody && Buffer.isBuffer(req.rawBody)
    ? req.rawBody
    : Buffer.from(JSON.stringify(req.body || {}), "utf8");
  const expected = crypto
    .createHmac("sha256", client.api_secret)
    .update(rawBodyBuf)
    .digest("hex");

  if (expected !== apiSign) return err(res, 401, "bad_signature");

  req.client = client;
  return next();
}

/* ------------------------ health ------------------------- */
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "content360-api" });
});

/* ------------------------ Admin UI (S3++++ clean) ------------------------ */
// HTML/JS are served as static files (clean, no template literals risk).
// Access:
// - Browser: /v1/admin/ui  -> login screen if not authenticated
// - Token gate: /v1/admin/ui?t=C360_ADMIN_TOKEN
const ADMIN_UI_DIR = path.join(__dirname, "admin-ui");

app.get("/v1/admin/ui", (req, res) => {
  // If token gate is present, let uiRequireLogin accept it and serve app directly.
  const t = String(req.query.t || "").trim();
  if (ADMIN_TOKEN && t === ADMIN_TOKEN) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).sendFile(path.join(ADMIN_UI_DIR, "app.html"));
  }
  // If already logged in via session cookie, serve app, else serve login.
  const cookies = parseCookies(req);
  const sid = cookies["c360_admin_sid"];
  const s = sid ? uiSessions.get(sid) : null;
  if (s && Date.now() <= s.expiresAt) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).sendFile(path.join(ADMIN_UI_DIR, "app.html"));
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.status(200).sendFile(path.join(ADMIN_UI_DIR, "login.html"));
});

app.get("/v1/admin/ui/", (_req, res) => res.redirect(302, "/v1/admin/ui"));

app.post("/v1/admin/ui/login", express.json(), (req, res) => {
  if (!ADMIN_PASSWORD) return err(res, 500, "admin_password_not_set");
  const password = String(req.body?.password || "");
  if (password !== ADMIN_PASSWORD) return err(res, 401, "invalid_login");
  const sid = newSessionId();
  uiSessions.set(sid, { expiresAt: Date.now() + UI_SESSION_TTL_MS });
  setSessionCookie(res, sid);
  return res.json({ ok: true });
});

app.post("/v1/admin/ui/logout", (_req, res) => {
  const cookies = parseCookies(_req);
  const sid = cookies["c360_admin_sid"];
  if (sid) uiSessions.delete(sid);
  clearSessionCookie(res);
  return res.json({ ok: true });
});

// Public static assets (required for login page)
app.get("/v1/admin/ui/admin-ui.js", (_req, res) => {
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  return res.status(200).sendFile(path.join(ADMIN_UI_DIR, "admin-ui.js"));
});

app.get("/v1/admin/ui/admin-ui.css", (_req, res) => {
  res.setHeader("Content-Type", "text/css; charset=utf-8");
  return res.status(200).sendFile(path.join(ADMIN_UI_DIR, "admin-ui.css"));
});


/* ------------------------ Admin UI API (session) ------------------------ */
// These endpoints are for the browser console only, protected by uiRequireLogin.
// They DO NOT replace the HMAC admin endpoints; they sit alongside them.

app.get("/v1/admin/ui/api/health/deps", uiRequireLogin, async (_req, res) => {
  // Reuse same health check logic as /v1/admin/health/deps but without HMAC.
  try {
    const dbOk = await pg.query("SELECT 1");
    // Redis: best effort (do not crash if Redis is down)
    let redisStatus = "unknown";
    try {
      const rconn = redisConnection();
      const pong = await rconn.ping();
      redisStatus = pong === "PONG" ? "ok" : "degraded";
    } catch (e) {
      redisStatus = "error";
    }

    // OpenAI: best effort (some deployments may not configure it yet)
    let openaiStatus = "unknown";
    try {
      if (typeof pingOpenAI === "function") {
        const openai = await pingOpenAI();
        openaiStatus = openai?.status || "unknown";
      }
    } catch (e) {
      openaiStatus = "degraded";
    }

    res.json({ ok: true, deps: { db: dbOk ? "ok" : "bad", redis: redisStatus, openai: openaiStatus }, time_utc: new Date().toISOString() });
  } catch (e) {
    console.error("[ui/api/health] error:", e?.message || e);
    return err(res, 500, "health_error");
  }
});

app.get("/v1/admin/ui/api/jobs", uiRequireLogin, async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const offset = Math.max(0, Number(req.query.offset || 0));
    const status = String(req.query.status || "").trim();
    const mode = String(req.query.mode || "").trim();
    const client_id = String(req.query.client_id || "").trim();

    const where = [];
    const args = [];
    if (status) { args.push(status); where.push(`status=$${args.length}`); }
    if (mode) { args.push(mode); where.push(`mode=$${args.length}`); }
    if (client_id) { args.push(client_id); where.push(`client_id=$${args.length}`); }

    args.push(limit); const pLimit = args.length;
    args.push(offset); const pOffset = args.length;

    const wsql = where.length ? "WHERE " + where.join(" AND ") : "";
    const q = `SELECT id, client_id, site_id, mode, status, aej_estimated, aej_final, created_at, finished_at, error_text
               FROM c360_jobs ${wsql}
               ORDER BY created_at DESC
               LIMIT $${pLimit} OFFSET $${pOffset}`;
    const r = await pg.query(q, args);
    res.json({ ok: true, jobs: r.rows });
  } catch (e) {
    console.error("[ui/api/jobs] error:", e?.message || e);
    return err(res, 500, "jobs_list_error");
  }
});

app.get("/v1/admin/ui/api/jobs/:id", uiRequireLogin, async (req, res) => {
  try {
    const jobId = String(req.params.id);
    const jobR = await pg.query(`SELECT * FROM c360_jobs WHERE id=$1`, [jobId]);
    if (!jobR.rows.length) return err(res, 404, "job_not_found");
    const job = jobR.rows[0];
    const holdsR = await pg.query(`SELECT * FROM c360_aej_holds WHERE job_id=$1 ORDER BY created_at ASC`, [jobId]);
    const logsR = await pg.query(`SELECT * FROM c360_aej_logs WHERE job_id=$1 ORDER BY created_at ASC LIMIT 200`, [jobId]);
    const evR = await pg.query(`SELECT * FROM c360_job_events WHERE job_id=$1 ORDER BY created_at ASC LIMIT 500`, [jobId]).catch(()=>({rows:[]}));
    res.json({ ok: true, job: maskSecrets(job), holds: holdsR.rows, aej_logs: logsR.rows, events: evR.rows });
  } catch (e) {
    console.error("[ui/api/job] error:", e?.message || e);
    return err(res, 500, "job_detail_error");
  }
});

app.post("/v1/admin/ui/api/jobs/:id/cancel", uiRequireLogin, async (req, res) => {
  // Reuse cancel logic by calling same SQL as admin endpoint
  try {
    const jobId = String(req.params.id);
    const r = await cancelJob(jobId);
    return res.json({ ok: true, ...r });
  } catch (e) {
    console.error("[ui/api/jobs/cancel] error:", e?.message || e);
    return err(res, 500, "job_cancel_error");
  }
});

app.post("/v1/admin/ui/api/jobs/:id/retry", uiRequireLogin, async (req, res) => {
  try {
    const jobId = String(req.params.id);
    const r = await retryJob(jobId);
    return res.json({ ok: true, ...r });
  } catch (e) {
    console.error("[ui/api/jobs/retry] error:", e?.message || e);
    return err(res, 500, "job_retry_error");
  }
});

// Clients management (UI)
app.get("/v1/admin/ui/api/clients", uiRequireLogin, async (_req, res) => {
  try {
    const r = await pg.query(`SELECT id, api_key, status, aej_balance, created_at FROM c360_clients ORDER BY created_at DESC LIMIT 500`);
    res.json({ ok: true, clients: r.rows });
  } catch (e) {
    console.error("[ui/api/clients] error:", e?.message || e);
    return err(res, 500, "clients_list_error");
  }
});

app.post("/v1/admin/ui/api/clients", uiRequireLogin, express.json(), async (req, res) => {
  try {
    const status = String(req.body?.status || "active");
    const aej_balance = Number(req.body?.aej_balance || 0);
    const api_key = String(req.body?.api_key || ("ck_" + crypto.randomBytes(16).toString("hex")));
    const api_secret = String(req.body?.api_secret || ("cs_" + crypto.randomBytes(20).toString("hex")));
    const id = String(req.body?.id || crypto.randomUUID());

    await pg.query(
      `INSERT INTO c360_clients (id, api_key, api_secret, status, aej_balance, created_at)
       VALUES ($1,$2,$3,$4,$5,NOW())`,
      [id, api_key, api_secret, status, aej_balance]
    );
    res.json({ ok: true, client: { id, api_key, api_secret, status, aej_balance } });
  } catch (e) {
    console.error("[ui/api/clients/create] error:", e?.message || e);
    return err(res, 500, "client_create_error");
  }
});

app.patch("/v1/admin/ui/api/clients/:id", uiRequireLogin, express.json(), async (req, res) => {
  try {
    const id = String(req.params.id);
    const fields = [];
    const args = [];
    const set = (k, v) => { args.push(v); fields.push(`${k}=$${args.length}`); };
    if (req.body?.status) set("status", String(req.body.status));
    if (req.body?.aej_balance !== undefined) set("aej_balance", Number(req.body.aej_balance));
    if (!fields.length) return err(res, 400, "no_fields");
    args.push(id);
    const q = `UPDATE c360_clients SET ${fields.join(", ")} WHERE id=$${args.length}`;
    await pg.query(q, args);
    res.json({ ok: true });
  } catch (e) {
    console.error("[ui/api/clients/update] error:", e?.message || e);
    return err(res, 500, "client_update_error");
  }
});

app.post("/v1/admin/ui/api/clients/:id/reset_secret", uiRequireLogin, async (req, res) => {
  try {
    const id = String(req.params.id);
    const api_secret = "cs_" + crypto.randomBytes(20).toString("hex");
    await pg.query(`UPDATE c360_clients SET api_secret=$1 WHERE id=$2`, [api_secret, id]);
    res.json({ ok: true, api_secret });
  } catch (e) {
    console.error("[ui/api/clients/reset_secret] error:", e?.message || e);
    return err(res, 500, "client_reset_secret_error");
  }
});


/* -------------------- S2 helpers: billing summary ------------------ */
async function fetchBillingSummary(clientId) {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0));
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));

  const quotaR = await pg.query(
    `SELECT plan_code, monthly_quota_aej
     FROM c360_site_settings
     WHERE client_id=$1`,
    [clientId]
  );
  const plan = quotaR.rows[0]?.plan_code || "starter";
  const quota = Number(quotaR.rows[0]?.monthly_quota_aej || 500);

  const usageR = await pg.query(
    `SELECT
       COALESCE(SUM(aej_used),0) AS aej_consumed,
       COALESCE(SUM(aej_used) FILTER (WHERE stage IN ('analyse','decision')),0) AS aej_analysis,
       COALESCE(SUM(aej_used) FILTER (WHERE stage IN ('generation','application')),0) AS aej_writing,
       COALESCE(SUM(aej_used) FILTER (WHERE stage='suivi'),0) AS aej_followup
     FROM c360_aej_logs
     WHERE client_id=$1 AND created_at >= $2 AND created_at < $3`,
    [clientId, monthStart, monthEnd]
  );
  const consumed = Number(usageR.rows[0]?.aej_consumed || 0);

  const holdsR = await pg.query(
    `SELECT COALESCE(SUM(aej_estimated),0) AS aej_held
     FROM c360_aej_holds
     WHERE client_id=$1 AND status='held'`,
    [clientId]
  );
  const held = Number(holdsR.rows[0]?.aej_held || 0);

  const balR = await pg.query(
    `SELECT aej_balance FROM c360_clients WHERE id=$1`,
    [clientId]
  );
  const aej_balance = Number(balR.rows[0]?.aej_balance || 0);

  return {
    month: monthStart.toISOString().slice(0, 7),
    plan,
    monthly_quota_aej: quota,
    aej_consumed: consumed,
    aej_held: held,
    aej_remaining: Math.max(0, quota - consumed - held),
    breakdown: {
      analysis: Number(usageR.rows[0]?.aej_analysis || 0),
      writing: Number(usageR.rows[0]?.aej_writing || 0),
      followup: Number(usageR.rows[0]?.aej_followup || 0),
    },
    aej_balance,
  };
}

/* -------------------- S1-T3 billing (NEW) ------------------ */
app.get("/v1/billing/me", authV1, async (req, res) => {
  try {
    const r = await fetchBillingSummary(req.client.id);
    res.json({ ok: true, ...r });
  } catch (e) {
    console.error("[billing/me] error:", e?.message || e);
    return err(res, 500, "billing_error");
  }
});

// Backward/Frontend convenience: simple AEJ balance endpoint.
app.get("/v1/aej/balance", authV1, async (req, res) => {
  try {
    const r = await fetchBillingSummary(req.client.id);
    return res.json({
      ok: true,
      month: r.month,
      plan: r.plan,
      monthly_quota_aej: r.monthly_quota_aej,
      aej_consumed: r.aej_consumed,
      aej_held: r.aej_held,
      aej_remaining: r.aej_remaining,
    });
  } catch (e) {
    console.error("[aej/balance] error:", e?.message || e);
    return err(res, 500, "billing_error");
  }
});

/* ------------------------- jobs -------------------------- */
app.post("/v1/jobs/create", authV1, async (req, res) => {
  const requestJson = req.body || {};
  const v = validateCreatePayload(requestJson);
  if (!v.ok) return res.status(400).json({ ok: false, error: "schema_invalid", details: v.errors });

  const mode = v.mode;
  const itemsCount = v.items.length;

  const idemKey = pickIdempotencyKey(req);

  // Calculate conservative AEJ reservation.
  const per = AEJ_ESTIMATE_PER_ITEM[mode] || 8;
  const aejEstimated = Math.max(1, Number(per) * itemsCount);

  // client id may be UUID (common) or integer depending on legacy DB.
  // Treat it as a string to avoid implicit integer casts.
  const clientId = String(req.client.id);
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0));
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));

  const client = await pg.connect();
  try {
    await client.query("BEGIN");

    // Idempotency: return same job_id if already created.
    if (idemKey) {
      const idemR = await client.query(
        `SELECT job_id FROM c360_idempotency WHERE client_id=$1 AND idem_key=$2`,
        [clientId, idemKey]
      );
      if (idemR.rows.length) {
        const existingJobId = idemR.rows[0].job_id;
        await client.query("COMMIT");
        await logJobEvent({ job_id: existingJobId, client_id: clientId, event_type: "idempotent_hit", message: "Idempotency hit: returning existing job" });
        return res.json({ ok: true, job_id: existingJobId, status: "queued", idempotent: true });
      }
    }

    // Quota check (month): consumed + active holds + this estimate.
    const quotaR = await client.query(
      `SELECT plan_code, monthly_quota_aej
       FROM c360_site_settings
       WHERE client_id=$1`,
      [clientId]
    );
    const plan = quotaR.rows[0]?.plan_code || "starter";
    const quota = Number(quotaR.rows[0]?.monthly_quota_aej || 500);

    const usageR = await client.query(
      `SELECT COALESCE(SUM(aej_used),0) AS aej_consumed
       FROM c360_aej_logs
       WHERE client_id=$1 AND created_at >= $2 AND created_at < $3`,
      [clientId, monthStart, monthEnd]
    );
    const consumed = Number(usageR.rows[0]?.aej_consumed || 0);

    const holdR = await client.query(
      `SELECT COALESCE(SUM(aej_estimated),0) AS aej_held
       FROM c360_aej_holds
       WHERE client_id=$1 AND status='held'`,
      [clientId]
    );
    const held = Number(holdR.rows[0]?.aej_held || 0);

    if (consumed + held + aejEstimated > quota) {
      await client.query("ROLLBACK");
      return res.status(402).json({
        ok: false,
        error: "quota_exceeded",
        plan,
        monthly_quota_aej: quota,
        aej_consumed: consumed,
        aej_held: held,
        aej_needed: aejEstimated,
        aej_remaining: Math.max(0, quota - consumed - held),
      });
    }

    const ins = await client.query(
      `INSERT INTO c360_jobs
       (client_id, mode, status, progress, request_json, idempotency_key, aej_estimated, created_at, updated_at)
       VALUES ($1, $2, 'queued', 0, $3::jsonb, $4, $5, NOW(), NOW())
       RETURNING id`,
      [clientId, mode, requestJson, idemKey, aejEstimated]
    );
    const jobId = ins.rows[0].id;

    await client.query(
      `INSERT INTO c360_aej_holds (job_id, client_id, aej_estimated, status, created_at)
       VALUES ($1,$2,$3,'held',NOW())`,
      [String(jobId), clientId, aejEstimated]
    );

    if (idemKey) {
      await client.query(
        `INSERT INTO c360_idempotency (client_id, idem_key, job_id, created_at)
         VALUES ($1,$2,$3,NOW())`,
        [clientId, idemKey, String(jobId)]
      );
    }

    await client.query("COMMIT");

    // Enqueue AFTER commit.
    await queue.add(
      "run",
      { job_id: jobId },
      {
        jobId,
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: 1000,
        removeOnFail: 2000,
      }
    );

    await logJobEvent({ job_id: jobId, client_id: clientId, event_type: "created", message: "Job created & enqueued", meta: { mode, items_count: itemsCount, aej_estimated: aejEstimated } });

    return res.json({ ok: true, job_id: jobId, status: "queued", aej_estimated: aejEstimated });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("[jobs/create] error:", e?.message || e);
    return err(res, 500, "job_create_error");
  } finally {
    client.release();
  }
});

app.get("/v1/jobs/:id/status", authV1, async (req, res) => {
  const jobId = req.params.id;
  const r = await pg.query(
    `SELECT id, status, progress, mode, updated_at
     FROM c360_jobs
     WHERE id=$1 AND client_id=$2`,
    [jobId, req.client.id]
  );

  if (!r.rows.length) return err(res, 404, "job_not_found");

  res.json({ ok: true, job_id: jobId, ...r.rows[0] });
});

app.get("/v1/jobs/:id/result", authV1, async (req, res) => {
  const jobId = req.params.id;
  const r = await pg.query(
    `SELECT id, status, progress, result_json
     FROM c360_jobs
     WHERE id=$1 AND client_id=$2`,
    [jobId, req.client.id]
  );

  if (!r.rows.length) return err(res, 404, "job_not_found");
  const row = r.rows[0];

  res.json({
    ok: true,
    job_id: jobId,
    status: row.status,
    progress: row.progress,
    result: row.result_json || null,
  });
});

/* ------------------------- S3 admin APIs -------------------------- */

// Health for dependencies: DB + Redis + Worker (best effort) + OpenAI.
app.get("/v1/admin/health/deps", authV1, requireAdmin, async (_req, res) => {
  const out = {
    ok: true,
    deps: {
      db: "unknown",
      redis: "unknown",
      worker: "unknown",
      openai: "unknown",
    },
    time_utc: new Date().toISOString(),
  };

  // DB
  try {
    await pg.query("SELECT 1");
    out.deps.db = "ok";
  } catch (e) {
    out.ok = false;
    out.deps.db = "error";
    out.db_error = String(e?.message || e);
  }

  // Redis
  let rconn = null;
  try {
    rconn = redisConnection();
    const pong = await rconn.ping();
    out.deps.redis = pong ? "ok" : "degraded";
    // Worker: best effort - check if queue operations work.
    const counts = await queue.getJobCounts("waiting", "active", "delayed", "failed", "completed");
    out.deps.worker = typeof counts === "object" ? "ok" : "unknown";
  } catch (e) {
    out.ok = false;
    out.deps.redis = "error";
    out.redis_error = String(e?.message || e);
    out.deps.worker = "unknown";
  } finally {
    try { await rconn?.quit(); } catch {}
  }

  // OpenAI
  try {
    const forced = await isForceDegraded();
    const o = await checkOpenAI();
    if (forced) {
      out.deps.openai = "degraded";
      out.openai = { status: "degraded", error: "force_degraded" };
    } else {
      out.deps.openai = o.status === "ok" ? "ok" : "degraded";
      if (o.status !== "ok") out.openai = o;
    }
  } catch (e) {
    out.deps.openai = "degraded";
    out.openai = { status: "degraded", error: String(e?.message || e) };
  }

  return res.json(out);
});

// Jobs list
app.get("/v1/admin/jobs", authV1, requireAdmin, async (req, res) => {
  try {
    const status = req.query.status ? String(req.query.status) : null;
    const client_id = req.query.client_id ? String(req.query.client_id) : null;
    const mode = req.query.mode ? String(req.query.mode) : null;
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const offset = Math.max(0, Number(req.query.offset || 0));

    const where = [];
    const args = [];
    let i = 1;

    if (status) { where.push(`status=$${i++}`); args.push(status); }
    if (client_id) { where.push(`client_id=$${i++}`); args.push(client_id); }
    if (mode) { where.push(`mode=$${i++}`); args.push(mode); }

    const wsql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const q = await pg.query(
      `SELECT id, client_id, mode, status, progress, aej_estimated, aej_final, created_at, updated_at, error_text
       FROM c360_jobs
       ${wsql}
       ORDER BY created_at DESC
       LIMIT $${i++} OFFSET $${i++}`,
      [...args, limit, offset]
    );

    return res.json({ ok: true, jobs: q.rows, limit, offset });
  } catch (e) {
    console.error("[admin/jobs] error:", e?.message || e);
    return err(res, 500, "admin_jobs_error");
  }
});

// Job detail
app.get("/v1/admin/jobs/:id", authV1, requireAdmin, async (req, res) => {
  try {
    const jobId = req.params.id;
    const q = await pg.query(
      `SELECT * FROM c360_jobs WHERE id=$1`,
      [jobId]
    );
    if (!q.rows.length) return err(res, 404, "job_not_found");
    const job = q.rows[0];

    const holds = await pg.query(
      `SELECT job_id, client_id, aej_estimated, status, created_at, released_at
       FROM c360_aej_holds WHERE job_id=$1`,
      [String(jobId)]
    );

    const aej = await pg.query(
      `SELECT stage, aej_used, tokens_used, model_used, created_at
       FROM c360_aej_logs WHERE job_id=$1 AND client_id=$2
       ORDER BY created_at ASC`,
      [String(jobId), String(job.client_id)]
    );

    return res.json({
      ok: true,
      job: {
        ...job,
        request_json: maskSecrets(job.request_json),
      },
      holds: holds.rows,
      aej_logs: aej.rows,
    });
  } catch (e) {
    console.error("[admin/job] error:", e?.message || e);
    return err(res, 500, "admin_job_error");
  }
});


// Job events timeline (S3+++)
app.get("/v1/admin/jobs/:id/events", authV1, requireAdmin, async (req, res) => {
  try {
    const jobId = String(req.params.id);
    const limit = Math.min(500, Math.max(1, Number(req.query.limit || 200)));
    const q = await pg.query(
      `SELECT id, job_id, client_id, event_type, message, meta, created_at
       FROM c360_job_events
       WHERE job_id=$1
       ORDER BY created_at ASC
       LIMIT $2`,
      [jobId, limit]
    );
    return res.json({ ok: true, job_id: jobId, events: q.rows });
  } catch (e) {
    console.error("[admin/job_events] error:", e?.message || e);
    return err(res, 500, "admin_job_events_error");
  }
});

// AEJ holds (S3+++)
app.get("/v1/admin/aej/holds", authV1, requireAdmin, async (req, res) => {
  try {
    const client_id = req.query.client_id ? String(req.query.client_id) : null;
    const limit = Math.min(500, Math.max(1, Number(req.query.limit || 100)));
    const where = [];
    const args = [];
    let i = 1;
    if (client_id) { where.push(`client_id=$${i++}`); args.push(client_id); }
    const wsql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const q = await pg.query(
      `SELECT job_id, client_id, aej_estimated, status, created_at, released_at
       FROM c360_aej_holds
       ${wsql}
       ORDER BY created_at DESC
       LIMIT $${i++}`,
      [...args, limit]
    );
    return res.json({ ok: true, holds: q.rows });
  } catch (e) {
    console.error("[admin/aej_holds] error:", e?.message || e);
    return err(res, 500, "admin_aej_holds_error");
  }
});

// AEJ logs / ledger (S3+++)
app.get("/v1/admin/aej/logs", authV1, requireAdmin, async (req, res) => {
  try {
    const client_id = req.query.client_id ? String(req.query.client_id) : null;
    const job_id = req.query.job_id ? String(req.query.job_id) : null;
    const limit = Math.min(2000, Math.max(1, Number(req.query.limit || 200)));
    const where = [];
    const args = [];
    let i = 1;
    if (client_id) { where.push(`client_id=$${i++}`); args.push(client_id); }
    if (job_id) { where.push(`job_id=$${i++}`); args.push(job_id); }
    const wsql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const q = await pg.query(
      `SELECT client_id, job_id, stage, aej_used, tokens_used, model_used, created_at
       FROM c360_aej_logs
       ${wsql}
       ORDER BY created_at DESC
       LIMIT $${i++}`,
      [...args, limit]
    );
    return res.json({ ok: true, logs: q.rows });
  } catch (e) {
    console.error("[admin/aej_logs] error:", e?.message || e);
    return err(res, 500, "admin_aej_logs_error");
  }
});

// OpenAI degraded mode flag (S3+++)
app.get("/v1/admin/openai/degraded", authV1, requireAdmin, async (_req, res) => {
  try {
    const v = await getAdminFlag("force_degraded");
    return res.json({ ok: true, force_degraded: v === "1" });
  } catch (e) {
    console.error("[admin/openai_degraded_get] error:", e?.message || e);
    return err(res, 500, "admin_openai_degraded_error");
  }
});

app.post("/v1/admin/openai/degraded", authV1, requireAdmin, async (req, res) => {
  try {
    const enabled = !!req.body?.enabled;
    await setAdminFlag("force_degraded", enabled ? "1" : "0");
    await logJobEvent({ job_id: "admin", client_id: String(req.client.id), event_type: "flag", message: `force_degraded=${enabled ? "1" : "0"}` });
    return res.json({ ok: true, force_degraded: enabled });
  } catch (e) {
    console.error("[admin/openai_degraded_post] error:", e?.message || e);
    return err(res, 500, "admin_openai_degraded_error");
  }
});


// CSV export for jobs
app.get("/v1/admin/jobs.csv", authV1, requireAdmin, async (req, res) => {
  try {
    const status = req.query.status ? String(req.query.status) : null;
    const client_id = req.query.client_id ? String(req.query.client_id) : null;
    const limit = Math.min(2000, Math.max(1, Number(req.query.limit || 500)));

    const where = [];
    const args = [];
    let i = 1;
    if (status) { where.push(`status=$${i++}`); args.push(status); }
    if (client_id) { where.push(`client_id=$${i++}`); args.push(client_id); }
    const wsql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const q = await pg.query(
      `SELECT id, client_id, mode, status, progress, aej_estimated, aej_final, created_at, updated_at, error_text
       FROM c360_jobs ${wsql}
       ORDER BY created_at DESC
       LIMIT $${i++}`,
      [...args, limit]
    );

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=content360_jobs.csv");

    const header = [
      "id","client_id","mode","status","progress","aej_estimated","aej_final","created_at","updated_at","error_text"
    ];
    let csv = header.join(",") + "\n";
    for (const r of q.rows) {
      csv += toCsvRow([
        r.id, r.client_id, r.mode, r.status, r.progress, r.aej_estimated, r.aej_final, r.created_at, r.updated_at, r.error_text
      ]) + "\n";
    }
    return res.send(csv);
  } catch (e) {
    console.error("[admin/jobs.csv] error:", e?.message || e);
    return err(res, 500, "admin_jobs_export_error");
  }
});

// Cancel a job (best effort). For queued jobs, we remove it from BullMQ.
app.post("/v1/admin/jobs/:id/cancel", authV1, requireAdmin, async (req, res) => {
  const jobId = String(req.params.id);
  try {
    const r = await pg.query(`SELECT id, status, client_id FROM c360_jobs WHERE id=$1`, [jobId]);
    if (!r.rows.length) return err(res, 404, "job_not_found");

    const st = r.rows[0].status;
    if (st === "done" || st === "error") {
      return res.json({ ok: true, job_id: jobId, status: st, canceled: false, reason: "already_final" });
    }

    await pg.query(
      `UPDATE c360_jobs SET status='canceled', updated_at=NOW(), error_text=COALESCE(error_text,'') WHERE id=$1`,
      [jobId]
    );

    try {
      const bj = await queue.getJob(jobId);
      if (bj) await bj.remove();
    } catch {}

    // Release hold if any.
    await pg.query(
      `UPDATE c360_aej_holds SET status='released', released_at=NOW()
       WHERE job_id=$1 AND status='held'`,
      [jobId]
    );

    await logJobEvent({ job_id: jobId, client_id: r.rows[0].client_id, event_type: "canceled", message: "Canceled by admin" });
    return res.json({ ok: true, job_id: jobId, status: "canceled" });
  } catch (e) {
    console.error("[admin/job/cancel] error:", e?.message || e);
    return err(res, 500, "admin_job_cancel_error");
  }
});

// Retry a job: reset DB state and re-enqueue.
app.post("/v1/admin/jobs/:id/retry", authV1, requireAdmin, async (req, res) => {
  const jobId = String(req.params.id);
  try {
    const r = await pg.query(`SELECT id, client_id FROM c360_jobs WHERE id=$1`, [jobId]);
    if (!r.rows.length) return err(res, 404, "job_not_found");

    await pg.query(
      `UPDATE c360_jobs
       SET status='queued', progress=0, error_text=NULL, result_json=NULL, updated_at=NOW()
       WHERE id=$1`,
      [jobId]
    );

    // Re-hold if missing.
    await pg.query(
      `INSERT INTO c360_aej_holds (job_id, client_id, aej_estimated, status, created_at)
       SELECT $1, client_id, COALESCE(aej_estimated,1), 'held', NOW()
       FROM c360_jobs WHERE id=$1
       ON CONFLICT DO NOTHING`,
      [jobId]
    );

    await queue.add("run", { job_id: jobId }, { jobId, attempts: 3, backoff: { type: "exponential", delay: 2000 } });

    await logJobEvent({ job_id: jobId, client_id: r.rows[0].client_id, event_type: "retry", message: "Retried by admin" });
    return res.json({ ok: true, job_id: jobId, status: "queued", retried: true });
  } catch (e) {
    console.error("[admin/job/retry] error:", e?.message || e);
    return err(res, 500, "admin_job_retry_error");
  }
});

// Replay by idempotency key (S3+ convenience)
app.get("/v1/admin/idempotency/:key", authV1, requireAdmin, async (req, res) => {
  try {
    const key = String(req.params.key).trim();
    if (!key) return err(res, 400, "invalid_idempotency_key");
    const r = await pg.query(
      `SELECT client_id, job_id, created_at FROM c360_idempotency WHERE idem_key=$1 ORDER BY created_at DESC LIMIT 20`,
      [key]
    );
    return res.json({ ok: true, items: r.rows });
  } catch (e) {
    console.error("[admin/idempotency] error:", e?.message || e);
    return err(res, 500, "admin_idempotency_error");
  }
});

app.listen(PORT, () => {
  console.log(`[api] Content360 API listening on port ${PORT}`);
});
