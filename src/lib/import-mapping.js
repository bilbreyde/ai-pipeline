// Pure mapping rules from the old spreadsheet's free text to this app's fields.
// Deliberately contains no account names: rules key off wording, so this file is safe to keep in git.

/** Free text Status -> stage. Order matters: the first rule that matches wins. */
export function mapStage(status) {
  const s = String(status ?? "").toLowerCase();
  if (/block/.test(s)) return "Blocked";
  if (/\brfp\b|proposal/.test(s)) return "Proposal / RFP";
  if (/\bwon\b/.test(s)) return "Won";
  if (/\blost\b/.test(s)) return "Lost";
  if (/qualified|active/.test(s)) return "Qualified";
  if (/early|identified/.test(s)) return "Identified";
  return "Discovery";
}

/** "Thoughtworks Engaged?" free text -> one of the fixed values. */
export function mapTw(text) {
  const s = String(text ?? "").trim().toLowerCase();
  if (s.startsWith("yes - actively") || s.startsWith("yes, actively")) return "Engaged";
  if (s.startsWith("yes")) return "Strong fit";
  if (s.startsWith("target")) return "Target";
  if (s.startsWith("potential")) return "Potential";
  if (s.startsWith("no, zones") || s.startsWith("zones")) return "Zones only";
  return "Not indicated";
}

export function mapLead(text) {
  const s = String(text ?? "").toLowerCase();
  if (/thoughtworks|\btw\b/.test(s)) return "Thoughtworks";
  if (/zones/.test(s)) return "Zones";
  return "";
}

/**
 * Deal size from a number, or from text such as "In Discovery (200K)".
 * Returns { size, heuristic }. heuristic is true when a bare number in parentheses,
 * like "(100)", was read as thousands, which is what the source workbook meant.
 */
export function parseSize(value) {
  if (typeof value === "number" && Number.isFinite(value)) return { size: Math.round(value), heuristic: false };
  const s = String(value ?? "");
  let m = s.match(/\((\d+(?:\.\d+)?)\s*k\)/i);
  if (m) return { size: Math.round(parseFloat(m[1]) * 1e3), heuristic: false };
  m = s.match(/\((\d+(?:\.\d+)?)\s*m\)/i);
  if (m) return { size: Math.round(parseFloat(m[1]) * 1e6), heuristic: false };
  m = s.match(/\((\d+)\)/);
  if (m) return { size: parseInt(m[1], 10) * 1e3, heuristic: true };
  return { size: null, heuristic: false };
}

/** Truncated names in the source, like "Salt River Project (", lose the dangling bracket. */
export function cleanAccount(name) {
  return String(name ?? "").replace(/\s*\(\s*$/, "").trim();
}

export function slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}
