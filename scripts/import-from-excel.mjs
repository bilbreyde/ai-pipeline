// Command line import, for loading a workbook without the web page. The page's Import button does the same job.
//
//   node scripts/import-from-excel.mjs "C:\path\to\workbook.xlsx"                          (dry run)
//   node scripts/import-from-excel.mjs "C:\path\to\workbook.xlsx" --apply --confirm-secured (writes)
//
// Reads either layout: the original AI Practice Progress Sheet, or an export from the app.
// Rules:
// 1. The workbook stays outside this repo. .gitignore also blocks *.xlsx.
// 2. Output is counts and row numbers only, never account names.
// 3. The dry run needs no Azure access and plans against an empty tracker, so "new" means "new if empty".
//    --apply plans against what is really in Cosmos.
// 4. --apply refuses to run without --confirm-secured. That flag is you saying sign in is enabled on the app
//    and this is a tenant approved place for customer data. The MVP has no sign in.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { loadCosmosStore } from "./env.mjs";
import { ImportError } from "../src/lib/errors.js";
import { applyPlan, parseWorkbook, planImport } from "../src/lib/xlsx.js";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const apply = args.includes("--apply");
const confirmed = args.includes("--confirm-secured");

if (!file || !existsSync(file)) {
  console.error("Usage: node scripts/import-from-excel.mjs <path-to-xlsx> [--apply --confirm-secured]");
  process.exit(1);
}
if (apply && !confirmed) {
  console.error("Refusing to write. --confirm-secured is required: the app must have sign in enabled and be approved for customer data.");
  process.exit(2);
}

let parsed;
try {
  parsed = await parseWorkbook(await readFile(file));
} catch (e) {
  if (e instanceof ImportError) { console.error(e.message); process.exit(1); }
  throw e;
}

let store, endpoint, existing = [];
if (apply) {
  ({ store, endpoint } = loadCosmosStore());
  existing = await store.list();
}
const plan = planImport(parsed, existing);
const s = plan.summary;
const $ = (n) => `$${Math.round(n).toLocaleString("en-US")}`;

console.log(`Sheet: "${plan.sheet}" (${plan.format === "legacy" ? "original workbook layout" : "export layout"})`);
console.log(`Rows read: ${s.total}   new ${s.create}, updated ${s.update}, unchanged ${s.unchanged}, skipped ${s.skipped}`);
if (s.blankRows) console.log(`Blank or spacer rows ignored: ${s.blankRows}`);
console.log(`Deal size on new rows: ${$(s.newDealSize)}`);
if (s.heuristicSizes) console.log(`${s.heuristicSizes} size(s) written like "(100)" were read as thousands. Check them in the app.`);
for (const r of plan.rows.filter((x) => x.action === "skip")) console.log(`  skipped row ${r.line}: ${r.reason.replace(/"[^"]*"/g, '"..."')}`);

if (!apply) {
  console.log("\nDry run only. Nothing was written. Add --apply --confirm-secured to import.");
  process.exit(0);
}

const result = await applyPlan(store, plan, "import-script", { log: (m) => console.error(m) });
console.log(`\nImported into ${endpoint}: ${result.created} added, ${result.updated} updated.`);
for (const f of result.failed) console.log(`  row ${f.line} not saved: ${f.error}`);
if (result.failed.length) process.exit(1);
