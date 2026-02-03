/**
 * Content360 Worker (BullMQ) - UPDATED for S1-T3 (AEJ stages) + S1-T4 (decision log)
 * CommonJS to match existing runtime.
 */
const { Worker } = require("bullmq");
const { Pool } = require("pg");
const { redisConnection } = require("./queue");

const { callOpenAI } = require("./openai_client");
const { promptQuickBoost, promptFullContent, promptEcomCatalog } = require("./prompts");
const { QUICK_BOOST_SCHEMA, FULL_CONTENT_SCHEMA, ECOM_CATALOG_SCHEMA } = require("./schemas");

const QUEUE = process.env.BULLMQ_QUEUE || "c360_jobs_v1";
const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY || 3);

const pg = new Pool({ connectionString: process.env.DATABASE_URL });

async function logJobEvent({ job_id, client_id, event_type, message = null, meta = null }) {
  try {
    await pg.query(
      `INSERT INTO c360_job_events (job_id, client_id, event_type, message, meta, created_at)
       VALUES ($1,$2,$3,$4,$5,NOW())`,
      [String(job_id), String(client_id), String(event_type), message, meta]
    );
  } catch (_) {}
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
  cachedDegraded = { v, at: now };
  return v === "1";
}

function normalizeMode(mode) {
  if (!mode) return "quick_boost";
  if (mode === "full") return "full_content";
  return mode;
}

function pickPromptAndSchema(mode, reqJson) {
  switch (mode) {
    case "quick_boost":
      return { prompt: promptQuickBoost(reqJson), schema: QUICK_BOOST_SCHEMA.schema };
    case "full_content":
      return { prompt: promptFullContent(reqJson), schema: FULL_CONTENT_SCHEMA.schema };
    case "ecom_catalog":
      return { prompt: promptEcomCatalog(reqJson), schema: ECOM_CATALOG_SCHEMA.schema };
    default:
      throw new Error(`Unsupported mode: ${mode}`);
  }
}

async function getJob(jobId) {
  const r = await pg.query("SELECT * FROM c360_jobs WHERE id=$1", [jobId]);
  return r.rows[0] || null;
}

async function setJob(jobId, patch) {
  const keys = Object.keys(patch);
  const vals = Object.values(patch);
  const setSql = keys.map((k, i) => `${k}=$${i + 1}`).join(", ");
  await pg.query(`UPDATE c360_jobs SET ${setSql}, updated_at=NOW() WHERE id=$${keys.length + 1}`, [...vals, jobId]);
}

async function releaseHold({ client_id, job_id }) {
  // S2: release AEJ reservation for this job (idempotent).
  await pg.query(
    `UPDATE c360_aej_holds
     SET status='released', released_at=NOW()
     WHERE job_id=$1 AND client_id=$2 AND status='held'`,
    [String(job_id), client_id]
  );
}

async function computeAEJTotal({ client_id, job_id }) {
  const r = await pg.query(
    `SELECT COALESCE(SUM(aej_used),0) AS total
     FROM c360_aej_logs
     WHERE client_id=$1 AND job_id=$2`,
    [client_id, String(job_id)]
  );
  return Number(r.rows[0]?.total || 0);
}

async function logAEJ({ client_id, job_id, stage, aej_used, tokens_used = null, model_used = null }) {
  await pg.query(
    `INSERT INTO c360_aej_logs (client_id, job_id, stage, aej_used, tokens_used, model_used, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (client_id, job_id, stage) DO NOTHING`,
    [client_id, String(job_id), stage, Number(aej_used || 0), tokens_used, model_used]
  );
}

function inferContentMeta(reqJson) {
  const first = Array.isArray(reqJson.items) && reqJson.items.length ? reqJson.items[0] : {};
  const content_source = reqJson.content_source || first.content_source || "wp";
  const content_type = reqJson.content_type || first.content_type || first.type || "page";
  const content_id =
    reqJson.content_id || first.content_id || first.wp_id || first.post_id || first.id || first.entity_id || "unknown";
  return { content_source, content_type, content_id: String(content_id) };
}

async function logDecision({ client_id, job_id, reqJson, decision_type, decision_reason }) {
  const meta = inferContentMeta(reqJson);
  await pg.query(
    `INSERT INTO c360_decision_log
       (client_id, job_id, content_source, content_type, content_id, decision_type, decision_reason, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
     ON CONFLICT (client_id, job_id, decision_type) DO NOTHING`,
    [client_id, String(job_id), meta.content_source, meta.content_type, meta.content_id, decision_type, decision_reason]
  );
}

function buildDeterministicFallback(mode) {
  if (mode === "ecom_catalog") {
    return {
      mode: "ecom_catalog",
      product: {
        short_description: "Description courte (fallback).",
        long_description_html: "<p>Description longue (fallback).</p>",
        bullets: ["Point 1", "Point 2", "Point 3"],
        specs: [],
      },
      seo: { focus_keyword: "", tags: [], meta_title: "Titre (fallback)", meta_description: "Meta description (fallback)" },
    };
  }
  if (mode === "full_content") {
    return {
      mode: "full_content",
      title: "Titre (fallback)",
      meta_description: "Meta description (fallback)",
      outline: ["H2 1", "H2 2", "H2 3"],
      intro: "Intro (fallback).",
      sections: [{ h2: "H2 1", content: "Contenu (fallback)." }],
      faq: [{ q: "Question ?", a: "Réponse (fallback)." }],
      tags: ["fallback"],
    };
  }
  return {
    mode: "quick_boost",
    title: "Titre (fallback)",
    meta_description: "Meta description (fallback)",
    intro: "Intro (fallback).",
    reassurance: ["Livraison", "Paiement sécurisé", "Support"],
    faq: [{ q: "Question ?", a: "Réponse (fallback)." }],
  };
}

const worker = new Worker(
  QUEUE,
  async (bullJob) => {
    const jobId = bullJob.data?.job_id;
    if (!jobId) throw new Error("missing job_id");

    const dbJob = await getJob(jobId);
    if (!dbJob) throw new Error(`job_not_found:${jobId}`);
    if (dbJob.status === "done") return { ok: true, skipped: true };
    if (dbJob.status === "canceled") {
      // Admin canceled before execution. Ensure reservation is released.
      await releaseHold({ client_id: dbJob.client_id, job_id: jobId });
      return { ok: true, skipped: true, canceled: true };
    }

    await setJob(jobId, { status: "running", progress: 10 });
    await logJobEvent({ job_id: jobId, client_id: dbJob.client_id, event_type: "running", message: "Job started" });

    const reqJson = dbJob.request_json;
    if (!reqJson) throw new Error("missing_request_json");

    const mode = normalizeMode(reqJson.mode || dbJob.mode);
    reqJson.mode = mode;

    await logAEJ({ client_id: dbJob.client_id, job_id: jobId, stage: "analyse", aej_used: 1 });

    await logDecision({
      client_id: dbJob.client_id,
      job_id: jobId,
      reqJson,
      decision_type: "analysed",
      decision_reason: "Analyse effectuée et mode de génération sélectionné.",
    });
    await logAEJ({ client_id: dbJob.client_id, job_id: jobId, stage: "decision", aej_used: 1 });

    await setJob(jobId, { progress: 30 });

    let exec = null;
    let source = "deterministic";
    let llm_error = null;
    let fatal_error = null;

    try {
      const forced = await isForceDegraded();
      if (forced) throw new Error("force_degraded");
      const { prompt, schema } = pickPromptAndSchema(mode, reqJson);
      await logJobEvent({ job_id: jobId, client_id: dbJob.client_id, event_type: "openai_call", message: "Calling OpenAI" });
      exec = await callOpenAI({ prompt, schema });
      source = "openai";
      await logJobEvent({ job_id: jobId, client_id: dbJob.client_id, event_type: "openai_ok", message: "OpenAI returned" });
    } catch (e) {
      llm_error = String(e?.message || e);
      exec = null;
    }

    await logAEJ({ client_id: dbJob.client_id, job_id: jobId, stage: "generation", aej_used: source === "openai" ? 5 : 1 });

    if (!exec) {
      // If OpenAI fails, we keep a deterministic fallback to avoid total failure.
      // This is also used for "OpenAI down" degraded mode.
      exec = buildDeterministicFallback(mode);
      await logJobEvent({ job_id: jobId, client_id: dbJob.client_id, event_type: "fallback", message: "Using deterministic fallback", meta: { llm_error } });
    }

    const resultPayload = {
      ok: true,
      results: [{ exec, source, llm_error, status: "ready_to_review" }],
    };

    await setJob(jobId, { status: "done", progress: 100, result_json: resultPayload });
    await logJobEvent({ job_id: jobId, client_id: dbJob.client_id, event_type: "done", message: "Job finished" });

    await logDecision({
      client_id: dbJob.client_id,
      job_id: jobId,
      reqJson,
      decision_type: "modified",
      decision_reason: source === "openai" ? "Optimisation IA générée et prête à être appliquée." : "Fallback utilisé : optimisation prête à être appliquée.",
    });
    await logAEJ({ client_id: dbJob.client_id, job_id: jobId, stage: "application", aej_used: 1 });

    // Finalize AEJ usage and release reservation (S2).
    const aejFinal = await computeAEJTotal({ client_id: dbJob.client_id, job_id: jobId });
    await setJob(jobId, { aej_final: aejFinal });
    await releaseHold({ client_id: dbJob.client_id, job_id: jobId });

    return { ok: true, job_id: jobId };
  },
  { connection: redisConnection(), concurrency: CONCURRENCY }
);

// Ensure we release holds on failures too.
worker.on("failed", async (job, err) => {
  try {
    const jobId = job?.data?.job_id;
    if (!jobId) return;
    const dbJob = await getJob(jobId);
    if (!dbJob) return;
    await setJob(jobId, { status: "error", progress: 100, error_text: String(err?.message || err) });
    await logJobEvent({ job_id: jobId, client_id: dbJob.client_id, event_type: "error", message: "Job failed", meta: { error: String(err?.message || err) } });
    await releaseHold({ client_id: dbJob.client_id, job_id: jobId });
  } catch (e) {
    console.error("[worker] failed cleanup error:", e?.message || e);
  }
  console.error(`[worker] failed bullmq_job=${job?.id}`, err?.message || err);
});

worker.on("completed", (job) => console.log(`[worker] completed bullmq_job=${job.id}`));

console.log(`[worker] BullMQ worker started | queue=${QUEUE} | concurrency=${CONCURRENCY}`);
