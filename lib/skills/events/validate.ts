// Checks events data BEFORE it goes in the cache. The text comes from a
// third-party website, so it is treated as untrusted: anything malformed is
// dropped, strings are cleaned and shortened, and links must point at the
// official events site.

import type { CampusEvent, EventsSnapshot } from "./types";

const LIMITS = { events: 300, title: 140, location: 140, description: 500 };
const OFFICIAL_LINK = /^https:\/\/uabevents\.com\//;
const DAY = 86400_000;

function clean(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.length === 0 ? null : cleaned.slice(0, max);
}

type Result = { ok: true; snapshot: EventsSnapshot; dropped: number } | { ok: false; error: string };

export function validateEvents(
  events: CampusEvent[],
  meta: { fetchedAt: string; source: string },
  now: Date = new Date(),
): Result {
  if (!Array.isArray(events)) return { ok: false, error: "events must be a list" };
  if (events.length > LIMITS.events) return { ok: false, error: `too many events (${events.length})` };

  const good: CampusEvent[] = [];
  let dropped = 0;
  for (const e of events) {
    const title = clean(e?.title, LIMITS.title);
    const description = clean(e?.description, LIMITS.description) ?? "";
    const location = e?.location === undefined ? undefined : (clean(e.location, LIMITS.location) ?? undefined);
    const start = typeof e?.start === "string" ? Date.parse(e.start) : NaN;
    const end = typeof e?.end === "string" ? Date.parse(e.end) : undefined;
    const url = typeof e?.url === "string" ? e.url.trim() : "";
    const id = clean(e?.id, 40);

    const badTimes =
      Number.isNaN(start) ||
      start < now.getTime() - 3 * DAY || // long over
      start > now.getTime() + 400 * DAY || // implausibly far away
      (end !== undefined && (Number.isNaN(end) || end < start || end - start > 14 * DAY));
    if (!title || !id || !OFFICIAL_LINK.test(url) || badTimes) {
      dropped++;
      continue;
    }
    good.push({
      id,
      title,
      start: new Date(start).toISOString(),
      ...(end !== undefined ? { end: new Date(end).toISOString() } : {}),
      ...(location ? { location } : {}),
      description,
      url,
    });
  }

  if (good.length === 0 && events.length > 0) return { ok: false, error: "no usable events in the feed" };
  const fetchedAt = new Date(meta.fetchedAt);
  if (Number.isNaN(fetchedAt.getTime())) return { ok: false, error: "bad fetchedAt" };
  return {
    ok: true,
    dropped,
    snapshot: { fetchedAt: fetchedAt.toISOString(), source: meta.source, events: good.sort((a, b) => a.start.localeCompare(b.start)) },
  };
}
