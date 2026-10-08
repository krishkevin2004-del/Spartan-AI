// Plain filtering over the cached calendar. No AI: given a range of days and
// some keywords, it returns the matching events in time order.
//
// Keyword matching is "soft": it looks for words in the title, description and
// location. Descriptions are free text, so this can miss things, and the
// answer says so.

import { addDays, michiganDate, prettyDate } from "../dining/time";
import type { CampusEvent } from "./types";

const TZ = "America/Detroit";

// Asking for "food" means any of these words in the listing.
const FOOD_WORDS = [
  "food", "snack", "bagel", "pizza", "pastr", "cookie", "ice cream", "breakfast", "lunch", "dinner",
  "cake", "treat", "refreshment", "coffee", "donut", "doughnut", "candy", "cupcake", "popcorn", "free meal",
];
const FOOD_TRIGGERS = /^(free )?(food|snack|eat|eats|refreshment|free)s?$/;

function stem(word: string): string {
  const w = word.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/(es|s)$/, "");
  return w.length > 5 ? w.slice(0, w.length - 1) : w; // "comedy" matches "comedian"
}

/** Did this keyword expand into a list of related words? The answer then says the match is approximate. */
export function isSoftKeyword(keyword: string): boolean {
  return FOOD_TRIGGERS.test(keyword.trim().toLowerCase());
}

function haystack(event: CampusEvent): string {
  return [event.title, event.description, event.location ?? ""].join(" ").toLowerCase();
}

function matches(event: CampusEvent, keywords: string[]): boolean {
  if (keywords.length === 0) return true;
  const text = haystack(event);
  return keywords.some((keyword) => {
    const k = keyword.trim().toLowerCase();
    if (!k) return false;
    if (isSoftKeyword(k)) return FOOD_WORDS.some((w) => text.includes(w));
    return text.includes(stem(k));
  });
}

/** Events from `from` to `to` (inclusive, Michigan dates). Today's list leaves out events that already ended. */
export function findEvents(
  events: CampusEvent[],
  from: string,
  to: string,
  keywords: string[],
  now: Date = new Date(),
): CampusEvent[] {
  const today = michiganDate(now);
  return events
    .filter((e) => {
      const startDay = michiganDate(new Date(e.start));
      const endDay = michiganDate(new Date(e.end ?? e.start));
      if (startDay > to || endDay < from) return false;
      const over = new Date(e.end ?? e.start).getTime() < now.getTime();
      if (over && from <= today) return false; // no point listing what already happened
      return matches(e, keywords);
    })
    .sort((a, b) => a.start.localeCompare(b.start));
}

/** "Thu, Oct 8, 6:30 p.m. to 8:30 p.m." in Michigan time, worked out in code so the model never has to. */
export function formatWhen(event: CampusEvent): string {
  const start = new Date(event.start);
  const clock = (d: Date) =>
    d.toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).replace("AM", "a.m.").replace("PM", "p.m.");
  const day = start.toLocaleDateString("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric" });
  if (!event.end) return `${day}, ${clock(start)}`;
  const end = new Date(event.end);
  if (michiganDate(end) !== michiganDate(start)) {
    return `${day}, ${clock(start)} to ${end.toLocaleDateString("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric" })}, ${clock(end)}`;
  }
  return `${day}, ${clock(start)} to ${clock(end)}`;
}

/** One event as plain text for the model to cite. */
export function eventBlock(event: CampusEvent): string {
  const where = event.location ? ` Location: ${event.location}.` : "";
  return `${event.title}. When: ${formatWhen(event)}.${where} ${event.description}`.trim();
}

export function describeRange(from: string, to: string): string {
  return from === to ? prettyDate(from) : `${prettyDate(from)} to ${prettyDate(to)}`;
}

export { addDays };
