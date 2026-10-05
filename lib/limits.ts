// ─────────────────────────────────────────────────────────────────────────────
// COST AND ABUSE LIMITS (GUARDRAIL #5)
//
// Stops one person (or a bot) from running up the Claude bill. Three limits,
// checked before every paid AI call:
//
//   1. Per visitor:  a few questions per minute, a few dozen per day.
//   2. Whole site:   a cap on questions per minute across everyone, so a
//                    swarm of bots on many IP addresses can't burst.
//   3. Daily budget: the real dollar cost of every Claude call is added up.
//                    Once today's total reaches the cap, AI answers pause until
//                    midnight (Michigan time). Help screens, the RA lookup and
//                    keyword escalation keep working; they cost nothing.
//
// Where counts are kept, so every Vercel server shares the same numbers:
//   - Upstash Redis (KV_REST_API_URL + KV_REST_API_TOKEN), or
//   - any standard Redis (a variable ending in REDIS_URL, like Storage_REDIS_URL).
// With neither (your laptop), counts live in memory. If Redis ever fails, the
// limits keep working from memory instead of taking the site down. Nothing
// about the visitor is stored: IP addresses are hashed with a secret salt
// before they're used as a key, and every key expires on its own within two days.
// ─────────────────────────────────────────────────────────────────────────────

import { Redis as UpstashRedis } from "@upstash/redis";
import { createHash, randomBytes } from "node:crypto";
import { createClient } from "redis";
import { CONFIG } from "./config";

// ── Storage: shared Redis if configured, otherwise memory ──────────────────

type Backend = {
  add(key: string, amount: number, ttlSeconds: number): Promise<number>;
  get(key: string): Promise<number>;
  ping(): Promise<void>;
};

/** Upstash Redis, over HTTPS. */
function upstashBackend(): Backend | null {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const redis = new UpstashRedis({ url, token });
  return {
    async add(key, amount, ttl) {
      const [total] = await redis.multi().incrbyfloat(key, amount).expire(key, ttl).exec<[number, number]>();
      return Number(total);
    },
    async get(key) {
      return Number((await redis.get<number>(key)) ?? 0);
    },
    async ping() {
      await redis.ping();
    },
  };
}

/** A standard Redis server (redis:// or rediss:// URL), such as Vercel's Redis integration. */
function standardRedisBackend(): { backend: Backend; url: string } | null {
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
        client.on("end", () => (connecting = null)); // reconnect from scratch next time
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
    url,
    backend: {
      async add(key, amount, ttl) {
        const [total] = await (await connect()).multi().incrByFloat(key, amount).expire(key, ttl).exec();
        return Number(total);
      },
      async get(key) {
        return Number((await (await connect()).get(key)) ?? 0);
      },
      async ping() {
        await (await connect()).ping();
      },
    },
  };
}

const standard = standardRedisBackend();
const backend: Backend | null = upstashBackend() ?? standard?.backend ?? null;

if (!backend && process.env.VERCEL_ENV === "production") {
  console.warn("⚠️  No Redis is connected. Limits are per-server only and much weaker. See README → Deploying.");
}

/** Give a Redis call a few seconds, then give up (so a stuck connection can't hang a question). */
function withTimeout<T>(promise: Promise<T>, ms = 3000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("redis timed out")), ms)),
  ]);
}

const memory = new Map<string, { value: number; expires: number }>();

/** For /api/health: is the shared counter store connected and working? */
export async function redisStatus(): Promise<"ok" | "not_connected" | "error"> {
  if (!backend) return "not_connected";
  try {
    await withTimeout(backend.ping());
    return "ok";
  } catch (err) {
    console.error("redis health check failed:", err instanceof Error ? err.message : "unknown error");
    return "error";
  }
}

function memoryAdd(key: string, amount: number, ttlSeconds: number): number {
  const now = Date.now();
  const entry = memory.get(key);
  const value = (entry && entry.expires > now ? entry.value : 0) + amount;
  memory.set(key, { value, expires: now + ttlSeconds * 1000 });
  if (memory.size > 10_000) for (const [k, e] of memory) if (e.expires <= now) memory.delete(k);
  return value;
}

/** Add `amount` to a counter and return the new total. The counter deletes itself after `ttlSeconds`. */
async function addTo(key: string, amount: number, ttlSeconds: number): Promise<number> {
  if (backend) {
    try {
      return await withTimeout(backend.add(key, amount, ttlSeconds));
    } catch (err) {
      console.error("limit store failed, using memory:", err instanceof Error ? err.message : "unknown error");
    }
  }
  return memoryAdd(key, amount, ttlSeconds);
}

async function read(key: string): Promise<number> {
  if (backend) {
    try {
      return await withTimeout(backend.get(key));
    } catch (err) {
      console.error("limit store failed, using memory:", err instanceof Error ? err.message : "unknown error");
    }
  }
  const entry = memory.get(key);
  return entry && entry.expires > Date.now() ? entry.value : 0;
}

// ── Keys ────────────────────────────────────────────────────────────────────

// The salt makes hashed IPs meaningless outside this app. It must be the same
// on every server, so counts line up. Uses IP_HASH_SALT if set, else the
// (secret) Redis token or URL, else a random value (fine for one laptop).
const SALT =
  process.env.IP_HASH_SALT ||
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  process.env.KV_REST_API_TOKEN ||
  standard?.url ||
  randomBytes(32).toString("hex");

function visitorKey(ip: string): string {
  return createHash("sha256").update(SALT + ip).digest("hex").slice(0, 32);
}

/** Today's date in Michigan, e.g. "2026-09-30". The daily budget resets at local midnight. */
function today(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Detroit" });
}

function thisMinute(): number {
  return Math.floor(Date.now() / 60_000);
}

// ── The checks ──────────────────────────────────────────────────────────────

export type LimitResult = "ok" | "visitor_limit" | "site_busy" | "budget_reached";

/**
 * Call once per question, before any paid AI call. Counts the question and
 * says whether it may go ahead.
 */
export async function checkLimits(ip: string): Promise<LimitResult> {
  // Budget first: once it's spent, nothing else matters today.
  if ((await spentToday()) >= CONFIG.limits.dailyBudgetUsd) return "budget_reached";

  const who = visitorKey(ip);
  const [visitorMinute, visitorDay, siteMinute] = await Promise.all([
    addTo(`lim:v:${who}:m:${thisMinute()}`, 1, 120),
    addTo(`lim:v:${who}:d:${today()}`, 1, 48 * 3600),
    addTo(`lim:site:m:${thisMinute()}`, 1, 120),
  ]);

  if (visitorMinute > CONFIG.limits.perVisitorPerMinute || visitorDay > CONFIG.limits.perVisitorPerDay) {
    return "visitor_limit";
  }
  if (siteMinute > CONFIG.limits.sitePerMinute) return "site_busy";
  return "ok";
}

/** A cheap per-visitor limit for the free endpoints (feedback, audit log), so they can't be flooded. */
export async function allowCheapRequest(ip: string, perMinute = 20): Promise<boolean> {
  return (await addTo(`lim:cheap:${visitorKey(ip)}:m:${thisMinute()}`, 1, 120)) <= perMinute;
}

// ── The daily budget ────────────────────────────────────────────────────────

export async function spentToday(): Promise<number> {
  return read(`lim:spend:${today()}`);
}

type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
};

/** Add the real cost of one Claude call to today's total. */
export async function recordSpend(usage: Usage): Promise<void> {
  const p = CONFIG.pricePerMillionTokens;
  const usd =
    (usage.input_tokens * p.input +
      (usage.cache_creation_input_tokens ?? 0) * p.cacheWrite +
      (usage.cache_read_input_tokens ?? 0) * p.cacheRead +
      usage.output_tokens * p.output) /
    1_000_000;
  try {
    await addTo(`lim:spend:${today()}`, usd, 48 * 3600);
  } catch (err) {
    console.error("could not record spend:", err instanceof Error ? err.message : "unknown error");
  }
}
