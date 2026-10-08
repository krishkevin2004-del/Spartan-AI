import { timingSafeEqual } from "node:crypto";

/** Does an "Authorization: Bearer <secret>" header carry the right secret? (Constant-time, so it can't be guessed bit by bit.) */
export function bearerMatches(header: string | null, secret: string): boolean {
  const given = Buffer.from((header ?? "").replace(/^Bearer\s+/i, ""));
  const wanted = Buffer.from(secret);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}
