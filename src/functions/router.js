// Azure Functions adapter. One catch all route sends everything through createHandlers().handle(),
// so routing is identical in Azure, in the local dev server and in the tests.
// host.json sets routePrefix to "" so the page is served at / and the API at /api/*.

import { app } from "@azure/functions";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHandlers } from "../lib/handlers.js";
import { createStore } from "../lib/store.js";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
let api;

// Import and export need a signed in user. ALLOW_ANONYMOUS_BULK=true lifts that, for testing with fictional data only.
const allowAnonymousBulk = process.env.ALLOW_ANONYMOUS_BULK === "true";

app.http("router", {
  methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
  authLevel: "anonymous", // Sign in is added at the platform layer (App Service authentication), not here.
  route: "{*rest}",
  handler: async (request, context) => {
    api ??= createHandlers({ store: createStore(), webRoot, log: (m) => context.error(m), allowAnonymousBulk });

    const hasBody = !["GET", "HEAD", "DELETE"].includes(request.method);
    const result = await api.handle({
      method: request.method,
      path: new URL(request.url).pathname,
      headers: Object.fromEntries(request.headers),
      body: hasBody ? await request.text() : undefined,
    });
    return { status: result.status, headers: result.headers, body: result.body };
  },
});
