// Framework free request handling. The Azure Functions adapter, the local dev server and the
// tests all call handle(), so what you test locally is the same code path that runs in Azure.
//
// handle({ method, path, headers, body }) -> { status, headers, body }
//   headers: lower case keys. body: raw request text (or undefined). Response body is a string, or a Buffer for the .xlsx export.

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ConflictError, ImportError, StaleError } from "./errors.js";
import { AiError } from "./ai.js";
import { TranscriptError, extractTranscript } from "./transcript.js";
import { analyzeTranscript, appendActivity, isRealDate, validateNote } from "./transcript-analysis.js";
import { mergeUpdate } from "./mutate.js";
import { DEFAULT_SETTINGS, ID_PATTERN, validateOpp, validateSettings } from "./validate.js";
import { XLSX_TYPE, applyPlan, buildWorkbook, describePlan, parseWorkbook, planImport } from "./xlsx.js";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024; // the .xlsx itself
const MAX_IMPORT_BODY_BYTES = 6 * 1024 * 1024; // the JSON wrapper with the file base64 encoded

const STATIC_FILES = {
  "": { file: "index.html", type: "text/html; charset=utf-8" },
  "index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "theme.js": { file: "theme.js", type: "text/javascript; charset=utf-8" },
  "dash-calc.js": { file: "dash-calc.js", type: "text/javascript; charset=utf-8" },
  "dash.js": { file: "dash.js", type: "text/javascript; charset=utf-8" },
  "transcript-ui.js": { file: "transcript-ui.js", type: "text/javascript; charset=utf-8" },
  "app.css": { file: "app.css", type: "text/css; charset=utf-8" },
};

// No third party origins at all. Inline style attributes are allowed because the UI sets bar widths.
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const SECURITY_HEADERS = {
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

const respond = (status, payload, extra = {}) => ({
  status,
  headers: { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8", ...extra },
  body: JSON.stringify(payload),
});
const fail = (status, message, details) => respond(status, details?.length ? { error: message, details } : { error: message });

/** Who made the request. Azure built in authentication sets this header; anonymous until it is enabled. */
export function actorFrom(headers) {
  const raw = headers["x-ms-client-principal-name"];
  return typeof raw === "string" ? raw.trim().slice(0, 120) : "";
}

/**
 * Cross site request guard for state changing calls. Once cookie based sign in is on, a hostile
 * page could otherwise submit requests as the signed in user. Browsers always send
 * Sec-Fetch-Site, and Origin on cross origin writes, so both are checked when present.
 */
function crossSiteBlocked(headers) {
  const site = headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return true;
  const origin = headers["origin"];
  if (origin) {
    const host = headers["x-forwarded-host"] || headers["host"];
    try {
      if (new URL(origin).host !== host) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/**
 * allowAnonymousBulk: import and export are refused unless a user is signed in, because they move the whole
 * data set in one request. Set true only for local development or for testing with fictional data.
 * The same gate covers transcript analysis, which sends customer conversations to a model and costs money per call.
 * ai: a Foundry client (or the local mock) with extract(), or null when the feature is not configured.
 */
export function createHandlers({ store, webRoot, log = () => {}, info = () => {}, allowAnonymousBulk = false, ai = null }) {
  const fileCache = new Map();

  async function serveStatic(rel) {
    const entry = STATIC_FILES[rel];
    if (!entry) return fail(404, "Not found.");
    if (!fileCache.has(entry.file)) {
      fileCache.set(entry.file, await readFile(path.join(webRoot, entry.file)));
    }
    return {
      status: 200,
      headers: { ...SECURITY_HEADERS, "Content-Type": entry.type },
      body: fileCache.get(entry.file).toString("utf8"),
    };
  }

  const bulkAllowed = (actor) => allowAnonymousBulk || actor !== "";
  const bulkBlocked = () =>
    fail(403, "Import and export are turned off until sign in is enabled. See the README section Before real customer data.");

  /** Why the transcript feature is unavailable to this caller, or null when it is available. */
  const aiWhy = (actor) => (!bulkAllowed(actor) ? "signin" : !ai ? "not-configured" : null);
  const aiBlocked = (actor) =>
    aiWhy(actor) === "signin"
      ? fail(403, "Transcript analysis is turned off until sign in is enabled. See the README section Before real customer data.")
      : aiWhy(actor) === "not-configured"
        ? fail(503, "Transcript analysis is not set up yet. It needs a Microsoft Foundry resource, see the README section Transcripts.")
        : null;

  /** The list and item responses carry only a count of meetings. The entries load on demand, so polling stays light. */
  function publicOpp(doc) {
    if (!doc || !Array.isArray(doc.activity)) return doc;
    const { activity, ...rest } = doc;
    return activity.length ? { ...rest, activityCount: activity.length, lastActivityAt: activity[activity.length - 1].at } : rest;
  }

  function parseJson(body, maxBytes = MAX_BODY_BYTES) {
    if (body === undefined || body === "") return { error: "A JSON body is required." };
    if (Buffer.byteLength(body) > maxBytes) return { error: "Body is too large.", status: 413 };
    try {
      return { value: JSON.parse(body) };
    } catch {
      return { error: "Body is not valid JSON." };
    }
  }

  async function currentSettings() {
    const saved = await store.getSettings();
    const { value } = saved ? validateSettings(saved) : {};
    return value ?? { ...DEFAULT_SETTINGS, probs: { ...DEFAULT_SETTINGS.probs } };
  }

  async function getSettings() {
    return respond(200, { settings: await currentSettings() });
  }

  async function putSettings(req) {
    const parsed = parseJson(req.body);
    if (parsed.error) return fail(parsed.status ?? 400, parsed.error);
    const { value, errors } = validateSettings(parsed.value);
    if (errors.length) return fail(400, "Settings are not valid.", errors);
    await store.putSettings(value);
    return respond(200, { settings: value });
  }

  async function createOpp(req, actor) {
    const parsed = parseJson(req.body);
    if (parsed.error) return fail(parsed.status ?? 400, parsed.error);
    const { value, errors } = validateOpp(parsed.value);
    if (errors.length) return fail(400, "Opportunity is not valid.", errors);
    const now = new Date().toISOString();
    const item = await store.create({
      id: randomUUID(),
      ...value,
      createdAt: now,
      createdBy: actor,
      updatedAt: now,
      updatedBy: actor,
    });
    return respond(201, { item: publicOpp(item) });
  }

  async function patchOpp(id, req, actor) {
    const parsed = parseJson(req.body);
    if (parsed.error) return fail(parsed.status ?? 400, parsed.error);
    const { value, errors } = validateOpp(parsed.value, { partial: true });
    if (errors.length) return fail(400, "Opportunity is not valid.", errors);
    if (Object.keys(value).length === 0) return fail(400, "Nothing to update.");

    try {
      const item = await mergeUpdate(store, id, value, actor);
      return item ? respond(200, { item: publicOpp(item) }) : fail(404, "Opportunity not found. It may have been deleted.");
    } catch (e) {
      if (!(e instanceof ConflictError)) throw e;
    }
    return fail(409, "Someone else is editing this row. Reload and try again.");
  }

  async function listActivity(id) {
    const cur = await store.get(id);
    if (!cur) return fail(404, "Opportunity not found.");
    const items = Array.isArray(cur.doc.activity) ? [...cur.doc.activity].reverse() : [];
    return respond(200, { items });
  }

  /** Step 1 of a transcript: read it, ask the model, return a proposal. Writes nothing. */
  async function analyze(req, actor) {
    const blocked = aiBlocked(actor);
    if (blocked) return blocked;
    const parsed = parseJson(req.body, MAX_IMPORT_BODY_BYTES);
    if (parsed.error) return fail(parsed.status ?? 400, parsed.error);
    const b = parsed.value;
    if (b === null || typeof b !== "object" || Array.isArray(b)) return fail(400, "Body must be a JSON object.");
    if (b.oppId !== undefined && (typeof b.oppId !== "string" || !ID_PATTERN.test(b.oppId))) return fail(400, "Invalid oppId.");
    if (b.meetingDate !== undefined && !isRealDate(b.meetingDate)) return fail(400, "meetingDate must be a real date as YYYY-MM-DD.");
    const started = Date.now();
    try {
      let input;
      if (b.file && typeof b.file === "object") {
        if (typeof b.file.data !== "string" || b.file.data === "") return fail(400, "file.data, the file encoded as base64, is required.");
        input = { name: b.file.name, buffer: Buffer.from(b.file.data, "base64") };
      } else if (typeof b.text === "string") {
        input = { text: b.text };
      } else {
        return fail(400, "Send text, or a file as { name, data }.");
      }
      const { text, source } = await extractTranscript(input);
      const proposal = await analyzeTranscript({ ai, store, mode: b.mode, transcript: text, meetingDate: b.meetingDate, oppId: b.oppId });
      info(`transcript analysed by=${actor || "anonymous"} mode=${b.mode} chars=${text.length} changes=${proposal.changes.length} ms=${Date.now() - started}`);
      return respond(200, { ...proposal, source, chars: text.length });
    } catch (e) {
      if (e instanceof TranscriptError || e instanceof AiError) return fail(e.status, e.message);
      throw e;
    }
  }

  /**
   * Step 2: save what the person reviewed. The values are re-validated exactly like a manual edit, so a tampered
   * request cannot store anything the normal form could not. Only this route can write the meeting history.
   */
  async function applyTranscript(req, actor) {
    const blocked = aiBlocked(actor);
    if (blocked) return blocked;
    const parsed = parseJson(req.body);
    if (parsed.error) return fail(parsed.status ?? 400, parsed.error);
    const b = parsed.value;
    if (b === null || typeof b !== "object" || Array.isArray(b)) return fail(400, "Body must be a JSON object.");
    if (b.mode !== "update" && b.mode !== "new") return fail(400, "mode must be update or new.");
    const fieldsIn = b.fields ?? {};
    if (typeof fieldsIn !== "object" || Array.isArray(fieldsIn)) return fail(400, "fields must be an object.");
    if (Object.prototype.hasOwnProperty.call(fieldsIn, "notes")) return fail(400, "Transcripts do not change the Notes field.");
    const { value: fields, errors } = validateOpp(fieldsIn, { partial: b.mode === "update" });
    if (errors.length) return fail(400, "Opportunity is not valid.", errors);
    const meetingDate = b.meetingDate ?? new Date().toISOString().slice(0, 10);
    const note = validateNote(b.note, { source: typeof b.source === "string" ? b.source : "", actor, meetingDate, applied: Object.keys(fields) });
    if (note.errors) return fail(400, "Meeting note is not valid.", note.errors);

    if (b.mode === "new") {
      const now = new Date().toISOString();
      const item = await store.create({
        id: randomUUID(), ...fields, ...(note.value ? { activity: [note.value] } : {}),
        createdAt: now, createdBy: actor, updatedAt: now, updatedBy: actor,
      });
      info(`transcript applied by=${actor || "anonymous"} mode=new fields=${Object.keys(fields).length}`);
      return respond(201, { item: publicOpp(item) });
    }

    if (typeof b.oppId !== "string" || !ID_PATTERN.test(b.oppId)) return fail(400, "oppId is required to update an opportunity.");
    if (!Object.keys(fields).length && !note.value) return fail(400, "Nothing to save.");
    try {
      const item = await mergeUpdate(store, b.oppId, (doc) => {
        if (typeof b.baseUpdatedAt === "string" && (doc.updatedAt ?? "") !== b.baseUpdatedAt) throw new StaleError();
        return { ...fields, ...(note.value ? { activity: appendActivity(doc.activity, note.value) } : {}) };
      }, actor);
      if (!item) return fail(404, "Opportunity not found. It may have been deleted.");
      info(`transcript applied by=${actor || "anonymous"} mode=update fields=${Object.keys(fields).length}`);
      return respond(200, { item: publicOpp(item) });
    } catch (e) {
      if (e instanceof StaleError) return fail(409, "Someone changed this opportunity after the transcript was analysed. Run the analysis again so you review the current values.");
      if (e instanceof ConflictError) return fail(409, "Someone else is editing this row. Try again.");
      throw e;
    }
  }

  async function exportWorkbook(actor) {
    if (!bulkAllowed(actor)) return bulkBlocked();
    const [opps, settings] = await Promise.all([store.list(), currentSettings()]);
    const buffer = await buildWorkbook({ opps, settings });
    const name = `ai-pipeline-${new Date().toISOString().slice(0, 10)}.xlsx`;
    return {
      status: 200,
      headers: { ...SECURITY_HEADERS, "Content-Type": XLSX_TYPE, "Content-Disposition": `attachment; filename="${name}"` },
      body: buffer,
    };
  }

  /** Both import steps re-read the uploaded file, so apply never trusts what a preview said. */
  async function importWorkbook(step, req, actor) {
    if (!bulkAllowed(actor)) return bulkBlocked();
    const parsed = parseJson(req.body, MAX_IMPORT_BODY_BYTES);
    if (parsed.error) return fail(parsed.status ?? 400, parsed.error);
    const data = parsed.value?.data;
    if (typeof data !== "string" || data === "") return fail(400, "data, the .xlsx file encoded as base64, is required.");
    const buffer = Buffer.from(data, "base64");
    if (buffer.length > MAX_UPLOAD_BYTES) return fail(413, "That file is larger than 4 MB.");
    if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
      return fail(400, "That does not look like an .xlsx file. Older .xls files and .csv files are not supported.");
    }
    try {
      const plan = planImport(await parseWorkbook(buffer), await store.list());
      if (step === "preview") return respond(200, describePlan(plan));
      const result = await applyPlan(store, plan, actor, { log });
      return respond(200, { result });
    } catch (e) {
      if (e instanceof ImportError) return fail(400, e.message);
      throw e;
    }
  }

  async function handleApi(rel, req) {
    const method = req.method;
    const actor = actorFrom(req.headers);
    const parts = rel.split("/").slice(1); // drop "api"
    const [resource, id, ...extra] = parts;

    if (resource === "opps" && id && extra.length === 1 && extra[0] === "activity") {
      if (!ID_PATTERN.test(id)) return fail(400, "Invalid id.");
      return method === "GET" ? listActivity(id) : fail(405, "Method not allowed.");
    }
    if (extra.length) return fail(404, "Not found.");

    if (resource === "health" && !id) {
      return method === "GET" ? respond(200, { ok: true, store: store.kind }) : fail(405, "Method not allowed.");
    }
    if (resource === "me" && !id) {
      return method === "GET"
        ? respond(200, { name: actor, authenticated: actor !== "", bulk: bulkAllowed(actor), ai: aiWhy(actor) === null, ...(aiWhy(actor) ? { aiWhy: aiWhy(actor) } : {}), ...(ai && ai.kind === "mock" ? { aiDemo: true } : {}) })
        : fail(405, "Method not allowed.");
    }

    const isWrite = method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
    if (isWrite) {
      if (crossSiteBlocked(req.headers)) return fail(403, "Cross site requests are not allowed.");
      if ((method !== "DELETE") && !String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return fail(415, "Content-Type must be application/json.");
      }
    }

    if (resource === "export" && !id) {
      if (method !== "GET") return fail(405, "Method not allowed.");
      if (crossSiteBlocked(req.headers)) return fail(403, "Cross site requests are not allowed.");
      return exportWorkbook(actor);
    }

    if (resource === "transcript" && (id === "analyze" || id === "apply")) {
      if (method !== "POST") return fail(405, "Method not allowed.");
      return id === "analyze" ? analyze(req, actor) : applyTranscript(req, actor);
    }

    if (resource === "import" && (id === "preview" || id === "apply")) {
      return method === "POST" ? importWorkbook(id, req, actor) : fail(405, "Method not allowed.");
    }

    if (resource === "opps") {
      if (!id) {
        if (method === "GET") return respond(200, { items: (await store.list()).map(publicOpp) });
        if (method === "POST") return createOpp(req, actor);
        return fail(405, "Method not allowed.");
      }
      if (!ID_PATTERN.test(id)) return fail(400, "Invalid id.");
      if (method === "PATCH") return patchOpp(id, req, actor);
      if (method === "DELETE") {
        const removed = await store.remove(id);
        return removed ? respond(200, { deleted: id }) : fail(404, "Opportunity not found.");
      }
      return fail(405, "Method not allowed.");
    }

    if (resource === "settings" && !id) {
      if (method === "GET") return getSettings();
      if (method === "PUT") return putSettings(req);
      return fail(405, "Method not allowed.");
    }

    return fail(404, "Not found.");
  }

  async function handle(req) {
    const rel = String(req.path ?? "").replace(/^\/+|\/+$/g, "");
    try {
      if (rel === "api" || rel.startsWith("api/")) return await handleApi(rel, req);
      if (req.method === "GET" || req.method === "HEAD") return await serveStatic(rel);
      return fail(405, "Method not allowed.");
    } catch (e) {
      log(`Unhandled error on ${req.method} /${rel}: ${e?.stack ?? e}`);
      return fail(500, "Unexpected error. It has been logged.");
    }
  }

  return { handle };
}
