// Loads .env.deploy (written by deploy.ps1) into process.env, checks that `az` is signed in to the
// tenant and subscription recorded there, then builds a Cosmos store. Variables already set in your
// shell win over the file. Every script that touches Cosmos (manage-users, seed-sample,
// import-from-excel) goes through loadCosmosStore, so none of them can act in the wrong tenant.

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCosmosStore } from "../src/lib/store-cosmos.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(root, ".env.deploy");

/**
 * Pure check of the settings against the signed in az account (`az account show` output).
 * Returns { endpoint, database, container }, or throws with a message safe to print.
 */
export function checkAzureContext(env, account) {
  const { COSMOS_ENDPOINT, COSMOS_DATABASE = "pipeline", COSMOS_CONTAINER = "items", TENANT_ID, SUBSCRIPTION_ID } = env;
  if (!COSMOS_ENDPOINT) throw new Error("COSMOS_ENDPOINT is not set. Run scripts/deploy.ps1 first, or set the variable yourself.");
  if (!TENANT_ID || !SUBSCRIPTION_ID) {
    throw new Error("TENANT_ID and SUBSCRIPTION_ID are not set. Rerun scripts/deploy.ps1 (it records them in .env.deploy), or set them yourself.");
  }
  if (!account || account.tenantId !== TENANT_ID || account.id !== SUBSCRIPTION_ID) {
    throw new Error(
      `az is signed in to tenant ${account?.tenantId ?? "(none)"}, subscription ${account?.id ?? "(none)"}.\n` +
        `This app lives in tenant ${TENANT_ID}, subscription ${SUBSCRIPTION_ID}. Switch with:\n` +
        `  az login --tenant ${TENANT_ID}\n  az account set --subscription ${SUBSCRIPTION_ID}`,
    );
  }
  return { endpoint: COSMOS_ENDPOINT, database: COSMOS_DATABASE, container: COSMOS_CONTAINER };
}

function signedInAccount() {
  // One fixed command string with shell: true, because az is az.cmd on Windows. Nothing user supplied goes in it.
  const r = spawnSync("az account show -o json", { encoding: "utf8", shell: true });
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

export function loadCosmosStore() {
  if (existsSync(envFile)) {
    process.loadEnvFile(envFile); // fills process.env, but does not override existing values
  }
  let settings;
  try {
    settings = checkAzureContext(process.env, signedInAccount());
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  return { store: createCosmosStore(settings), endpoint: settings.endpoint };
}
