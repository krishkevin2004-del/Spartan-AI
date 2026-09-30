import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | null = null;

/** One shared Claude API client. Reads ANTHROPIC_API_KEY from the environment. */
export function getClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set. Put it in .env.local (see .env.example).");
  }
  client ??= new Anthropic();
  return client;
}
