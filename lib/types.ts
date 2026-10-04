// Shared shapes used by the ingest script, the server and the web page.

import type { EscalationCategory } from "./escalation";

/** One citable block of the handbook. */
export type HandbookChunk = {
  id: string; // e.g. "campus-housing-rules-and-regulations--guests-1"
  part: string; // top-level heading, e.g. "Campus Housing Rules and Regulations"
  section: string; // the heading we cite, e.g. "Guests"
  pageStart: number;
  pageEnd: number;
  text: string; // the exact handbook text, shown to residents as the source
};

/** The file written by `npm run ingest`. */
export type HandbookIndex = {
  handbookTitle: string;
  sourceFile: string;
  sourceSha256: string; // fingerprint of the PDF, so we know which version this came from
  builtAt: string;
  chunks: HandbookChunk[];
};

/** A citation as shown under an answer. */
export type Citation = {
  source: string; // "2026-27 On-Campus Housing Handbook" or "Hall staff guidance"
  section: string;
  pages?: string; // "p. 15" or "pp. 15-16" (handbook only)
  passage: string; // the exact text that was cited
};

/** One earlier message, sent along so follow-up questions make sense. */
export type HistoryTurn = { role: "user" | "assistant"; text: string };

/** Everything the assistant can reply with. */
export type AssistantReply =
  | { type: "answer"; answer: string; citations: Citation[] }
  | { type: "chat"; text: string } // fixed reply to greetings and thanks
  | { type: "ra_lookup"; hallId?: string } // show RA contacts (asks for the hall if unknown)
  // layer = which check fired, for the anonymous audit log (never shown to residents)
  | { type: "escalate"; category: EscalationCategory; layer?: "keyword" | "classifier" | "fail_closed" }
  | { type: "not_found"; note?: string }
  | { type: "off_topic" }
  // visitor = this person asked too much; busy = the whole site is flooded; budget = today's spending cap is reached
  | { type: "rate_limited"; reason: "visitor" | "busy" | "budget" }
  | { type: "error"; message: string };
