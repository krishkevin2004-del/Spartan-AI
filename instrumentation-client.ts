// Runs in the resident's browser when the page loads. Vercel BotID quietly
// checks that requests to our API come from a real browser, not a script.
// Every POST to /api/* is protected; the server side is in lib/requestGuard.ts.
import { initBotId } from "botid/client/core";

initBotId({
  protect: [{ path: "/api/*", method: "POST" }],
});
