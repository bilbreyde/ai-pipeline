// In memory store with the same contract as the Cosmos store. Used by tests and the local dev server.
// Data is lost when the process exits, which is the point.

import { ConflictError } from "./errors.js";

export function createMemoryStore() {
  const opps = new Map();
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
  };
}
