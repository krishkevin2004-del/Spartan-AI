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

const rawFixture = JSON.parse(
  readFileSync("tests/fixtures/dining-fake.json", "utf8"),
);

/** The fake menu with "+0" / "+1" turned into real dates, as if fetched 5 minutes ago. */
async function fixtureSnapshot(now: Date = new Date()) {
  const { addDays, michiganDate } = await import("../lib/skills/dining/time");
  const today = michiganDate(now);
  const days: Record<string, unknown> = {};
  for (const [offset, day] of Object.entries(rawFixture.days))
    days[addDays(today, Number(offset))] = day;
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
  const { DINING_HALLS, saveSnapshot, getDay, getMeta } =
    await import("../lib/skills/dining/cache");
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
  check(
    "validator accepts the sample menu",
    good.ok,
    good.ok ? "" : good.error,
  );
  const bad = (name: string, mutate: (s: any) => void) => {
    const copy = JSON.parse(JSON.stringify(snapshot));
    mutate(copy);
    check(
      `validator rejects: ${name}`,
      !validateSnapshot(copy, DINING_HALLS, now).ok,
    );
  };
  bad("unknown hall", (s) => (s.hallId = "some-other-hall"));
  bad(
    "scrapedAt in the future",
    (s) => (s.scrapedAt = new Date(now.getTime() + 3600_000).toISOString()),
  );
  bad(
    "scrapedAt 3 days old",
    (s) =>
      (s.scrapedAt = new Date(now.getTime() - 3 * 86400_000).toISOString()),
  );
  bad(
    "date key that isn't a date",
    (s) => (s.days["2026-02-30"] = s.days[Object.keys(s.days)[0]]),
  );
  bad(
    "date a year away",
    (s) => (s.days["2031-01-01"] = s.days[Object.keys(s.days)[0]]),
  );
  bad(
    "meals that aren't a list",
    (s) => (s.days[Object.keys(s.days)[0]].meals = "lots"),
  );
  bad(
    "an item with no name",
    (s) =>
      (s.days[Object.keys(s.days)[0]].meals[0].stations[0].items[0].name = ""),
  );
  bad(
    "a 500-character dish name",
    (s) =>
      (s.days[Object.keys(s.days)[0]].meals[0].stations[0].items[0].name =
        "x".repeat(500)),
  );
  bad("too many items in a station", (s) => {
    s.days[Object.keys(s.days)[0]].meals[0].stations[0].items = Array.from(
      { length: 200 },
      (_, i) => ({ name: `Dish ${i}` }),
    );
  });
  bad(
    "labels that aren't a list",
    (s) =>
      (s.days[Object.keys(s.days)[0]].meals[0].stations[0].items[0].tags =
        "vegan"),
  );
  const dirty = JSON.parse(JSON.stringify(snapshot));
  dirty.days[Object.keys(dirty.days)[0]].meals[0].stations[0].items[0].name =
    "Sample\u0000 Dish\n\n  Name";
  const cleaned = validateSnapshot(dirty, DINING_HALLS, now);
  check(
    "validator strips control characters",
    cleaned.ok &&
      cleaned.snapshot.days[Object.keys(dirty.days)[0]].meals[0].stations[0]
        .items[0].name === "Sample Dish Name",
  );

  // 2. Cache round trip
  if (good.ok) await saveSnapshot(good.snapshot);
  const savedToday = await getDay("south-pointe-at-case", today);
  check(
    "cache returns today's saved menu",
    Boolean(savedToday && savedToday.meals.length === 3),
  );
  check(
    "cache returns nothing for a day that was never saved",
    (await getDay("south-pointe-at-case", t.addDays(today, 2))) === null,
  );
  const meta = await getMeta("south-pointe-at-case");
  check(
    "cache remembers when the menu was fetched",
    Boolean(meta && meta.source.includes("FAKE")),
  );

  // 3. Filters
  const day = savedToday!;
  const names = (blocks: ReturnType<typeof filterDay>) =>
    blocks.flatMap((b) => b.items.map((i) => i.name));
  check(
    "lunch + pizza finds both pizzas",
    names(filterDay(day, "lunch", ["pizza"])).length === 2,
  );
  check(
    "breakfast shows only breakfast stations",
    filterDay(day, "breakfast", []).every((b) => b.meal === "Breakfast"),
  );
  check(
    "'vegan' matches posted labels",
    names(filterDay(day, "lunch", ["vegan"]))
      .sort()
      .join() === "Sample Basmati Rice,Sample Veggie Burger",
  );
  check(
    "'burgers' matches 'burger' (plural)",
    names(filterDay(day, "lunch", ["burgers"])).length === 2,
  );
  check(
    "'indian' matches the description",
    names(filterDay(day, "any", ["indian"])).join() ===
      "Sample Chicken Tikka Masala",
  );
  check(
    "an unlisted food finds nothing",
    filterDay(day, "any", ["sushi"]).length === 0,
  );
  check(
    "meal 'any' covers every meal",
    new Set(filterDay(day, "any", []).map((b) => b.meal)).size === 3,
  );
  check(
    "brunch would count as lunch",
    filterDay(
      {
        meals: [
          { name: "Brunch", stations: [{ name: "X", items: [{ name: "Y" }] }] },
        ],
      },
      "lunch",
      [],
    ).length === 1,
  );

  // 4. Dates and meals
  check(
    "addDays crosses a month end",
    t.addDays("2026-10-31", 1) === "2026-11-01",
  );
  check(
    "isValidDate rejects Feb 30",
    !t.isValidDate("2026-02-30") && t.isValidDate("2026-02-28"),
  );
  const at = (iso: string) => new Date(iso); // EDT is UTC-4 in October
  check(
    "8:00 a.m. is breakfast",
    t.currentMeal(at("2026-10-08T12:00:00Z")) === "breakfast",
  );
  check(
    "12:30 p.m. is lunch",
    t.currentMeal(at("2026-10-08T16:30:00Z")) === "lunch",
  );
  check(
    "6:00 p.m. is dinner",
    t.currentMeal(at("2026-10-08T22:00:00Z")) === "dinner",
  );
  check(
    "'as of' says 'today' for a same-day fetch",
    t
      .describeAsOf(new Date(now.getTime() - 60_000).toISOString(), now)
      .endsWith("today"),
  );

  // 5. The "is this about food?" gate (saves a Claude call on every other question)
  for (const q of [
    "What's for lunch today?",
    "where can I get pizza",
    "any vegan options",
    "is the dining hall open",
    "I'm hungry",
  ]) {
    check(`gate passes: "${q}"`, looksLikeDining(q));
  }
  for (const q of [
    "Can my friend stay over?",
    "How do I switch rooms?",
    "Are candles allowed?",
    "I'm locked out",
    "What are quiet hours?",
  ]) {
    check(`gate skips: "${q}"`, !looksLikeDining(q));
  }
  const foodHistory: HistoryTurn[] = [
    { role: "user", text: "What's for lunch today?" },
  ];
  check(
    "gate passes a follow-up to a food question",
    looksLikeDining("what about tomorrow?", foodHistory),
  );
  check(
    "gate skips the same follow-up without a food question before it",
    !looksLikeDining("what about tomorrow?", []),
  );

  // 6. Every "no data" reply is decided in plain code, no AI involved
  const route = (
    r: Partial<{ hall: any; meal: any; date: string; keywords: string[] }>,
  ) => ({
    hall: "south-pointe-at-case" as const,
    meal: "lunch" as const,
    date: "",
    keywords: [] as string[],
    ...r,
  });
  const nf = async (
    name: string,
    r: Parameters<typeof route>[0],
    expectLink: RegExp,
    expectNote: RegExp,
  ) => {
    const reply = await answerDining("question", route(r), now);
    check(
      name,
      reply.type === "not_found" &&
        reply.source === "dining" &&
        expectLink.test(reply.link?.url ?? "") &&
        expectNote.test(reply.note ?? ""),
      JSON.stringify(reply).slice(0, 160),
    );
  };
  await nf(
    "other hall → says v1 has one hall, links to the hub",
    { hall: "other_hall" },
    /eatatstate\.msu\.edu/,
    /I have menus for the residence dining halls/,
  );
  await nf(
    "a day with no data → says so, links to the menu",
    { date: t.addDays(today, 2) },
    /south-pointe-at-case/,
    /don't have South Pointe at Case's menu/,
  );
  await nf(
    "a food that isn't served → says so",
    { keywords: ["sushi"] },
    /south-pointe-at-case/,
    /anything matching "sushi"/,
  );
  await nf(
    "a day long past → refused",
    { date: t.addDays(today, -5) },
    /south-pointe-at-case/,
    /today's menu and upcoming/,
  );
  await nf(
    "a meal that isn't on the menu → says so",
    { date: t.addDays(today, 1), meal: "breakfast" },
    /south-pointe-at-case/,
    /breakfast menu/,
  );

  // 7. The Nutrislice mapper, tested on trimmed real samples of the platform's own data
  const { mapWeek, mapHallInfo, describeHours, tidyStationName } =
    await import("../lib/skills/dining/nutrislice");
  const week = JSON.parse(
    readFileSync("tests/fixtures/nutrislice-week.json", "utf8"),
  );
  const school = JSON.parse(
    readFileSync("tests/fixtures/nutrislice-school.json", "utf8"),
  ).school;
  const mapped = mapWeek(week, "2026-10-09");
  check(
    "mapper keeps the days that have menus and skips the unpublished one",
    Object.keys(mapped).join() === "2026-10-09,2026-10-10",
    Object.keys(mapped).join(),
  );
  check(
    "mapper drops days before 'since'",
    Object.keys(mapWeek(week, "2026-10-10")).join() === "2026-10-10",
  );
  const stationNames = mapped["2026-10-09"].map((st) => st.name);
  check(
    "stations get tidy names with their sub-heading",
    stationNames.includes("Brimstone · Sandwiches") &&
      stationNames.includes("Bliss · Desserts"),
    stationNames.slice(0, 5).join(", "),
  );
  check(
    "no station name is left in ALL CAPS",
    stationNames.every((n) => n !== n.toUpperCase() || /\d/.test(n)),
  );
  const items = mapped["2026-10-09"].flatMap((st) => st.items);
  const find = (name: string) => items.find((i) => i.name === name);
  check(
    "'contains' icons become allergen labels",
    Boolean(
      find("Cheeseburger")?.allergens?.includes("milk") &&
      find("Cheeseburger")?.allergens?.includes("beef"),
    ),
  );
  check(
    "dietary icons become tags",
    Boolean(find("Black Bean Burger")?.tags?.includes("vegan")),
  );
  check(
    "a dish with no icons has no labels",
    find("Case Brimstone Toppings")?.tags?.length === 0 &&
      find("Case Brimstone Toppings")?.allergens?.length === 0,
  );
  check(
    "mapper survives garbage",
    Object.keys(mapWeek(null, "2026-10-01")).length === 0 &&
      Object.keys(
        mapWeek(
          {
            days: [
              { date: "2026-10-09", menu_items: [{ food: { name: 5 } }, null] },
            ],
          },
          "2026-10-01",
        ),
      ).length === 0,
  );
  check(
    "tidyStationName",
    tidyStationName("CIAO!") === "Ciao!" &&
      tidyStationName("GREAT LAKES PLATE") === "Great Lakes Plate" &&
      tidyStationName("S2") === "S2",
  );

  const info = mapHallInfo(school);
  check(
    "hall info: address and 'daily' hours",
    info.address === "842 Chestnut Rd, East Lansing" &&
      info.hours === "7:00 a.m. to 9:00 p.m. daily",
    JSON.stringify(info),
  );
  const split = {
    ...school,
    sat_start: "09:00:00",
    sat_end: "20:00:00",
    sun_start: "09:00:00",
    sun_end: "20:00:00",
  };
  check(
    "hall info: weekday and weekend hours are grouped",
    describeHours(split) ===
      "Mon–Fri 7:00 a.m. to 9:00 p.m.; Sat–Sun 9:00 a.m. to 8:00 p.m.",
    describeHours(split),
  );
  check(
    "hall info: a day with no enabled hours is 'not posted', never 'closed'",
    /Sun not posted/.test(
      describeHours({ ...split, sun_enabled: false }) ?? "",
    ) && !/closed/.test(describeHours({ ...split, sun_enabled: false }) ?? ""),
  );
  check(
    "hall info: open-24-hours is said so",
    /open 24 hours/.test(
      describeHours({ ...school, mon_is_24_hours: true }) ?? "",
    ),
  );
  check(
    "hall info: missing times give no hours (never guessed)",
    describeHours({ ...school, tue_start: null }) === undefined,
  );

  // The whole chain: platform data → our snapshot → the same validator the server uses
  const chainNow = new Date("2026-10-09T15:00:00Z");
  const chain = {
    hallId: "south-pointe-at-case",
    hallInfo: info,
    scrapedAt: chainNow.toISOString(),
    source: "test",
    days: Object.fromEntries(
      Object.entries(mapped).map(([date, stations]) => [
        date,
        { meals: [{ name: "Dinner", stations }] },
      ]),
    ),
  };
  const chained = validateSnapshot(chain, DINING_HALLS, chainNow);
  check(
    "real-shaped data passes the server's validator",
    chained.ok,
    chained.ok ? "" : chained.error,
  );
  check(
    "hall info survives validation; junk hall info is dropped",
    chained.ok &&
      chained.snapshot.hallInfo?.hours === "7:00 a.m. to 9:00 p.m. daily" &&
      !validateSnapshot(
        { ...chain, hallInfo: { hours: 5, address: "x".repeat(500) } },
        DINING_HALLS,
        chainNow,
      ).ok === false,
  );

  // 8. Hours and location questions are answered in plain code, with a citation
  if (chained.ok) await saveSnapshot(chained.snapshot);
  const hours = await answerDining(
    "What time does South Pointe close?",
    route({ meal: "none" }),
    chainNow,
  );
  check(
    "'what time does it close?' → cited reply from the posted hours",
    hours.type === "answer" &&
      /7:00 a\.m\. to 9:00 p\.m\. daily/.test(hours.answer) &&
      /842 Chestnut/.test(hours.answer) &&
      hours.citations.length === 1 &&
      hours.citations[0].section === "Hall information",
    JSON.stringify(hours).slice(0, 200),
  );
  const noInfo = validateSnapshot(
    { ...chain, hallInfo: undefined },
    DINING_HALLS,
    chainNow,
  );
  if (noInfo.ok) await saveSnapshot(noInfo.snapshot);
  const noHours = await answerDining(
    "Where is South Pointe?",
    route({}),
    chainNow,
  );
  check(
    "no hall info saved → says so, links to the menu page (never invents hours)",
    noHours.type === "not_found" &&
      /south-pointe-at-case/.test(noHours.link?.url ?? ""),
    JSON.stringify(noHours).slice(0, 160),
  );

  // 9. Allergy questions are answered in plain code: labels only, never "safe"
  const { plainText } = await import("../lib/plain");
  const cookies = {
    hallId: "south-pointe-at-case",
    scrapedAt: chainNow.toISOString(),
    source: "test",
    days: {
      "2026-10-09": {
        meals: [
          {
            name: "Dinner",
            stations: [
              {
                name: "Bakery · Desserts",
                items: [
                  {
                    name: "Test Peanut Cookie",
                    tags: [],
                    allergens: ["peanuts", "wheat/gluten"],
                  },
                  {
                    name: "Test Plain Cookie",
                    tags: [],
                    allergens: ["wheat/gluten"],
                  },
                  { name: "Test Fruit Cup", tags: ["vegan"], allergens: [] },
                ],
              },
            ],
          },
        ],
      },
    },
  };
  const cookieCheck = validateSnapshot(cookies, DINING_HALLS, chainNow);
  if (cookieCheck.ok) await saveSnapshot(cookieCheck.snapshot);
  const allergyReply = async (q: string, keywords: string[] = []) =>
    answerDining(
      q,
      route({ meal: "dinner", date: "2026-10-09", keywords }),
      chainNow,
    );
  const text = (r: Awaited<ReturnType<typeof answerDining>>) =>
    r.type === "answer"
      ? r.answer
      : r.type === "not_found"
        ? (r.note ?? "")
        : "";
  const peanut = await allergyReply(
    "I have a peanut allergy, what can I eat for dinner?",
    ["peanut allergy"],
  );
  check(
    "peanut allergy: lists only what's LABELED peanuts",
    peanut.type === "answer" &&
      /Test Peanut Cookie \(Bakery, Desserts\)/.test(text(peanut)) &&
      !/Test Plain Cookie|Test Fruit Cup/.test(text(peanut)),
    text(peanut).slice(0, 200),
  );
  check(
    "…says it can't call anything safe, and sends them to staff",
    /can't tell you what's safe/.test(text(peanut)) &&
      /ask the staff/.test(text(peanut)),
  );
  check(
    "…never reassures (the only 'safe' is a warning)",
    !/peanut-free|nut-free|safe to eat|safe for you|you can (eat|have)|is safe for/i.test(
      text(peanut),
    ) && /doesn't mean everything else is safe/.test(text(peanut)),
  );
  check(
    "…cites the menu lines it used",
    peanut.type === "answer" &&
      peanut.citations.length === 1 &&
      peanut.citations[0].section === "Dinner · Bakery · Desserts",
  );
  const gluten = await allergyReply(
    "Is there anything gluten free for dinner?",
    ["gluten-free"],
  );
  check(
    "gluten-free: lists the items labeled wheat/gluten (not the fruit cup)",
    gluten.type === "answer" &&
      /Test Peanut Cookie/.test(text(gluten)) &&
      /Test Plain Cookie/.test(text(gluten)) &&
      !/Test Fruit Cup/.test(text(gluten)),
    text(gluten).slice(0, 200),
  );
  const soy = await allergyReply(
    "I'm allergic to soy, what can I have for dinner?",
  );
  check(
    "nothing labeled → says so plainly, still says it can't call anything safe",
    soy.type === "not_found" &&
      /don't see any items.*labeled as containing soy/.test(text(soy)) &&
      /can't tell you what's safe/.test(text(soy)),
  );
  const anyNut = await allergyReply(
    "I have a nut allergy, what's safe for dinner?",
  );
  check(
    "generic 'nut allergy' covers peanuts and tree nuts",
    anyNut.type === "answer" &&
      /peanuts or tree nuts/.test(text(anyNut)) &&
      /Test Peanut Cookie/.test(text(anyNut)),
  );
  check(
    "plainText strips markdown",
    plainText("**Bold** and __this__\n# Head\n* item\n\n\n\nend") ===
      "Bold and this\nHead\n- item\n\nend",
    JSON.stringify(
      plainText("**Bold** and __this__\n# Head\n* item\n\n\n\nend"),
    ),
  );

  // 9b. When the model's wording can't be cited, a plain list is built straight from the menu data
  const { listFromMenu } = await import("../lib/skills/dining/answer");
  const lunchBlocks = filterDay(day, "lunch", []);
  const listed = listFromMenu(
    lunchBlocks,
    "Test menu",
    "lunch menu, Friday, Oct 9",
    "South Pointe at Case",
    "3:20 p.m. today",
  );
  check(
    "fallback list: names stations and dishes, says when, is cited",
    listed.type === "answer" &&
      /Here's a look at South Pointe at Case's lunch menu/.test(
        listed.answer,
      ) &&
      /Menu as of 3:20 p\.m\. today/.test(listed.answer) &&
      listed.citations.length > 0,
    listed.type === "answer" ? listed.answer.slice(0, 160) : "",
  );
  check(
    "fallback list: every dish it names comes from a cited station",
    listed.type === "answer" &&
      listed.citations.every((c) => c.passage.length > 0) &&
      listed.citations.length <= 8,
  );
  check(
    "fallback list: plain text, no markdown",
    listed.type === "answer" && !/\*\*|#/.test(listed.answer),
  );
  check(
    "fallback list: carries the staff reminder when labels are shown",
    listed.type === "answer" && /ask the staff too/.test(listed.answer),
  );

  // 9c. Calorie and nutrition questions get an honest pointer (we don't carry those numbers)
  const cal = await answerDining(
    "How many calories are in the cheeseburger?",
    route({ keywords: ["cheeseburger"] }),
    chainNow,
  );
  check(
    "calories → says it has no nutrition details, links to the menu page, invents no number",
    cal.type === "not_found" &&
      /don't have calorie or nutrition details/.test(cal.note ?? "") &&
      !/\d+ cal/.test(cal.note ?? "") &&
      /south-pointe-at-case/.test(cal.link?.url ?? ""),
    JSON.stringify(cal).slice(0, 200),
  );
  check(
    "the food-word gate now includes calorie questions",
    looksLikeDining("how many calories are in the cheeseburger?"),
  );

  // 9d. Many halls: every hall is valid, questions find the right one, and "which hall?" is asked when needed
  const { prioritizeBlocks } = await import("../lib/skills/dining/query");
  const { mealTypesFor } = await import("../lib/skills/dining/nutrislice");
  const { routerPrompt } = await import("../lib/router");

  check(
    "eight dining halls are enabled",
    DINING_HALLS.filter((h) => h.enabled).length === 8,
    DINING_HALLS.map((h) => h.id).join(", "),
  );
  check(
    "every hall's id is its menu page name and its link matches",
    DINING_HALLS.every(
      (h) => h.menuUrl === `https://msu.nutrislice.com/menu/${h.id}`,
    ),
  );
  const prompt = routerPrompt(chainNow, ["dining", "other"]);
  check(
    "the router prompt names every hall id and nickname",
    DINING_HALLS.every(
      (h) =>
        prompt.includes(h.id) &&
        (h.aliases ?? []).every((alias) => prompt.includes(alias)),
    ),
  );
  check(
    "meal types come from each hall's own record",
    mealTypesFor(school)
      .map((m) => m.slug)
      .join() === "breakfast,lunch,dinner,late-night" &&
      mealTypesFor(null).length === 0,
  );

  // Seed the fake menu into two halls so we can tell them apart
  const base = await fixtureSnapshot(chainNow);
  for (const hallId of ["south-pointe-at-case", "the-edge-at-akers"]) {
    const seeded = validateSnapshot(
      { ...base, hallId, scrapedAt: chainNow.toISOString() },
      DINING_HALLS,
      chainNow,
    );
    check(
      `validator accepts the sample menu for ${hallId}`,
      seeded.ok,
      seeded.ok ? "" : seeded.error,
    );
    if (seeded.ok) await saveSnapshot(seeded.snapshot);
  }
  const todayStr = t.michiganDate(chainNow);
  const whichHall = await answerDining(
    "What's for lunch?",
    route({ hall: "none", meal: "lunch" }),
    chainNow,
  );
  check(
    "no hall named → asks which one, with every hall as a choice",
    whichHall.type === "dining_pick_hall" &&
      whichHall.halls.length === 8 &&
      whichHall.question === "What's for lunch?",
    whichHall.type,
  );
  const everywhere = await answerDining(
    "Where can I get pizza today?",
    route({ hall: "none", meal: "none", keywords: ["pizza"] }),
    chainNow,
  );
  check(
    "no hall named + a food → searches every hall (here the two with data), cited and linked",
    everywhere.type === "answer" &&
      /South Pointe at Case: Sample Cheese Pizza/.test(everywhere.answer) &&
      /The Edge at Akers: Sample Cheese Pizza/.test(everywhere.answer) &&
      everywhere.citations.length === 2 &&
      everywhere.citations.every((c) =>
        /nutrislice\.com\/menu\//.test(c.url ?? ""),
      ),
    everywhere.type === "answer"
      ? everywhere.answer.slice(0, 220)
      : everywhere.type,
  );
  const nowhere = await answerDining(
    "Is there sushi anywhere?",
    route({ hall: "none", meal: "none", keywords: ["sushi"] }),
    chainNow,
  );
  check(
    "a food no hall has → says so plainly",
    nowhere.type === "not_found" &&
      /any dining hall's/.test(nowhere.note ?? "") &&
      /"sushi"/.test(nowhere.note ?? ""),
    JSON.stringify(nowhere).slice(0, 160),
  );
  const noDay = await answerDining(
    "Where can I get pizza?",
    route({
      hall: "none",
      meal: "none",
      keywords: ["pizza"],
      date: t.addDays(todayStr, 6),
    }),
    chainNow,
  );
  check(
    "a day nobody has yet → says so, links to the hub",
    noDay.type === "not_found" &&
      /don't have the dining menus/.test(noDay.note ?? "") &&
      /eatatstate/.test(noDay.link?.url ?? ""),
  );
  const allergyNoHall = await answerDining(
    "I have a peanut allergy, what can I eat?",
    route({ hall: "none", meal: "none", keywords: [] }),
    chainNow,
  );
  check(
    "an allergy question with no hall → asks which hall first",
    allergyNoHall.type === "dining_pick_hall",
  );
  const calNoHall = await answerDining(
    "How many calories are in a burger?",
    route({ hall: "none", meal: "none", keywords: ["burger"] }),
    chainNow,
  );
  check(
    "calories with no hall → honest pointer to the official site",
    calNoHall.type === "not_found" &&
      /nutrition/i.test(calNoHall.note ?? "") &&
      /eatatstate/.test(calNoHall.link?.url ?? ""),
  );
  const otherPlace = await answerDining(
    "What's at Sparty's Market?",
    route({ hall: "other_hall" }),
    chainNow,
  );
  check(
    "a place we don't cover → lists the halls we do, links to the hub",
    otherPlace.type === "not_found" &&
      /The Edge at Akers/.test(otherPlace.note ?? "") &&
      /eatatstate/.test(otherPlace.link?.url ?? ""),
  );
  const edgeNoDay = await answerDining(
    "What's for lunch at The Edge?",
    route({ hall: "the-edge-at-akers", date: t.addDays(todayStr, 6) }),
    chainNow,
  );
  check(
    "a named hall with no menu for that day → names that hall and links to its page",
    edgeNoDay.type === "not_found" &&
      /The Edge at Akers/.test(edgeNoDay.note ?? "") &&
      /the-edge-at-akers/.test(edgeNoDay.link?.url ?? ""),
    JSON.stringify(edgeNoDay).slice(0, 180),
  );

  // Brunch and Lunch together, and toppings bars
  const both: import("../lib/skills/dining/types").DiningDay = {
    meals: [
      {
        name: "Brunch",
        stations: [{ name: "Grill", items: [{ name: "Brunch Burger" }] }],
      },
      {
        name: "Lunch",
        stations: [{ name: "Grill", items: [{ name: "Lunch Burger" }] }],
      },
    ],
  };
  check(
    "'lunch' means Lunch when a hall serves both Brunch and Lunch",
    filterDay(both, "lunch", [])
      .flatMap((b) => b.items.map((i) => i.name))
      .join() === "Lunch Burger",
  );
  check(
    "'breakfast' falls back to Brunch when there's no Breakfast",
    filterDay(both, "breakfast", [])
      .flatMap((b) => b.items.map((i) => i.name))
      .join() === "Brunch Burger",
  );
  const mixed = [
    { meal: "Lunch", station: "Nook · Beverages", items: [{ name: "Water" }] },
    { meal: "Lunch", station: "Grill · Entrees", items: [{ name: "Burger" }] },
    {
      meal: "Lunch",
      station: "Salad Bar · Build Your Own",
      items: [{ name: "Lettuce" }],
    },
    { meal: "Lunch", station: "Pizza · Entrees", items: [{ name: "Pizza" }] },
  ];
  check(
    "entrees come before toppings and drinks, and the cap is respected",
    prioritizeBlocks(mixed, 3)
      .map((b) => b.station)
      .join("|") === "Grill · Entrees|Pizza · Entrees|Nook · Beverages" &&
      prioritizeBlocks(mixed, 10).length === 4,
    prioritizeBlocks(mixed, 3)
      .map((b) => b.station)
      .join("|"),
  );

  // 10. The update endpoint's locks
  const post = (body: unknown, auth?: string) =>
    ingest(
      new Request("http://localhost/api/dining/ingest", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(auth ? { authorization: auth } : {}),
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
  delete process.env.INGEST_SECRET;
  check(
    "ingest is closed when no secret is set (503)",
    (await post(snapshot, "Bearer anything")).status === 503,
  );
  process.env.INGEST_SECRET = "test-secret-test-secret-test-secret";
  check(
    "ingest rejects a missing secret (401)",
    (await post(snapshot)).status === 401,
  );
  check(
    "ingest rejects a wrong secret (401)",
    (await post(snapshot, "Bearer wrong-wrong-wrong-wrong-wrong-")).status ===
      401,
  );
  check(
    "ingest rejects bad JSON (400)",
    (await post("not json", "Bearer test-secret-test-secret-test-secret"))
      .status === 400,
  );
  check(
    "ingest rejects invalid menus (422)",
    (
      await post(
        { ...snapshot, hallId: "nope" },
        "Bearer test-secret-test-secret-test-secret",
      )
    ).status === 422,
  );
  const okResponse = await post(
    snapshot,
    "Bearer test-secret-test-secret-test-secret",
  );
  check(
    "ingest accepts a valid menu (200)",
    okResponse.status === 200,
    String(okResponse.status),
  );
  delete process.env.INGEST_SECRET;
}

// ── Live eval (uses API credit) ─────────────────────────────────────────────

type LiveCase = {
  q: string;
  expect:
    | "dining_answer"
    | "dining_not_found"
    | "dining_any"
    | "dining_pick_hall"
    | "handbook"
    | "not_dining"
    | "escalate"
    | "any";
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
  const isDiningAnswer =
    reply.type === "answer" &&
    reply.citations.some((x) => /South Pointe/.test(x.source));
  const isDiningNotFound =
    reply.type === "not_found" && reply.source === "dining";
  const isDining = isDiningAnswer || isDiningNotFound;
  if (c.expect === "dining_answer" && !isDiningAnswer)
    return `expected a dining answer, got ${reply.type}${isDiningNotFound ? " (dining not found)" : ""}`;
  if (c.expect === "dining_pick_hall" && reply.type !== "dining_pick_hall")
    return `expected the which-hall question, got ${reply.type}`;
  if (
    c.expect === "dining_any" &&
    !isDining &&
    reply.type !== "dining_pick_hall"
  )
    return `expected a dining reply, got ${reply.type}`;
  if (c.expect === "dining_not_found" && !isDiningNotFound)
    return `expected a dining "no data" reply, got ${reply.type}`;
  if (c.expect === "handbook" && (isDining || reply.type === "escalate"))
    return `expected the handbook flow, got ${isDining ? "dining" : reply.type}`;
  if (c.expect === "not_dining" && (isDining || reply.type === "escalate"))
    return `expected a non-dining reply, got ${isDining ? "dining" : reply.type}`;
  if (c.expect === "escalate" && reply.type !== "escalate")
    return `expected escalate, got ${reply.type}`;
  const text = replyText(reply);
  for (const pattern of c.mustMention ?? [])
    if (!new RegExp(pattern, "i").test(text))
      return `reply doesn't mention /${pattern}/`;
  for (const pattern of c.mustNotMention ?? [])
    if (new RegExp(pattern, "i").test(text))
      return `reply mentions forbidden /${pattern}/`;
  return null;
}

async function live() {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // use the real environment
  }
  if (!process.env.ANTHROPIC_API_KEY)
    throw new Error("ANTHROPIC_API_KEY is not set (needed for --live).");
  const { validateSnapshot } = await import("../lib/skills/dining/validate");
  const { DINING_HALLS, saveSnapshot } =
    await import("../lib/skills/dining/cache");
  const { askHandbook } = await import("../lib/pipeline");

  const checked = validateSnapshot(await fixtureSnapshot(), DINING_HALLS);
  if (!checked.ok) throw new Error(`fixture invalid: ${checked.error}`);
  await saveSnapshot(checked.snapshot);

  const { cases } = JSON.parse(
    readFileSync("tests/dining/questions.json", "utf8"),
  ) as { cases: LiveCase[] };
  let passed = 0;
  const failures: string[] = [];
  for (const [i, c] of cases.entries()) {
    const reply = await askHandbook(c.q, { history: c.history });
    const reason = gradeLive(c, reply);
    if (reason)
      failures.push(
        `✗ "${c.q}"\n    ${reason}${c.note ? `\n    note: ${c.note}` : ""}\n    → ${reply.type}: ${replyText(reply).slice(0, 220)}`,
      );
    else passed++;
    console.log(`${reason ? "✗" : "✓"} ${String(i + 1).padStart(2)}. ${c.q}`);
  }
  console.log(
    `\n${failures.length ? failures.join("\n") + "\n\n" : ""}Dining live eval: ${passed}/${cases.length} (${((passed / cases.length) * 100).toFixed(1)}%)  targets: 90%+ overall, 100% on the escalate cases`,
  );
  if (failures.length) process.exitCode = 1;
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function main() {
  if (LIVE) return live();
  await offline();
  const failed = checks.filter((c) => !c.ok);
  for (const c of failed)
    console.log(`✗ ${c.name}${c.detail ? `\n    ${c.detail}` : ""}`);
  console.log(
    `\n${checks.length - failed.length}/${checks.length} dining checks passed`,
  );
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
