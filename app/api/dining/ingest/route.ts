// POST /api/dining/ingest   (Authorization: Bearer <INGEST_SECRET>)
//
// How menu data gets into the cache. Whatever fetches the menus (a scheduled
// job, an official feed) sends one hall's data here as JSON. The secret proves
// it's ours, and the data is checked strictly before it's stored.
//
// This route deliberately does NOT use the browser/bot checks the question
// routes use, because the caller is a program, not a browser. The secret is its
// only door. If INGEST_SECRET isn't set, the route is closed.

import { timingSafeEqual } from "node:crypto";
import { DINING_HALLS, saveSnapshot } from "@/lib/skills/dining/cache";
import { validateSnapshot } from "@/lib/skills/dining/validate";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 600_000;

function secretMatches(header: string | null, secret: string): boolean {
  const given = Buffer.from((header ?? "").replace(/^Bearer\s+/i, ""));
  const wanted = Buffer.from(secret);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

export async function POST(request: Request) {
  const secret = process.env.INGEST_SECRET;
  if (!secret || secret.length < 24) return Response.json({ error: "ingest is not enabled" }, { status: 503 });
  if (!secretMatches(request.headers.get("authorization"), secret)) return new Response(null, { status: 401 });

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return new Response(null, { status: 413 });
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return new Response(null, { status: 413 });

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "body is not valid JSON" }, { status: 400 });
  }

  const checked = validateSnapshot(body, DINING_HALLS);
  if (!checked.ok) return Response.json({ error: checked.error }, { status: 422 });

  try {
    const { days } = await saveSnapshot(checked.snapshot);
    console.log(JSON.stringify({ event: "dining_ingest", hall: checked.snapshot.hallId, days }));
    return Response.json({ ok: true, hall: checked.snapshot.hallId, days });
  } catch (err) {
    console.error("dining ingest failed:", err instanceof Error ? err.message : "unknown error");
    return Response.json({ error: "could not save to the cache" }, { status: 502 });
  }
}
