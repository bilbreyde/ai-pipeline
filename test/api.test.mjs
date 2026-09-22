import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createHandlers } from "../src/lib/handlers.js";
import { createMemoryStore } from "../src/lib/store-memory.js";
import { ConflictError } from "../src/lib/errors.js";

async function setup() {
  const webRoot = await mkdtemp(path.join(os.tmpdir(), "web-"));
  await writeFile(path.join(webRoot, "index.html"), "<!doctype html><title>t</title>");
  await writeFile(path.join(webRoot, "app.js"), "console.log(1)");
  await writeFile(path.join(webRoot, "app.css"), "body{}");
  await writeFile(path.join(webRoot, "secret.txt"), "nope");
  const store = createMemoryStore();
  const { handle } = createHandlers({ store, webRoot });
  const call = (method, p, body, headers = {}) =>
    handle({
      method, path: p,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
  return { call, store, webRoot };
}
const json = (r) => JSON.parse(r.body);

test("health reports the store kind", async () => {
  const { call } = await setup();
  const r = await call("GET", "/api/health");
  assert.equal(r.status, 200);
  assert.deepEqual(json(r), { ok: true, store: "memory" });
});

test("create fills defaults, stamps audit fields, and lists", async () => {
  const { call } = await setup();
  const r = await call("POST", "/api/opps", { account: "  Contoso  " }, { "x-ms-client-principal-name": "don@example.com" });
  assert.equal(r.status, 201);
  const { item } = json(r);
  assert.equal(item.account, "Contoso");
  assert.equal(item.stage, "Identified");
  assert.equal(item.size, null);
  assert.equal(item.createdBy, "don@example.com");
  assert.match(item.id, /^[0-9a-f-]{36}$/);
  const list = json(await call("GET", "/api/opps"));
  assert.equal(list.items.length, 1);
});

test("create rejects bad input with readable details", async () => {
  const { call } = await setup();
  const r = await call("POST", "/api/opps", { account: "", stage: "Nope", size: -5, closeDate: "2026-02-31", gmPct: 95, lead: "Acme", extra: 1 });
  assert.equal(r.status, 400);
  const d = json(r).details.join(" ");
  for (const s of ["account is required", "stage must be one of", "size must be", "closeDate must be", "gmPct must be", "lead must be", "Unknown field: extra"]) {
    assert.ok(d.includes(s), `missing: ${s}`);
  }
});

test("patch merges only the fields sent", async () => {
  const { call } = await setup();
  const { item } = json(await call("POST", "/api/opps", { account: "A", seller: "Sam", size: 100000 }));
  const r = await call("PATCH", `/api/opps/${item.id}`, { stage: "Qualified" }, { "x-ms-client-principal-name": "pat@example.com" });
  assert.equal(r.status, 200);
  const updated = json(r).item;
  assert.equal(updated.stage, "Qualified");
  assert.equal(updated.seller, "Sam");
  assert.equal(updated.size, 100000);
  assert.equal(updated.updatedBy, "pat@example.com");
});

test("patch rejects unknown fields, empty patches, and cannot change id", async () => {
  const { call } = await setup();
  const { item } = json(await call("POST", "/api/opps", { account: "A" }));
  assert.equal((await call("PATCH", `/api/opps/${item.id}`, { id: "hijack" })).status, 400);
  assert.equal((await call("PATCH", `/api/opps/${item.id}`, {})).status, 400);
  assert.equal((await call("PATCH", "/api/opps/missing", { stage: "Won" })).status, 404);
});

test("patch retries after an etag conflict instead of losing the other edit", async () => {
  const { call, store } = await setup();
  const { item } = json(await call("POST", "/api/opps", { account: "A", seller: "Sam" }));
  // Simulate another writer sneaking in between our read and our write, once.
  const realReplace = store.replace.bind(store);
  let sneaked = false;
  store.replace = async (id, doc, etag) => {
    if (!sneaked) {
      sneaked = true;
      const cur = await store.get(id);
      await realReplace(id, { ...cur.doc, seller: "Riley" }, cur.etag);
    }
    return realReplace(id, doc, etag);
  };
  const r = await call("PATCH", `/api/opps/${item.id}`, { stage: "Qualified" });
  assert.equal(r.status, 200);
  const updated = json(r).item;
  assert.equal(updated.stage, "Qualified");
  assert.equal(updated.seller, "Riley"); // the concurrent edit survived
});

test("patch gives up with 409 after repeated conflicts", async () => {
  const { call, store } = await setup();
  const { item } = json(await call("POST", "/api/opps", { account: "A" }));
  store.replace = async () => { throw new ConflictError(); };
  assert.equal((await call("PATCH", `/api/opps/${item.id}`, { stage: "Won" })).status, 409);
});

test("delete removes, then 404s", async () => {
  const { call } = await setup();
  const { item } = json(await call("POST", "/api/opps", { account: "A" }));
  assert.equal((await call("DELETE", `/api/opps/${item.id}`, undefined, {})).status, 200);
  assert.equal((await call("DELETE", `/api/opps/${item.id}`, undefined, {})).status, 404);
});

test("ids with path characters are refused", async () => {
  const { call } = await setup();
  assert.equal((await call("PATCH", "/api/opps/a%2Fb", { stage: "Won" })).status, 400);
  assert.equal((await call("DELETE", "/api/opps/a b")).status, 400);
});

test("settings default, validate, and persist", async () => {
  const { call } = await setup();
  const d = json(await call("GET", "/api/settings")).settings;
  assert.equal(d.marginBasis, "price");
  assert.equal(d.defaultGm, 30);
  assert.equal((await call("PUT", "/api/settings", { marginBasis: "cost", defaultGm: 999, probs: {} })).status, 400);
  const next = { marginBasis: "cost", defaultGm: 25, probs: { ...d.probs, Qualified: 40 } };
  assert.equal((await call("PUT", "/api/settings", next)).status, 200);
  const back = json(await call("GET", "/api/settings")).settings;
  assert.equal(back.marginBasis, "cost");
  assert.equal(back.probs.Qualified, 40);
});

test("writes require a JSON content type and same origin", async () => {
  const { call } = await setup();
  assert.equal((await call("POST", "/api/opps", "{}", { "content-type": "text/plain" })).status, 415);
  assert.equal((await call("POST", "/api/opps", { account: "A" }, { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await call("POST", "/api/opps", { account: "A" }, { origin: "https://evil.example", host: "app.example" })).status, 403);
  assert.equal((await call("POST", "/api/opps", { account: "A" }, { origin: "https://app.example", host: "app.example" })).status, 201);
  assert.equal((await call("POST", "/api/opps", { account: "A" }, { "sec-fetch-site": "same-origin" })).status, 201);
});

test("bad JSON and oversized bodies are rejected", async () => {
  const { call } = await setup();
  assert.equal((await call("POST", "/api/opps", "{nope")).status, 400);
  assert.equal((await call("POST", "/api/opps", JSON.stringify({ account: "A", notes: "x".repeat(70000) }))).status, 413);
});

test("static files: whitelist only, no traversal, security headers present", async () => {
  const { call } = await setup();
  const home = await call("GET", "/");
  assert.equal(home.status, 200);
  assert.match(home.headers["Content-Type"], /text\/html/);
  assert.match(home.headers["Content-Security-Policy"], /script-src 'self'/);
  assert.equal(home.headers["X-Content-Type-Options"], "nosniff");
  assert.equal((await call("GET", "/app.js")).status, 200);
  assert.equal((await call("GET", "/secret.txt")).status, 404);
  assert.equal((await call("GET", "/../secret.txt")).status, 404);
  assert.equal((await call("GET", "/%2e%2e/secret.txt")).status, 404);
});

test("me reflects the sign in header", async () => {
  const { call } = await setup();
  assert.deepEqual(json(await call("GET", "/api/me")), { name: "", authenticated: false, bulk: false, ai: false, aiWhy: "signin" });
  assert.deepEqual(json(await call("GET", "/api/me", undefined, { "x-ms-client-principal-name": "don@example.com" })), { name: "don@example.com", authenticated: true, bulk: true, ai: false, aiWhy: "not-configured" });
});

test("unknown api routes and methods", async () => {
  const { call } = await setup();
  assert.equal((await call("GET", "/api/nope")).status, 404);
  assert.equal((await call("GET", "/api/opps/x/y")).status, 404);
  assert.equal((await call("PUT", "/api/opps", {})).status, 405);
});
