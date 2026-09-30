import { withBotId } from "botid/next/config";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Make sure the handbook index ships with the API route on Vercel.
  outputFileTracingIncludes: {
    "/api/ask": ["./data/handbook-index.json"],
  },
};

// withBotId adds the routes Vercel BotID needs (see lib/requestGuard.ts).
export default withBotId(nextConfig);
