import { createCosmosStore } from "./store-cosmos.js";
import { createMemoryStore } from "./store-memory.js";

/**
 * Pick the store from the environment.
 * A missing Cosmos endpoint is an error, never a silent fall back to memory, because a
 * memory store in Azure would look healthy and lose every edit on the next restart.
 */
export function createStore(env = process.env) {
  if (env.STORE === "memory") return createMemoryStore();
  if (!env.COSMOS_ENDPOINT) {
    throw new Error("COSMOS_ENDPOINT is not set. Set it, or set STORE=memory for local development only.");
  }
  return createCosmosStore({
    endpoint: env.COSMOS_ENDPOINT,
    database: env.COSMOS_DATABASE ?? "pipeline",
    container: env.COSMOS_CONTAINER ?? "items",
  });
}
