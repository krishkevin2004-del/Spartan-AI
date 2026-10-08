// ─────────────────────────────────────────────────────────────────────────────
// The whole flow, in order. Both the website and the test script
// (`npm run eval`) call askHandbook(), so tests exercise the real thing.
//
//   1. Ask       → basic checks on the question
//   4. Escalate  → layer 1: keyword rules (no AI)
//                  layer 2: safety classifier (separate call, fails closed)
//      RA lookup → "what's my RA's number?" answered from hall-contacts.json
//      Skills    → (only if switched on) food questions → dining, event questions → events
//   2+3. Answer  → Claude answers from the handbook, with checked citations
//
// Escalation runs before the answer step, every time. A message that
// escalates never reaches the answer step at all.
// ─────────────────────────────────────────────────────────────────────────────

import { answerQuestion } from "./answer";
import { CONFIG } from "./config";
import { checkEscalation } from "./escalation";
import { isRaContactRequest, matchHall } from "./halls";
import { checkLimits } from "./limits";
import { routeMessage, shouldRoute } from "./router";
import { classifySafety } from "./safety";
import { answerDining } from "./skills/dining/answer";
import { answerEvents } from "./skills/events/answer";
import type { AssistantReply, HistoryTurn } from "./types";

export async function askHandbook(
  rawQuestion: string,
  options: { ip?: string; history?: HistoryTurn[] } = {},
): Promise<AssistantReply> {
  // ── 1. Ask ──
  const question = rawQuestion.trim();
  if (!question) return { type: "error", message: "Type a question first." };
  if (question.length > CONFIG.maxQuestionLength) {
    return { type: "error", message: `Please keep questions under ${CONFIG.maxQuestionLength} characters.` };
  }

  // ── 4. Escalate, layer 1: keywords ──
  // Runs before rate limiting: an obvious crisis always gets the help screen.
  const keywordHit = checkEscalation(question);
  if (keywordHit) return { type: "escalate", category: keywordHit, layer: "keyword" };

  // Cost and abuse limits, before any paid AI call. (The "Get help now" link
  // stays on screen, and the reply below points to help too.)
  if (options.ip) {
    const limit = await checkLimits(options.ip);
    if (limit === "visitor_limit") return { type: "rate_limited", reason: "visitor" };
    if (limit === "site_busy") return { type: "rate_limited", reason: "busy" };
    if (limit === "budget_reached") return { type: "rate_limited", reason: "budget" };
  }

  // ── 4. Escalate, layer 2: safety classifier (fails closed) ──
  const history = (options.history ?? []).slice(-CONFIG.historyTurns);
  const previousUserMessage = [...history].reverse().find((t) => t.role === "user")?.text;
  const safety = await classifySafety(question, previousUserMessage);
  if (safety.label !== "safe") {
    return { type: "escalate", category: "general", layer: safety.failedClosed ? "fail_closed" : "classifier" };
  }

  // ── RA contact lookup (no AI answer needed) ──
  if (isRaContactRequest(question)) return { type: "ra_lookup", hallId: matchHall(question)?.id };

  // ── Extra skills (dining, events) ──
  // Each is OFF unless its switch is on (DINING_ENABLED=1, EVENTS_ENABLED=1).
  // Only messages that look like they could be about an enabled skill get
  // routed; anything the router doesn't claim continues to the handbook below,
  // exactly as before.
  if (shouldRoute(question, history)) {
    const route = await routeMessage(question, history);
    if (route.label === "dining") return answerDining(question, route.dining);
    if (route.label === "events") return answerEvents(question, route.events);
  }

  // ── 2 + 3. Answer from the handbook ──
  const reply = await answerQuestion(question, history);
  if (reply.type === "ra_lookup") return { type: "ra_lookup", hallId: matchHall(question)?.id };
  return reply;
}
