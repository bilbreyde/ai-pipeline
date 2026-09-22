import { test } from "node:test";
import assert from "node:assert/strict";
import { AiError, baseUrl, createFoundryClient } from "../src/lib/ai.js";

const SCHEMA = { type: "object", additionalProperties: false, required: ["a"], properties: { a: { type: "string" } } };
const ok = (content, extra = {}) => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ choices: [{ finish_reason: "stop", message: { content, ...extra } }] }) });
const err = (status, message = "", headers = {}) => ({ ok: false, status, headers: new Headers(headers), json: async () => ({ error: { message, code: /filtered/.test(message) ? "content_filter" : "x" } }) });

function client(responses, opts = {}) {
  const calls = [];
  const tokens = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return r;
  };
  const credential = { getToken: async (scope) => { tokens.push(scope); return { token: `tok-${tokens.length}` }; } };
  return { c: createFoundryClient({ endpoint: "https://zpipe-ai.openai.azure.com/", deployment: "gpt41", credential, fetchImpl, ...opts }), calls, tokens };
}
const run = (c) => c.extract({ system: "sys", user: "usr", schema: SCHEMA, name: "thing" });

test("endpoint forms all reduce to the v1 chat completions url", () => {
  const want = "https://zpipe-ai.openai.azure.com/openai/v1/chat/completions";
  assert.equal(baseUrl("https://zpipe-ai.openai.azure.com/"), want);
  assert.equal(baseUrl("https://zpipe-ai.openai.azure.com/openai/v1"), want);
  assert.equal(baseUrl("https://x.services.ai.azure.com/api/projects/p1"), "https://x.services.ai.azure.com/openai/v1/chat/completions");
  assert.throws(() => baseUrl("http://insecure.example.com"), /https/);
  assert.throws(() => baseUrl("not a url"), /valid URL/);
});

test("request shape: bearer token, deployment as model, strict json schema, no api key", async () => {
  const { c, calls } = client([ok('{"a":"hi"}')]);
  assert.deepEqual(await run(c), { a: "hi" });
  const { url, init, body } = calls[0];
  assert.equal(url, "https://zpipe-ai.openai.azure.com/openai/v1/chat/completions");
  assert.equal(init.headers.Authorization, "Bearer tok-1");
  assert.ok(!("api-key" in init.headers));
  assert.equal(body.model, "gpt41");
  assert.deepEqual(body.response_format, { type: "json_schema", json_schema: { name: "thing", strict: true, schema: SCHEMA } });
  assert.deepEqual(body.messages.map((m) => m.role), ["system", "user"]);
  assert.equal(body.max_completion_tokens, 16000, "reasoning tokens count against this cap, so it must be generous");
  assert.ok(!("temperature" in body), "reasoning deployments reject a temperature");
  assert.ok(!("reasoning_effort" in body), "not sent unless configured");
});

test("a 401 retries once with the other token audience", async () => {
  const { c, tokens } = client([err(401, "bad audience"), ok('{"a":"x"}')]);
  await run(c);
  assert.deepEqual(tokens, ["https://cognitiveservices.azure.com/.default", "https://ai.azure.com/.default"]);
});

test("a 401 on both audiences explains the missing role", async () => {
  const { c } = client([err(401), err(401)]);
  await assert.rejects(run(c), (e) => e instanceof AiError && /Cognitive Services OpenAI User/.test(e.message));
});

test("older deployments that want max_tokens are retried with it", async () => {
  const { c, calls } = client([err(400, "Unsupported parameter: 'max_completion_tokens' is not supported with this model."), ok('{"a":"y"}')]);
  await run(c);
  assert.ok("max_tokens" in calls[1].body && !("max_completion_tokens" in calls[1].body));
});

test("429 waits and retries once, then reports the quota problem", async () => {
  const { c, calls } = client([err(429, "", { "retry-after": "0" }), ok('{"a":"z"}')]);
  assert.deepEqual(await run(c), { a: "z" });
  assert.equal(calls.length, 2);
  const { c: c2 } = client([err(429, "", { "retry-after": "0" }), err(429)]);
  await assert.rejects(run(c2), (e) => e.status === 503 && /busy or out of quota/.test(e.message));
});

test("errors are plain language and carry no request content", async () => {
  const cases = [[404, /deployment was not found/], [400, /content filter/, "The response was filtered due to the prompt triggering Azure OpenAI's content management policy"], [500, /returned an error \(500\)/]];
  for (const [status, re, msg] of cases) {
    const { c } = client([err(status, msg ?? "")]);
    await assert.rejects(run(c), (e) => e instanceof AiError && re.test(e.message) && !e.message.includes("usr"));
  }
});

test("timeouts and network failures", async () => {
  const slow = async (url, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  const c = createFoundryClient({ endpoint: "https://x.openai.azure.com", deployment: "d", credential: { getToken: async () => ({ token: "t" }) }, fetchImpl: slow, timeoutMs: 20 });
  await assert.rejects(run(c), (e) => e.status === 504 && /took too long/.test(e.message));
  const { c: c2 } = client([new TypeError("fetch failed")]);
  await assert.rejects(run(c2), /Could not reach/);
});

test("refusals, truncation and bad json are reported, not returned", async () => {
  await assert.rejects(run(client([ok(null, { refusal: "no" })]).c), /declined/);
  await assert.rejects(run(client([{ ...ok("{"), json: async () => ({ choices: [{ finish_reason: "length", message: { content: "{" } }] }) }]).c), /cut off/);
  await assert.rejects(run(client([ok("not json")]).c), /not valid JSON/);
});

test("reasoning_effort is sent only when configured", async () => {
  const { c, calls } = client([ok('{"a":"1"}')], { reasoningEffort: "low" });
  await run(c);
  assert.equal(calls[0].body.reasoning_effort, "low");
});

test("a deployment that rejects reasoning_effort is retried without it, and stays without it", async () => {
  const { c, calls } = client([err(400, "Unrecognized request argument supplied: reasoning_effort"), ok('{"a":"2"}'), ok('{"a":"3"}')], { reasoningEffort: "low" });
  assert.deepEqual(await run(c), { a: "2" });
  assert.ok("reasoning_effort" in calls[0].body && !("reasoning_effort" in calls[1].body));
});

test("all three parameter fallbacks can stack in one call (audience, max_tokens, reasoning_effort)", async () => {
  const { c, calls, tokens } = client(
    [err(401), err(400, "Unsupported parameter: 'max_completion_tokens'"), err(400, "Unsupported parameter: reasoning_effort"), ok('{"a":"ok"}')],
    { reasoningEffort: "low" },
  );
  assert.deepEqual(await run(c), { a: "ok" });
  assert.equal(calls.length, 4);
  assert.equal(tokens.length, 4);
  const last = calls[3].body;
  assert.ok("max_tokens" in last && !("max_completion_tokens" in last) && !("reasoning_effort" in last));
});

test("aiFromEnv builds a client only when Foundry is configured", async () => {
  const { aiFromEnv } = await import("../src/lib/ai.js");
  assert.equal(await aiFromEnv({}), null);
  const ai = await aiFromEnv({ FOUNDRY_ENDPOINT: "https://x.openai.azure.com", FOUNDRY_DEPLOYMENT: "d", FOUNDRY_REASONING_EFFORT: " Low " });
  assert.equal(ai.kind, "foundry");
});
