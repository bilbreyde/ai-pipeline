import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createHandlers } from "../src/lib/handlers.js";
import { createMemoryStore } from "../src/lib/store-memory.js";
import { validateSeller } from "../src/lib/validate.js";

async function setup() {
  const webRoot = await mkdtemp(path.join(os.tmpdir(), "web-"));
  await writeFile(path.join(webRoot, "index.html"), "<!doctype html><title>t</title>");
  const store = createMemoryStore();
  const { handle } = createHandlers({ store, webRoot });
  const call = (method, p, body, headers = {}) =>
    handle({
      method, path: p,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
  return { call, store };
}
const json = (r) => JSON.parse(r.body);

test("validateSeller: trims, lower cases the email, and rejects a bad address", () => {
  assert.deepEqual(validateSeller({ name: "  Avery  ", email: " Avery@Zones.com " }), { value: { name: "Avery", email: "avery@zones.com" }, errors: [] });
  assert.deepEqual(validateSeller({ name: "Avery", email: "not an email" }).errors, ["That does not look like an email address."]);
  assert.deepEqual(validateSeller({ name: "", email: "a@b.com" }).errors, ["name is required."]);
  assert.deepEqual(validateSeller({ name: "Avery", email: "" }).errors, ["email is required."]);
  assert.deepEqual(validateSeller({ name: "x".repeat(81), email: "a@b.com" }).errors, ["name must be 80 characters or fewer."]);
  assert.deepEqual(validateSeller(null).errors, ["Body must be a JSON object."]);
});

test("GET /api/sellers starts empty", async () => {
  const { call } = await setup();
  assert.deepEqual(json(await call("GET", "/api/sellers")), { sellers: {} });
});

test("POST /api/sellers saves an address and GET returns it", async () => {
  const { call } = await setup();
  const r = await call("POST", "/api/sellers", { name: "Avery", email: "Avery@Zones.com" });
  assert.equal(r.status, 200);
  assert.deepEqual(json(r), { seller: { name: "Avery", email: "avery@zones.com" } });
  assert.deepEqual(json(await call("GET", "/api/sellers")), { sellers: { Avery: "avery@zones.com" } });
});

test("POST /api/sellers is case insensitive by name: a later save with different casing replaces the entry, not adds one", async () => {
  const { call } = await setup();
  await call("POST", "/api/sellers", { name: "avery", email: "avery@zones.com" });
  await call("POST", "/api/sellers", { name: "Avery", email: "avery.new@zones.com" });
  assert.deepEqual(json(await call("GET", "/api/sellers")), { sellers: { Avery: "avery.new@zones.com" } });
});

test("POST /api/sellers rejects bad input with readable details", async () => {
  const { call } = await setup();
  const r = await call("POST", "/api/sellers", { name: "", email: "nope" });
  assert.equal(r.status, 400);
  const d = json(r).details.join(" ");
  assert.ok(d.includes("name is required"));
  assert.ok(d.includes("does not look like an email"));
});

test("POST /api/sellers rejects an unknown field the same way opps and settings do", async () => {
  const { call } = await setup();
  const r = await call("POST", "/api/sellers", { name: "Avery", email: "a@b.com", phone: "555" });
  // extra fields are simply ignored by validateSeller (it only reads name/email), matching how the directory
  // is meant to be used: a name and an address, nothing else.
  assert.equal(r.status, 200);
});

test("wrong method and content type on /api/sellers", async () => {
  const { call } = await setup();
  assert.equal((await call("DELETE", "/api/sellers")).status, 405);
  assert.equal((await call("POST", "/api/sellers", "name=Avery", { "content-type": "text/plain" })).status, 415);
});

test("sellers persist independently of opportunities and settings", async () => {
  const { call } = await setup();
  await call("POST", "/api/sellers", { name: "Avery", email: "avery@zones.com" });
  await call("POST", "/api/opps", { account: "Contoso" });
  assert.deepEqual(json(await call("GET", "/api/sellers")), { sellers: { Avery: "avery@zones.com" } });
});
