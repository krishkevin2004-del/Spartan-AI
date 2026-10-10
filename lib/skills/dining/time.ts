// Date and time helpers. Everything is in Michigan time, because that's where
// the dining halls are. Dates are plain "YYYY-MM-DD" strings.

import { CONFIG } from "../../config";

const TZ = "America/Detroit";

/** Today's date in Michigan, e.g. "2026-10-08". */
export function michiganDate(now: Date = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: TZ });
}

/** The current time in Michigan as hours, e.g. 14.5 means 2:30 p.m. */
export function michiganHour(now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  const minute = Number(parts.find((p) => p.type === "minute")?.value);
  return hour + minute / 60;
}

/** Is this a real calendar date written as YYYY-MM-DD? */
export function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(value);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** "Thursday, Oct 8" */
export function prettyDate(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Which meal does someone most likely mean right now, if they didn't say? A rough guess from the time of day. */
export function currentMeal(
  now: Date = new Date(),
): "breakfast" | "lunch" | "dinner" {
  const hour = michiganHour(now);
  if (hour < CONFIG.dining.mealCutoffs.breakfastUntil) return "breakfast";
  if (hour < CONFIG.dining.mealCutoffs.lunchUntil) return "lunch";
  return "dinner";
}

/** "7:42 a.m. today" or "Oct 7 at 7:42 a.m." for the "as of" line. */
export function describeAsOf(iso: string, now: Date = new Date()): string {
  const when = new Date(iso);
  const time = when
    .toLocaleTimeString("en-US", {
      timeZone: TZ,
      hour: "numeric",
      minute: "2-digit",
    })
    .replace("AM", "a.m.")
    .replace("PM", "p.m.");
  if (michiganDate(when) === michiganDate(now)) return `${time} today`;
  const day = when.toLocaleDateString("en-US", {
    timeZone: TZ,
    month: "short",
    day: "numeric",
  });
  return `${day} at ${time}`;
}

/** Ends a sentence with one period: "as of 7:42 a.m. today" gets one, "as of Oct 9 at 11:35 p.m." already has it. */
export function endSentence(text: string): string {
  return text.endsWith(".") ? text : `${text}.`;
}
