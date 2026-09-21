/* Pipeline math shared by the table view and the dashboard. No DOM in here, so it can be tested in Node.
   Loaded as a plain script: it publishes window.DashCalc. */
(function (root) {
"use strict";

var STAGES = ["Identified", "Discovery", "Qualified", "Proposal / RFP", "Blocked", "Won", "Lost"];
var OPEN = ["Identified", "Discovery", "Qualified", "Proposal / RFP", "Blocked"];
var TW_ORDER = ["Engaged", "Strong fit", "Target", "Potential", "Not indicated", "Zones only"];
var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
var MEASURES = { margin: "Estimated margin", weighted: "Weighted margin", size: "Deal size" };

/* ---------- per row math (the single source of truth for the page) ---------- */
function isOpen(o) { return OPEN.indexOf(o.stage) > -1; }
function gmOf(o, st) {
  var g = (o.gmPct == null || o.gmPct === "") ? st.defaultGm : Number(o.gmPct);
  return Math.min(90, Math.max(0, g || 0));
}
function marginOf(o, st) {
  if (o.size == null || isNaN(o.size)) return null;
  var g = gmOf(o, st) / 100;
  return st.marginBasis === "cost" ? o.size / (1 - g) - o.size : o.size * g;
}
function probOf(o, st) { var p = st.probs[o.stage]; return (p == null ? 0 : p) / 100; }
function weightedOf(o, st) { var m = marginOf(o, st); return m == null ? null : m * probOf(o, st); }
function gapsOf(o) {
  if (!isOpen(o)) return [];
  var g = [];
  if (o.size == null) g.push("No size");
  if (!o.seller) g.push("No seller");
  if (!o.nextStep) g.push("No next step");
  return g;
}

/* ---------- aggregation ---------- */
function blank() { return { n: 0, sized: 0, size: 0, margin: 0, weighted: 0, unsized: 0 }; }
function add(acc, o, st) {
  acc.n++;
  var m = marginOf(o, st);
  if (o.size == null || m == null) { acc.unsized++; return; }
  acc.sized++;
  acc.size += o.size;
  acc.margin += m;
  acc.weighted += m * probOf(o, st);
}
function isoDay(d) {
  var m = d.getMonth() + 1, day = d.getDate();
  return d.getFullYear() + "-" + (m < 10 ? "0" : "") + m + "-" + (day < 10 ? "0" : "") + day;
}
function monthIndex(y, m) { return y * 12 + (m - 1); }

/**
 * opts: lead ("" any, "Zones", "Thoughtworks", "_none"), seg (""), today (ISO day, default now),
 *       staleDays (14). Returns plain objects only.
 */
function build(opps, st, opts) {
  opts = opts || {};
  var today = opts.today || isoDay(new Date());
  var staleDays = opts.staleDays == null ? 14 : opts.staleDays;
  var nowMs = opts.nowMs == null ? Date.now() : opts.nowMs;

  var scoped = opps.filter(function (o) {
    if (opts.lead && (o.lead || "") !== (opts.lead === "_none" ? "" : opts.lead)) return false;
    if (opts.seg && (o.segment || "") !== opts.seg) return false;
    return true;
  });
  var open = scoped.filter(isOpen);
  var won = scoped.filter(function (o) { return o.stage === "Won"; });
  var lost = scoped.filter(function (o) { return o.stage === "Lost"; });

  function total(list) { var a = blank(); list.forEach(function (o) { add(a, o, st); }); return a; }
  var openT = total(open), wonT = total(won), lostT = total(lost);

  function groupBy(list, keyFn, keys) {
    var map = {}, order = [];
    (keys || []).forEach(function (k) { map[k] = blank(); map[k].key = k; order.push(k); });
    list.forEach(function (o) {
      var k = keyFn(o);
      if (!map[k]) { map[k] = blank(); map[k].key = k; order.push(k); }
      add(map[k], o, st);
    });
    return order.map(function (k) { return map[k]; });
  }

  var byStage = groupBy(open, function (o) { return o.stage; }, OPEN);
  var bySeller = groupBy(open, function (o) { return o.seller || ""; });
  var byLead = groupBy(open, function (o) { return o.lead || ""; }, ["Zones", "Thoughtworks", ""]);
  var byTw = groupBy(open, function (o) { return o.tw || "Not indicated"; }, TW_ORDER);

  /* close timeline: overdue | this month .. up to 12 months | later | no date */
  var ty = Number(today.slice(0, 4)), tm = Number(today.slice(5, 7)), tIdx = monthIndex(ty, tm);
  var overdue = blank(), none = blank(), later = blank(), months = {}, lastIdx = tIdx + 5; // at least six months shown
  open.forEach(function (o) {
    if (!o.closeDate) { add(none, o, st); return; }
    if (o.closeDate < today) { add(overdue, o, st); return; }
    var idx = monthIndex(Number(o.closeDate.slice(0, 4)), Number(o.closeDate.slice(5, 7)));
    if (idx > tIdx + 11) { add(later, o, st); return; }
    if (!months[idx]) months[idx] = blank();
    add(months[idx], o, st);
    if (idx > lastIdx) lastIdx = idx;
  });
  var timeline = [];
  overdue.key = "overdue"; overdue.kind = "overdue"; overdue.label = "Overdue";
  timeline.push(overdue);
  for (var i = tIdx; i <= lastIdx; i++) {
    var b = months[i] || blank();
    var y = Math.floor(i / 12), m = i % 12;
    b.key = y + "-" + (m + 1); b.kind = "month";
    b.label = MON[m] + (y !== ty ? " '" + String(y).slice(2) : "");
    b.title = MON[m] + " " + y;
    timeline.push(b);
  }
  later.key = "later"; later.kind = "later"; later.label = "Later"; later.title = "Later than 12 months";
  none.key = "none"; none.kind = "none"; none.label = "No date";
  timeline.push(later); timeline.push(none);

  /* data gaps, open pipeline only */
  var gaps = { open: open.length, noSize: 0, noSeller: 0, noNext: 0, overdue: 0, stale: 0, anyGap: 0 };
  open.forEach(function (o) {
    var g = gapsOf(o);
    if (g.length) gaps.anyGap++;
    if (o.size == null) gaps.noSize++;
    if (!o.seller) gaps.noSeller++;
    if (!o.nextStep) gaps.noNext++;
    if (o.closeDate && o.closeDate < today) gaps.overdue++;
    var t = Date.parse(o.updatedAt || "");
    if (!isNaN(t) && (nowMs - t) / 864e5 > staleDays) gaps.stale++;
  });

  var blended = openT.size > 0 ? openT.margin / openT.size : null;

  return {
    today: today,
    scopedCount: scoped.length,
    kpi: { open: openT, won: wonT, lost: lostT, blendedGm: blended },
    byStage: byStage, bySeller: bySeller, byLead: byLead, byTw: byTw,
    timeline: timeline, gaps: gaps, openDeals: open
  };
}

/* ---------- helpers for charts, all measure aware ---------- */
function value(g, measure) { return g[measure]; }

/**
 * Sort sellers by the chosen measure. Keep the top `limit`, fold the rest into "Other".
 * "Unassigned" (no seller) is never folded away, because it is a data gap worth seeing.
 */
function rankSellers(groups, measure, limit) {
  var real = groups.filter(function (g) { return g.key !== "" && g.n > 0; });
  var un = groups.filter(function (g) { return g.key === "" && g.n > 0; })[0];
  real.sort(function (a, b) { return value(b, measure) - value(a, measure) || a.key.localeCompare(b.key); });
  var head = real.slice(0, limit), tail = real.slice(limit);
  var out = head.slice();
  if (tail.length) {
    var other = blank(); other.key = "\u0000other"; other.label = "Other (" + tail.length + ")"; other.folded = tail.length;
    tail.forEach(function (g) {
      other.n += g.n; other.sized += g.sized; other.size += g.size; other.margin += g.margin;
      other.weighted += g.weighted; other.unsized += g.unsized;
    });
    out.push(other);
  }
  if (un) { un.label = "Unassigned"; out.push(un); }
  out.forEach(function (g) { if (!g.label) g.label = g.key; });
  return out;
}

/** Largest open deals by the chosen measure. Deals without a size cannot be ranked and are left out. */
function topDeals(openDeals, st, measure, limit) {
  var rows = openDeals.filter(function (o) { return o.size != null; }).map(function (o) {
    return {
      id: o.id, account: o.account, stage: o.stage, seller: o.seller || "",
      size: o.size, margin: marginOf(o, st), weighted: weightedOf(o, st)
    };
  });
  rows.sort(function (a, b) { return b[measure] - a[measure] || a.account.localeCompare(b.account); });
  return rows.slice(0, limit);
}

/** "$1.24M", "$480K", "$950". Same compact style as the table view. */
function compact(n) {
  if (n == null) return "–";
  var a = Math.abs(n);
  if (a >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return "$" + Math.round(n / 1e3) + "K";
  return "$" + Math.round(n);
}
function full(n) { return n == null ? "" : "$" + Math.round(n).toLocaleString("en-US"); }

root.DashCalc = {
  STAGES: STAGES, OPEN: OPEN, TW_ORDER: TW_ORDER, MEASURES: MEASURES,
  isOpen: isOpen, gmOf: gmOf, marginOf: marginOf, probOf: probOf, weightedOf: weightedOf, gapsOf: gapsOf,
  build: build, rankSellers: rankSellers, topDeals: topDeals, compact: compact, full: full, isoDay: isoDay
};
})(typeof window !== "undefined" ? window : globalThis);
