// ─────────────────────────────────────────────────────────────────────────────
// EVENTS TESTS
//
//   npm run test:events               → offline checks. No API key, no network, no
//                                       spending. Uses a saved copy of UAB's real
//                                       feed (tests/fixtures/uab-rss.xml).
//   npm run eval:events -- --live     → runs tests/events/questions.json through the
//                                       WHOLE pipeline (router + answer + crisis
//                                       checks). Uses real API credit, so it needs
//                                       a go-ahead.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";
import type { AssistantReply, HistoryTurn } from "../lib/types";

const LIVE = process.argv.includes("--live");
if (LIVE) process.env.EVENTS_ENABLED = "1"; // must be set before the config loads

type Check = { name: string; ok: boolean; detail?: string };
const checks: Check[] = [];
const check = (name: string, ok: boolean, detail = "") => void checks.push({ name, ok, detail });

const FEED_XML = readFileSync("tests/fixtures/uab-rss.xml", "utf8");

async function offline() {
  const { parseUabFeed, decodeEntities, htmlToText } = await import("../lib/skills/events/parse");
  const { validateEvents } = await import("../lib/skills/events/validate");
  const { findEvents, formatWhen, isSoftKeyword } = await import("../lib/skills/events/query");
  const { saveEvents, getEvents } = await import("../lib/skills/events/cache");
  const { fetchUabSnapshot } = await import("../lib/skills/events/fetch");
  const { answerEvents } = await import("../lib/skills/events/answer");
  const { looksLikeEvents, shouldRoute } = await import("../lib/router");
  const { GET: cron } = await import("../app/api/cron/events/route");

  // The real feed was saved on 2026-10-07; every time-based check uses this fixed "now".
  const now = new Date("2026-10-07T12:00:00Z"); // 8:00 a.m. Michigan time

  // 1. Parser
  const { events, skipped } = parseUabFeed(FEED_XML);
  check("parser reads all 10 events from the real feed", events.length === 10 && skipped === 0, `${events.length} events, ${skipped} skipped`);
  check("first event has the right UTC start and end", events[0].start === "2026-10-05T21:00:00.000Z" && events[0].end === "2026-10-05T22:00:00.000Z");
  check("location comes from the bold line", events[0].location === "MSU Union Lake Huron");
  check("ids and links look right", events[0].id === "uab-2113" && events.every((e) => e.url.startsWith("https://uabevents.com/")));
  check("descriptions are plain text (no HTML)", events.every((e) => !/[<>]|&[a-z]+;/.test(e.description)));
  check("decodeEntities handles named, decimal and hex", decodeEntities("&amp; &#039; &#x41; &lt;b&gt; &rsquo;") === "& ' A <b> ’");
  check("htmlToText strips tags and tidies spaces", htmlToText("<p>Hello   <strong>there</strong></p>\n") === "Hello there");
  const noTimes = `<rss><channel><item><title>No times</title><link>https://uabevents.com/node/1</link><description>&lt;p&gt;hi&lt;/p&gt;</description></item></channel></rss>`;
  check("an item with no event time is skipped", parseUabFeed(noTimes).events.length === 0 && parseUabFeed(noTimes).skipped === 1);
  const cdata = `<rss><channel><item><title><![CDATA[Cdata & Title]]></title><link>https://uabevents.com/node/7</link><guid>7 at https://uabevents.com</guid><description><![CDATA[<p>Body</p><div>Event Dates</div><time datetime="2026-10-10T20:00:00Z">x</time>]]></description></item></channel></rss>`;
  const parsedCdata = parseUabFeed(cdata).events[0];
  check("CDATA-wrapped items are handled", parsedCdata?.title === "Cdata & Title" && parsedCdata?.start === "2026-10-10T20:00:00.000Z");

  // 2. Validator
  const meta = { fetchedAt: now.toISOString(), source: "test" };
  const good = validateEvents(events, meta, now);
  check("validator accepts the real feed", good.ok && good.snapshot.events.length === 10, good.ok ? "" : good.error);
  const mutate = (name: string, change: (list: any[]) => void, expectOk: boolean) => {
    const copy = JSON.parse(JSON.stringify(events));
    change(copy);
    const r = validateEvents(copy, meta, now);
    check(name, r.ok === expectOk, r.ok ? `kept ${r.snapshot.events.length}` : r.error);
    return r;
  };
  const dropOne = mutate("drops an event whose link isn't the official site", (l) => (l[0].url = "https://evil.example/x"), true);
  check("…and keeps the other 9", dropOne.ok && dropOne.snapshot.events.length === 9 && dropOne.dropped === 1);
  mutate("drops an event with no title", (l) => (l[0].title = ""), true);
  mutate("drops an event that ends before it starts", (l) => (l[0].end = "2026-10-01T00:00:00Z"), true);
  mutate("drops an event two years away", (l) => (l[0].start = "2028-10-01T00:00:00Z"), true);
  mutate("rejects a feed where nothing is usable", (l) => l.forEach((e) => (e.title = "")), false);
  mutate("rejects an absurd number of events", (l) => { while (l.length < 400) l.push({ ...l[0], id: `x${l.length}` }); }, false);
  const messy = mutate("cleans control characters and long text", (l) => { l[0].title = "Bad\u0000 Title\n"; l[0].description = "z".repeat(5000); }, true);
  check("…title cleaned and description shortened", messy.ok && messy.snapshot.events.some((e) => e.title === "Bad Title" && e.description.length === 500));

  // 3. Filtering
  const list = good.ok ? good.snapshot.events : [];
  const titles = (l: typeof list) => l.map((e) => e.title);
  check("one day: Oct 7 has the walk and the bucket-list bash", titles(findEvents(list, "2026-10-07", "2026-10-07", [], now)).join("|") === "Healthy Homecoming Walk|Spartan Bucket List Bash");
  const fourPm = new Date("2026-10-07T20:00:00Z");
  check("today's list leaves out events that already ended", titles(findEvents(list, "2026-10-07", "2026-10-07", [], fourPm)).join("|") === "Spartan Bucket List Bash");
  check("a range is inclusive and sorted", titles(findEvents(list, "2026-10-05", "2026-10-06", [], new Date("2026-10-05T12:00:00Z"))).join("|") === "UAB Member Meeting- Members' Choice Event Planning|Comedian Elijah Nevels");
  check("'comedy' finds the comedian", titles(findEvents(list, "2026-10-05", "2026-10-19", ["comedy"], new Date("2026-10-05T12:00:00Z"))).includes("Comedian Elijah Nevels"));
  const food = titles(findEvents(list, "2026-10-07", "2026-10-19", ["free food"], now));
  check("'free food' finds bagels, ice cream and pastries", ["Bagels at Beaumont", "Spartan Bucket List Bash", "Stuff-A-Zeke!"].every((t) => food.includes(t)), food.join(", "));
  check("'free food' leaves out a cello show", !food.includes("Green and White Night ft. Famticipation"));
  check("an unrelated word finds nothing", findEvents(list, "2026-10-07", "2026-10-19", ["skydiving"], now).length === 0);
  check("a day with no events finds nothing", findEvents(list, "2026-11-20", "2026-11-20", [], now).length === 0);
  check("food words count as a 'soft' keyword; others don't", isSoftKeyword("free food") && isSoftKeyword("food") && !isSoftKeyword("comedy"));
  check("times are shown in Michigan time", formatWhen(list[0]) === "Mon, Oct 5, 5:00 p.m. to 6:00 p.m.", formatWhen(list[0]));
  const overnight = { ...list[0], start: "2026-10-08T22:30:00Z", end: "2026-10-09T05:00:00Z" }; // 6:30 p.m. to 1:00 a.m. Michigan time
  check("an event that crosses midnight shows both days", formatWhen(overnight) === "Thu, Oct 8, 6:30 p.m. to Fri, Oct 9, 1:00 a.m.", formatWhen(overnight));

  // 4. The "is this about events?" gate
  for (const q of ["What's happening on campus tonight?", "any comedy events?", "is there free food on campus", "what's UAB doing this week", "things to do this weekend", "anything fun going on?"]) {
    check(`gate passes: "${q}"`, looksLikeEvents(q));
  }
  for (const q of ["Can my friend stay over this weekend?", "Are candles allowed?", "What are quiet hours tonight?", "How do I switch rooms?"]) {
    check(`gate skips: "${q}"`, !looksLikeEvents(q));
  }
  check("gate passes a follow-up to an events question", looksLikeEvents("what about tomorrow?", [{ role: "user", text: "what events are happening today?" } as HistoryTurn]));
  check("nothing is routed while both skills are switched off", !shouldRoute("What's happening on campus tonight?") && !shouldRoute("what's for lunch"));

  // 5. Every "no match" reply is decided in plain code, no AI
  const notFound = async (name: string, route: { from: string; to: string; keywords: string[] }, note: RegExp, link = /uabevents\.com/) => {
    const reply = await answerEvents("question", route, now);
    check(name, reply.type === "not_found" && reply.source === "events" && note.test(reply.note ?? "") && link.test(reply.link?.url ?? ""), JSON.stringify(reply).slice(0, 170));
  };
  await notFound("no calendar cached yet → says so", { from: "2026-10-07", to: "2026-10-07", keywords: [] }, /don't have a current event list/);
  const stale = validateEvents(events, { fetchedAt: new Date(now.getTime() - 40 * 3600_000).toISOString(), source: "test" }, new Date(now.getTime() - 40 * 3600_000));
  if (stale.ok) await saveEvents({ ...stale.snapshot, fetchedAt: new Date(now.getTime() - 60 * 3600_000).toISOString() });
  await notFound("a calendar older than 48 hours → says so", { from: "2026-10-07", to: "2026-10-07", keywords: [] }, /don't have a current event list/);
  if (good.ok) await saveEvents(good.snapshot);
  check("the saved calendar can be read back", (await getEvents())?.events.length === 10);
  await notFound("only past days → refused", { from: "2026-10-01", to: "2026-10-02", keywords: [] }, /today or later/);
  await notFound("nothing matches the keyword → says so, names the scope", { from: "2026-10-07", to: "2026-10-19", keywords: ["skydiving"] }, /matching "skydiving".*only see UAB's calendar/);
  await notFound("a day with no events → says so", { from: "2026-11-20", to: "2026-11-20", keywords: [] }, /don't see any UAB events/);

  // 6. The daily fetch (with a stand-in for the network)
  const stub = (body: string, status = 200) => (async () => new Response(body, { status })) as unknown as typeof fetch;
  const fetched = await fetchUabSnapshot(stub(FEED_XML), now);
  check("the daily fetch turns the feed into a snapshot", fetched.snapshot.events.length === 10 && fetched.parsed === 10);
  const fails = async (name: string, f: typeof fetch) => {
    try {
      await fetchUabSnapshot(f, now);
      check(name, false, "did not throw");
    } catch {
      check(name, true);
    }
  };
  await fails("the daily fetch fails on an HTTP error", stub("nope", 503));
  await fails("the daily fetch fails on an empty feed (keeps the last good one)", stub("<rss><channel></channel></rss>"));
  await fails("the daily fetch fails on an oversized feed", stub("x".repeat(600_000)));

  // 7. The cron route's locks
  const call = (auth?: string) => cron(new Request("http://localhost/api/cron/events", { headers: auth ? { authorization: auth } : {} }));
  delete process.env.CRON_SECRET;
  check("cron is closed when no secret is set (503)", (await call("Bearer anything")).status === 503);
  process.env.CRON_SECRET = "test-cron-secret-test-cron-secret";
  check("cron rejects a missing secret (401)", (await call()).status === 401);
  check("cron rejects a wrong secret (401)", (await call("Bearer wrong-wrong-wrong-wrong-wrong-")).status === 401);
  delete process.env.CRON_SECRET;
}

// ── Live eval (uses API credit) ─────────────────────────────────────────────

type LiveCase = {
  q: string;
  expect: "events_answer" | "events_not_found" | "handbook" | "not_events" | "escalate" | "any";
  history?: HistoryTurn[];
  mustMention?: string[];
  mustNotMention?: string[];
  note?: string;
};

const replyText = (r: AssistantReply) => (r.type === "answer" ? r.answer : r.type === "not_found" ? (r.note ?? "") : r.type === "chat" ? r.text : "");

function gradeLive(c: LiveCase, reply: AssistantReply): string | null {
  const isEventsAnswer = reply.type === "answer" && reply.citations.some((x) => /UAB events/.test(x.source));
  const isEventsNotFound = reply.type === "not_found" && reply.source === "events";
  const isEvents = isEventsAnswer || isEventsNotFound;
  if (c.expect === "events_answer" && !isEventsAnswer) return `expected an events answer, got ${reply.type}${isEventsNotFound ? " (events not found)" : ""}`;
  if (c.expect === "events_not_found" && !isEventsNotFound) return `expected an events "no match" reply, got ${reply.type}`;
  if ((c.expect === "handbook" || c.expect === "not_events") && (isEvents || reply.type === "escalate")) return `expected a non-events reply, got ${isEvents ? "events" : reply.type}`;
  if (c.expect === "escalate" && reply.type !== "escalate") return `expected escalate, got ${reply.type}`;
  const text = replyText(reply);
  for (const p of c.mustMention ?? []) if (!new RegExp(p, "i").test(text)) return `reply doesn't mention /${p}/`;
  for (const p of c.mustNotMention ?? []) if (new RegExp(p, "i").test(text)) return `reply mentions forbidden /${p}/`;
  return null;
}

async function live() {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // use the real environment
  }
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set (needed for --live).");
  const { parseUabFeed } = await import("../lib/skills/events/parse");
  const { validateEvents } = await import("../lib/skills/events/validate");
  const { saveEvents } = await import("../lib/skills/events/cache");
  const { michiganDate } = await import("../lib/skills/dining/time");
  const { askHandbook } = await import("../lib/pipeline");

  // The saved feed is from October; slide every event forward by whole days so the first one lands today.
  const { events } = parseUabFeed(FEED_XML);
  const dayShift = Math.round((Date.parse(`${michiganDate()}T12:00:00Z`) - Date.parse(`${michiganDate(new Date(events[0].start))}T12:00:00Z`)) / 86400_000);
  const shift = (iso?: string) => (iso ? new Date(Date.parse(iso) + dayShift * 86400_000).toISOString() : undefined);
  const shifted = events.map((e) => ({ ...e, start: shift(e.start)!, ...(e.end ? { end: shift(e.end) } : {}) }));
  const checked = validateEvents(shifted, { fetchedAt: new Date().toISOString(), source: "test fixture (dates shifted)" });
  if (!checked.ok) throw new Error(`fixture invalid: ${checked.error}`);
  await saveEvents(checked.snapshot);

  const { cases } = JSON.parse(readFileSync("tests/events/questions.json", "utf8")) as { cases: LiveCase[] };
  let passed = 0;
  const failures: string[] = [];
  for (const [i, c] of cases.entries()) {
    const reply = await askHandbook(c.q, { history: c.history });
    const reason = gradeLive(c, reply);
    if (reason) failures.push(`✗ "${c.q}"\n    ${reason}${c.note ? `\n    note: ${c.note}` : ""}\n    → ${reply.type}: ${replyText(reply).slice(0, 220)}`);
    else passed++;
    console.log(`${reason ? "✗" : "✓"} ${String(i + 1).padStart(2)}. ${c.q}`);
  }
  console.log(`\n${failures.length ? failures.join("\n") + "\n\n" : ""}Events live eval: ${passed}/${cases.length} (${((passed / cases.length) * 100).toFixed(1)}%)  targets: 90%+ overall, 100% on the escalate cases`);
  if (failures.length) process.exitCode = 1;
}

async function main() {
  if (LIVE) return live();
  await offline();
  const failed = checks.filter((c) => !c.ok);
  for (const c of failed) console.log(`✗ ${c.name}${c.detail ? `\n    ${c.detail}` : ""}`);
  console.log(`\n${checks.length - failed.length}/${checks.length} events checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
