// Checks menu data BEFORE it goes in the cache. The data comes from outside
// (a scheduled job or a feed), and residents will trust what the bot says
// about it, so anything oversized, malformed or for an unknown hall is
// rejected, never "fixed up" and stored.

import { addDays, isValidDate, michiganDate } from "./time";
import type { DiningDay, DiningHall, DiningItem, DiningMeal, DiningSnapshot, DiningStation } from "./types";

const LIMITS = {
  days: 31,
  mealsPerDay: 6,
  stationsPerMeal: 40,
  itemsPerStation: 80,
  nameLength: 120,
  descriptionLength: 400,
  labelsPerItem: 14,
  labelLength: 40,
};

type Result = { ok: true; snapshot: DiningSnapshot } | { ok: false; error: string };

/** Strip control characters and trim. Returns null for anything that isn't a usable string. */
function cleanString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > 0 && cleaned.length <= max ? cleaned : null;
}

function cleanLabels(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > LIMITS.labelsPerItem) return null;
  const labels: string[] = [];
  for (const raw of value) {
    const label = cleanString(raw, LIMITS.labelLength);
    if (!label) return null;
    labels.push(label.toLowerCase());
  }
  return labels;
}

export function validateSnapshot(input: unknown, halls: DiningHall[], now: Date = new Date()): Result {
  const fail = (error: string): Result => ({ ok: false, error });
  if (typeof input !== "object" || input === null) return fail("body must be a JSON object");
  const raw = input as Record<string, unknown>;

  const hall = halls.find((h) => h.id === raw.hallId);
  if (!hall || !hall.enabled) return fail("unknown or disabled hallId");

  const scrapedAt = typeof raw.scrapedAt === "string" ? new Date(raw.scrapedAt) : null;
  if (!scrapedAt || Number.isNaN(scrapedAt.getTime())) return fail("scrapedAt must be an ISO time");
  if (scrapedAt.getTime() > now.getTime() + 10 * 60_000) return fail("scrapedAt is in the future");
  if (now.getTime() - scrapedAt.getTime() > 48 * 3600_000) return fail("scrapedAt is more than 2 days old");

  const source = cleanString(raw.source, 300);
  if (!source) return fail("source is required");

  if (typeof raw.days !== "object" || raw.days === null || Array.isArray(raw.days)) return fail("days must be an object");
  const dateKeys = Object.keys(raw.days);
  if (dateKeys.length === 0 || dateKeys.length > LIMITS.days) return fail(`days must hold 1 to ${LIMITS.days} dates`);

  const today = michiganDate(now);
  const earliest = addDays(today, -1);
  const latest = addDays(today, 30);

  const days: Record<string, DiningDay> = {};
  for (const date of dateKeys) {
    if (!isValidDate(date)) return fail(`bad date key: ${date}`);
    if (date < earliest || date > latest) return fail(`date out of range: ${date}`);

    const rawDay = (raw.days as Record<string, unknown>)[date] as { meals?: unknown } | null;
    if (!rawDay || !Array.isArray(rawDay.meals) || rawDay.meals.length > LIMITS.mealsPerDay) {
      return fail(`${date}: meals must be a list of up to ${LIMITS.mealsPerDay}`);
    }

    const meals: DiningMeal[] = [];
    for (const rawMeal of rawDay.meals as Array<{ name?: unknown; stations?: unknown }>) {
      const mealName = cleanString(rawMeal?.name, LIMITS.nameLength);
      if (!mealName || !Array.isArray(rawMeal.stations) || rawMeal.stations.length > LIMITS.stationsPerMeal) {
        return fail(`${date}: bad meal`);
      }
      const stations: DiningStation[] = [];
      for (const rawStation of rawMeal.stations as Array<{ name?: unknown; items?: unknown }>) {
        const stationName = cleanString(rawStation?.name, LIMITS.nameLength);
        if (!stationName || !Array.isArray(rawStation.items) || rawStation.items.length > LIMITS.itemsPerStation) {
          return fail(`${date} ${mealName}: bad station`);
        }
        const items: DiningItem[] = [];
        for (const rawItem of rawStation.items as Array<Record<string, unknown>>) {
          const name = cleanString(rawItem?.name, LIMITS.nameLength);
          const tags = cleanLabels(rawItem?.tags);
          const allergens = cleanLabels(rawItem?.allergens);
          const description =
            rawItem?.description === undefined ? undefined : cleanString(rawItem.description, LIMITS.descriptionLength);
          if (!name || !tags || !allergens || description === null) return fail(`${date} ${mealName} ${stationName}: bad item`);
          items.push({ name, ...(description ? { description } : {}), tags, allergens });
        }
        stations.push({ name: stationName, items });
      }
      meals.push({ name: mealName, stations });
    }
    days[date] = { meals };
  }

  // Optional hall information. Anything that isn't a short plain string is dropped.
  const rawInfo = (typeof raw.hallInfo === "object" && raw.hallInfo !== null ? raw.hallInfo : {}) as Record<string, unknown>;
  const address = cleanString(rawInfo.address, 160);
  const hours = cleanString(rawInfo.hours, 240);
  const hallInfo = address || hours ? { ...(address ? { address } : {}), ...(hours ? { hours } : {}) } : undefined;

  return { ok: true, snapshot: { hallId: hall.id, ...(hallInfo ? { hallInfo } : {}), scrapedAt: scrapedAt.toISOString(), source, days } };
}
