// Spreadsheet export and import.
//
// Two layouts can be read back in:
//   "pipeline"  the workbook this app exports. Rows are matched by the Id column and updated in place.
//   "legacy"    the original AI Practice Progress Sheet (Accounts tab). One time migration: new accounts are
//               added, anything already in the tracker is left alone so a re-run cannot revert your edits.
//
// Import is always two steps: parse and plan (read only), then apply. Nothing here deletes a row.
// exceljs is loaded on demand so a normal page load never pays for it.
//
// Note on formula injection: cell text is written as string cells, never as formulas, so a value such as
// =HYPERLINK(...) typed into a Notes field stays inert text in Excel. That protection is lost if this is
// ever changed to write CSV, so do not add a CSV export without prefixing risky cells.

import { randomUUID } from "node:crypto";
import { ConflictError, ImportError } from "./errors.js";
import { cleanAccount, mapLead, mapStage, mapTw, parseSize } from "./import-mapping.js";
import { mergeUpdate } from "./mutate.js";
import { ID_PATTERN, STAGES, TW_STATUS, validateOpp } from "./validate.js";

export const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const PIPELINE_SHEET = "Pipeline";
export const ASSUMPTIONS_SHEET = "Assumptions";
export const MAX_ROWS = 1000;

const NAVY = "FF003087";
const SLATE = "FF5B6B8C";
const WHITE = "FFFFFFFF";
const MONEY = '"$"#,##0';
const OPEN_STAGES = STAGES.filter((s) => s !== "Won" && s !== "Lost");
const LEAD_CHOICES = ["Zones", "Thoughtworks"];

// ---------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------

// Order here is the column order in the workbook. computed columns are formulas or notes that import ignores.
const COLUMNS = [
  { key: "account", header: "Account", width: 28 },
  { key: "opportunity", header: "Opportunity", width: 44, wrap: true },
  { key: "stage", header: "Stage", width: 16 },
  { key: "segment", header: "Segment", width: 16 },
  { key: "lead", header: "Lead", width: 14 },
  { key: "seller", header: "Seller", width: 18 },
  { key: "tw", header: "Thoughtworks", width: 15 },
  { key: "size", header: "Deal size", width: 14, fmt: MONEY },
  { key: "gmPct", header: "GM% override", width: 14 },
  { key: "closeDate", header: "Close date", width: 12, fmt: "yyyy-mm-dd" },
  { key: "nextStep", header: "Next step", width: 44, wrap: true },
  { key: "notes", header: "Notes", width: 44, wrap: true },
  { key: "margin", header: "Est. margin (formula)", width: 18, fmt: MONEY, computed: true },
  { key: "weighted", header: "Weighted margin (formula)", width: 20, fmt: MONEY, computed: true },
  { key: "updated", header: "Last updated (ignored on import)", width: 30, computed: true },
  { key: "id", header: "Id (do not edit)", width: 38, computed: true },
];
const colNo = (key) => COLUMNS.findIndex((c) => c.key === key) + 1;
const colLetter = (key) => String.fromCharCode(64 + colNo(key));

/** Same arithmetic as the page and as the workbook formulas, so cached results match what Excel recalculates. */
function marginFor(o, settings) {
  if (o.size == null) return null;
  const g = (o.gmPct == null ? settings.defaultGm : o.gmPct) / 100;
  return settings.marginBasis === "cost" ? o.size / (1 - g) - o.size : o.size * g;
}

/**
 * Build the workbook. opps: array of opportunity documents. settings: validated settings.
 * Returns a Buffer. The Pipeline sheet's margin columns are live formulas over the Assumptions sheet.
 */
export async function buildWorkbook({ opps, settings, now = new Date() }) {
  const { default: ExcelJS } = await import("exceljs");
  const wb = new ExcelJS.Workbook();
  wb.creator = "Zones AI Practice Pipeline";
  wb.created = now;
  wb.modified = now;

  const ws = wb.addWorksheet(PIPELINE_SHEET, { views: [{ state: "frozen", xSplit: 1, ySplit: 1 }] });
  ws.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));

  const header = ws.getRow(1);
  header.height = 30;
  COLUMNS.forEach((c, i) => {
    const cell = header.getCell(i + 1);
    cell.font = { bold: true, color: { argb: WHITE } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: c.computed ? SLATE : NAVY } };
    cell.alignment = { vertical: "middle", wrapText: true };
  });

  const sorted = [...opps].sort(
    (a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage) || String(a.account).localeCompare(String(b.account)),
  );

  const L = Object.fromEntries(COLUMNS.map((c) => [c.key, colLetter(c.key)]));
  const A = `${ASSUMPTIONS_SHEET}!`;
  sorted.forEach((o, i) => {
    const r = i + 2;
    const m = marginFor(o, settings);
    const p = (settings.probs[o.stage] ?? 0) / 100;
    const row = ws.addRow({
      account: o.account,
      opportunity: o.opportunity ?? "",
      stage: o.stage,
      segment: o.segment ?? "",
      lead: o.lead ?? "",
      seller: o.seller ?? "",
      tw: o.tw ?? "",
      size: o.size ?? null,
      gmPct: o.gmPct ?? null,
      closeDate: o.closeDate ? new Date(`${o.closeDate}T00:00:00Z`) : null,
      nextStep: o.nextStep ?? "",
      notes: o.notes ?? "",
      margin: {
        formula:
          `IF(${L.size}${r}="","",IF(${A}$B$2="cost",` +
          `${L.size}${r}/(1-IF(${L.gmPct}${r}="",${A}$B$3,${L.gmPct}${r})/100)-${L.size}${r},` +
          `${L.size}${r}*IF(${L.gmPct}${r}="",${A}$B$3,${L.gmPct}${r})/100))`,
        result: m == null ? "" : m,
      },
      weighted: {
        formula: `IF(${L.margin}${r}="","",${L.margin}${r}*IFERROR(VLOOKUP(${L.stage}${r},${A}$A$6:$B$12,2,FALSE),0)/100)`,
        result: m == null ? "" : m * p,
      },
      updated: o.updatedAt ? `${o.updatedAt.slice(0, 10)}${o.updatedBy ? ` by ${o.updatedBy}` : ""}` : "",
      id: o.id,
    });
    COLUMNS.forEach((c, j) => {
      const cell = row.getCell(j + 1);
      cell.alignment = { vertical: "top", wrapText: !!c.wrap };
      if (c.fmt) cell.numFmt = c.fmt;
      if (c.computed) cell.font = { color: { argb: SLATE } };
    });
  });

  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNS.length } };

  // Dropdowns on the fixed value columns, including 200 spare rows for people adding rows in Excel.
  const lists = {
    stage: STAGES,
    lead: LEAD_CHOICES,
    tw: TW_STATUS,
  };
  for (const [key, values] of Object.entries(lists)) {
    for (let r = 2; r <= sorted.length + 201; r++) {
      ws.getCell(`${colLetter(key)}${r}`).dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: [`"${values.join(",")}"`],
        showErrorMessage: true,
        errorTitle: "Not a valid value",
        error: `Choose one of: ${values.join(", ")}.`,
      };
    }
  }

  // ---- Assumptions ----
  const as = wb.addWorksheet(ASSUMPTIONS_SHEET);
  as.columns = [{ width: 32 }, { width: 22 }, { width: 70 }];
  as.getCell("A1").value = "Assumptions behind the margin columns";
  as.getCell("A1").font = { bold: true, size: 13, color: { argb: NAVY } };
  as.getCell("A2").value = "Margin basis (price or cost)";
  as.getCell("B2").value = settings.marginBasis;
  as.getCell("C2").value = "price: margin = size x GM%.  cost: margin = size / (1 - GM%) - size.";
  as.getCell("A3").value = "Default GM %";
  as.getCell("B3").value = settings.defaultGm;
  as.getCell("C3").value = "A row's GM% override replaces this default.";
  as.getCell("B2").dataValidation = { type: "list", allowBlank: false, formulae: ['"price,cost"'] };
  for (const [i, h] of ["Stage", "Win probability %"].entries()) {
    const cell = as.getCell(5, i + 1);
    cell.value = h;
    cell.font = { bold: true, color: { argb: WHITE } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
  }
  STAGES.forEach((s, i) => {
    as.getCell(6 + i, 1).value = s;
    as.getCell(6 + i, 2).value = settings.probs[s] ?? 0;
  });
  as.getCell("A14").value = "Open pipeline (everything except Won and Lost)";
  as.getCell("A14").font = { bold: true, size: 13, color: { argb: NAVY } };

  const open = sorted.filter((o) => OPEN_STAGES.includes(o.stage));
  const sum = (f) => open.reduce((s, o) => s + (f(o) ?? 0), 0);
  const range = (key) => `${PIPELINE_SHEET}!$${colLetter(key)}:$${colLetter(key)}`;
  const stageRange = range("stage");
  const totals = [
    ["Deal size", "size", sum((o) => o.size)],
    ["Est. margin", "margin", sum((o) => marginFor(o, settings))],
    ["Weighted margin", "weighted", sum((o) => {
      const m = marginFor(o, settings);
      return m == null ? null : m * ((settings.probs[o.stage] ?? 0) / 100);
    })],
  ];
  totals.forEach(([label, key, result], i) => {
    const r = 15 + i;
    as.getCell(r, 1).value = label;
    as.getCell(r, 2).value = {
      formula: `SUMIFS(${range(key)},${stageRange},"<>Won",${stageRange},"<>Lost")`,
      result,
    };
    as.getCell(r, 2).numFmt = MONEY;
  });
  as.getCell("A19").value =
    "These mirror the app's Assumptions panel at export time. Editing them here changes this workbook's formulas only. Import does not read them back.";
  as.getCell("A19").alignment = { wrapText: true, vertical: "top" };
  as.mergeCells("A19:C20");

  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---------------------------------------------------------------------------------------------
// Import: read
// ---------------------------------------------------------------------------------------------

const PIPELINE_PREFIXES = {
  account: "account", opportunity: "opportunity", stage: "stage", segment: "segment", lead: "lead",
  seller: "seller", tw: "thoughtworks", size: "deal size", gmPct: "gm", closeDate: "close",
  nextStep: "next step", notes: "notes", id: "id",
};
const LEGACY_PREFIXES = {
  account: "account", opportunity: "opportunity", band: "estimated size", margin: "rev/gm", size: "deal size",
  tw: "thoughtworks", status: "status", next: "next step", segment: "sales segment", seller: "seller", lead: "lead by",
};

function cellValue(cell) {
  const v = cell?.value;
  if (v instanceof Date) return v;
  if (v && typeof v === "object") {
    if ("error" in v) return "";
    if ("result" in v) {
      const r = v.result;
      return r && typeof r === "object" && !(r instanceof Date) ? "" : (r ?? "");
    }
    if ("richText" in v) return v.richText.map((t) => t.text).join("");
    if ("text" in v) return typeof v.text === "string" ? v.text : (v.text?.richText ?? []).map((t) => t.text).join("");
  }
  return v ?? "";
}

const textOf = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? "").trim());

function inspectSheet(ws) {
  const headers = {};
  ws.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => {
    const t = textOf(cellValue(cell)).toLowerCase();
    if (t && !(t in headers)) headers[t] = col;
  });
  const find = (prefix) => {
    const k = Object.keys(headers).find((h) => h.startsWith(prefix));
    return k ? headers[k] : null;
  };
  const cols = (prefixes) => Object.fromEntries(Object.entries(prefixes).map(([k, p]) => [k, find(p)]));
  if (find("account") && find("stage")) return { format: "pipeline", cols: cols(PIPELINE_PREFIXES) };
  if (find("account") && find("status")) return { format: "legacy", cols: cols(LEGACY_PREFIXES) };
  return null;
}

function readMoney(v) {
  if (v === "" || v == null) return { value: null };
  if (typeof v === "number") return Number.isFinite(v) ? { value: Math.round(v) } : { error: true };
  const s = String(v).trim().toLowerCase().replace(/[$,\s]/g, "");
  if (!s) return { value: null };
  const m = s.match(/^(\d+(?:\.\d+)?)([km]?)$/);
  if (!m) return { error: true };
  return { value: Math.round(parseFloat(m[1]) * (m[2] === "k" ? 1e3 : m[2] === "m" ? 1e6 : 1)) };
}

function readPercent(v) {
  if (v === "" || v == null) return { value: null };
  let n = typeof v === "number" ? v : Number(String(v).replace(/[%\s]/g, ""));
  if (!Number.isFinite(n)) return { error: true };
  if (n > 0 && n < 1) n *= 100; // an Excel cell formatted as a percent stores 0.3 for 30%
  return { value: Math.round(n * 100) / 100 };
}

function readDate(v) {
  if (v === "" || v == null) return { value: "" };
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? { error: true } : { value: v.toISOString().slice(0, 10) };
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { value: s };
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) return { value: `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}` };
  return { error: true };
}

const pick = (list, text) => list.find((x) => x.toLowerCase() === text.toLowerCase());

function readPipelineRow(get) {
  const out = { fields: {}, createOnly: {}, warnings: [], errors: [], id: "" };
  const f = out.fields;
  for (const k of ["account", "opportunity", "segment", "seller", "nextStep", "notes"]) {
    if (get(k) !== undefined) f[k] = textOf(get(k));
  }
  if (get("account") !== undefined && !f.account) out.errors.push("Account is blank.");
  if (get("account") === undefined) out.errors.push("No Account column.");

  if (get("stage") !== undefined && textOf(get("stage"))) {
    const t = textOf(get("stage"));
    const s = pick(STAGES, t);
    if (s) f.stage = s;
    else out.errors.push(`Stage "${t}" is not one of: ${STAGES.join(", ")}.`);
  }
  if (get("tw") !== undefined && textOf(get("tw"))) {
    const t = textOf(get("tw"));
    const s = pick(TW_STATUS, t);
    if (s) f.tw = s;
    else out.errors.push(`Thoughtworks "${t}" is not one of: ${TW_STATUS.join(", ")}.`);
  }
  if (get("lead") !== undefined) {
    const t = textOf(get("lead"));
    if (!t) f.lead = "";
    else if (pick(LEAD_CHOICES, t)) f.lead = pick(LEAD_CHOICES, t);
    else out.errors.push(`Lead "${t}" must be blank, Zones or Thoughtworks.`);
  }
  if (get("size") !== undefined) {
    const r = readMoney(get("size"));
    if (r.error) out.errors.push(`Deal size "${textOf(get("size"))}" is not a number.`);
    else f.size = r.value;
  }
  if (get("gmPct") !== undefined) {
    const r = readPercent(get("gmPct"));
    if (r.error) out.errors.push(`GM% "${textOf(get("gmPct"))}" is not a number.`);
    else f.gmPct = r.value;
  }
  if (get("closeDate") !== undefined) {
    const r = readDate(get("closeDate"));
    if (r.error) out.errors.push(`Close date "${textOf(get("closeDate"))}" is not a date. Use YYYY-MM-DD.`);
    else f.closeDate = r.value;
  }
  const id = get("id") !== undefined ? textOf(get("id")) : "";
  if (id) {
    if (ID_PATTERN.test(id)) out.id = id;
    else out.errors.push("Id is not valid. Clear it to add this as a new row.");
  }
  return out;
}

function readLegacyRow(get) {
  const account = cleanAccount(textOf(get("account")));
  if (!account) return null; // subtotal or spacer rows on the old sheet
  const out = { fields: {}, createOnly: {}, warnings: [], errors: [], id: "", heuristic: false };

  let size = parseSize(get("size"));
  if (size.size == null) {
    const r = readMoney(get("size"));
    if (!r.error && r.value != null) size = { size: r.value, heuristic: false };
  }
  if (size.heuristic) {
    out.heuristic = true;
    out.warnings.push(`Deal size written as "${textOf(get("size"))}" was read as $${size.size.toLocaleString("en-US")}. Check it.`);
  }
  const status = textOf(get("status"));
  const band = textOf(get("band"));
  out.fields = {
    account,
    opportunity: textOf(get("opportunity")),
    stage: mapStage(status),
    segment: textOf(get("segment")),
    lead: mapLead(get("lead")),
    seller: textOf(get("seller")),
    tw: mapTw(get("tw")),
    size: size.size,
    nextStep: textOf(get("next")),
  };
  out.createOnly.notes = [band && `Size band on original sheet: ${band}`, status && `Original status: ${status}`].filter(Boolean).join("\n").slice(0, 2000);
  return out;
}

/**
 * Read a workbook buffer. Returns { format, sheet, rows, blankRows } where each row is
 * { line, fields, createOnly, id, warnings, errors }. Throws ImportError for problems with the file itself.
 */
export async function parseWorkbook(buffer) {
  const { default: ExcelJS } = await import("exceljs");
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch {
    throw new ImportError("That file could not be read. Use an .xlsx workbook. Older .xls files and .csv files are not supported.");
  }

  const rank = (ws) => (ws.name.trim() === PIPELINE_SHEET ? 0 : /^accounts/i.test(ws.name.trim()) ? 1 : 2);
  const sheets = [...wb.worksheets].sort((a, b) => rank(a) - rank(b));
  let found = null;
  for (const ws of sheets) {
    const info = inspectSheet(ws);
    if (info) { found = { ws, ...info }; break; }
  }
  if (!found) {
    throw new ImportError(
      "No sheet has a header row in row 1 that this tracker recognises. Expected Account and Stage (an export from this page) " +
      `or Account and Status (the original workbook). Sheets found: ${wb.worksheets.map((w) => w.name).join(", ") || "none"}.`,
    );
  }

  const { ws, format, cols } = found;
  const reader = format === "legacy" ? readLegacyRow : readPipelineRow;
  const rows = [];
  let blankRows = 0;
  ws.eachRow({ includeEmpty: false }, (row, line) => {
    if (line === 1) return;
    const get = (key) => (cols[key] ? cellValue(row.getCell(cols[key])) : undefined);
    const anyContent = Object.keys(cols).some((k) => cols[k] && textOf(get(k)) !== "");
    if (!anyContent) { blankRows++; return; }
    const r = reader(get);
    if (!r) { blankRows++; return; }
    rows.push({ line, ...r });
  });
  if (rows.length > MAX_ROWS) {
    throw new ImportError(`This sheet has ${rows.length} rows. The limit for one import is ${MAX_ROWS}. Split the file and import it in parts.`);
  }
  return { format, sheet: ws.name.trim(), rows, blankRows };
}

// ---------------------------------------------------------------------------------------------
// Import: plan (read only) and apply
// ---------------------------------------------------------------------------------------------

const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const keyOf = (account, opportunity) => `${norm(account)}|${norm(opportunity)}`;
const same = (a, b) => (a ?? "") === (b ?? "");

/**
 * Decide what an import would do, without writing. existing: the current opportunity documents.
 * Every row ends up as create, update, unchanged or skip (with a reason).
 */
export function planImport(parsed, existing) {
  const byId = new Map(existing.map((d) => [d.id, d]));
  const byKey = new Map();
  for (const d of existing) {
    const k = keyOf(d.account, d.opportunity);
    if (!byKey.has(k)) byKey.set(k, d);
  }
  const claimed = new Map();
  const claim = (token, line) => {
    if (claimed.has(token)) return claimed.get(token);
    claimed.set(token, line);
    return null;
  };

  const rows = [];
  let heuristicSizes = 0;
  for (const r of parsed.rows) {
    const base = { line: r.line, account: r.fields.account ?? "", warnings: r.warnings };
    const skip = (reason) => rows.push({ ...base, action: "skip", reason });
    if (r.errors.length) { skip(r.errors.join(" ")); continue; }
    if (r.heuristic) heuristicSizes++;

    const key = keyOf(r.fields.account, r.fields.opportunity);
    const target = (r.id && byId.get(r.id)) || byKey.get(key) || null;

    if (target) {
      const prior = claim(`id:${target.id}`, r.line);
      if (prior) { skip(`Same opportunity as row ${prior} in this file.`); continue; }
      if (parsed.format === "legacy") {
        rows.push({ ...base, action: "unchanged", id: target.id, reason: "Already in the tracker. The original workbook only adds new rows." });
        continue;
      }
      const { value, errors } = validateOpp(r.fields, { partial: true });
      if (errors.length) { skip(errors.join(" ")); continue; }
      const patch = {};
      for (const [k, v] of Object.entries(value)) if (!same(v, target[k])) patch[k] = v;
      const changed = Object.keys(patch);
      rows.push({ ...base, action: changed.length ? "update" : "unchanged", id: target.id, patch, changed });
      continue;
    }

    const prior = claim(`key:${key}`, r.line) ?? (r.id ? claim(`id:${r.id}`, r.line) : null);
    if (prior) { skip(`Same opportunity as row ${prior} in this file.`); continue; }
    const { value, errors } = validateOpp({ ...r.fields, ...r.createOnly });
    if (errors.length) { skip(errors.join(" ")); continue; }
    rows.push({ ...base, action: "create", id: r.id || randomUUID(), create: value });
  }

  const count = (a) => rows.filter((r) => r.action === a).length;
  return {
    format: parsed.format,
    sheet: parsed.sheet,
    rows,
    summary: {
      total: rows.length,
      create: count("create"),
      update: count("update"),
      unchanged: count("unchanged"),
      skipped: count("skip"),
      blankRows: parsed.blankRows,
      heuristicSizes,
      newDealSize: rows.filter((r) => r.action === "create").reduce((s, r) => s + (r.create.size ?? 0), 0),
    },
  };
}

/** What the API and the page need to show a preview. Trims the internal write payloads. */
export function describePlan(plan, { maxListed = 300 } = {}) {
  const rows = plan.rows.map(({ line, action, account, changed, reason, warnings }) => ({
    line, action, account, changed: changed ?? [], reason: reason ?? "", warnings,
  }));
  const interesting = rows.filter((r) => r.action !== "unchanged");
  const skipped = interesting.filter((r) => r.action === "skip");
  const rest = interesting.filter((r) => r.action !== "skip").slice(0, maxListed);
  return {
    format: plan.format,
    sheet: plan.sheet,
    summary: plan.summary,
    rows: [...skipped, ...rest].sort((a, b) => a.line - b.line),
    truncated: interesting.length - skipped.length > maxListed,
  };
}

/** Write a plan. Never deletes. Bounded concurrency. Returns counts and a list of rows that failed. */
export async function applyPlan(store, plan, actor, { concurrency = 6, log = () => {} } = {}) {
  const who = actor || "import";
  const work = plan.rows.filter((r) => r.action === "create" || r.action === "update");
  const result = {
    created: 0,
    updated: 0,
    unchanged: plan.summary.unchanged,
    skipped: plan.summary.skipped,
    failed: [],
  };
  let next = 0;
  async function worker() {
    while (next < work.length) {
      const r = work[next++];
      try {
        if (r.action === "create") {
          const t = new Date().toISOString();
          await store.create({ id: r.id, ...r.create, createdAt: t, createdBy: who, updatedAt: t, updatedBy: who });
          result.created++;
        } else {
          const item = await mergeUpdate(store, r.id, r.patch, who);
          if (item) result.updated++;
          else result.failed.push({ line: r.line, account: r.account, error: "The row was deleted while the import ran." });
        }
      } catch (e) {
        log(`Import row ${r.line} failed: ${e?.stack ?? e}`);
        result.failed.push({
          line: r.line,
          account: r.account,
          error: e instanceof ConflictError ? "Someone else was editing this row. Import again to retry it." : "Could not be saved.",
        });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, work.length) }, worker));
  result.failed.sort((a, b) => a.line - b.line);
  return result;
}
