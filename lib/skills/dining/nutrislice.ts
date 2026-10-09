// Turns the data MSU's menu platform (Nutrislice) sends to its own web page
// into this project's dining shapes. Pure functions: no network, no browser.
// scripts/dining-scrape.ts does the fetching and calls these.
//
// The platform's data is outside our control, so every read is defensive:
// anything missing or odd is skipped, never guessed.

import type { DiningItem, DiningStation } from "./types";

type Json = Record<string, any>; // external data: we check each field before using it

/** "BRIMSTONE" → "Brimstone", "CIAO!" → "Ciao!", "S2" stays "S2". */
export function tidyStationName(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => (/\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(" ");
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

/** Dietary labels (vegan...) and "contains ..." labels, from a dish's icons. */
function labelsFor(food: Json): { tags: string[]; allergens: string[] } {
  const tags: string[] = [];
  const allergens: string[] = [];
  const icons = food?.icons?.food_icons;
  for (const icon of Array.isArray(icons) ? icons : []) {
    const name = cleanText(icon?.name).toLowerCase();
    if (!name) continue;
    if (icon?.behavior === 1) allergens.push(name); // "This contains milk"
    else if (icon?.behavior === 2) tags.push(name); // "Vegan", "Vegetarian"
  }
  return { tags, allergens };
}

/**
 * One week of one meal (Breakfast, Lunch, ...) in, a map of date → stations out.
 * Only dates on or after `since` are kept, and days with no dishes are left out
 * (the menu for those days isn't published yet).
 */
export function mapWeek(week: unknown, since: string): Record<string, DiningStation[]> {
  const out: Record<string, DiningStation[]> = {};
  const days = (week as Json)?.days;
  if (!Array.isArray(days)) return out;

  for (const day of days) {
    const date = cleanText(day?.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < since || !Array.isArray(day?.menu_items)) continue;

    // Each dish belongs to a station block (BLISS, BRIMSTONE, ...) named in menu_info,
    // and sits under a sub-heading (Entrees, Sides, ...).
    const stationNames = new Map<string, string>();
    for (const [id, info] of Object.entries((day.menu_info ?? {}) as Json)) {
      const display = cleanText((info as Json)?.section_options?.display_name);
      if (display) stationNames.set(id, tidyStationName(display));
    }

    const stations = new Map<string, DiningItem[]>();
    let section = "";
    for (const row of day.menu_items as Json[]) {
      if (row?.is_section_title) {
        section = cleanText(row.text);
        continue;
      }
      const name = cleanText(row?.food?.name);
      if (!name) continue;

      const base = stationNames.get(String(row.menu_id)) ?? "Menu";
      const stationName = section ? `${base} · ${section}` : base;
      const description = cleanText(row.food.description);
      const { tags, allergens } = labelsFor(row.food);
      const list = stations.get(stationName) ?? [];
      list.push({ name, ...(description ? { description } : {}), tags, allergens });
      stations.set(stationName, list);
    }

    if (stations.size > 0) out[date] = [...stations].map(([name, items]) => ({ name, items }));
  }
  return out;
}

// ── Hall information (address and posted hours) ─────────────────────────────

const DAYS = [
  ["mon", "Mon"],
  ["tue", "Tue"],
  ["wed", "Wed"],
  ["thu", "Thu"],
  ["fri", "Fri"],
  ["sat", "Sat"],
  ["sun", "Sun"],
] as const;

/** "21:00:00" → "9:00 p.m." */
function clock(value: unknown): string | null {
  const m = typeof value === "string" ? value.match(/^(\d{1,2}):(\d{2})/) : null;
  if (!m) return null;
  const hour = Number(m[1]);
  const suffix = hour >= 12 ? "p.m." : "a.m.";
  return `${hour % 12 === 0 ? 12 : hour % 12}:${m[2]} ${suffix}`;
}

/** The hall's posted hours as plain words, e.g. "7:00 a.m. to 9:00 p.m. daily". */
export function describeHours(school: Json): string | undefined {
  const perDay = DAYS.map(([key, label]) => {
    if (school?.[`${key}_enabled`] === false) return { label, text: "closed" };
    if (school?.[`${key}_is_24_hours`]) return { label, text: "open 24 hours" };
    const start = clock(school?.[`${key}_start`]);
    const end = clock(school?.[`${key}_end`]);
    return start && end ? { label, text: `${start} to ${end}` } : null;
  });
  if (perDay.some((d) => d === null)) return undefined;
  const days = perDay as { label: string; text: string }[];
  if (days.every((d) => d.text === days[0].text)) return `${days[0].text} daily`;

  // Group runs of days with the same hours: "Mon–Fri 7:00 a.m. to 9:00 p.m.; Sat–Sun 9:00 a.m. to 8:00 p.m."
  const runs: string[] = [];
  for (let i = 0; i < days.length; ) {
    let j = i;
    while (j + 1 < days.length && days[j + 1].text === days[i].text) j++;
    runs.push(`${i === j ? days[i].label : `${days[i].label}–${days[j].label}`} ${days[i].text}`);
    i = j + 1;
  }
  return runs.join("; ");
}

export function mapHallInfo(school: unknown): { address?: string; hours?: string } {
  const s = (school ?? {}) as Json;
  const address = cleanText(s.address);
  const hours = describeHours(s);
  return { ...(address ? { address } : {}), ...(hours ? { hours } : {}) };
}
