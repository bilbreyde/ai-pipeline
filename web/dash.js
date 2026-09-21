/* Dashboard tab. Charts are hand built inline SVG: no libraries, no third party requests, strict CSP safe.
   Every label that comes from data (account, seller) is inserted with textContent, never as markup.
   Depends on dash-calc.js. app.js calls Dash.render(ctx) whenever the dashboard is visible and data changes. */
(function () {
"use strict";
var C = window.DashCalc;
var SVGNS = "http://www.w3.org/2000/svg";
var D = { measure: "margin", lead: "", seg: "", tables: {} };
var last = null, cards = [], tip = null, built = false, lastW = 0, resizeT = 0;
var SELLER_LIMIT = 7, DEAL_LIMIT = 8;

/* ---------- tiny DOM helpers ---------- */
function apply(el, attrs) {
  for (var k in attrs) { if (attrs[k] !== null && attrs[k] !== undefined) el.setAttribute(k, attrs[k]); }
}
function add(el, kids) {
  (kids || []).forEach(function (k) {
    if (k === null || k === undefined || k === false) return;
    el.appendChild(typeof k === "object" ? k : document.createTextNode(String(k)));
  });
  return el;
}
function h(tag, attrs, kids) { var el = document.createElement(tag); apply(el, attrs); return add(el, kids); }
function s(tag, attrs, text) {
  var el = document.createElementNS(SVGNS, tag); apply(el, attrs);
  if (text !== undefined) el.textContent = text;
  return el;
}
function $(id) { return document.getElementById(id); }
function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
function plural(n, one, many) { return n + " " + (n === 1 ? one : (many || one + "s")); }
function pct(x) { return (Math.round(x * 1000) / 10).toFixed(1).replace(/\.0$/, "") + "%"; }
function textW(str, size) { return String(str).length * size * 0.58; }
function fit(str, maxPx, size) {
  var max = Math.max(3, Math.floor(maxPx / (size * 0.58)));
  str = String(str);
  return str.length <= max ? str : str.slice(0, max - 1) + "…";
}

/* ---------- color helpers: label ink chosen by the fill under it ---------- */
function lum(hex) {
  var m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return null;
  var v = [0, 2, 4].map(function (i) {
    var c = parseInt(m[1].slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
function varHex(varName) { return getComputedStyle(document.documentElement).getPropertyValue(varName).trim(); }
function inkOn(varName) {
  var hex = getComputedStyle(document.documentElement).getPropertyValue(varName);
  var L = lum(hex);
  if (L === null) return "#0b0b0b";
  var vsWhite = 1.05 / (L + 0.05), vsBlack = (L + 0.05) / 0.0538; // 0b0b0b luminance is about 0.0033
  return vsWhite >= vsBlack ? "#ffffff" : "#0b0b0b";
}

/* ---------- path builders: 4px rounded data end, square at the baseline ---------- */
function hBarPath(x, y, w, ht, r) {
  r = Math.min(r, w, ht / 2);
  return "M" + x + "," + y + "h" + (w - r) + "a" + r + "," + r + " 0 0 1 " + r + "," + r + "v" + (ht - 2 * r) +
    "a" + r + "," + r + " 0 0 1 " + (-r) + "," + r + "h" + (-(w - r)) + "z";
}
function vBarPath(x, y, w, ht, r) {
  r = Math.min(r, w / 2, ht);
  return "M" + x + "," + (y + ht) + "v" + (-(ht - r)) + "a" + r + "," + r + " 0 0 1 " + r + "," + (-r) +
    "h" + (w - 2 * r) + "a" + r + "," + r + " 0 0 1 " + r + "," + r + "v" + (ht - r) + "z";
}
function segPath(x, y, w, ht, r, roundLeft, roundRight) {
  var rl = roundLeft ? Math.min(r, w / 2, ht / 2) : 0, rr = roundRight ? Math.min(r, w / 2, ht / 2) : 0;
  return "M" + (x + rl) + "," + y + "h" + (w - rl - rr) +
    (rr ? "a" + rr + "," + rr + " 0 0 1 " + rr + "," + rr : "") + "v" + (ht - 2 * rr) +
    (rr ? "a" + rr + "," + rr + " 0 0 1 " + (-rr) + "," + rr : "") + "h" + (-(w - rl - rr)) +
    (rl ? "a" + rl + "," + rl + " 0 0 1 " + (-rl) + "," + (-rl) : "") + "v" + (-(ht - 2 * rl)) +
    (rl ? "a" + rl + "," + rl + " 0 0 1 " + rl + "," + (-rl) : "") + "z";
}

/* ---------- tooltip: enhances, never gates. Every value here is also in a label or the table view. ---------- */
function ensureTip() {
  if (tip) return;
  tip = h("div", { id: "tip", role: "tooltip", hidden: "" });
  document.body.appendChild(tip);
}
function hideTip() { if (tip) tip.hidden = true; }
function showTip(d, x, y) {
  ensureTip();
  clear(tip);
  add(tip, [
    h("div", { class: "tip-val" }, [d.value]),
    h("div", { class: "tip-name" }, [d.name])
  ]);
  (d.rows || []).forEach(function (r) {
    add(tip, [h("div", { class: "tip-row" }, [
      h("span", { class: "tip-key " + (r.cls || "") }),
      h("span", { class: "tip-k" }, [r.k]),
      h("b", null, [r.v])
    ])]);
  });
  tip.hidden = false;
  var w = tip.offsetWidth, ht = tip.offsetHeight;
  var left = Math.min(Math.max(8, x + 14), window.innerWidth - w - 8);
  var top = y + 16 + ht > window.innerHeight - 8 ? Math.max(8, y - ht - 12) : y + 16;
  tip.style.left = left + "px";
  tip.style.top = top + "px";
}
function bindTip(node, d) {
  node.addEventListener("pointermove", function (e) { showTip(d, e.clientX, e.clientY); });
  node.addEventListener("pointerleave", hideTip);
  node.addEventListener("focus", function () {
    var r = node.getBoundingClientRect();
    showTip(d, r.left + Math.min(r.width, 220) / 2, r.top + r.height / 2);
  });
  node.addEventListener("blur", hideTip);
}

/* ---------- chart primitives ---------- */
/** What to print at a bar tip. Zero deals and deals without a size are different facts, so they read differently. */
function valText(g, m) { return g.n === 0 ? "None" : g.sized === 0 ? "No size" : C.compact(g[m]); }
function measureRows(g, st) {
  return [
    { k: "Deals", v: String(g.n) },
    { k: "Deal size", v: C.full(g.size) },
    { k: "Estimated margin", v: C.full(g.margin) },
    { k: "Weighted margin", v: C.full(g.weighted) }
  ].concat(g.unsized ? [{ k: "Without a size", v: String(g.unsized) }] : []);
}

/** Horizontal bars. rows: [{label, sub, value, cls, name, tipRows, aria}]. Values are labelled at the bar tip. */
function hBars(container, rows, opt) {
  opt = opt || {};
  var W = Math.max(280, container.clientWidth), twoLine = rows.some(function (r) { return r.sub; });
  var pitch = twoLine ? 42 : 32, barH = 18, pad = 4;
  var labelW = Math.round(Math.min(opt.maxLabel || 180, Math.max(96, W * 0.32)));
  var valueRoom = 76, barMax = Math.max(40, W - labelW - valueRoom);
  var max = Math.max.apply(null, rows.map(function (r) { return r.value || 0; }).concat([0]));
  var H = rows.length * pitch + pad * 2;
  var svg = s("svg", { class: "chart", width: W, height: H, viewBox: "0 0 " + W + " " + H, role: "group", "aria-label": opt.aria || "Bar chart" });
  svg.appendChild(s("line", { class: "axis", x1: labelW, x2: labelW, y1: 0, y2: H }));
  rows.forEach(function (r, i) {
    var y = pad + i * pitch;
    var g = s("g", { class: "row", tabindex: 0, role: "img", "aria-label": r.aria });
    g.appendChild(s("rect", { class: "hit", x: 0, y: y, width: W, height: pitch }));
    var mid = y + pitch / 2;
    g.appendChild(s("text", { class: "t-lbl", x: 0, y: r.sub ? mid - 3 : mid + 4 }, fit(r.label, labelW - 12, 12)));
    if (r.sub) g.appendChild(s("text", { class: "t-sub", x: 0, y: mid + 12 }, fit(r.sub, labelW - 12, 11)));
    var len = max > 0 ? Math.round((r.value || 0) / max * barMax) : 0;
    if (len > 0) g.appendChild(s("path", { class: "mark " + r.cls, d: hBarPath(labelW, y + (pitch - barH) / 2, Math.max(len, 2), barH, 4) }));
    g.appendChild(s("text", { class: "t-val", x: labelW + Math.max(len, 2) + 8, y: mid + 4 }, r.valueText));
    bindTip(g, { value: r.valueText, name: r.name, rows: r.tipRows });
    svg.appendChild(g);
  });
  container.appendChild(svg);
}

/** Columns for the close timeline. buckets: [{label, short, value, cls, name, tipRows, valueText, aria}] */
function columns(container, buckets, opt) {
  var W = Math.max(300, container.clientWidth), H = 236, top = 24, axisBand = 34, left = 4;
  var n = buckets.length, band = (W - left * 2) / n, colW = Math.min(24, Math.floor(band * 0.6));
  var base = H - axisBand, plotH = base - top;
  var max = Math.max.apply(null, buckets.map(function (b) { return b.value || 0; }).concat([0]));
  var maxIdx = -1;
  buckets.forEach(function (b, i) { if (max > 0 && b.value === max && maxIdx < 0) maxIdx = i; });
  var svg = s("svg", { class: "chart", width: W, height: H, viewBox: "0 0 " + W + " " + H, role: "group", "aria-label": opt.aria });
  svg.appendChild(s("line", { class: "axis", x1: left, x2: W - left, y1: base, y2: base }));
  buckets.forEach(function (b, i) {
    var cx = left + band * i + band / 2;
    var hgt = max > 0 ? Math.round((b.value || 0) / max * plotH) : 0;
    var g = s("g", { class: "row", tabindex: 0, role: "img", "aria-label": b.aria });
    g.appendChild(s("rect", { class: "hit", x: cx - band / 2, y: 0, width: band, height: H }));
    if (hgt > 0) g.appendChild(s("path", { class: "mark tx " + b.cls, d: vBarPath(cx - colW / 2, base - Math.max(hgt, 2), colW, Math.max(hgt, 2), 4) }));
    var wide = band >= textW(b.valueText, 11) + 10;
    if ((b.value || 0) > 0 && (wide || i === maxIdx)) {
      g.appendChild(s("text", { class: "t-val t-mid", x: cx, y: base - Math.max(hgt, 2) - 6 }, b.valueText));
    }
    var lbl = band < textW(b.label, 11) + 6 ? (b.short || b.label) : b.label;
    if (band >= textW(lbl, 11) + 4) g.appendChild(s("text", { class: "t-ax t-mid", x: cx, y: base + 18 }, lbl)); // names are in the tooltip and table view
    bindTip(g, { value: b.valueText, name: b.name, rows: b.tipRows });
    svg.appendChild(g);
  });
  container.appendChild(svg);
}

/** One horizontal stacked bar with a 2px surface gap between segments. Percent inside a segment only when it fits. */
function stack(container, segs, total, opt) {
  var W = Math.max(280, container.clientWidth), ht = 28, gap = 2;
  var live = segs.filter(function (g) { return g.value > 0; });
  var svg = s("svg", { class: "chart", width: W, height: ht + 4, viewBox: "0 0 " + W + " " + (ht + 4), role: "group", "aria-label": opt.aria });
  var avail = W - gap * Math.max(0, live.length - 1), x = 0;
  live.forEach(function (g, i) {
    var w = Math.max(3, Math.round(g.value / total * avail));
    if (i === live.length - 1) w = Math.max(3, W - x);
    var node = s("g", { class: "row", tabindex: 0, role: "img", "aria-label": g.aria });
    node.appendChild(s("rect", { class: "hit", x: x, y: 0, width: w, height: ht + 4 }));
    node.appendChild(s("path", { class: "mark tx " + g.cls, d: segPath(x, 2, w, ht, 4, i === 0, i === live.length - 1) }));
    var lab = pct(g.value / total);
    if (w >= textW(lab, 12) + 16) {
      node.appendChild(s("text", { class: "t-mid t-in", x: x + w / 2, y: 2 + ht / 2 + 4, fill: inkOn(g.inkVar), stroke: varHex(g.inkVar) }, lab));
    }
    bindTip(node, { value: g.valueText, name: g.name, rows: g.tipRows });
    svg.appendChild(node);
    x += w + gap;
  });
  container.appendChild(svg);
}

function legend(items) {
  return h("ul", { class: "legend" }, items.map(function (i) {
    return h("li", null, [
      h("span", { class: "sw " + i.cls }),
      h("span", { class: "lg-name" }, [i.name]),
      i.val ? h("span", { class: "lg-val" }, [i.val]) : null
    ]);
  }));
}

/* ---------- cards ---------- */
function makeCard(id, title, wide) {
  var body = h("div", { class: "chart-body" });
  var tables = h("div", { class: "chart-table", hidden: "" });
  var sub = h("p", { class: "card-sub" });
  var btn = h("button", { class: "btn small tbl-toggle", type: "button", "aria-pressed": "false" }, ["Table view"]);
  var root = h("section", { class: "card" + (wide ? " wide" : ""), "aria-labelledby": "h-" + id }, [
    h("header", null, [h("div", null, [h("h2", { id: "h-" + id }, [title]), sub]), btn]),
    body, tables
  ]);
  var card = { id: id, root: root, body: body, tables: tables, sub: sub, btn: btn, render: null, specs: [] };
  btn.addEventListener("click", function () {
    D.tables[id] = !D.tables[id];
    syncTable(card);
  });
  return card;
}
function syncTable(card) {
  var on = !!D.tables[card.id];
  card.body.hidden = on;
  card.tables.hidden = !on;
  card.btn.setAttribute("aria-pressed", String(on));
  card.btn.textContent = on ? "Chart view" : "Table view";
  hideTip();
}
function fillTables(card) {
  clear(card.tables);
  card.specs.forEach(function (sp) {
    var t = h("table", { class: "dt" }, [
      h("caption", null, [sp.caption]),
      h("thead", null, [h("tr", null, sp.head.map(function (x, i) { return h("th", { class: i ? "num" : "" }, [x]); }))]),
      h("tbody", null, sp.rows.map(function (r) {
        return h("tr", null, r.map(function (x, i) { return h(i ? "td" : "th", { class: i ? "num" : "", scope: i ? null : "row" }, [x]); }));
      }))
    ]);
    card.tables.appendChild(t);
  });
}

var ORD = ["o1", "o2", "o3", "o4"];
var TW_ORD_CLS = { "Engaged": "o4", "Strong fit": "o3", "Target": "o2", "Potential": "o1", "Not indicated": "cg", "Zones only": "cg" };
var STAGE_CLS = { "Identified": "o1", "Discovery": "o2", "Qualified": "o3", "Proposal / RFP": "o4", "Blocked": "cg" };

function build() {
  var stage = makeCard("stage", "Margin by stage");
  stage.render = function (data, m, st) {
    var rows = data.byStage.map(function (g) {
      return {
        label: g.key, value: g[m], valueText: valText(g, m), cls: STAGE_CLS[g.key],
        name: g.key + " (" + plural(g.n, "deal") + ")", tipRows: measureRows(g, st),
        aria: g.key + ", " + C.MEASURES[m] + " " + C.compact(g[m]) + ", " + plural(g.n, "deal")
      };
    });
    hBars(stage.body, rows, { aria: C.MEASURES[m] + " by stage" });
    var unsized = data.kpi.open.unsized;
    stage.sub.textContent = C.MEASURES[m] + " on " + plural(data.kpi.open.n, "open deal") + ". Darker bars are later in the sales process. Blocked is gray." +
      (unsized ? " " + plural(unsized, "deal") + " without a size " + (unsized === 1 ? "is" : "are") + " not counted." : "");
    stage.specs = [{
      caption: "Open pipeline by stage", head: ["Stage", "Deals", "Deal size", "Est. margin", "Weighted margin"],
      rows: data.byStage.map(function (g) { return [g.key, String(g.n), C.full(g.size), C.full(g.margin), C.full(g.weighted)]; })
    }];
  };

  var seller = makeCard("seller", "Margin by seller");
  seller.render = function (data, m, st) {
    var ranked = C.rankSellers(data.bySeller, m, SELLER_LIMIT);
    var rows = ranked.map(function (g) {
      return {
        label: g.label, value: g[m], valueText: valText(g, m),
        cls: g.key === "" || g.folded ? "cg" : "c1", name: g.label + " (" + plural(g.n, "deal") + ")", tipRows: measureRows(g, st),
        aria: g.label + ", " + C.MEASURES[m] + " " + C.compact(g[m]) + ", " + plural(g.n, "deal")
      };
    });
    if (!rows.length) { seller.body.appendChild(h("p", { class: "empty" }, ["No open opportunities in this view."])); }
    else hBars(seller.body, rows, { aria: C.MEASURES[m] + " by seller" });
    var un = data.bySeller.filter(function (g) { return g.key === "" && g.n; })[0];
    seller.sub.textContent = C.MEASURES[m] + " by seller, open pipeline." + (un ? " " + plural(un.n, "deal") + " with no seller " + (un.n === 1 ? "is" : "are") + " shown in gray." : "");
    seller.specs = [{
      caption: "Open pipeline by seller", head: ["Seller", "Deals", "Deal size", "Est. margin", "Weighted margin"],
      rows: ranked.map(function (g) { return [g.label, String(g.n), C.full(g.size), C.full(g.margin), C.full(g.weighted)]; })
    }];
  };

  var timeline = makeCard("timeline", "Expected close timeline", true);
  timeline.render = function (data, m, st) {
    var bs = data.timeline.map(function (g) {
      var cls = g.kind === "overdue" ? "c2" : g.kind === "none" ? "cg" : "c1";
      var nm = (g.title || g.label) + " (" + plural(g.n, "deal") + ")";
      return {
        label: g.label, short: g.kind === "overdue" ? "Past" : g.kind === "later" ? "12m+" : g.kind === "none" ? "None" : g.label.replace(/ '\d\d$/, ""),
        value: g[m], valueText: C.compact(g[m]), cls: cls, name: nm, tipRows: measureRows(g, st),
        aria: nm + ", " + C.MEASURES[m] + " " + C.compact(g[m])
      };
    });
    timeline.body.appendChild(legend([
      { cls: "c1", name: "Scheduled" }, { cls: "c2", name: "Overdue (close date has passed)" }, { cls: "cg", name: "No close date" }
    ]));
    columns(timeline.body, bs, { aria: C.MEASURES[m] + " by expected close month" });
    var over = data.timeline[0], none = data.timeline[data.timeline.length - 1];
    timeline.sub.textContent = C.MEASURES[m] + " of open deals by expected close month." +
      (over.n ? " " + plural(over.n, "deal") + " past the close date." : "") + (none.n ? " " + plural(none.n, "deal") + " with no date." : "");
    timeline.specs = [{
      caption: "Open pipeline by expected close", head: ["Close", "Deals", "Deal size", "Est. margin", "Weighted margin"],
      rows: data.timeline.map(function (g) { return [g.title || g.label, String(g.n), C.full(g.size), C.full(g.margin), C.full(g.weighted)]; })
    }];
  };

  var lead = makeCard("lead", "Zones and Thoughtworks");
  lead.render = function (data, m, st) {
    var names = { "Zones": "Zones", "Thoughtworks": "Thoughtworks", "": "Lead not set" };
    var cls = { "Zones": "c1", "Thoughtworks": "c2", "": "cg" };
    var inkVar = { "Zones": "--c1", "Thoughtworks": "--c2", "": "--cg" };
    var total = data.byLead.reduce(function (a, g) { return a + (g[m] || 0); }, 0);
    lead.body.appendChild(h("h3", { class: "mini" }, ["Who leads the deal"]));
    if (total > 0) {
      var segs = data.byLead.map(function (g) {
        return {
          value: g[m], cls: cls[g.key], inkVar: inkVar[g.key], valueText: C.compact(g[m]),
          name: names[g.key] + " (" + plural(g.n, "deal") + ")", tipRows: measureRows(g, st),
          aria: names[g.key] + ", " + C.compact(g[m]) + ", " + pct(g[m] / total)
        };
      });
      stack(lead.body, segs, total, { aria: C.MEASURES[m] + " by lead" });
      lead.body.appendChild(legend(data.byLead.map(function (g) {
        return { cls: cls[g.key], name: names[g.key], val: C.compact(g[m]) + (total ? " · " + pct((g[m] || 0) / total) : "") };
      })));
    } else {
      lead.body.appendChild(h("p", { class: "empty" }, ["Nothing to split yet. Add deal sizes to see this."]));
    }
    lead.body.appendChild(h("h3", { class: "mini" }, ["Thoughtworks engagement"]));
    var rows = data.byTw.map(function (g) {
      return {
        label: g.key, value: g[m], valueText: valText(g, m), cls: TW_ORD_CLS[g.key],
        name: g.key + " (" + plural(g.n, "deal") + ")", tipRows: measureRows(g, st),
        aria: g.key + ", " + C.MEASURES[m] + " " + C.compact(g[m]) + ", " + plural(g.n, "deal")
      };
    });
    hBars(lead.body, rows, { aria: C.MEASURES[m] + " by Thoughtworks engagement", maxLabel: 120 });
    lead.sub.textContent = C.MEASURES[m] + ", open pipeline. Darker engagement bars mean closer Thoughtworks involvement.";
    lead.specs = [
      { caption: "Open pipeline by lead", head: ["Lead", "Deals", "Deal size", "Est. margin", "Weighted margin"],
        rows: data.byLead.map(function (g) { return [names[g.key], String(g.n), C.full(g.size), C.full(g.margin), C.full(g.weighted)]; }) },
      { caption: "Open pipeline by Thoughtworks engagement", head: ["Engagement", "Deals", "Deal size", "Est. margin", "Weighted margin"],
        rows: data.byTw.map(function (g) { return [g.key, String(g.n), C.full(g.size), C.full(g.margin), C.full(g.weighted)]; }) }
    ];
  };

  var deals = makeCard("deals", "Largest open deals");
  deals.render = function (data, m, st) {
    var top = C.topDeals(data.openDeals, st, m, DEAL_LIMIT);
    var rows = top.map(function (d) {
      var sub = d.stage + (d.seller ? " · " + d.seller : "");
      return {
        label: d.account, sub: sub, value: d[m], valueText: C.compact(d[m]), cls: "c1", name: d.account + ", " + sub,
        tipRows: [{ k: "Deal size", v: C.full(d.size) }, { k: "Estimated margin", v: C.full(d.margin) }, { k: "Weighted margin", v: C.full(d.weighted) }],
        aria: d.account + ", " + d.stage + ", " + C.MEASURES[m] + " " + C.compact(d[m])
      };
    });
    if (!rows.length) deals.body.appendChild(h("p", { class: "empty" }, ["No sized open deals in this view."]));
    else hBars(deals.body, rows, { aria: "Largest open deals by " + C.MEASURES[m].toLowerCase(), maxLabel: 190 });
    var skipped = data.kpi.open.unsized;
    deals.sub.textContent = "Top " + rows.length + " by " + C.MEASURES[m].toLowerCase() + "." + (skipped ? " " + plural(skipped, "deal") + " without a size cannot be ranked." : "");
    deals.specs = [{
      caption: "Largest open deals", head: ["Account", "Stage", "Seller", "Deal size", "Est. margin", "Weighted margin"],
      rows: top.map(function (d) { return [d.account, d.stage, d.seller || "Unassigned", C.full(d.size), C.full(d.margin), C.full(d.weighted)]; })
    }];
  };

  var gaps = makeCard("gaps", "Data quality", true);
  gaps.render = function (data) {
    var g = data.gaps, n = g.open;
    var items = [
      { k: "No deal size", v: g.noSize, hint: "Not counted in any margin figure." },
      { k: "No seller", v: g.noSeller, hint: "Nobody owns the follow up." },
      { k: "No next step", v: g.noNext, hint: "Nothing is planned." },
      { k: "Past expected close", v: g.overdue, hint: "The close date has passed and the deal is still open." },
      { k: "Not updated in 14 days", v: g.stale, hint: "Possibly stale. Check with the seller." }
    ];
    var list = h("ul", { class: "gap-list" });
    items.forEach(function (i) {
      var share = n ? i.v / n : 0;
      var fill = h("i", { class: "gap-fill" });
      fill.style.width = Math.round(share * 100) + "%";
      list.appendChild(h("li", null, [
        h("span", { class: "gap-k" }, [i.k]),
        h("span", { class: "gap-track", "aria-hidden": "true" }, [fill]),
        h("span", { class: "gap-v" }, [i.v ? i.v + " of " + n : "None"]),
        h("span", { class: "gap-hint" }, [i.hint])
      ]));
    });
    gaps.body.appendChild(list);
    gaps.body.appendChild(h("p", { class: "gap-foot" }, [
      g.anyGap ? plural(g.anyGap, "open row") + " " + (g.anyGap === 1 ? "has" : "have") + " a size, seller or next step missing. " : "Every open row has a size, seller and next step. ",
      g.anyGap ? h("button", { class: "btn small", type: "button", id: "dashShowGaps" }, ["Show these rows"]) : null
    ]));
    var btn = gaps.body.querySelector("#dashShowGaps");
    if (btn && last && last.hooks) btn.addEventListener("click", last.hooks.showGaps);
    gaps.sub.textContent = "Open pipeline only. Gaps here are the ones that make the totals wrong.";
    gaps.specs = [{
      caption: "Open rows with a data gap", head: ["Check", "Rows", "Of open rows"],
      rows: items.map(function (i) { return [i.k, String(i.v), String(n)]; })
    }];
  };

  return [stage, seller, timeline, lead, deals, gaps];
}

/* ---------- KPI row and filters ---------- */
function renderKpis(data) {
  var k = data.kpi, box = $("dashKpis");
  clear(box);
  function tile(label, val, note, hero) {
    return h("div", { class: "kpi" + (hero ? " hero" : "") }, [
      h("span", { class: "k-label" }, [label]),
      h("span", { class: "k-val" }, [val]),
      h("span", { class: "k-note" }, [note])
    ]);
  }
  var blended = k.blendedGm == null ? "" : "Blended GM " + pct(k.blendedGm);
  add(box, [
    tile("Weighted margin", C.compact(k.open.weighted), "Open pipeline, by stage win probability", true),
    tile("Estimated margin", C.compact(k.open.margin), blended || "Add deal sizes to see this"),
    tile("Open deal size", C.compact(k.open.size), plural(k.open.n, "open deal") + (k.open.unsized ? ", " + k.open.unsized + " without a size" : "")),
    tile("Closed won", C.compact(k.won.margin), plural(k.won.n, "deal") + ", " + C.compact(k.won.size) + " deal size"),
    tile("Rows with gaps", data.gaps.anyGap + " of " + data.gaps.open, "Missing a size, seller or next step")
  ]);
}
function segments(opps) {
  var set = {};
  opps.forEach(function (o) { if (o.segment) set[o.segment] = 1; });
  return Object.keys(set).sort();
}
function syncFilters(ctx, data) {
  var seg = $("dSeg"), cur = D.seg, list = segments(ctx.opps);
  if (cur && list.indexOf(cur) < 0) { D.seg = cur = ""; }
  var sig = list.join("|");
  if (seg.getAttribute("data-sig") !== sig) {
    clear(seg);
    add(seg, [h("option", { value: "" }, ["Any segment"])].concat(list.map(function (x) { return h("option", { value: x }, [x]); })));
    seg.setAttribute("data-sig", sig);
  }
  seg.value = D.seg;
  $("dLead").value = D.lead;
  Array.prototype.forEach.call(document.querySelectorAll("#dMeasure [role=radio]"), function (b) {
    var on = b.getAttribute("data-m") === D.measure;
    b.setAttribute("aria-checked", String(on));
    b.tabIndex = on ? 0 : -1;
  });
  var total = ctx.opps.length, shown = data.scopedCount;
  $("dScope").textContent = (D.lead || D.seg) ? "Showing " + shown + " of " + total + " opportunities. Won and lost deals count only in the tiles." : "Won and lost deals count only in the tiles.";
}

/* ---------- public ---------- */
function render(ctx) {
  last = ctx;
  var view = $("view-dash");
  if (!view || view.hidden || !ctx.loaded) return;
  if (!built) { init(); }
  var data = C.build(ctx.opps, ctx.settings, { lead: D.lead, seg: D.seg });
  hideTip();
  renderKpis(data);
  syncFilters(ctx, data);
  cards.forEach(function (c) {
    clear(c.body);
    c.render(data, D.measure, ctx.settings);
    fillTables(c);
    syncTable(c);
  });
  lastW = view.clientWidth;
}

function init() {
  built = true;
  cards = build();
  var grid = $("dashGrid");
  cards.forEach(function (c) { grid.appendChild(c.root); });

  $("dMeasure").addEventListener("click", function (e) {
    var b = e.target.closest("[data-m]"); if (!b) return;
    D.measure = b.getAttribute("data-m"); rerender();
  });
  $("dMeasure").addEventListener("keydown", function (e) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    var keys = ["margin", "weighted", "size"], i = keys.indexOf(D.measure);
    i = (i + (e.key === "ArrowRight" ? 1 : keys.length - 1)) % keys.length;
    D.measure = keys[i]; rerender();
    var b = document.querySelector('#dMeasure [data-m="' + D.measure + '"]'); if (b) b.focus();
  });
  $("dLead").addEventListener("change", function (e) { D.lead = e.target.value; rerender(); });
  $("dSeg").addEventListener("change", function (e) { D.seg = e.target.value; rerender(); });
  document.addEventListener("scroll", hideTip, true);

  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(function () {
      var v = $("view-dash");
      if (!v || v.hidden || Math.abs(v.clientWidth - lastW) < 8) return;
      clearTimeout(resizeT);
      resizeT = setTimeout(rerender, 120);
    }).observe($("view-dash"));
  }
}
function rerender() { if (last) render(last); }

window.Dash = { render: render, rerender: rerender, state: D };
})();
