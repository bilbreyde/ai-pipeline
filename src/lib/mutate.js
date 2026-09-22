// Shared write path for updating one opportunity. The PATCH route and the spreadsheet import both use it,
// so two people (or a person and an import) touching different fields of one row never overwrite each other.

import { ConflictError } from "./errors.js";

export const MAX_CONFLICT_RETRIES = 3;

/**
 * patch is an object, or a function of the current document that returns one (used when the new value depends on the
 * old one, like appending to a list, and when the caller wants to refuse to write over a stale row by throwing).
 * Read, merge, write with the etag. If someone else saved in between, re-read and merge again.
 * Returns the saved document, or null if the row no longer exists.
 * Throws ConflictError if it still loses the race after MAX_CONFLICT_RETRIES attempts.
 */
export async function mergeUpdate(store, id, patch, actor) {
  for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt++) {
    const current = await store.get(id);
    if (!current) return null;
    const changes = typeof patch === "function" ? patch(current.doc) : patch;
    const merged = { ...current.doc, ...changes, id, updatedAt: new Date().toISOString(), updatedBy: actor };
    try {
      const item = await store.replace(id, merged, current.etag);
      return item ?? null;
    } catch (e) {
      if (!(e instanceof ConflictError)) throw e;
    }
  }
  throw new ConflictError();
}
