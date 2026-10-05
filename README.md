# Housing Handbook Assistant

A small web app that answers MSU housing policy questions using **only** the official
On-Campus Housing Handbook, and cites the section every answer came from. Sensitive
topics never reach the answer step: they go straight to a fixed screen with real people
to contact. Built for MSU on-campus residents, any hall. Runs on Claude Haiku 4.5.

## How a message flows

```
Resident types a message
        │
        ▼
 Layer 1: keyword rules (lib/escalation.ts) ──match──▶ Fixed help screen
        │ no match              (runs in the browser AND on the server, no AI)
        ▼
 Layer 2: safety classifier (lib/safety.ts) ──"escalate", error or timeout──▶ Fixed help screen
        │ "safe"                (separate Claude call, forced tool: only "safe" or "escalate")
        ▼
 Asking for the RA's number? ──yes──▶ "Which hall?" → that hall's contacts (data/hall-contacts.json)
        │ no
        ▼
 Claude reads the whole handbook (cached) and answers at temperature 0 (lib/answer.ts)
        │
        ├── no citation / not covered ──▶ "Not in the handbook" + point to the RA
        ▼
 Answer + citation (section, page, and the exact handbook text)
```

A **Get help now** button is on screen at all times, independent of both checks.

## Where each guardrail lives

| Guardrail (CLAUDE.md) | Where it's enforced |
|---|---|
| 1. Handbook-only, temperature 0 | `lib/config.ts` (`temperature: 0`), prompt in `lib/answer.ts` |
| 2. Hardcoded escalation, two layers, fail closed | `lib/escalation.ts` (keywords + the fixed screens), `lib/safety.ts` (classifier), `lib/pipeline.ts` (order) |
| 2. Escalation audit log | `app/api/ask/route.ts` and `app/api/escalation-log/route.ts` log `{event: "escalation", category, layer}`, never message text |
| 3. Every answer cited | `lib/answer.ts` uses Claude's Citations feature; an answer with no citation is replaced by "not in the handbook" |
| 4. No student data | No login, no database of questions. Questions are never logged. Rate-limit counters use a salted one-way hash of the IP and expire within two days. |
| 5. Off-topic refused, rate limited | `lib/answer.ts` (`[OFF_TOPIC]`), plus the cost protection below |
| 6. Contained scope | One handbook, one index file, no shared infrastructure |

**Retrieval note:** the Claude API has no embeddings endpoint, and the handbook is only
~22k tokens, so instead of vector search Claude receives the whole handbook (split into
145 numbered blocks) on every question. It is prompt-cached, so this is cheap, and the
Citations feature tells us exactly which blocks an answer used.

## Running it on your computer

You need [Node.js](https://nodejs.org) 20+ and a Claude API key.

```bash
npm install
cp .env.example .env.local      # then paste your key into .env.local
npm run ingest                  # splits the PDF into data/handbook-index.json (no API calls)
npm run dev                     # open the address it prints
```

## Testing

```bash
npm run test:escalation         # free, instant: keyword rules + RA-number detection
npm run eval -- --escalation    # both escalation layers (keywords + classifier) on every question
npm run eval                    # the whole system end to end (add --verbose to see every reply)
```

Targets before a resident sees it: **100% on escalation** (including the paraphrased
distress cases) and **90%+** on everything else. Last run (2026-09-30): escalation 36/36,
everything else 92/93. Add real questions from residents to `tests/questions.json`.

## Data you maintain

- `data/hall-contacts.json`: Service Center numbers for every hall (from liveon.msu.edu).
  **RA on-duty numbers are not published online**; fill in `raOnDutyPhone` for each hall as
  you collect them. Until then residents are pointed to their Service Center.
- `data/staff-guidance.json`: policy info from hall staff that isn't in the handbook
  (e.g. finals quiet hours). Cited separately from the handbook.
- `lib/escalation.ts`: crisis contacts and the fixed screens. Have REHS review changes.

## If the assistant isn't answering

Symptom: every question shows the "Let's get you to a person" help screen. That's the safety
check failing closed because it couldn't reach Claude. To see why, open the live site, then in
the browser console run:

```js
fetch('/api/health', {method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'}).then(r => r.json()).then(console.log)
```

| `claude` says | Meaning | Fix |
|---|---|---|
| `ok` | Claude is reachable | Nothing to fix |
| `no_key` | The server has no `ANTHROPIC_API_KEY` | Vercel → Settings → Environment Variables: add it with **Production** ticked, then Redeploy |
| `invalid_key` | The key is wrong, has a stray space, or was deleted | Paste a fresh key, save, Redeploy |
| `no_credit` | The Anthropic account has no credit | console.anthropic.com → Billing |
| `rate_limited` / `timeout` / `network` | Temporary | Try again in a minute |

`redis` should say `ok`. `not_connected` means no Redis is linked, so cost limits only count
per server; `error` means it's linked but unreachable (limits fall back to memory). Vercel's **Logs** tab also records the reason on every failure
(search for `safety classifier failed`). Environment-variable changes only apply after a **Redeploy**.

## Updating the handbook (every year)

1. Put the new PDF in this folder; update `handbookPdfPath` and `handbookTitle` in `lib/config.ts`.
2. Compare its Table of Contents with `scripts/handbook-sections.ts` and update the headings.
3. `npm run ingest -- --dry-run` lists every section found and warns about missing headings.
4. `npm run ingest`, then `npm run eval`.
5. Re-check phone numbers in `lib/escalation.ts` and `data/hall-contacts.json`.
6. Commit `data/handbook-index.json` and redeploy.

## Protection against runaway cost

One person (or a bot) can't run up the Claude bill. Every request passes these, in order:

| Layer | What it stops | Where |
|---|---|---|
| Same-site check | Scripts calling the API directly instead of using the page (production only) | `lib/requestGuard.ts` |
| Vercel BotID | Bots and headless browsers, invisibly, no CAPTCHA | `lib/requestGuard.ts`, `instrumentation-client.ts` |
| Size limits | Huge payloads: 500-char questions, 4 short history turns, 8 KB max request | `lib/requestGuard.ts`, `app/api/ask/route.ts` |
| Per visitor | 6 questions/minute, 40/day per IP | `lib/limits.ts` |
| Whole site | 40 questions/minute across everyone (stops swarms of IPs) | `lib/limits.ts` |
| Daily budget | Adds up the real cost of every Claude call; at $0.50/day (≈ $15/month) AI answers pause until midnight | `lib/limits.ts` |
| Claude Console spend limit | The final backstop, enforced by Anthropic | you set it (below) |

Keyword escalation, the help screens, "Get help now" and the RA lookup cost nothing and keep
working even when a limit is hit. Every limit message points to the RA and to "Get help now".
All numbers are in `lib/config.ts` (`limits`); `DAILY_BUDGET_USD` overrides the budget.

## Deploying to Vercel

1. Put this folder in a Git repository and import it in Vercel (framework: Next.js).
2. **Connect Redis** (so the cost limits are shared by every Vercel server): Vercel project →
   Storage → Marketplace → pick **Upstash** or **Redis** → free plan → connect to this project.
   Either works. It adds variables like `KV_REST_API_URL` / `KV_REST_API_TOKEN` (Upstash) or
   `Storage_REDIS_URL` (Redis); the site detects whichever is there. Without one, limits only
   count per server and are much weaker. If Redis ever fails, limits fall back to memory.
3. **Environment variables** (Project → Settings → Environment Variables):
   `ANTHROPIC_API_KEY` (required; the name must match exactly), `DAILY_BUDGET_USD` (optional, default 0.50),
   `IP_HASH_SALT` (optional, any long random string).
4. **BotID** works automatically once deployed. Optional (Pro plan): Firewall → Rules →
   enable *Vercel BotID Deep Analysis*.
5. **Claude Console spend limit**: console.anthropic.com → Settings → Limits → set a
   monthly spend limit (e.g. $20). If everything else failed, Anthropic stops the spending.
6. Make sure `data/handbook-index.json` is committed.

Test after deploying by using the site in a browser. `curl` against `/api/ask` is
blocked in production by design.

## Cost

Claude Haiku 4.5 ($1 / $5 per million input/output tokens). Each question makes a tiny
classifier call plus an answer call that reads the cached handbook. Roughly $0.005 per
question when the cache is warm, about $0.05 for the first question after an idle hour.
Expected pilot volume lands well under the ~$15/month planning number, and the
daily budget cap enforces that ceiling automatically (see above). `LOG_USAGE=1` in
`.env.local` prints token use per question.
