import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createHandlers } from "../src/lib/handlers.js";
import { createMemoryStore } from "../src/lib/store-memory.js";
import {
  clearSessionCookie, hashPassword, isExpired, isLocked, newSessionToken, normalizeUsername,
  parseCookies, recordFailedAttempt, sessionExpiry, setSessionCookie, validatePassword,
  validateUsername, verifyPassword,
} from "../src/lib/auth.js";

// ---------- auth.js, unit level ----------

test("hashPassword and verifyPassword round trip, and reject a wrong password", async () => {
  const { hash, salt } = await hashPassword("correct horse battery staple");
  assert.equal(await verifyPassword("correct horse battery staple", hash, salt), true);
  assert.equal(await verifyPassword("wrong password entirely", hash, salt), false);
});

test("verifyPassword is safe against missing or malformed stored values", async () => {
  assert.equal(await verifyPassword("anything", undefined, undefined), false);
  assert.equal(await verifyPassword("anything", "", ""), false);
  assert.equal(await verifyPassword("anything", "not-hex-but-a-string", "salt"), false);
});

test("normalizeUsername and validateUsername", () => {
  assert.equal(normalizeUsername("  Don.Bilbrey  "), "don.bilbrey");
  assert.equal(normalizeUsername(42), "");
  assert.equal(validateUsername("Don.Bilbrey"), "don.bilbrey");
  assert.equal(validateUsername("a"), null); // too short
  assert.equal(validateUsername("x".repeat(41)), null); // too long
  assert.equal(validateUsername("bad user"), null); // spaces not allowed
  assert.equal(validateUsername("bad@user"), null); // @ not allowed
  assert.equal(validateUsername("ok_user-01"), "ok_user-01");
});

test("validatePassword enforces the length window", () => {
  assert.equal(validatePassword("short"), false);
  assert.equal(validatePassword("x".repeat(11)), false);
  assert.equal(validatePassword("x".repeat(12)), true);
  assert.equal(validatePassword("x".repeat(200)), true);
  assert.equal(validatePassword("x".repeat(201)), false);
  assert.equal(validatePassword(12345678901), false); // not a string
});

test("newSessionToken makes long, unique, random looking tokens", () => {
  const a = newSessionToken(), b = newSessionToken();
  assert.notEqual(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("sessionExpiry and isExpired", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  assert.equal(sessionExpiry(now), "2026-01-02T00:00:00.000Z");
  assert.equal(isExpired("2020-01-01T00:00:00.000Z"), true);
  assert.equal(isExpired(new Date(Date.now() + 60000).toISOString()), false);
  assert.equal(isExpired("not a date"), true);
});

test("isLocked and recordFailedAttempt: five misses lock the account for 15 minutes", () => {
  assert.equal(isLocked(null), false);
  assert.equal(isLocked({}), false);
  let user = {};
  for (let i = 0; i < 4; i++) {
    user = { ...user, ...recordFailedAttempt(user) };
    assert.equal(user.failedAttempts, i + 1);
    assert.equal(isLocked(user), false);
  }
  user = { ...user, ...recordFailedAttempt(user) };
  assert.equal(user.failedAttempts, 0); // counter resets once it converts into a lock
  assert.equal(isLocked(user), true);
  const minutesLeft = (Date.parse(user.lockedUntil) - Date.now()) / 60000;
  assert.ok(minutesLeft > 14 && minutesLeft <= 15);
});

test("parseCookies reads the session cookie out of a Cookie header", () => {
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies(""), {});
  assert.deepEqual(parseCookies("a=1; pipeline_session=abc123; other=x"), { a: "1", pipeline_session: "abc123", other: "x" });
  assert.deepEqual(parseCookies("weird=%2Fpath%20here"), { weird: "/path here" });
});

test("setSessionCookie and clearSessionCookie carry the right security attributes", () => {
  const set = setSessionCookie("tok123");
  assert.match(set, /^pipeline_session=tok123;/);
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Strict/);
  assert.match(set, /Secure/);
  assert.match(set, /Max-Age=86400/);
  assert.doesNotMatch(setSessionCookie("tok123", { secure: false }), /Secure/);
  const cleared = clearSessionCookie();
  assert.match(cleared, /^pipeline_session=;/);
  assert.match(cleared, /Max-Age=0/);
});

// ---------- through the HTTP handler ----------

async function setup({ allowAnonymousBulk = false, secureCookies = true } = {}) {
  const webRoot = await mkdtemp(path.join(os.tmpdir(), "web-"));
  await writeFile(path.join(webRoot, "index.html"), "<!doctype html><title>t</title>");
  const store = createMemoryStore();
  const { handle } = createHandlers({ store, webRoot, allowAnonymousBulk, secureCookies });
  const call = (method, p, body, headers = {}) =>
    handle({
      method, path: p,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
  return { call, store };
}
const json = (r) => JSON.parse(r.body);
const cookieValue = (r) => {
  const set = r.headers["Set-Cookie"];
  const m = set && set.match(/^pipeline_session=([^;]*)/);
  return m ? m[1] : null;
};
const withCookie = (token) => ({ cookie: `pipeline_session=${token}` });

async function createAccount(store, username, password) {
  const { hash, salt } = await hashPassword(password);
  await store.putUser({ id: username, username, passwordHash: hash, passwordSalt: salt, failedAttempts: 0, lockedUntil: null, createdAt: new Date().toISOString() });
}

test("without sign in, pipeline data routes are blocked; auth and health are not", async () => {
  const { call } = await setup();
  assert.equal((await call("GET", "/api/opps")).status, 403);
  assert.equal((await call("GET", "/api/settings")).status, 403);
  assert.equal((await call("GET", "/api/sellers")).status, 403);
  assert.equal((await call("GET", "/api/health")).status, 200);
  assert.equal((await call("GET", "/api/me")).status, 200);
  assert.equal(json(await call("GET", "/api/opps")).error, "Sign in to see or change pipeline data.");
});

test("login requires a username and password, and rejects a bad JSON body", async () => {
  const { call } = await setup();
  assert.equal((await call("POST", "/api/auth/login", {})).status, 400);
  assert.equal((await call("POST", "/api/auth/login", { username: "don" })).status, 400);
  assert.equal((await call("POST", "/api/auth/login", "not json")).status, 400);
});

test("login with a real account succeeds, sets a session cookie, and the cookie authenticates later requests", async () => {
  const { call, store } = await setup();
  await createAccount(store, "don", "correct horse battery staple");

  const r = await call("POST", "/api/auth/login", { username: "Don", password: "correct horse battery staple" });
  assert.equal(r.status, 200);
  assert.equal(json(r).name, "don");
  const token = cookieValue(r);
  assert.ok(token && token.length > 20);

  const me = await call("GET", "/api/me", undefined, withCookie(token));
  assert.deepEqual(json(me), { name: "don", authenticated: true, bulk: true, ai: false, aiWhy: "not-configured" });

  const opps = await call("GET", "/api/opps", undefined, withCookie(token));
  assert.equal(opps.status, 200);
});

test("a wrong password and a nonexistent username give the exact same status and message", async () => {
  const { call, store } = await setup();
  await createAccount(store, "don", "correct horse battery staple");
  const wrongPw = await call("POST", "/api/auth/login", { username: "don", password: "totally wrong password" });
  const noSuchUser = await call("POST", "/api/auth/login", { username: "nobody-here", password: "totally wrong password" });
  assert.equal(wrongPw.status, 401);
  assert.equal(noSuchUser.status, 401);
  assert.equal(json(wrongPw).error, json(noSuchUser).error);
  assert.equal(json(wrongPw).error, "Invalid username or password.");
  assert.equal(wrongPw.headers["Set-Cookie"], undefined);
});

test("five failed sign ins lock the account, even with the correct password, until it clears", async () => {
  const { call, store } = await setup();
  await createAccount(store, "don", "correct horse battery staple");
  for (let i = 0; i < 5; i++) {
    const r = await call("POST", "/api/auth/login", { username: "don", password: "nope" });
    assert.equal(r.status, 401);
  }
  const lockedUntil = (await store.getUser("don")).lockedUntil;
  assert.ok(lockedUntil);
  // Several attempts during the lock, wrong and right, all refused. Attempts made during the lock
  // must not restart the count or clear it (a bug once let the second attempt after a lock through).
  for (const password of ["nope", "correct horse battery staple", "nope", "correct horse battery staple"]) {
    const lockedOut = await call("POST", "/api/auth/login", { username: "don", password });
    assert.equal(lockedOut.status, 401);
    assert.equal(json(lockedOut).error, "Invalid username or password.");
  }
  assert.equal((await store.getUser("don")).lockedUntil, lockedUntil);

  // Simulate the lock clearing.
  const user = await store.getUser("don");
  await store.putUser({ ...user, lockedUntil: new Date(Date.now() - 1000).toISOString() });
  const nowOk = await call("POST", "/api/auth/login", { username: "don", password: "correct horse battery staple" });
  assert.equal(nowOk.status, 200);
});

test("a successful sign in clears any earlier failed attempts", async () => {
  const { call, store } = await setup();
  await createAccount(store, "don", "correct horse battery staple");
  await call("POST", "/api/auth/login", { username: "don", password: "nope" });
  await call("POST", "/api/auth/login", { username: "don", password: "nope" });
  await call("POST", "/api/auth/login", { username: "don", password: "correct horse battery staple" });
  const user = await store.getUser("don");
  assert.equal(user.failedAttempts, 0);
  assert.equal(user.lockedUntil, null);
});

test("logout clears the session so the cookie no longer authenticates", async () => {
  const { call, store } = await setup();
  await createAccount(store, "don", "correct horse battery staple");
  const token = cookieValue(await call("POST", "/api/auth/login", { username: "don", password: "correct horse battery staple" }));

  const out = await call("POST", "/api/auth/logout", {}, withCookie(token));
  assert.equal(out.status, 200);
  assert.match(out.headers["Set-Cookie"], /Max-Age=0/);

  const after = await call("GET", "/api/opps", undefined, withCookie(token));
  assert.equal(after.status, 403);
});

test("deleting the account revokes an open session immediately, with no session list to clean up", async () => {
  const { call, store } = await setup();
  await createAccount(store, "don", "correct horse battery staple");
  const token = cookieValue(await call("POST", "/api/auth/login", { username: "don", password: "correct horse battery staple" }));
  assert.equal((await call("GET", "/api/opps", undefined, withCookie(token))).status, 200);

  await store.deleteUser("don");
  const after = await call("GET", "/api/opps", undefined, withCookie(token));
  assert.equal(after.status, 403);
});

test("an expired session is treated as signed out", async () => {
  const { call, store } = await setup();
  await createAccount(store, "don", "correct horse battery staple");
  const expired = "expired-token-value";
  await store.putSession({ id: expired, username: "don", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() - 1000).toISOString() });
  const r = await call("GET", "/api/opps", undefined, withCookie(expired));
  assert.equal(r.status, 403);
});

test("a session for a username with no account is treated as signed out", async () => {
  const { call, store } = await setup();
  const orphan = "orphan-token-value";
  await store.putSession({ id: orphan, username: "ghost", createdAt: new Date().toISOString(), expiresAt: sessionExpiry() });
  const r = await call("GET", "/api/opps", undefined, withCookie(orphan));
  assert.equal(r.status, 403);
});

test("change password requires sign in, checks the current password, and enforces the new one's length", async () => {
  const { call, store } = await setup();
  await createAccount(store, "don", "correct horse battery staple");
  assert.equal((await call("POST", "/api/auth/change-password", { currentPassword: "x", newPassword: "y".repeat(12) })).status, 403);

  const token = cookieValue(await call("POST", "/api/auth/login", { username: "don", password: "correct horse battery staple" }));
  const wrongCur = await call("POST", "/api/auth/change-password", { currentPassword: "not it", newPassword: "y".repeat(12) }, withCookie(token));
  assert.equal(wrongCur.status, 401);

  const tooShort = await call("POST", "/api/auth/change-password", { currentPassword: "correct horse battery staple", newPassword: "short" }, withCookie(token));
  assert.equal(tooShort.status, 400);

  const ok = await call("POST", "/api/auth/change-password", { currentPassword: "correct horse battery staple", newPassword: "a brand new password" }, withCookie(token));
  assert.equal(ok.status, 200);

  // The old password no longer works; the new one does.
  const oldLogin = await call("POST", "/api/auth/login", { username: "don", password: "correct horse battery staple" });
  assert.equal(oldLogin.status, 401);
  const newLogin = await call("POST", "/api/auth/login", { username: "don", password: "a brand new password" });
  assert.equal(newLogin.status, 200);
});

test("changing the password signs out every other session for that account, and only that account", async () => {
  const { call, store } = await setup();
  await createAccount(store, "don", "correct horse battery staple");
  await createAccount(store, "sam", "another long password");
  const login = async (username, password) => cookieValue(await call("POST", "/api/auth/login", { username, password }));
  const here = await login("don", "correct horse battery staple");
  const elsewhere = await login("don", "correct horse battery staple"); // e.g. whoever else had the old password
  const other = await login("sam", "another long password");

  const ok = await call("POST", "/api/auth/change-password", { currentPassword: "correct horse battery staple", newPassword: "a brand new password" }, withCookie(here));
  assert.equal(ok.status, 200);

  assert.equal((await call("GET", "/api/opps", undefined, withCookie(here))).status, 200); // the session that changed it stays
  assert.equal((await call("GET", "/api/opps", undefined, withCookie(elsewhere))).status, 403);
  assert.equal((await call("GET", "/api/opps", undefined, withCookie(other))).status, 200); // another user is untouched
});

test("deleteSessionsFor removes every session for a username, or all but one", async () => {
  const store = createMemoryStore();
  const exp = sessionExpiry();
  for (const [id, username] of [["a1", "don"], ["a2", "don"], ["a3", "don"], ["b1", "sam"]]) {
    await store.putSession({ id, username, expiresAt: exp });
  }
  assert.equal(await store.deleteSessionsFor("don", { except: "a2" }), 2);
  assert.ok(await store.getSession("a2"));
  assert.equal(await store.getSession("a1"), null);
  assert.equal(await store.deleteSessionsFor("don"), 1);
  assert.equal(await store.getSession("a2"), null);
  assert.ok(await store.getSession("b1"));
});

test("auth routes still require same origin and JSON content type", async () => {
  const { call } = await setup();
  assert.equal((await call("POST", "/api/auth/login", { username: "a", password: "b" }, { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await call("POST", "/api/auth/login", { username: "a", password: "b" }, { "content-type": "text/plain" })).status, 415);
});

test("allowAnonymousBulk (local dev) opens pipeline data without sign in, but /api/me still reports the truth", async () => {
  const { call } = await setup({ allowAnonymousBulk: true });
  assert.equal((await call("GET", "/api/opps")).status, 200);
  assert.deepEqual(json(await call("GET", "/api/me")), { name: "", authenticated: false, bulk: true, ai: false, aiWhy: "not-configured" });
});

test("secureCookies false (local http dev) omits Secure from the cookie", async () => {
  const { call, store } = await setup({ secureCookies: false });
  await createAccount(store, "don", "correct horse battery staple");
  const r = await call("POST", "/api/auth/login", { username: "don", password: "correct horse battery staple" });
  assert.doesNotMatch(r.headers["Set-Cookie"], /Secure/);
});
