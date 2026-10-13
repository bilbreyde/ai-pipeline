import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

// web/dash-calc.js is a plain browser script. Load it the way a browser would, into a bare context.
const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../web/dash-calc.js");
const ctx = vm.createContext({});
vm.runInContext(readFileSync(file, "utf8"), ctx);
const C = ctx.DashCalc;

const ST = { marginBasis: "price", defaultGm: 30 };
const TODAY = "2026-09-21";
const NOW = Date.parse("2026-09-21T12:00:00Z");
const opp = (o) => ({ id: o.account, opportunity: "", stage: "Qualified", segment: "", lead: "", seller: "Sam", tw: "Not indicated", size: null, gmPct: null, closeDate: "", nextStep: "x", notes: "", updatedAt: "2026-09-20T00:00:00Z", ...o });
// Objects built inside the vm context have a different Object.prototype, which deepStrictEqual rejects.
const plain = (x) => JSON.parse(JSON.stringify(x));
const build = (opps, o = {}) => C.build(opps, ST, { today: TODAY, nowMs: NOW, ...o });

test("row math: price basis, cost basis, GM override", () => {
  const o = opp({ account: "A", size: 100000, stage: "Proposal / RFP" });
  assert.equal(C.marginOf(o, ST), 30000);
  assert.equal(C.marginOf({ ...o, gmPct: 45 }, ST), 45000);
  const cost = { ...ST, marginBasis: "cost" };
  assert.ok(Math.abs(C.marginOf(o, cost) - (100000 / 0.7 - 100000)) < 1e-6);
  assert.equal(C.marginOf(opp({ account: "B" }), ST), null);
  assert.equal(C.marginOf({ ...o, size: NaN }, ST), null);
});

test("totals separate open, won and lost, and count unsized deals without adding them", () => {
  const d = build([
    opp({ account: "A", size: 100000, stage: "Qualified" }),
    opp({ account: "B", stage: "Discovery" }),
    opp({ account: "C", size: 200000, stage: "Won" }),
    opp({ account: "D", size: 50000, stage: "Lost" }),
  ]);
  assert.equal(d.kpi.open.n, 2);
  assert.equal(d.kpi.open.size, 100000);
  assert.equal(d.kpi.open.margin, 30000);
  assert.equal(d.kpi.open.unsized, 1);
  assert.equal(d.kpi.won.margin, 60000);
  assert.equal(d.kpi.lost.n, 1);
  assert.equal(d.kpi.blendedGm, 0.3);
  assert.equal(d.byStage.map((g) => g.key).join(), "Account planning,Identified,Discovery,Qualified,Proposal / RFP,Blocked");
  assert.equal(d.byStage[2].unsized, 1);
});

test("Account planning has no margin and its missing size is not a data gap, unlike every other open stage", () => {
  const planned = opp({ account: "P", stage: "Account planning" }); // no size, no seller override needed here
  assert.equal(C.marginOf(planned, ST), null);
  assert.deepEqual(plain(C.gapsOf(planned)), []);
  const plannedNoSeller = opp({ account: "P2", stage: "Account planning", seller: "" });
  assert.deepEqual(plain(C.gapsOf(plannedNoSeller)), ["No seller"]); // still flagged: only "No size" is exempt
  const identifiedNoSize = opp({ account: "I", stage: "Identified" });
  assert.deepEqual(plain(C.gapsOf(identifiedNoSize)), ["No size"]); // every other open stage is unaffected

  const d = build([planned, opp({ account: "D", size: 100000, stage: "Discovery" })]);
  assert.equal(d.gaps.open, 2);
  assert.equal(d.gaps.noSize, 0); // the Account planning row doesn't count, the Discovery row has a size
  assert.equal(d.byStage[0].key, "Account planning");
  assert.equal(d.byStage[0].n, 1);
  assert.equal(d.byStage[0].size, 0);
});

test("stage categories: OPEN is counted, ACTIVE adds Prospecting first, CLOSED adds Unqualified after Lost", () => {
  assert.equal(C.STAGES.join(), "Prospecting,Account planning,Identified,Discovery,Qualified,Proposal / RFP,Blocked,Won,Lost,Unqualified");
  assert.equal(C.ACTIVE.join(), ["Prospecting"].concat(plain(C.OPEN)).join());
  assert.equal(C.CLOSED.join(), "Won,Lost,Unqualified");
  assert.equal(C.STAGES.length, C.ACTIVE.length + C.CLOSED.length);
  const p = opp({ stage: "Prospecting" }), u = opp({ stage: "Unqualified" });
  assert.equal(C.isOpen(p), false); assert.equal(C.isActive(p), true); assert.equal(C.isClosed(p), false);
  assert.equal(C.isOpen(u), false); assert.equal(C.isActive(u), false); assert.equal(C.isClosed(u), true);
});

test("Prospecting is in no money rollup, even with a size", () => {
  const base = [opp({ account: "Q", size: 100000, stage: "Qualified", seller: "Sam", lead: "Zones", tw: "Engaged", closeDate: "2026-10-15" })];
  const withP = base.concat([opp({ account: "P", size: 900000, stage: "Prospecting", seller: "Sam", lead: "Zones", tw: "Engaged", closeDate: "2026-10-15" })]);
  const a = build(base), b = build(withP);
  for (const k of ["open", "won", "lost"]) assert.deepEqual(plain(b.kpi[k]), plain(a.kpi[k]), k);
  assert.equal(b.kpi.blendedGm, a.kpi.blendedGm);
  assert.deepEqual(plain(b.byStage), plain(a.byStage));
  assert.ok(!b.byStage.some((g) => g.key === "Prospecting"));
  assert.deepEqual(plain(b.bySeller), plain(a.bySeller));
  assert.deepEqual(plain(b.byLead), plain(a.byLead));
  assert.deepEqual(plain(b.byTw), plain(a.byTw));
  assert.deepEqual(plain(b.timeline), plain(a.timeline));
  assert.deepEqual(plain(C.topDeals(b.openDeals, ST, "size", 10)).map((r) => r.account), ["Q"]);
  assert.equal(b.prospecting, 1);
});

test("Prospecting gets staleness and the seller and next step gaps, but never No size", () => {
  const p = opp({ account: "P", stage: "Prospecting", size: null, seller: "", nextStep: "", updatedAt: "2026-08-01T00:00:00Z" });
  assert.deepEqual(plain(C.gapsOf(p)), ["No seller", "No next step"]);
  assert.deepEqual(plain(C.gapsOf(opp({ stage: "Prospecting" }))), []);
  const d = build([p]);
  assert.deepEqual(plain(d.gaps), { open: 1, noSize: 0, noSeller: 1, noNext: 1, overdue: 0, stale: 1, anyGap: 1 });
  assert.equal(d.kpi.open.n, 0);
});

test("Unqualified is in no pipeline total, no lost total, and gets no gaps or staleness", () => {
  const list = [
    opp({ account: "Q", size: 100000, stage: "Qualified" }),
    opp({ account: "L", size: 50000, stage: "Lost" }),
  ];
  const u = opp({ account: "U", size: 400000, stage: "Unqualified", seller: "", nextStep: "", updatedAt: "2026-01-01T00:00:00Z" });
  const a = build(list), b = build(list.concat([u]));
  assert.deepEqual(plain(b.kpi), plain(a.kpi));
  assert.equal(b.kpi.lost.n, 1);
  assert.equal(b.kpi.lost.size, 50000);
  assert.deepEqual(plain(b.byStage), plain(a.byStage));
  assert.deepEqual(plain(b.gaps), plain(a.gaps));
  assert.deepEqual(plain(C.gapsOf(u)), []);
});

test("lead and segment filters scope every number", () => {
  const list = [
    opp({ account: "A", size: 100000, lead: "Zones", segment: "ENT" }),
    opp({ account: "B", size: 200000, lead: "Thoughtworks", segment: "MM" }),
    opp({ account: "C", size: 400000, lead: "", segment: "ENT" }),
  ];
  assert.equal(build(list, { lead: "Zones" }).kpi.open.size, 100000);
  assert.equal(build(list, { lead: "_none" }).kpi.open.size, 400000);
  assert.equal(build(list, { seg: "ENT" }).kpi.open.size, 500000);
  assert.equal(build(list, { lead: "Zones", seg: "MM" }).kpi.open.n, 0);
  const all = build(list);
  assert.deepEqual(plain(all.byLead.map((g) => [g.key, g.size])), [["Zones", 100000], ["Thoughtworks", 200000], ["", 400000]]);
});

test("timeline: overdue, this month onward, later, and no date, all from the ISO strings", () => {
  const d = build([
    opp({ account: "late", size: 1000, closeDate: "2026-09-20" }),
    opp({ account: "today", size: 2000, closeDate: "2026-09-21" }),
    opp({ account: "oct", size: 4000, closeDate: "2026-10-31" }),
    opp({ account: "jan", size: 8000, closeDate: "2027-01-05" }),
    opp({ account: "far", size: 16000, closeDate: "2028-01-01" }),
    opp({ account: "none", size: 32000 }),
    opp({ account: "wonpast", size: 999999, stage: "Won", closeDate: "2026-01-01" }),
  ]);
  const by = Object.fromEntries(d.timeline.map((b) => [b.key, b]));
  assert.equal(by.overdue.size, 1000);
  assert.equal(by["2026-9"].size, 2000);        // closing today is not overdue
  assert.equal(by["2026-10"].size, 4000);
  assert.equal(by["2027-1"].size, 8000);
  assert.equal(by["2027-1"].label, "Jan '27");
  assert.equal(by.later.size, 16000);
  assert.equal(by.none.size, 32000);
  assert.equal(d.timeline[0].key, "overdue");
  assert.equal(d.timeline.at(-1).key, "none");
  assert.equal(d.timeline.filter((b) => b.kind === "month").length, 6); // Sep 2026 through Feb 2027
});

test("timeline always shows at least six months, even with no dated deals", () => {
  const d = build([opp({ account: "A", size: 1 })]);
  assert.equal(d.timeline.filter((b) => b.kind === "month").length, 6);
});

test("sellers: ranked by the chosen measure, tail folded into Other, Unassigned never folded", () => {
  const list = [];
  for (let i = 0; i < 10; i++) list.push(opp({ account: "S" + i, seller: "Seller" + i, size: (i + 1) * 1000 }));
  list.push(opp({ account: "U", seller: "", size: 1 }));
  const d = build(list);
  const r = C.rankSellers(d.bySeller, "size", 7);
  assert.equal(r[0].label, "Seller9");
  assert.equal(r.length, 9); // 7 + Other + Unassigned
  const other = r.find((g) => g.folded);
  assert.equal(other.folded, 3);
  assert.equal(other.size, 1000 + 2000 + 3000);
  assert.equal(r.at(-1).label, "Unassigned");
  const byMargin = C.rankSellers(d.bySeller, "margin", 2);
  assert.equal(byMargin.length, 4); // 2 + Other + Unassigned, same folding logic under a different measure
});

test("largest deals skip unsized rows and follow the measure", () => {
  const list = [
    opp({ account: "Big low margin", size: 900000, gmPct: 5, stage: "Identified" }),
    opp({ account: "Mid", size: 500000, stage: "Proposal / RFP" }),
    opp({ account: "Unsized" }),
  ];
  const d = build(list);
  assert.deepEqual(plain(C.topDeals(d.openDeals, ST, "size", 8).map((x) => x.account)), ["Big low margin", "Mid"]);
  assert.deepEqual(plain(C.topDeals(d.openDeals, ST, "margin", 8).map((x) => x.account)), ["Mid", "Big low margin"]);
});

test("data gaps count open rows only, and stale means no update in 14 days", () => {
  const d = build([
    opp({ account: "ok", size: 1, closeDate: "2026-12-01" }),
    opp({ account: "gaps", seller: "", nextStep: "", closeDate: "2026-01-01", updatedAt: "2026-08-01T00:00:00Z" }),
    opp({ account: "won", stage: "Won", seller: "", size: null }),
  ]);
  assert.deepEqual(plain(d.gaps), { open: 2, noSize: 1, noSeller: 1, noNext: 1, overdue: 1, stale: 1, anyGap: 1 });
});

test("compact formatting matches the table view", () => {
  assert.equal(C.compact(null), "–");
  assert.equal(C.compact(950), "$950");
  assert.equal(C.compact(480000), "$480K");
  assert.equal(C.compact(1240000), "$1.24M");
  assert.equal(C.full(1234567), "$1,234,567");
});
