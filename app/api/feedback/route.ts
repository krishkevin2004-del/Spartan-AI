// POST /api/feedback  { vote: "up" | "down", section?: string }
//
// Thumbs up/down on an answer. Anonymous: we log the vote and the cited
// section name only, never the question or answer text.

import { allowCheapRequest } from "@/lib/limits";
import { guardRequest } from "@/lib/requestGuard";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const guard = await guardRequest(request);
  if (!guard.ok) return guard.response;
  if (!(await allowCheapRequest(guard.ip))) return new Response(null, { status: 429 });

  const body = guard.body as { vote?: unknown; section?: unknown } | null;
  const vote = body?.vote === "up" || body?.vote === "down" ? body.vote : null;
  // Section names are short headings; anything else is dropped.
  const section = typeof body?.section === "string" && body.section.length <= 100 ? body.section : undefined;
  if (!vote) return new Response(null, { status: 400 });
  console.log(JSON.stringify({ event: "feedback", vote, section }));
  return new Response(null, { status: 204 });
}
