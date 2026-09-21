// Loads the fictional sample opportunities into Cosmos. Safe to run repeatedly (upsert by id).
// Usage: npm run seed:sample
// Uses your `az login` session. deploy.ps1 granted you the Cosmos data role. If you get a 403
// right after deploying, wait a few minutes for the role assignment to propagate and rerun.

import { loadCosmosStore } from "./env.mjs";
import { SAMPLE_OPPS } from "../src/lib/sample-data.js";

const { store, endpoint } = loadCosmosStore();
const now = new Date().toISOString();

for (const o of SAMPLE_OPPS) {
  await store.upsert({ ...o, createdAt: now, createdBy: "sample", updatedAt: now, updatedBy: "sample" });
}
console.log(`Seeded ${SAMPLE_OPPS.length} fictional opportunities into ${endpoint}`);
