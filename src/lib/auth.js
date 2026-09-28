// Username and password sign in. Stand in for Entra ID in a dev tenant where an app registration
// is not an option. No third party auth library and no signing secret: passwords are hashed with
// Node's built in scrypt, and sessions are opaque random tokens looked up in the store on every
// request, never a signed token, so there is nothing that needs to be kept secret to run this file
// and revoking access is just deleting a document, not rotating a key.
//
// Accounts are managed with scripts/manage-users.mjs, run locally against Cosmos with your own
// az login. There is no admin role and no user management API in the running app: whoever can
// reach Cosmos controls who exists, the same trust boundary the rest of this project already uses.

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);

export const USERNAME_PATTERN = /^[a-z0-9._-]{2,40}$/;
export const MIN_PASSWORD_LENGTH = 12;

export const SESSION_COOKIE = "pipeline_session";
const SESSION_HOURS = 24;

const LOCKOUT_MAX_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

/** { hash, salt }, both hex. Store both on the user document. */
export async function hashPassword(password) {
  const salt = randomBytes(SALT_BYTES).toString("hex");
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN);
  return { hash: derived.toString("hex"), salt };
}

/** Timing safe: always compares the full derived key, never short circuits on a byte mismatch. */
export async function verifyPassword(password, hash, salt) {
  if (typeof hash !== "string" || typeof salt !== "string" || !hash || !salt) return false;
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN);
  const stored = Buffer.from(hash, "hex");
  if (stored.length !== derived.length) return false;
  return timingSafeEqual(derived, stored);
}

export function normalizeUsername(input) {
  return typeof input === "string" ? input.trim().toLowerCase() : "";
}

export function validateUsername(input) {
  const u = normalizeUsername(input);
  return USERNAME_PATTERN.test(u) ? u : null;
}

export function validatePassword(input) {
  return typeof input === "string" && input.length >= MIN_PASSWORD_LENGTH && input.length <= 200;
}

export function newSessionToken() {
  return randomBytes(32).toString("hex");
}

export function sessionExpiry(from = new Date()) {
  return new Date(from.getTime() + SESSION_HOURS * 3600 * 1000).toISOString();
}

export function isExpired(iso) {
  const t = Date.parse(iso);
  return Number.isNaN(t) || t <= Date.now();
}

/** Is this account locked out right now, after too many failed attempts? */
export function isLocked(user) {
  return !!user?.lockedUntil && !isExpired(user.lockedUntil);
}

/** Call after a failed password check. Returns the fields to merge onto the user document. */
export function recordFailedAttempt(user) {
  const attempts = (user?.failedAttempts ?? 0) + 1;
  if (attempts >= LOCKOUT_MAX_ATTEMPTS) {
    return { failedAttempts: 0, lockedUntil: new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000).toISOString() };
  }
  return { failedAttempts: attempts, lockedUntil: null };
}

/** Call after a successful password check, to clear any prior failed attempts. */
export const clearFailedAttempts = () => ({ failedAttempts: 0, lockedUntil: null });

/** Parses a Cookie request header into { name: value }. Not a general purpose parser, just enough for this app's own cookie. */
export function parseCookies(header) {
  const out = {};
  if (typeof header !== "string" || !header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[name] = part.slice(i + 1).trim();
    }
  }
  return out;
}

/**
 * secure: false only for local http development. Everywhere else this must be true, or the
 * session cookie would be sent in the clear.
 */
export function setSessionCookie(token, { secure = true, maxAgeSeconds = SESSION_HOURS * 3600 } = {}) {
  const parts = [`${SESSION_COOKIE}=${encodeURIComponent(token)}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAgeSeconds}`];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie({ secure = true } = {}) {
  const parts = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}
