const { Queue } = require("bullmq");
const IORedis = require("ioredis");

function redisConnection() {
  // PRIORITÉ à REDIS_URL (Render / prod)
  if (process.env.REDIS_URL) {
    return new IORedis(process.env.REDIS_URL, {
      maxRetriesPerRequest: null
    });
  }

  // Fallback local / docker
  return new IORedis({
    host: process.env.REDIS_HOST || "localhost",
    port: Number(process.env.REDIS_PORT || 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null
  });
}

function sanitizeQueueName(name) {
  if (!name) return "c360_jobs_v1";
  return name.replace(/[:/\\]/g, "_");
}

function getQueue() {
  const rawName = process.env.BULLMQ_QUEUE;
  const queueName = sanitizeQueueName(rawName);
  return new Queue(queueName, { connection: redisConnection() });
}

module.exports = {
  getQueue,
  redisConnection
};


  // Prevent process crash on connection errors.
  r.on("error", (e) => {
    console.warn("[redis] error:", e?.message || e);
  });
  r.on("connect", () => {
    console.log("[redis] connected", { host, port });
  });
  r.on("ready", () => {
    console.log("[redis] ready");
  });

  _redisSingleton = r;
  return r;
}

function sanitizeQueueName(name) {
  if (!name) return "c360_jobs_v1";
  return name.replace(/[:/\\]/g, "_");
}

function getQueue() {
  const rawName = process.env.BULLMQ_QUEUE;
  const queueName = sanitizeQueueName(rawName);
  return new Queue(queueName, { connection: redisConnection() });
}

module.exports = {
  getQueue,
  redisConnection
};
