// Loads .env.deploy (written by deploy.ps1) into process.env, then builds a Cosmos store.
// Variables already set in your shell win over the file.

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCosmosStore } from "../src/lib/store-cosmos.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(root, ".env.deploy");

export function loadCosmosStore() {
  if (existsSync(envFile)) {
    process.loadEnvFile(envFile); // fills process.env, but does not override existing values
  }
  const { COSMOS_ENDPOINT, COSMOS_DATABASE = "pipeline", COSMOS_CONTAINER = "items" } = process.env;
  if (!COSMOS_ENDPOINT) {
    console.error("COSMOS_ENDPOINT is not set. Run scripts/deploy.ps1 first, or set the variable yourself.");
    process.exit(1);
  }
  return { store: createCosmosStore({ endpoint: COSMOS_ENDPOINT, database: COSMOS_DATABASE, container: COSMOS_CONTAINER }), endpoint: COSMOS_ENDPOINT };
}
