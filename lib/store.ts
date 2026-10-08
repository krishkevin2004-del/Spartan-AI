// ─────────────────────────────────────────────────────────────────────────────
// A small key-value store for cached skill data (today's dining menu, ...).
// JSON in, JSON out, with an expiry.
//
// Uses the same Redis the rate limiter uses (Upstash, or a standard Redis URL),
// and plain memory when none is connected (your laptop). This is separate from
// lib/limits.ts on purpose: the cost-protection code stays untouched.
//
// Reads that fail return "nothing there" (the skill then says it has no data);
// writes that fail throw, so the daily update can report the problem.
// ─────────────────────────────────────────────────────────────────────────────

import { Redis as UpstashRedis } from "@upstash/redis";
import { createClient } from "redis";

type Backend = {
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  get<T>(key: string): Promise<T | null>;
  ping(): Promise<void>;
};

function upstashBackend(): Backend | null {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const redis = new UpstashRedis({ url, token });
  return {
    async set(key, value, ttl) {
      await redis.set(key, value, { ex: ttl });
    },
    async get<T>(key: string) {
      return (await redis.get<T>(key)) ?? null;
    },
    async ping() {
      await redis.ping();
    },
  };
}

function standardRedisBackend(): Backend | null {
  const entry = Object.entries(process.env).find(
    ([name, value]) => /(^|_)REDIS_URL$/i.test(name) && value?.startsWith("redis"),
  );
  if (!entry) return null;
  const url = entry[1] as string;

  const makeClient = () => createClient({ url, socket: { connectTimeout: 3000, reconnectStrategy: false } });
  type Client = ReturnType<typeof makeClient>;
  let connecting: Promise<Client> | null = null;
  const connect = (): Promise<Client> => {
    if (!connecting) {
      connecting = (async () => {
        const client = makeClient();
        client.on("error", (err) => console.error("redis error:", err.message));
        client.on("end", () => (connecting = null));
        await client.connect();
        return client;
      })().catch((err) => {
        connecting = null;
        throw err;
      });
    }
    return connecting;
  };

  return {
    async set(key, value, ttl) {
      await (await connect()).set(key, JSON.stringify(value), { EX: ttl });
    },
    async get<T>(key: string) {
      const raw = await (await connect()).get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    },
    async ping() {
      await (await connect()).ping();
    },
  };
}

const backend: Backend | null = upstashBackend() ?? standardRedisBackend();
const memory = new Map<string, { value: string; expires: number }>();

function withTimeout<T>(promise: Promise<T>, ms = 4000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("store timed out")), ms)),
  ]);
}

/** "redis" when a shared Redis is connected, otherwise "memory" (this server only). */
export const storeKind: "redis" | "memory" = backend ? "redis" : "memory";

export async function setJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  if (backend) return withTimeout(backend.set(key, value, ttlSeconds));
  memory.set(key, { value: JSON.stringify(value), expires: Date.now() + ttlSeconds * 1000 });
}

export async function getJson<T>(key: string): Promise<T | null> {
  if (backend) {
    try {
      return await withTimeout(backend.get<T>(key));
    } catch (err) {
      console.error("store read failed:", err instanceof Error ? err.message : "unknown error");
      return null;
    }
  }
  const entry = memory.get(key);
  if (!entry || entry.expires <= Date.now()) return null;
  return JSON.parse(entry.value) as T;
}
