// Local dev server: same handlers as Azure, in memory store, fictional sample data.
// Usage: npm run dev            (http://localhost:7071)
//        PORT=8080 npm run dev
// Nothing here touches Azure. Data disappears when you stop it. Import and export are open here unless you set ALLOW_ANONYMOUS_BULK=false to see the signed out experience.

import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHandlers } from "../src/lib/handlers.js";
import { createMemoryStore } from "../src/lib/store-memory.js";
import { SAMPLE_OPPS } from "../src/lib/sample-data.js";
import { aiFromEnv } from "../src/lib/ai.js";
import { createMockAi } from "./mock-ai.mjs";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../web");
const port = Number(process.env.PORT ?? 7071);

const store = createMemoryStore();
const now = new Date().toISOString();
for (const o of SAMPLE_OPPS) {
  await store.upsert({ ...o, createdAt: now, createdBy: "sample", updatedAt: now, updatedBy: "sample" });
}
// Transcripts: the demo model unless FOUNDRY_ENDPOINT and FOUNDRY_DEPLOYMENT are set (then it calls the real Foundry
// resource with your az login). Set AI=off to see the "not set up" state.
const ai = process.env.AI === "off" ? null : (await aiFromEnv(process.env, (m) => console.error(m))) ?? createMockAi();
const api = createHandlers({ store, webRoot, log: (m) => console.error(m), info: (m) => console.log(m), allowAnonymousBulk: process.env.ALLOW_ANONYMOUS_BULK !== "false", ai });

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks).toString("utf8") : undefined;
  const headers = { ...req.headers };
  // Lets you test the "signed in" display locally: DEV_USER=don@example.com npm run dev
  if (process.env.DEV_USER) headers["x-ms-client-principal-name"] = process.env.DEV_USER;
  const out = await api.handle({ method: req.method, path: new URL(req.url, "http://localhost").pathname, headers, body });
  res.writeHead(out.status, out.headers);
  res.end(req.method === "HEAD" ? undefined : out.body);
});

server.listen(port, () => console.log(`Pipeline dev server on http://localhost:${port} (memory store, sample data, AI: ${ai ? ai.kind : "off"})`));
