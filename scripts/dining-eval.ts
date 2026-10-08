// ─────────────────────────────────────────────────────────────────────────────
// DINING TESTS
//
//   npm run test:dining               → offline checks. No API key, no network, no
//                                       spending. Covers the validator, the cache,
//                                       the filters, date/meal logic, the "is this
//                                       about food?" gate, every "no data" reply,
//                                       and the update endpoint's locks.
//   npm run eval:dining -- --live     → runs tests/dining/questions.json through the
//                                       WHOLE pipeline (router + answer + crisis
//                                       checks) against the FAKE sample menu. Uses
//                                       real API credit, so it needs a go-ahead.
//
// Nothing here touches real menu data: tests/fixtures/dining-fake.json is
// invented ("Sample Cheeseburger", ...).
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";
import type { AssistantReply, HistoryTurn } from "../lib/types";

const LIVE = process.argv.includes("--live");
if (LIVE) process.env.DINING_ENABLED = "1"; // must be set before the config loads

type Check = { name: string; ok: boolean; detail?: string };
const checks: Check[] = [];
function check(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok, detail });
}

// ── Shared helpers ──────────────────────────────────────────────────────────

const rawFixture = JSON.parse(readFileSync("tests/fixtures/dining-fake.json", "utf8"));

/** The fake menu with "+0" / "+1" turned into real dates, as if fetched 5 minutes ago. */
async function fixtureSnapshot(now: Date = new Date()) {
  const { addDays, michiganDate } = await import("../lib/skills/dining/time");
  const today = michiganDate(now);
  const days: Record<string, unknown> = {};
  for (const [offset, day] of Object.entries(rawFixture.days)) days[addDays(today, Number(offset))] = day;
  return {
    hallId: rawFixture.hallId,
    source: rawFixture.source,
    scrapedAt: new Date(now.getTime() - 5 * 60_000).toISOString(),
    days,
  };
}

// ── Offline tests ───────────────────────────────────────────────────────────

async function offline() {
  const { validateSnapshot } = await import("../lib/skills/dining/validate");
  const { DINING_HALLS, saveSnapshot, getDay, getMeta } = await import("../lib/skills/dining/cache");
  const { filterDay } = await import("../lib/skills/dining/query");
  const t = await import("../lib/skills/dining/time");
  const { looksLikeDining } = await import("../lib/router");
  const { answerDining } = await import("../lib/skills/dining/answer");
  const { POST: ingest } = await import("../app/api/dining/ingest/route");

  const now = new Date();
  const snapshot = await fixtureSnapshot(now);
  const today = t.michiganDate(now);

  // 1. Validator: good data in, bad data out
  const good = validateSnapshot(snapshot, DINING_HALLS, now);
  check("validator accepts the sample menu", good.ok, good.ok ? "" : good.error);
  const bad = (name: string, mutate: (s: any) => void) => {
    const copy = JSON.parse(JSON.stringify(snapshot));
    mutate(copy);
    check(`validator rejects: ${name}`, !validateSnapshot(copy, DINING_HALLS, now).ok);
  };
  bad("unknown hall", (s) => (s.hallId = "some-other-hall"));
  bad("scrapedAt in the future", (s) => (s.scrapedAt = new Date(now.getTime() + 3600_000).toISOString()));
  bad("scrapedAt 3 days old", (s) => (s.scrapedAt = new Date(now.getTime() - 3 * 86400_000).toISOString()));
  bad("date key that isn't a date", (s) => (s.days["2026-02-30"] = s.days[Object.keys(s.days)[0]]));
  bad("date a year away", (s) => (s.days["2031-01-01"] = s.days[Object.keys(s.days)[0]]));
  bad("meals that aren't a list", (s) => (s.days[Object.keys(s.days)[0]].meals = "lots"));
  bad("an item with no name", (s) => (s.days[Object.keys(s.days)[0]].meals[0].stations[0].items[0].name = ""));
  bad("a 500-character dish name", (s) => (s.days[Object.keys(s.days)[0]].meals[0].stations[0].items[0].name = "x".repeat(500)));
  bad("too many items in a station", (s) => {
    s.days[Object.keys(s.days)[0]].meals[0].stations[0].items = Array.from({ length: 200 }, (_, i) => ({ name: `Dish ${i}` }));
  });
  bad("labels that aren't a list", (s) => (s.days[Object.keys(s.days)[0]].meals[0].stations[0].items[0].tags = "vegan"));
  const dirty = JSON.parse(JSON.stringify(snapshot));
  dirty.days[Object.keys(dirty.days)[0]].meals[0].stations[0].items[0].name = "Sample\u0000 Dish\n\n  Name";
  const cleaned = validateSnapshot(dirty, DINING_HALLS, now);
  check(
    "validator strips control characters",
    cleaned.ok && cleaned.snapshot.days[Object.keys(dirty.days)[0]].meals[0].stations[0].items[0].name === "Sample Dish Name",
  );

  // 2. Cache round trip
  if (good.ok) await saveSnapshot(good.snapshot);
  const savedToday = await getDay("south-pointe-at-case", today);
  check("cache returns today's saved menu", Boolean(savedToday && savedToday.meals.length === 3));
  check("cache returns nothing for a day that was never saved", (await getDay("south-pointe-at-case", t.addDays(today, 2))) === null);
  const meta = await getMeta("south-pointe-at-case");
  check("cache remembers when the menu was fetched", Boolean(meta && meta.source.includes("FAKE")));

  // 3. Filters
  const day = savedToday!;
  const names = (blocks: ReturnType<typeof filterDay>) => blocks.flatMap((b) => b.items.map((i) => i.name));
  check("lunch + pizza finds both pizzas", names(filterDay(day, "lunch", ["pizza"])).length === 2);
  check("breakfast shows only breakfast stations", filterDay(day, "breakfast", []).every((b) => b.meal === "Breakfast"));
  check("'vegan' matches posted labels", names(filterDay(day, "lunch", ["vegan"])).sort().join() === "Sample Basmati Rice,Sample Veggie Burger");
  check("'burgers' matches 'burger' (plural)", names(filterDay(day, "lunch", ["burgers"])).length === 2);
  check("'indian' matches the description", names(filterDay(day, "any", ["indian"])).join() === "Sample Chicken Tikka Masala");
  check("an unlisted food finds nothing", filterDay(day, "any", ["sushi"]).length === 0);
  check("meal 'any' covers every meal", new Set(filterDay(day, "any", []).map((b) => b.meal)).size === 3);
  check("brunch would count as lunch", filterDay({ meals: [{ name: "Brunch", stations: [{ name: "X", items: [{ name: "Y" }] }] }] }, "lunch", []).length === 1);

  // 4. Dates and meals
  check("addDays crosses a month end", t.addDays("2026-10-31", 1) === "2026-11-01");
  check("isValidDate rejects Feb 30", !t.isValidDate("2026-02-30") && t.isValidDate("2026-02-28"));
  const at = (iso: string) => new Date(iso); // EDT is UTC-4 in October
  check("8:00 a.m. is breakfast", t.currentMeal(at("2026-10-08T12:00:00Z")) === "breakfast");
  check("12:30 p.m. is lunch", t.currentMeal(at("2026-10-08T16:30:00Z")) === "lunch");
  check("6:00 p.m. is dinner", t.currentMeal(at("2026-10-08T22:00:00Z")) === "dinner");
  check("'as of' says 'today' for a same-day fetch", t.describeAsOf(new Date(now.getTime() - 60_000).toISOString(), now).endsWith("today"));

  // 5. The "is this about food?" gate (saves a Claude call on every other question)
  for (const q of ["What's for lunch today?", "where can I get pizza", "any vegan options", "is the dining hall open", "I'm hungry"]) {
    check(`gate passes: "${q}"`, looksLikeDining(q));
  }
  for (const q of ["Can my friend stay over?", "How do I switch rooms?", "Are candles allowed?", "I'm locked out", "What are quiet hours?"]) {
    check(`gate skips: "${q}"`, !looksLikeDining(q));
  }
  const foodHistory: HistoryTurn[] = [{ role: "user", text: "What's for lunch today?" }];
  check("gate passes a follow-up to a food question", looksLikeDining("what about tomorrow?", foodHistory));
  check("gate skips the same follow-up without a food question before it", !looksLikeDining("what about tomorrow?", []));

  // 6. Every "no data" reply is decided in plain code, no AI involved
  const route = (r: Partial<{ hall: any; meal: any; date: string; keywords: string[] }>) => ({
    hall: "south_pointe_at_case" as const,
    meal: "lunch" as const,
    date: "",
    keywords: [] as string[],
    ...r,
  });
  const nf = async (name: string, r: Parameters<typeof route>[0], expectLink: RegExp, expectNote: RegExp) => {
    const reply = await answerDining("question", route(r), now);
    check(
      name,
      reply.type === "not_found" && reply.source === "dining" && expectLink.test(reply.link?.url ?? "") && expectNote.test(reply.note ?? ""),
      JSON.stringify(reply).slice(0, 160),
    );
  };
  await nf("other hall → says v1 has one hall, links to the hub", { hall: "other_hall" }, /eatatstate\.msu\.edu/, /only have South Pointe/);
  await nf("a day with no data → says so, links to the menu", { date: t.addDays(today, 2) }, /south-pointe-at-case/, /don't have South Pointe at Case's menu/);
  await nf("a food that isn't served → says so", { keywords: ["sushi"] }, /south-pointe-at-case/, /anything matching "sushi"/);
  await nf("a day long past → refused", { date: t.addDays(today, -5) }, /south-pointe-at-case/, /today's menu and upcoming/);
  await nf("a meal that isn't on the menu → says so", { date: t.addDays(today, 1), meal: "breakfast" }, /south-pointe-at-case/, /breakfast menu/);

  // 7. The update endpoint's locks
  const post = (body: unknown, auth?: string) =>
    ingest(
      new Request("http://localhost/api/dining/ingest", {
        method: "POST",
        headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
  delete process.env.INGEST_SECRET;
  check("ingest is closed when no secret is set (503)", (await post(snapshot, "Bearer anything")).status === 503);
  process.env.INGEST_SECRET = "test-secret-test-secret-test-secret";
  check("ingest rejects a missing secret (401)", (await post(snapshot)).status === 401);
  check("ingest rejects a wrong secret (401)", (await post(snapshot, "Bearer wrong-wrong-wrong-wrong-wrong-")).status === 401);
  check("ingest rejects bad JSON (400)", (await post("not json", "Bearer test-secret-test-secret-test-secret")).status === 400);
  check("ingest rejects invalid menus (422)", (await post({ ...snapshot, hallId: "nope" }, "Bearer test-secret-test-secret-test-secret")).status === 422);
  const okResponse = await post(snapshot, "Bearer test-secret-test-secret-test-secret");
  check("ingest accepts a valid menu (200)", okResponse.status === 200, String(okResponse.status));
  delete process.env.INGEST_SECRET;
}

// ── Live eval (uses API credit) ─────────────────────────────────────────────

type LiveCase = {
  q: string;
  expect: "dining_answer" | "dining_not_found" | "handbook" | "not_dining" | "escalate" | "any";
  history?: HistoryTurn[];
  mustMention?: string[];
  mustNotMention?: string[];
  note?: string;
};

function replyText(reply: AssistantReply): string {
  if (reply.type === "answer") return reply.answer;
  if (reply.type === "not_found") return reply.note ?? "";
  if (reply.type === "chat") return reply.text;
  return "";
}

function gradeLive(c: LiveCase, reply: AssistantReply): string | null {
  const isDiningAnswer = reply.type === "answer" && reply.citations.some((x) => /South Pointe/.test(x.source));
  const isDiningNotFound = reply.type === "not_found" && reply.source === "dining";
  const isDining = isDiningAnswer || isDiningNotFound;
  if (c.expect === "dining_answer" && !isDiningAnswer) return `expected a dining answer, got ${reply.type}${isDiningNotFound ? " (dining not found)" : ""}`;
  if (c.expect === "dining_not_found" && !isDiningNotFound) return `expected a dining "no data" reply, got ${reply.type}`;
  if (c.expect === "handbook" && (isDining || reply.type === "escalate")) return `expected the handbook flow, got ${isDining ? "dining" : reply.type}`;
  if (c.expect === "not_dining" && (isDining || reply.type === "escalate")) return `expected a non-dining reply, got ${isDining ? "dining" : reply.type}`;
  if (c.expect === "escalate" && reply.type !== "escalate") return `expected escalate, got ${reply.type}`;
  const text = replyText(reply);
  for (const pattern of c.mustMention ?? []) if (!new RegExp(pattern, "i").test(text)) return `reply doesn't mention /${pattern}/`;
  for (const pattern of c.mustNotMention ?? []) if (new RegExp(pattern, "i").test(text)) return `reply mentions forbidden /${pattern}/`;
  return null;
}

async function live() {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // use the real environment
  }
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set (needed for --live).");
  const { validateSnapshot } = await import("../lib/skills/dining/validate");
  const { DINING_HALLS, saveSnapshot } = await import("../lib/skills/dining/cache");
  const { askHandbook } = await import("../lib/pipeline");

  const checked = validateSnapshot(await fixtureSnapshot(), DINING_HALLS);
  if (!checked.ok) throw new Error(`fixture invalid: ${checked.error}`);
  await saveSnapshot(checked.snapshot);

  const { cases } = JSON.parse(readFileSync("tests/dining/questions.json", "utf8")) as { cases: LiveCase[] };
  let passed = 0;
  const failures: string[] = [];
  for (const [i, c] of cases.entries()) {
    const reply = await askHandbook(c.q, { history: c.history });
    const reason = gradeLive(c, reply);
    if (reason) failures.push(`✗ "${c.q}"\n    ${reason}${c.note ? `\n    note: ${c.note}` : ""}\n    → ${reply.type}: ${replyText(reply).slice(0, 220)}`);
    else passed++;
    console.log(`${reason ? "✗" : "✓"} ${String(i + 1).padStart(2)}. ${c.q}`);
  }
  console.log(`\n${failures.length ? failures.join("\n") + "\n\n" : ""}Dining live eval: ${passed}/${cases.length} (${((passed / cases.length) * 100).toFixed(1)}%)  targets: 90%+ overall, 100% on the escalate cases`);
  if (failures.length) process.exitCode = 1;
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function main() {
  if (LIVE) return live();
  await offline();
  const failed = checks.filter((c) => !c.ok);
  for (const c of failed) console.log(`✗ ${c.name}${c.detail ? `\n    ${c.detail}` : ""}`);
  console.log(`\n${checks.length - failed.length}/${checks.length} dining checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
