// Saves and loads the daily dining menus. One cache entry per hall per date,
// so answering a question only reads one small entry, plus a little "meta" entry
// that says when the data was fetched.

import hallData from "../../../data/dining/halls.json";
import { CONFIG } from "../../config";
import { getJson, setJson } from "../../store";
import type { DiningDay, DiningHall, DiningHallInfo, DiningSnapshot } from "./types";

export const DINING_HALLS: DiningHall[] = hallData.halls as DiningHall[];
export const DINING_HUB_URL: string = hallData.hubUrl;

const dayKey = (hallId: string, date: string) => `dining:${hallId}:day:${date}`;
const metaKey = (hallId: string) => `dining:${hallId}:meta`;

type Meta = { scrapedAt: string; source: string; dates: string[]; hallInfo?: DiningHallInfo };

const TTL_SECONDS = CONFIG.dining.cacheDays * 24 * 3600;

/** Store every day in the snapshot. Same data in, same data out, so running it twice is harmless. */
export async function saveSnapshot(snapshot: DiningSnapshot): Promise<{ days: number }> {
  const dates = Object.keys(snapshot.days);
  for (const date of dates) await setJson(dayKey(snapshot.hallId, date), snapshot.days[date], TTL_SECONDS);
  const meta: Meta = { scrapedAt: snapshot.scrapedAt, source: snapshot.source, dates, ...(snapshot.hallInfo ? { hallInfo: snapshot.hallInfo } : {}) };
  await setJson(metaKey(snapshot.hallId), meta, TTL_SECONDS);
  return { days: dates.length };
}

/** One day's menu, or null if we don't have it. */
export async function getDay(hallId: string, date: string): Promise<DiningDay | null> {
  return getJson<DiningDay>(dayKey(hallId, date));
}

/** When the data was last fetched, and from where. */
export async function getMeta(hallId: string): Promise<{ scrapedAt: string; source: string; hallInfo?: DiningHallInfo } | null> {
  const meta = await getJson<Meta>(metaKey(hallId));
  return meta ? { scrapedAt: meta.scrapedAt, source: meta.source, hallInfo: meta.hallInfo } : null;
}
