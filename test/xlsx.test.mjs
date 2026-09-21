import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import ExcelJS from "exceljs";
import { createHandlers } from "../src/lib/handlers.js";
import { createMemoryStore } from "../src/lib/store-memory.js";
import { DEFAULT_SETTINGS, OPP_FIELDS } from "../src/lib/validate.js";
import { SAMPLE_OPPS } from "../src/lib/sample-data.js";
import { applyPlan, buildWorkbook, describePlan, parseWorkbook, planImport, XLSX_TYPE } from "../src/lib/xlsx.js";

const settings = { ...DEFAULT_SETTINGS, probs: { ...DEFAULT_SETTINGS.probs } };
const NOW = new Date().toISOString();

async function seeded(items = SAMPLE_OPPS) {
  const store = createMemoryStore();
  for (const o of items) await store.upsert({ ...o, createdAt: NOW, createdBy: "t", updatedAt: NOW, updatedBy: "t" });
  return store;
}
const load = async (buf) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf); return wb; };
const save = async (wb) => Buffer.from(await wb.xlsx.writeBuffer());
const pick = (o) => Object.fromEntries(OPP_FIELDS.map((k) => [k, o[k]]));

test("export: header, one row per opportunity, formulas with cached results, assumptions", async () => {
  const store = await seeded();
  const opps = await store.list();
  const wb = await load(await buildWorkbook({ opps, settings }));
  const ws = wb.getWorksheet("Pipeline");
  assert.equal(ws.getRow(1).getCell(1).value, "Account");
  assert.equal(ws.getRow(1).getCell(1).fill.fgColor.argb, "FF003087");
  assert.equal(ws.actualRowCount, opps.length + 1);
  const sized = ws.getRows(2, opps.length).find((r) => typeof r.getCell(8).value === "number");
  const m = sized.getCell(13).value;
  assert.match(m.formula, /^IF\(H\d+="",""/);
  assert.equal(m.result, sized.getCell(8).value * 0.3);
  const as = wb.getWorksheet("Assumptions");
  assert.equal(as.getCell("B2").value, "price");
  assert.equal(as.getCell("B3").value, 30);
  assert.equal(as.getCell("A6").value, "Identified");
});

test("round trip: export then import into an empty tracker recreates every field and id", async () => {
  const a = await seeded();
  const buf = await buildWorkbook({ opps: await a.list(), settings });
  const b = createMemoryStore();
  const plan = planImport(await parseWorkbook(buf), await b.list());
  assert.equal(plan.format, "pipeline");
  assert.equal(plan.summary.create, SAMPLE_OPPS.length);
  assert.equal(plan.summary.skipped, 0);
  const res = await applyPlan(b, plan, "tester");
  assert.equal(res.created, SAMPLE_OPPS.length);
  assert.deepEqual(res.failed, []);
  const byId = (list) => Object.fromEntries(list.map((o) => [o.id, pick(o)]));
  assert.deepEqual(byId(await b.list()), byId(await a.list()));
  const any = (await b.list())[0];
  assert.equal(any.createdBy, "tester");
});

test("re-importing the same export changes nothing", async () => {
  const a = await seeded();
  const buf = await buildWorkbook({ opps: await a.list(), settings });
  const plan = planImport(await parseWorkbook(buf), await a.list());
  assert.equal(plan.summary.unchanged, SAMPLE_OPPS.length);
  assert.equal(plan.summary.create + plan.summary.update + plan.summary.skipped, 0);
});

test("editing cells in Excel updates only the changed fields, and blank clears optional ones", async () => {
  const store = await seeded();
  const before = await store.list();
  const wb = await load(await buildWorkbook({ opps: before, settings }));
  const ws = wb.getWorksheet("Pipeline");
  const row = ws.getRow(2);
  const id = row.getCell(16).value;
  row.getCell(3).value = "Won";      // stage
  row.getCell(8).value = 123456;     // deal size
  row.getCell(6).value = null;       // seller cleared
  const plan = planImport(await parseWorkbook(await save(wb)), before);
  const upd = plan.rows.filter((r) => r.action === "update");
  assert.equal(upd.length, 1);
  assert.equal(upd[0].id, id);
  assert.deepEqual(upd[0].changed.sort(), ["seller", "size", "stage"]);
  const res = await applyPlan(store, plan, "pat@example.com");
  assert.equal(res.updated, 1);
  const after = (await store.get(id)).doc;
  assert.equal(after.stage, "Won");
  assert.equal(after.size, 123456);
  assert.equal(after.seller, "");
  assert.equal(after.updatedBy, "pat@example.com");
  const orig = before.find((o) => o.id === id);
  assert.equal(after.nextStep, orig.nextStep); // untouched field survives
});

test("rows with problems are skipped with a reason, good rows still import", async () => {
  const store = createMemoryStore();
  const wb = await load(await buildWorkbook({ opps: [], settings }));
  const ws = wb.getWorksheet("Pipeline");
  const put = (r, vals) => vals.forEach((v, i) => { if (v !== undefined) ws.getRow(r).getCell(i + 1).value = v; });
  put(2, ["Good Co", "Pilot", "Discovery", "", "Zones", "Sam", "Target", "250k", 35]);
  put(3, ["Bad Stage Co", "", "Maybe"]);
  put(4, ["", "No name"]);
  put(5, ["Bad Size Co", "", "Qualified", "", "", "", "", "lots"]);
  put(6, ["Good Co", "Pilot", "Qualified"]);           // duplicate of row 2
  put(7, ["Bad GM Co", "", "Qualified", "", "", "", "", 1000, 95]);
  put(8, ["Bad Date Co", "", "Qualified", "", "", "", "", 10, null, "tomorrow"]);
  const plan = planImport(await parseWorkbook(await save(wb)), []);
  assert.equal(plan.summary.create, 1);
  assert.equal(plan.summary.skipped, 6);
  const reasons = Object.fromEntries(plan.rows.map((r) => [r.line, r.reason]));
  assert.match(reasons[3], /Stage "Maybe"/);
  assert.match(reasons[4], /Account is blank/);
  assert.match(reasons[5], /not a number/);
  assert.match(reasons[6], /Same opportunity as row 2/);
  assert.match(reasons[7], /gmPct must be/);
  assert.match(reasons[8], /not a date/);
  const res = await applyPlan(store, plan, "");
  assert.equal(res.created, 1);
  const [only] = await store.list();
  assert.equal(only.size, 250000);   // "250k"
  assert.equal(only.gmPct, 35);
  assert.equal(only.createdBy, "import"); // anonymous actor falls back to a label
});

test("a percent formatted GM cell (0.35) is read as 35", async () => {
  const wb = await load(await buildWorkbook({ opps: [], settings }));
  const ws = wb.getWorksheet("Pipeline");
  ws.getRow(2).getCell(1).value = "Pct Co";
  ws.getRow(2).getCell(9).value = 0.35;
  const plan = planImport(await parseWorkbook(await save(wb)), []);
  assert.equal(plan.rows[0].create.gmPct, 35);
});

async function legacyWorkbook(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Accounts ");
  ws.addRow(["Account", "Opportunity", "Estimated Size", "Rev/GM", "Deal Size", "Thoughtworks Engaged?", "Status", "Next Steps", "Sales Segment", "Seller", "Lead By"]);
  rows.forEach((r) => ws.addRow(r));
  wb.addWorksheet("Other stuff").addRow(["ignore me"]);
  return save(wb);
}

test("original workbook: maps wording to stages, reads (100) as thousands, adds only new rows", async () => {
  const buf = await legacyWorkbook([
    ["Northwind (", "AI assistant", "$100K-$500K", 15000, "In Discovery (200K)", "Yes - actively engaged", "Active RFP Response", "Send SOW", "ENT", "Sam", "Thoughtworks lead"],
    ["Fabrikam", "Data platform", "", "", "(100)", "Potential", "Early stage", "", "MM", "", "Zones"],
    ["Contoso", "Copilot rollout", "", "", 75000, "", "Blocked on legal", "", "", "Riley", ""],
    ["", "spacer row", "", "", "", "", "", "", "", "", ""],
  ]);
  const existing = [{ id: "e1", account: "Contoso", opportunity: "Copilot rollout", stage: "Won", size: 1 }];
  const parsed = await parseWorkbook(buf);
  assert.equal(parsed.format, "legacy");
  assert.equal(parsed.sheet, "Accounts");
  const plan = planImport(parsed, existing);
  assert.equal(plan.summary.create, 2);
  assert.equal(plan.summary.unchanged, 1); // Contoso already there, left alone
  assert.equal(plan.summary.heuristicSizes, 1);
  const store = createMemoryStore();
  await store.upsert({ ...existing[0] });
  await applyPlan(store, plan, "don@example.com");
  const list = await store.list();
  const nw = list.find((o) => o.account === "Northwind");
  assert.equal(nw.stage, "Proposal / RFP");
  assert.equal(nw.size, 200000);
  assert.equal(nw.lead, "Thoughtworks");
  assert.equal(nw.tw, "Engaged");
  assert.match(nw.notes, /Original status: Active RFP Response/);
  assert.equal(list.find((o) => o.account === "Fabrikam").size, 100000);
  assert.equal(list.find((o) => o.account === "Contoso").stage, "Won"); // not reverted
  const again = planImport(parsed, await store.list());
  assert.equal(again.summary.create, 0); // idempotent
});

test("files that are not workbooks, or have no recognised header, are refused", async () => {
  await assert.rejects(parseWorkbook(Buffer.from("PK\x03\x04 not really a zip")), /could not be read/);
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet("Sheet1").addRow(["Name", "Value"]);
  await assert.rejects(parseWorkbook(await save(wb)), /recognises/);
});

test("more than the row limit is refused", async () => {
  const wb = await load(await buildWorkbook({ opps: [], settings }));
  const ws = wb.getWorksheet("Pipeline");
  for (let i = 2; i <= 1002; i++) ws.getRow(i).getCell(1).value = `Co ${i}`;
  await assert.rejects(parseWorkbook(await save(wb)), /limit for one import/);
});

test("text that looks like a formula is exported as text, not a formula", async () => {
  const opps = [{ id: "x1", account: "=HYPERLINK(\"http://evil\",\"x\")", opportunity: "+cmd", stage: "Identified", notes: "@SUM(1)", size: null }];
  const wb = await load(await buildWorkbook({ opps, settings }));
  const c = wb.getWorksheet("Pipeline").getRow(2).getCell(1);
  assert.equal(typeof c.value, "string");
  assert.equal(c.type, ExcelJS.ValueType.String);
});

// ---------- through the HTTP handler ----------

async function api({ allowAnonymousBulk = false } = {}) {
  const webRoot = await mkdtemp(path.join(os.tmpdir(), "web-"));
  await writeFile(path.join(webRoot, "index.html"), "x");
  const store = await seeded();
  const { handle } = createHandlers({ store, webRoot, allowAnonymousBulk });
  const call = (method, p, body, headers = {}) => handle({
    method, path: p,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  return { call, store };
}
const USER = { "x-ms-client-principal-name": "don@example.com" };
const json = (r) => JSON.parse(r.body);

test("export and import are refused without sign in unless explicitly allowed", async () => {
  const { call } = await api();
  assert.equal((await call("GET", "/api/export")).status, 403);
  assert.equal((await call("POST", "/api/import/preview", { data: "UEs=" })).status, 403);
  assert.equal((await call("POST", "/api/import/apply", { data: "UEs=" })).status, 403);
  assert.equal((await call("GET", "/api/export", undefined, USER)).status, 200);
  const open = await api({ allowAnonymousBulk: true });
  assert.equal((await open.call("GET", "/api/export")).status, 200);
});

test("export returns a real xlsx with a download filename", async () => {
  const { call } = await api();
  const r = await call("GET", "/api/export", undefined, USER);
  assert.equal(r.headers["Content-Type"], XLSX_TYPE);
  assert.match(r.headers["Content-Disposition"], /^attachment; filename="ai-pipeline-\d{4}-\d{2}-\d{2}\.xlsx"$/);
  assert.equal(r.headers["Cache-Control"], "no-store");
  assert.ok(Buffer.isBuffer(r.body));
  assert.equal(r.body.subarray(0, 2).toString(), "PK");
  assert.equal((await call("GET", "/api/export", undefined, { ...USER, "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await call("POST", "/api/export", {}, USER)).status, 405);
});

test("preview writes nothing, apply writes, and the summary matches", async () => {
  const { call, store } = await api();
  const buf = (await call("GET", "/api/export", undefined, USER)).body;
  // Change one deal in the file, add one new row.
  const wb = await load(buf);
  const ws = wb.getWorksheet("Pipeline");
  ws.getRow(2).getCell(8).value = 999;
  const n = ws.actualRowCount + 1;
  ws.getRow(n).getCell(1).value = "Brand New Co";
  const data = (await save(wb)).toString("base64");

  const before = (await store.list()).length;
  const pv = await call("POST", "/api/import/preview", { data }, USER);
  assert.equal(pv.status, 200);
  const p = json(pv);
  assert.equal(p.summary.create, 1);
  assert.equal(p.summary.update, 1);
  assert.equal((await store.list()).length, before); // preview is read only

  const ap = await call("POST", "/api/import/apply", { data }, USER);
  assert.equal(ap.status, 200);
  const { result } = json(ap);
  assert.equal(result.created, 1);
  assert.equal(result.updated, 1);
  assert.deepEqual(result.failed, []);
  const list = await store.list();
  assert.equal(list.length, before + 1);
  assert.ok(list.some((o) => o.account === "Brand New Co" && o.createdBy === "don@example.com"));
});

test("import rejects non xlsx uploads, missing data, oversize bodies, and cross site posts", async () => {
  const { call } = await api({ allowAnonymousBulk: true });
  const notZip = Buffer.from("hello there, not a workbook").toString("base64");
  assert.equal((await call("POST", "/api/import/preview", { data: notZip })).status, 400);
  assert.equal((await call("POST", "/api/import/preview", {})).status, 400);
  assert.equal((await call("POST", "/api/import/preview", "{nope")).status, 400);
  assert.equal((await call("POST", "/api/import/preview", { data: "A".repeat(7 * 1024 * 1024) })).status, 413);
  const junkZip = Buffer.from("PK\x03\x04junkjunkjunk").toString("base64");
  const bad = await call("POST", "/api/import/preview", { data: junkZip });
  assert.equal(bad.status, 400);
  assert.match(json(bad).error, /could not be read/);
  assert.equal((await call("POST", "/api/import/preview", { data: junkZip }, { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await call("POST", "/api/import/preview", { data: junkZip }, { "content-type": "text/plain" })).status, 415);
  assert.equal((await call("GET", "/api/import/preview")).status, 405);
  assert.equal((await call("POST", "/api/import/nope", {})).status, 404);
});

test("describePlan lists skipped rows first-class and never leaks write payloads", async () => {
  const store = createMemoryStore();
  const wb = await load(await buildWorkbook({ opps: [], settings }));
  const ws = wb.getWorksheet("Pipeline");
  ws.getRow(2).getCell(1).value = "Ok Co";
  ws.getRow(3).getCell(1).value = "Odd Co";
  ws.getRow(3).getCell(3).value = "Nope";
  const d = describePlan(planImport(await parseWorkbook(await save(wb)), await store.list()));
  assert.equal(d.rows.length, 2);
  assert.ok(d.rows.every((r) => !("create" in r) && !("patch" in r)));
  assert.equal(d.rows.find((r) => r.line === 3).action, "skip");
});
