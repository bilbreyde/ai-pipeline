// Field rules for opportunities and settings. Shared by the API and the importer.

export const STAGES = ["Identified", "Discovery", "Qualified", "Proposal / RFP", "Blocked", "Won", "Lost"];
export const TW_STATUS = ["Engaged", "Strong fit", "Target", "Potential", "Not indicated", "Zones only"];
export const LEADS = ["", "Zones", "Thoughtworks"];
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

export const DEFAULT_SETTINGS = Object.freeze({
  marginBasis: "price",
  defaultGm: 30,
  probs: Object.freeze({
    "Identified": 5,
    "Discovery": 10,
    "Qualified": 25,
    "Proposal / RFP": 50,
    "Blocked": 10,
    "Won": 100,
    "Lost": 0,
  }),
});

// [min, max] length after trimming. min 0 means optional.
const TEXT_RULES = {
  account: [1, 120],
  opportunity: [0, 800],
  segment: [0, 60],
  seller: [0, 80],
  nextStep: [0, 800],
  notes: [0, 2000],
};

export const OPP_FIELDS = [
  "account", "opportunity", "stage", "segment", "lead", "seller",
  "tw", "size", "gmPct", "closeDate", "nextStep", "notes",
];

const DEFAULTS = {
  opportunity: "", stage: "Identified", segment: "", lead: "", seller: "",
  tw: "Not indicated", size: null, gmPct: null, closeDate: "", nextStep: "", notes: "",
};

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function isRealDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Validate an opportunity payload.
 * create (partial=false): every field is filled, missing ones take defaults, account is required.
 * patch (partial=true): only the fields present are validated and returned.
 * Returns { value, errors }. Unknown fields are rejected, never stored.
 */
export function validateOpp(input, { partial = false } = {}) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { errors: ["Body must be a JSON object."] };
  }
  const errors = [];
  const out = {};

  for (const k of Object.keys(input)) {
    if (!OPP_FIELDS.includes(k)) errors.push(`Unknown field: ${k}.`);
  }

  for (const [k, [min, max]] of Object.entries(TEXT_RULES)) {
    if (!has(input, k)) {
      if (!partial && min > 0) errors.push(`${k} is required.`);
      continue;
    }
    if (typeof input[k] !== "string") { errors.push(`${k} must be text.`); continue; }
    const v = input[k].trim();
    if (v.length < min) errors.push(`${k} is required.`);
    else if (v.length > max) errors.push(`${k} must be ${max} characters or fewer.`);
    else out[k] = v;
  }

  if (has(input, "stage")) {
    if (!STAGES.includes(input.stage)) errors.push(`stage must be one of: ${STAGES.join(", ")}.`);
    else out.stage = input.stage;
  }
  if (has(input, "tw")) {
    if (!TW_STATUS.includes(input.tw)) errors.push(`tw must be one of: ${TW_STATUS.join(", ")}.`);
    else out.tw = input.tw;
  }
  if (has(input, "lead")) {
    if (!LEADS.includes(input.lead)) errors.push(`lead must be blank, Zones or Thoughtworks.`);
    else out.lead = input.lead;
  }
  if (has(input, "size")) {
    const s = input.size;
    if (s === null) out.size = null;
    else if (typeof s !== "number" || !Number.isFinite(s) || s < 0 || s > 1e10) errors.push("size must be a number between 0 and 10,000,000,000, or null.");
    else out.size = Math.round(s);
  }
  if (has(input, "gmPct")) {
    const g = input.gmPct;
    if (g === null) out.gmPct = null;
    else if (typeof g !== "number" || !Number.isFinite(g) || g < 1 || g > 90) errors.push("gmPct must be a number from 1 to 90, or null.");
    else out.gmPct = g;
  }
  if (has(input, "closeDate")) {
    const d = input.closeDate;
    if (d === "" || d === null) out.closeDate = "";
    else if (typeof d !== "string" || !isRealDate(d)) errors.push("closeDate must be blank or a real date as YYYY-MM-DD.");
    else out.closeDate = d;
  }

  if (errors.length) return { errors };
  if (!partial) {
    for (const [k, v] of Object.entries(DEFAULTS)) if (!has(out, k)) out[k] = v;
  }
  return { value: out, errors: [] };
}

/** Validate a settings payload. Returns { value, errors }. */
export function validateSettings(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { errors: ["Body must be a JSON object."] };
  }
  const errors = [];
  for (const k of Object.keys(input)) {
    if (!["marginBasis", "defaultGm", "probs"].includes(k)) errors.push(`Unknown field: ${k}.`);
  }
  if (input.marginBasis !== "price" && input.marginBasis !== "cost") errors.push("marginBasis must be price or cost.");
  const g = input.defaultGm;
  if (typeof g !== "number" || !Number.isFinite(g) || g < 1 || g > 90) errors.push("defaultGm must be a number from 1 to 90.");
  const probs = {};
  if (input.probs === null || typeof input.probs !== "object" || Array.isArray(input.probs)) {
    errors.push("probs must be an object keyed by stage.");
  } else {
    for (const k of Object.keys(input.probs)) if (!STAGES.includes(k)) errors.push(`Unknown stage in probs: ${k}.`);
    for (const s of STAGES) {
      const p = input.probs[s];
      if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 100) errors.push(`probs["${s}"] must be a number from 0 to 100.`);
      else probs[s] = p;
    }
  }
  if (errors.length) return { errors };
  return { value: { marginBasis: input.marginBasis, defaultGm: g, probs }, errors: [] };
}
