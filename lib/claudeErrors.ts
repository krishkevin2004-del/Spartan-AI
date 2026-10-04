// Turns a failed Claude call into a short, plain label, so a maintainer can see
// WHY the assistant isn't answering without reading raw error text.
// Used in the server log (lib/safety.ts, lib/answer.ts) and by /api/health.

import Anthropic from "@anthropic-ai/sdk";

export type ClaudeProblem =
  | "no_key" // ANTHROPIC_API_KEY isn't set on the server
  | "invalid_key" // the key is wrong, typed with spaces, or was deleted
  | "no_credit" // the Anthropic account has no credit left
  | "rate_limited" // Anthropic is throttling this key
  | "model_unavailable" // the model name isn't available to this key
  | "timeout" // Claude took too long to respond
  | "network" // couldn't reach Anthropic at all
  | "other";

export function describeClaudeError(err: unknown): ClaudeProblem {
  const message = err instanceof Error ? err.message : "";
  if (message.includes("ANTHROPIC_API_KEY is not set")) return "no_key";
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return "invalid_key";
  }
  if (err instanceof Anthropic.BadRequestError && /credit balance|billing/i.test(message)) return "no_credit";
  if (err instanceof Anthropic.RateLimitError) return "rate_limited";
  if (err instanceof Anthropic.NotFoundError) return "model_unavailable";
  if (err instanceof Anthropic.APIConnectionTimeoutError) return "timeout";
  if (err instanceof Anthropic.APIConnectionError) return "network";
  return "other";
}
