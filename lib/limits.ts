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
// Where counts are kept: Upstash Redis when it's connected (production), so
// every Vercel server shares the same counts. Without Redis (your laptop),
// counts live in memory. Nothing about the visitor is stored: IP addresses are
// hashed with a secret salt before they're used as a key, and every key
// expires on its own within two days.
// ─────────────────────────────────────────────────────────────────────────────

import { Redis } from "@upstash/redis";
import { createHash, randomBytes } from "node:crypto";
import { CONFIG } from "./config";

// ── Storage: Redis if configured, otherwise memory ─────────────────────────

const hasRedis = Boolean(
  (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL) &&
    (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN),
);
const redis = hasRedis ? Redis.fromEnv() : null;

if (!redis && process.env.VERCEL_ENV === "production") {
  console.warn(
    "⚠️  Upstash Redis is not connected. Limits are per-server only and much weaker. See README → Deploying.",
  );
}

const memory = new Map<string, { value: number; expires: number }>();

/** For /api/health: is the shared counter store connected and working? */
export async function redisStatus(): Promise<"ok" | "not_connected" | "error"> {
  if (!redis) return "not_connected";
  try {
    await redis.ping();
    return "ok";
  } catch {
    return "error";
  }
}

/** Add `amount` to a counter and return the new total. The counter deletes itself after `ttlSeconds`. */
async function addTo(key: string, amount: number, ttlSeconds: number): Promise<number> {
  if (redis) {
    const [total] = await redis.multi().incrbyfloat(key, amount).expire(key, ttlSeconds).exec<[number, number]>();
    return Number(total);
  }
  const now = Date.now();
  const entry = memory.get(key);
  const value = (entry && entry.expires > now ? entry.value : 0) + amount;
  memory.set(key, { value, expires: now + ttlSeconds * 1000 });
  if (memory.size > 10_000) for (const [k, e] of memory) if (e.expires <= now) memory.delete(k);
  return value;
}

async function read(key: string): Promise<number> {
  if (redis) return Number((await redis.get<number>(key)) ?? 0);
  const entry = memory.get(key);
  return entry && entry.expires > Date.now() ? entry.value : 0;
}

// ── Keys ────────────────────────────────────────────────────────────────────

// The salt makes hashed IPs meaningless outside this app. It must be the same
// on every server, so counts line up. Uses IP_HASH_SALT if set, else the
// (secret) Redis token, else a random value (fine for one laptop).
const SALT =
  process.env.IP_HASH_SALT ||
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  process.env.KV_REST_API_TOKEN ||
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
