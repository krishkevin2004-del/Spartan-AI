// Saves and loads the events calendar. The whole calendar is small (dozens of
// events), so it lives under one cache key.

import { CONFIG } from "../../config";
import { getJson, setJson } from "../../store";
import type { EventsSnapshot } from "./types";

const KEY = "events:uab:snapshot";
const TTL_SECONDS = CONFIG.events.cacheDays * 24 * 3600;

export async function saveEvents(snapshot: EventsSnapshot): Promise<void> {
  await setJson(KEY, snapshot, TTL_SECONDS);
}

export async function getEvents(): Promise<EventsSnapshot | null> {
  return getJson<EventsSnapshot>(KEY);
}
