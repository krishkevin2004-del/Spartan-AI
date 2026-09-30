// POST /api/escalation-log  { category, layer }
//
// Audit trail for escalations that fire in the browser (the keyword check runs
// there too, so those questions never leave the device) and for clicks on the
// "Get help now" link. Anonymous: only the category and which check fired are
// logged. No message text, no IP, nothing tied to a person.

import { SCREENS } from "@/lib/escalation";
import { allowCheapRequest } from "@/lib/limits";
import { guardRequest } from "@/lib/requestGuard";

export const runtime = "nodejs";

const LAYERS = new Set(["keyword", "help_link"]);

export async function POST(request: Request) {
  const guard = await guardRequest(request);
  if (!guard.ok) return guard.response;
  if (!(await allowCheapRequest(guard.ip))) return new Response(null, { status: 429 });

  const body = guard.body as { category?: unknown; layer?: unknown } | null;
  const category = typeof body?.category === "string" && body.category in SCREENS ? body.category : null;
  const layer = typeof body?.layer === "string" && LAYERS.has(body.layer) ? body.layer : null;
  if (!category || !layer) return new Response(null, { status: 400 });
  console.log(JSON.stringify({ event: "escalation", category, layer, where: "browser" }));
  return new Response(null, { status: 204 });
}
