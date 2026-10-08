// GET /api/cron/events   (Authorization: Bearer <CRON_SECRET>)
//
// The once-a-day job that refreshes the events calendar: fetch UAB's RSS feed
// (one request), parse and check it, save it to the cache. Vercel Cron calls
// this on the schedule in vercel.json, and sends the secret automatically when
// a CRON_SECRET environment variable is set. Without the secret this route is
// closed, so nobody else can trigger fetches.

import { bearerMatches } from "@/lib/secrets";
import { saveEvents } from "@/lib/skills/events/cache";
import { fetchUabSnapshot } from "@/lib/skills/events/fetch";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 24) return Response.json({ error: "cron is not enabled" }, { status: 503 });
  if (!bearerMatches(request.headers.get("authorization"), secret)) return new Response(null, { status: 401 });

  try {
    const { snapshot, parsed, skipped, dropped } = await fetchUabSnapshot();
    await saveEvents(snapshot);
    console.log(JSON.stringify({ event: "events_refresh", events: snapshot.events.length, parsed, skipped, dropped }));
    return Response.json({ ok: true, events: snapshot.events.length, skipped, dropped });
  } catch (err) {
    // The cache keeps the last good calendar (it expires after a few days), so one bad day is harmless.
    console.error("events refresh failed:", err instanceof Error ? err.message : "unknown error");
    return Response.json({ error: "refresh failed" }, { status: 502 });
  }
}
