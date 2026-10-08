// The once-a-day job: fetch UAB's RSS feed, parse it, check it, and hand back
// a snapshot ready to cache. One request per run. The bot names itself and the
// project in its User-Agent, and does not retry in a loop.

import { CONFIG } from "../../config";
import { parseUabFeed } from "./parse";
import { validateEvents } from "./validate";
import type { EventsSnapshot } from "./types";

const USER_AGENT = "AskSpartyBot/1.0 (student-built MSU assistant pilot; +https://github.com/krishkevin2004-del/Spartan-AI)";
const MAX_FEED_BYTES = 500_000;

export async function fetchUabSnapshot(
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<{ snapshot: EventsSnapshot; parsed: number; skipped: number; dropped: number }> {
  const response = await fetchImpl(CONFIG.events.feedUrl, {
    headers: { "user-agent": USER_AGENT, accept: "application/rss+xml, application/xml;q=0.9" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`feed returned HTTP ${response.status}`);

  const xml = await response.text();
  if (xml.length > MAX_FEED_BYTES) throw new Error("feed is unexpectedly large");

  const { events, skipped } = parseUabFeed(xml);
  // A feed that normally lists events and suddenly lists none is more likely broken than empty,
  // so don't overwrite the last good calendar with nothing.
  if (events.length === 0) throw new Error("feed had no usable events");
  const checked = validateEvents(events, { fetchedAt: now.toISOString(), source: CONFIG.events.feedUrl }, now);
  if (!checked.ok) throw new Error(checked.error);
  return { snapshot: checked.snapshot, parsed: events.length, skipped, dropped: checked.dropped };
}
