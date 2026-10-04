// POST /api/health  →  { claude, redis, model }
//
// For whoever maintains the site: answers "why isn't the assistant answering?"
// It makes one tiny Claude call (about a thousandth of a cent) and reports a
// plain label such as "ok", "invalid_key" or "no_credit". It never returns the
// key or any other secret. Same bot and size protection as every other route,
// plus its own tight limit.

import { getClient } from "@/lib/claude";
import { describeClaudeError, type ClaudeProblem } from "@/lib/claudeErrors";
import { CONFIG } from "@/lib/config";
import { allowCheapRequest, redisStatus } from "@/lib/limits";
import { guardRequest } from "@/lib/requestGuard";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const guard = await guardRequest(request);
  if (!guard.ok) return guard.response;
  if (!(await allowCheapRequest(guard.ip, 5))) return new Response(null, { status: 429 });

  let claude: ClaudeProblem | "ok" = "ok";
  try {
    await getClient().messages.create(
      { model: CONFIG.chatModel, max_tokens: 1, messages: [{ role: "user", content: "ping" }] },
      { timeout: 8000, maxRetries: 0 },
    );
  } catch (err) {
    claude = describeClaudeError(err);
  }

  return Response.json({ claude, redis: await redisStatus(), model: CONFIG.chatModel });
}
