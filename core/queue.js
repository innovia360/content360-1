const { Queue } = require("bullmq");
const IORedis = require("ioredis");

// IMPORTANT: Redis can be temporarily unavailable during docker startup.
// ioredis emits 'error' events; without a handler, Node may crash.
// We keep the API alive and let BullMQ retry until Redis is ready.
let _redisSingleton = null;

function redisConnection() {
  if (_redisSingleton) return _redisSingleton;

  const host = process.env.REDIS_HOST || "redis"; // docker-compose service name
  const port = Number(process.env.REDIS_PORT || 6379);
  const password = process.env.REDIS_PASSWORD || undefined;

  const r = new IORedis({
    host,
    port,
    password,
    // BullMQ recommends this for long-running jobs.
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    // Backoff retry when Redis isn't ready yet.
    retryStrategy(times) {
      const delay = Math.min(times * 500, 5000);
      return delay;
    },
  });

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
