// ─────────────────────────────────────────────────────────────────────────────
// DINING SCRAPER: fetch every dining hall's menus and hand them to the cache.
//
//   npm run dining:scrape -- --out-dir menus --only the-edge-at-akers   a dry run: one hall, saved to files
//   npm run dining:scrape -- --post                                     every hall, sent to /api/dining/ingest
//                                                                       (needs INGEST_URL and INGEST_SECRET)
//
// Permission: MSU Dining authorized this access. MSU's menus are hosted by
// Nutrislice, whose terms prohibit automated access unless authorized.
// KEEP MSU DINING'S EMAIL on file. If they ever ask us to stop, stop.
//
// How it behaves (please keep it this way):
//   - It identifies itself honestly in its User-Agent, with the project link.
//   - It loads about 50 pages once a day, 2.5 seconds apart. Nothing else.
//   - It opens the pages a visitor would and reads the menu data the page itself
//     receives. It clicks the site's terms screen ("View Menus") like a visitor.
//   - Each hall is sent as soon as it's done, so one hall failing never loses the rest.
//   - If the site says no (HTTP 403, 429, 503), it STOPS. No retries, no workarounds.
//
// It needs Google Chrome (installed on GitHub's runners and most laptops).
// ─────────────────────────────────────────────────────────────────────────────

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page, type Response } from "playwright-core";
import { DINING_HALLS } from "../lib/skills/dining/cache";
import { mapHallInfo, mapWeek, mealTypesFor } from "../lib/skills/dining/nutrislice";
import { addDays, michiganDate } from "../lib/skills/dining/time";
import type { DiningHall, DiningMeal, DiningSnapshot } from "../lib/skills/dining/types";
import { validateSnapshot } from "../lib/skills/dining/validate";

const USER_AGENT =
  "AskSpartyBot/1.0 (student-built MSU assistant pilot, authorized by MSU Dining; +https://github.com/krishkevin2004-del/Spartan-AI)";
const PAUSE_MS = 2500;
const SCHOOLS_API = /\/menu\/api\/schools\/(\?|$)/;

class BlockedError extends Error {}

const args = process.argv.slice(2);
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const outDir = flag("--out-dir");
const onlyHall = flag("--only");
const doPost = args.includes("--post");
const log = (message: string) => console.log(`[dining-scrape] ${message}`);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A hard stop, so a stuck page can never leave this running (or hammering the site).
setTimeout(() => {
  console.error("[dining-scrape] FAILED: took longer than 15 minutes, stopping");
  process.exit(1);
}, 15 * 60_000).unref();

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

/** One hall: every meal it serves, this week and next. Returns the snapshot to send. */
async function scrapeHall(
  page: Page,
  hall: DiningHall,
  record: Record<string, unknown>,
  today: string,
  pageCount: { n: number },
): Promise<DiningSnapshot> {
  const mealTypes = mealTypesFor(record);
  if (mealTypes.length === 0) throw new Error("no meal types listed for this hall");

  const days: DiningSnapshot["days"] = {};
  for (const weekOffset of [0, 7]) {
    const anchor = addDays(today, weekOffset);
    for (const meal of mealTypes) {
      if (pageCount.n > 0) await pause(PAUSE_MS);
      const weekApi = new RegExp(`/menu/api/weeks/school/${hall.id}/menu-type/${meal.slug}/`);
      const response = await loadMenuWeek(page, `${hall.menuUrl}/${meal.slug}/${anchor}`, weekApi);
      pageCount.n++;

      if (response && [403, 429, 503].includes(response.status())) {
        throw new BlockedError(`the site answered ${response.status()} (${hall.name}, ${meal.name}); stopping as agreed`);
      }
      if (!response || !response.ok()) {
        log(`  ${hall.name}: no data for ${meal.name}, week of ${anchor} (skipping)`);
        continue;
      }

      const byDate = mapWeek(await response.json(), addDays(today, -1));
      for (const [date, stations] of Object.entries(byDate)) {
        const day = (days[date] ??= { meals: [] });
        const entry: DiningMeal = { name: meal.name, stations };
        // The same week can come back twice; keep one copy of each meal per day.
        if (!day.meals.some((m) => m.name === meal.name)) day.meals.push(entry);
      }
    }
  }

  return {
    hallId: hall.id,
    hallInfo: mapHallInfo(record),
    scrapedAt: new Date().toISOString(),
    source: hall.menuUrl,
    days,
  };
}

async function main() {
  if (!outDir && !doPost) throw new Error("Pass --out-dir <folder> (dry run) and/or --post.");
  const halls = DINING_HALLS.filter((h) => h.enabled && (!onlyHall || h.id === onlyHall));
  if (halls.length === 0) throw new Error(`no hall to scrape${onlyHall ? ` named ${onlyHall}` : ""}`);
  if (outDir) mkdirSync(outDir, { recursive: true });
  if (doPost && (!process.env.INGEST_URL || !process.env.INGEST_SECRET)) {
    throw new Error("--post needs INGEST_URL and INGEST_SECRET");
  }

  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome", headless: true });
  const failed: string[] = [];
  try {
    const context = await browser.newContext({ userAgent: USER_AGENT, viewport: { width: 1280, height: 1000 } });
    const page = await context.newPage();

    // The platform's own list of locations (name, address, hours, meals). The page loads it on any visit.
    const records = new Map<string, Record<string, unknown>>();
    const schoolsLoaded = page.waitForResponse((r) => SCHOOLS_API.test(r.url()), { timeout: 45_000 });
    page.on("response", async (res) => {
      if (!SCHOOLS_API.test(res.url()) || !res.ok()) return;
      try {
        const body = await res.json();
        for (const s of Array.isArray(body) ? body : (body?.results ?? [])) if (s?.slug) records.set(s.slug, s);
      } catch {
        // not JSON we understand: ignore
      }
    });
    await page.goto(halls[0].menuUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await schoolsLoaded.catch(() => null);
    await pause(1500); // let the response handler above finish reading it
    if (records.size === 0) throw new Error("couldn't read the list of dining locations");
    log(`found ${records.size} locations; scraping ${halls.length} dining hall(s)`);

    const today = michiganDate();
    const pageCount = { n: 0 };
    for (const hall of halls) {
      const record = records.get(hall.id);
      if (!record) {
        log(`${hall.name}: not in the platform's location list (skipping)`);
        failed.push(hall.id);
        continue;
      }
      try {
        const snapshot = await scrapeHall(page, hall, record, today, pageCount);

        // The same checks the server will run, so a bad scrape is caught here and never sent.
        const checked = validateSnapshot(snapshot, DINING_HALLS);
        if (!checked.ok) throw new Error(`invalid data: ${checked.error}`);
        const dates = Object.keys(checked.snapshot.days).sort();
        if (dates.length === 0) throw new Error("no menus found (not publishing nothing over the last good data)");
        log(`${hall.name}: ${dates.length} days (${dates[0]} to ${dates[dates.length - 1]}), hours: ${checked.snapshot.hallInfo?.hours ?? "not posted"}`);

        if (outDir) writeFileSync(join(outDir, `${hall.id}.json`), JSON.stringify(checked.snapshot, null, 1));
        if (doPost) {
          const res = await fetch(process.env.INGEST_URL as string, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${process.env.INGEST_SECRET}` },
            body: JSON.stringify(checked.snapshot),
            signal: AbortSignal.timeout(30_000),
          });
          const text = await res.text();
          if (!res.ok) throw new Error(`ingest answered ${res.status}: ${text.slice(0, 160)}`);
          log(`  sent: ${text}`);
        }
      } catch (err) {
        if (err instanceof BlockedError) throw err;
        log(`${hall.name}: FAILED: ${err instanceof Error ? err.message : err}`);
        failed.push(hall.id);
      }
    }
    log(`done: ${pageCount.n} page loads, ${halls.length - failed.length} of ${halls.length} halls updated`);
  } finally {
    await browser.close();
  }
  if (failed.length > 0) throw new Error(`these halls did not update: ${failed.join(", ")}`);
}

main().catch((err) => {
  console.error(`[dining-scrape] FAILED: ${err instanceof Error ? err.message : err}`);
  process.exit(err instanceof BlockedError ? 3 : 1);
});
