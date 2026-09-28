// In memory store with the same contract as the Cosmos store. Used by tests and the local dev server.
// Data is lost when the process exits, which is the point.

import { ConflictError } from "./errors.js";

export function createMemoryStore() {
  const opps = new Map();
  const users = new Map();
  const sessions = new Map();
  let settings = null;
  let sellers = null;
  let etagSeq = 0;
  const nextEtag = () => `"${++etagSeq}"`;
  const copy = (o) => structuredClone(o);

  return {
    kind: "memory",

    async list() {
      return [...opps.values()].map((r) => copy(r.doc));
    },

    async get(id) {
      const r = opps.get(id);
      return r ? { doc: copy(r.doc), etag: r.etag } : null;
    },

    async create(doc) {
      opps.set(doc.id, { doc: copy(doc), etag: nextEtag() });
      return copy(doc);
    },

    async replace(id, doc, etag) {
      const r = opps.get(id);
      if (!r) return null;
      if (r.etag !== etag) throw new ConflictError();
      opps.set(id, { doc: copy(doc), etag: nextEtag() });
      return copy(doc);
    },

    async upsert(doc) {
      opps.set(doc.id, { doc: copy(doc), etag: nextEtag() });
      return copy(doc);
    },

    async remove(id) {
      return opps.delete(id);
    },

    async getSettings() {
      return settings ? copy(settings) : null;
    },

    async putSettings(value) {
      settings = copy(value);
      return copy(settings);
    },

    /** { byKey: { "<lower cased seller name>": { name, email } } }, the same shape as Cosmos. */
    async getSellerDirectory() {
      return sellers ? copy(sellers) : null;
    },

    async putSellerDirectory(value) {
      sellers = copy(value);
      return copy(sellers);
    },

    /** Users and sessions. Accounts are managed by scripts/manage-users.mjs; the running app only signs in, signs out and changes your own password. */
    async getUser(username) {
      const r = users.get(username);
      return r ? copy(r) : null;
    },

    async putUser(user) {
      users.set(user.id, copy(user));
      return copy(user);
    },

    async deleteUser(username) {
      return users.delete(username);
    },

    async listUsers() {
      return [...users.values()].map(copy);
    },

    async getSession(token) {
      const r = sessions.get(token);
      return r ? copy(r) : null;
    },

    async putSession(session) {
      sessions.set(session.id, copy(session));
      return copy(session);
    },

    async deleteSession(token) {
      return sessions.delete(token);
    },

    /** Deletes every session for this username, except the token in `except`. Returns how many went. */
    async deleteSessionsFor(username, { except } = {}) {
      let n = 0;
      for (const [token, s] of sessions) {
        if (s.username === username && token !== except) {
          sessions.delete(token);
          n++;
        }
      }
      return n;
    },
  };
}
