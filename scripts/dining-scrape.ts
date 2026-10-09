// ─────────────────────────────────────────────────────────────────────────────
// DINING SCRAPER: fetch South Pointe at Case's menus and hand them to the cache.
//
//   npm run dining:scrape -- --out menus.json      saves the result to a file (a dry run)
//   npm run dining:scrape -- --post                sends it to the site's /api/dining/ingest
//                                                  (needs INGEST_URL and INGEST_SECRET)
//
// Permission: MSU Dining authorized this access. MSU's menus are hosted by
// Nutrislice, whose terms prohibit automated access unless authorized.
// KEEP MSU DINING'S EMAIL on file. If they ever ask us to stop, stop.
//
// How it behaves (please keep it this way):
//   - It identifies itself honestly in its User-Agent, with the project link.
//   - It loads about 9 pages once a day, 2.5 seconds apart. Nothing else.
//   - It opens the pages a visitor would and reads the menu data the page itself
//     receives. It clicks the site's terms screen ("View Menus") like a visitor.
//   - If the site says no (HTTP 403, 429, 503), it STOPS. No retries, no workarounds.
//
// It needs Google Chrome (installed on GitHub's runners and most laptops).
// ─────────────────────────────────────────────────────────────────────────────

import { writeFileSync } from "node:fs";
import { chromium, type Page, type Response } from "playwright-core";
import { DINING_HALLS } from "../lib/skills/dining/cache";
import { mapHallInfo, mapWeek } from "../lib/skills/dining/nutrislice";
import { addDays, michiganDate } from "../lib/skills/dining/time";
import type { DiningMeal, DiningSnapshot } from "../lib/skills/dining/types";
import { validateSnapshot } from "../lib/skills/dining/validate";

const USER_AGENT =
  "AskSpartyBot/1.0 (student-built MSU assistant pilot, authorized by MSU Dining; +https://github.com/krishkevin2004-del/Spartan-AI)";
const PAUSE_MS = 2500;
const HALL_ID = "south-pointe-at-case";
const SLUG = "south-pointe-at-case";
const MEAL_TYPES: { name: string; slug: string }[] = [
  { name: "Breakfast", slug: "breakfast" },
  { name: "Lunch", slug: "lunch" },
  { name: "Dinner", slug: "dinner" },
  { name: "Late Night", slug: "late-night" },
];

class BlockedError extends Error {}

const args = process.argv.slice(2);
const outFile = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;
const doPost = args.includes("--post");
const log = (message: string) => console.log(`[dining-scrape] ${message}`);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Open one meal's page and return the menu data the page receives. The site may send a
 * first-time visitor to its terms screen a few seconds after loading; if so, click
 * "View Menus" (like a visitor would) and the page carries on to the menu.
 */
async function loadMenuWeek(page: Page, url: string, weekApi: RegExp): Promise<Response | null> {
  const data = page.waitForResponse((r) => weekApi.test(r.url()), { timeout: 45_000 });
  data.catch(() => undefined); // handled below; this just prevents an "unhandled rejection"
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });

  const first = await Promise.race([
    data.then((response) => ({ kind: "data" as const, response })),
    page.waitForURL(/menus-eula/, { timeout: 20_000 }).then(() => ({ kind: "terms" as const })),
  ]).catch(() => null);

  if (first?.kind === "data") return first.response;
  if (first?.kind === "terms") {
    await page.getByRole("button", { name: /view menus/i }).first().click();
    return data.catch(() => null); // after the click the page returns to the menu and loads it
  }
  return null;
}

// A hard stop, so a stuck page can never leave this running (or hammering the site).
setTimeout(() => {
  console.error("[dining-scrape] FAILED: took longer than 6 minutes, stopping");
  process.exit(1);
}, 6 * 60_000).unref();

async function main() {
  if (!outFile && !doPost) throw new Error("Pass --out <file> (dry run) and/or --post.");
  const hall = DINING_HALLS.find((h) => h.id === HALL_ID);
  if (!hall) throw new Error("hall not found in data/dining/halls.json");

  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome", headless: true });
  try {
    const context = await browser.newContext({ userAgent: USER_AGENT, viewport: { width: 1280, height: 1000 } });
    const page = await context.newPage();

    // Quietly remember the hall's own record (address, hours) when the page loads it.
    let school: unknown = null;
    page.on("response", async (res: Response) => {
      if (!/\/menu\/api\/schools\/(\?|$)/.test(res.url()) || !res.ok()) return;
      try {
        const body = await res.json();
        const list = Array.isArray(body) ? body : (body?.results ?? []);
        school = list.find((s: { slug?: string }) => s?.slug === SLUG) ?? school;
      } catch {
        // not JSON we understand: ignore
      }
    });

    const today = michiganDate();
    const days: DiningSnapshot["days"] = {};
    let pages = 0;

    for (const weekOffset of [0, 7]) {
      const anchor = addDays(today, weekOffset);
      for (const meal of MEAL_TYPES) {
        if (pages > 0) await pause(PAUSE_MS);
        const url = `${hall.menuUrl}/${meal.slug}/${anchor}`;
        const weekApi = new RegExp(`/menu/api/weeks/school/${SLUG}/menu-type/${meal.slug}/`);

        const response = await loadMenuWeek(page, url, weekApi);
        pages++;

        if (response && [403, 429, 503].includes(response.status())) {
          throw new BlockedError(`the site answered ${response.status()} for ${meal.name}; stopping as agreed`);
        }
        if (!response || !response.ok()) {
          log(`no menu data for ${meal.name}, week of ${anchor} (skipping)`);
          continue;
        }

        const byDate = mapWeek(await response.json(), addDays(today, -1));
        let count = 0;
        for (const [date, stations] of Object.entries(byDate)) {
          const day = (days[date] ??= { meals: [] });
          const entry: DiningMeal = { name: meal.name, stations };
          // The same week can be returned twice (this week and next); keep one copy of each meal per day.
          if (!day.meals.some((m) => m.name === meal.name)) day.meals.push(entry);
          count++;
        }
        log(`${meal.name}, week of ${anchor}: ${count} day(s) with a menu`);
      }
    }

    const snapshot = {
      hallId: HALL_ID,
      hallInfo: mapHallInfo(school),
      scrapedAt: new Date().toISOString(),
      source: hall.menuUrl,
      days,
    };

    // Same checks the server will run, so a bad scrape is caught here and never sent.
    const checked = validateSnapshot(snapshot, DINING_HALLS);
    if (!checked.ok) throw new Error(`scrape produced invalid data: ${checked.error}`);
    const dates = Object.keys(checked.snapshot.days).sort();
    if (dates.length === 0) throw new Error("scrape found no menus at all (not publishing nothing over the last good data)");
    log(`ready: ${dates.length} days (${dates[0]} to ${dates[dates.length - 1]}), hall info: ${JSON.stringify(checked.snapshot.hallInfo ?? {})}`);

    if (outFile) {
      writeFileSync(outFile, JSON.stringify(checked.snapshot, null, 1));
      log(`saved to ${outFile}`);
    }

    if (doPost) {
      const url = process.env.INGEST_URL;
      const secret = process.env.INGEST_SECRET;
      if (!url || !secret) throw new Error("--post needs INGEST_URL and INGEST_SECRET");
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
        body: JSON.stringify(checked.snapshot),
        signal: AbortSignal.timeout(30_000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`ingest answered ${res.status}: ${text.slice(0, 200)}`);
      log(`sent to the site: ${text}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(`[dining-scrape] FAILED: ${err instanceof Error ? err.message : err}`);
  process.exit(err instanceof BlockedError ? 3 : 1);
});
