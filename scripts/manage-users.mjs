// Account lifecycle for username and password sign in (src/lib/auth.js). There is no admin role
// and no user management screen in the running app on purpose: whoever can run this script, using
// their own `az login` session against Cosmos, controls who can sign in. That is the same trust
// boundary scripts/seed-sample.mjs and scripts/import-from-excel.mjs already use.
//
// Usage:
//   node scripts/manage-users.mjs create <username>              creates an account, prints a generated password
//   node scripts/manage-users.mjs create <username> --password <pw>   creates an account with a password you choose
//   node scripts/manage-users.mjs reset-password <username>      generates and prints a new password, signs out open sessions
//   node scripts/manage-users.mjs reset-password <username> --password <pw>
//   node scripts/manage-users.mjs unlock <username>               clears a lockout from too many failed sign ins
//   node scripts/manage-users.mjs revoke <username> --confirm     deletes the account; any open session for it
//                                                                  stops working on its next request, immediately
//   node scripts/manage-users.mjs list                            usernames, locked state, when each was created
//
// A generated password is shown once, in this terminal, and is not saved anywhere by this script.
// Write it down or pass it to the person some other way, and have them use "Change password" in the
// app afterwards. --password is there for scripting or a password manager; typing one on the command
// line puts it in your shell history, so prefer letting the script generate one when that matters.

import { loadCosmosStore } from "./env.mjs";
import { hashPassword, validatePassword, validateUsername } from "../src/lib/auth.js";
import { randomBytes } from "node:crypto";

const args = process.argv.slice(2);
const command = args[0];
const target = args[1];
const flagValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name) => args.includes(name);

function usage(message) {
  if (message) console.error(message + "\n");
  console.error(
    "Usage:\n" +
      "  node scripts/manage-users.mjs create <username> [--password <pw>]\n" +
      "  node scripts/manage-users.mjs reset-password <username> [--password <pw>]\n" +
      "  node scripts/manage-users.mjs unlock <username>\n" +
      "  node scripts/manage-users.mjs revoke <username> --confirm\n" +
      "  node scripts/manage-users.mjs list",
  );
  process.exit(1);
}

function generatePassword() {
  // 20 characters from an unambiguous URL safe alphabet, well over the 12 character minimum.
  return randomBytes(15).toString("base64url");
}

if (!command) usage();

if (command === "list") {
  const { store, endpoint } = loadCosmosStore();
  const users = await store.listUsers();
  console.log(`${users.length} account(s) in ${endpoint}`);
  for (const u of users.sort((a, b) => a.username.localeCompare(b.username))) {
    const locked = u.lockedUntil && Date.parse(u.lockedUntil) > Date.now();
    console.log(`  ${u.username}${locked ? "  (locked)" : ""}  created ${u.createdAt ?? "unknown"}`);
  }
  process.exit(0);
}

if (!["create", "reset-password", "unlock", "revoke"].includes(command)) {
  usage(`Unknown command "${command}".`);
}

const username = validateUsername(target ?? "");
if (!username) {
  usage(`"${target ?? ""}" is not a valid username. Use 2 to 40 characters: lower case letters, digits, dot, underscore or hyphen.`);
}

const { store, endpoint } = loadCosmosStore();

if (command === "create" || command === "reset-password") {
  const existing = await store.getUser(username);
  if (command === "create" && existing) usage(`${username} already has an account. Use reset-password to change it.`);
  if (command === "reset-password" && !existing) usage(`${username} has no account. Use create instead.`);

  const password = flagValue("--password") ?? generatePassword();
  if (!validatePassword(password)) usage("Password must be 12 to 200 characters.");
  const { hash, salt } = await hashPassword(password);
  const now = new Date().toISOString();
  await store.putUser({
    id: username,
    username,
    passwordHash: hash,
    passwordSalt: salt,
    failedAttempts: 0,
    lockedUntil: null,
    createdAt: existing?.createdAt ?? now,
    passwordChangedAt: now,
  });
  if (command === "reset-password") {
    // A reset is often because the old password leaked, so sign that account out everywhere.
    const ended = await store.deleteSessionsFor(username);
    if (ended) console.log(`Signed out ${ended} open session(s) for ${username}.`);
  }
  console.log(`${command === "create" ? "Created" : "Reset password for"} ${username} in ${endpoint}.`);
  if (!flagValue("--password")) console.log(`Password (shown once, not saved anywhere): ${password}`);
  console.log("Have them sign in and use Change password to set one only they know.");
  process.exit(0);
}

if (command === "unlock") {
  const user = await store.getUser(username);
  if (!user) usage(`${username} has no account.`);
  await store.putUser({ ...user, failedAttempts: 0, lockedUntil: null });
  console.log(`${username} is unlocked.`);
  process.exit(0);
}

if (command === "revoke") {
  if (!has("--confirm")) usage(`This deletes ${username}'s account. Add --confirm to do it.`);
  const removed = await store.deleteUser(username);
  // Sessions are keyed by username, so without this, creating the same username again later would
  // bring any unexpired session from the deleted account back to life.
  await store.deleteSessionsFor(username);
  console.log(removed ? `${username}'s account is deleted. Any session it had stops working on its next request.` : `${username} had no account.`);
  process.exit(0);
}
