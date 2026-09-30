// POST /api/ask  { question: string, history?: HistoryTurn[] }  →  AssistantReply
//
// Privacy: the question text is never logged or stored. The only thing we log
// is an anonymous analytics line: what kind of reply it was, which handbook
// section was cited, and the hour of day. See logAnalytics() below.

import { CONFIG } from "@/lib/config";
import { askHandbook } from "@/lib/pipeline";
import { guardRequest } from "@/lib/requestGuard";
import type { AssistantReply, HistoryTurn } from "@/lib/types";

export const runtime = "nodejs";

/** Keep only well-formed history turns from the browser, cut short so they can't inflate cost. */
function cleanHistory(raw: unknown): HistoryTurn[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t): t is HistoryTurn => (t?.role === "user" || t?.role === "assistant") && typeof t?.text === "string")
    .slice(-CONFIG.historyTurns)
    .map((t) => ({ role: t.role, text: t.text.slice(0, CONFIG.maxHistoryTurnLength) }));
}

function logAnalytics(reply: AssistantReply) {
  // Escalations get their own audit line so there's a record the system works.
  if (reply.type === "escalate") {
    console.log(JSON.stringify({ event: "escalation", category: reply.category, layer: reply.layer, where: "server" }));
  }
  const entry = {
    event: "ask",
    outcome: reply.type,
    limit: reply.type === "rate_limited" ? reply.reason : undefined,
    section: reply.type === "answer" ? reply.citations[0]?.section : undefined,
    hour: new Date().toLocaleString("en-US", { timeZone: "America/Detroit", hour: "numeric", hour12: false }),
  };
  console.log(JSON.stringify(entry));
}

export async function POST(request: Request) {
  const guard = await guardRequest(request);
  if (!guard.ok) return guard.response;

  const body = guard.body as { question?: unknown; history?: unknown } | null;
  const question = typeof body?.question === "string" ? body.question : "";
  const history = cleanHistory(body?.history);

  try {
    const reply = await askHandbook(question, { ip: guard.ip, history });
    logAnalytics(reply);
    return Response.json(reply, { status: reply.type === "rate_limited" ? 429 : 200 });
  } catch (err) {
    // Log the error type only, never the question.
    console.error("ask failed:", err instanceof Error ? err.message : "unknown error");
    const reply: AssistantReply = {
      type: "error",
      message: "Something went wrong on our end. For now, please ask your RA or the Service Center.",
    };
    logAnalytics(reply);
    return Response.json(reply, { status: 500 });
  }
}
