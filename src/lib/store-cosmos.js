// Cosmos DB store. Entra ID only: the account has key auth disabled, so there is no connection
// string anywhere. DefaultAzureCredential resolves to the Function App's managed identity in
// Azure, and to your `az login` session when you run scripts locally.

import { CosmosClient } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";
import { ConflictError } from "./errors.js";

const OPP = "opp";
const SETTINGS = "settings";
const SETTINGS_ID = "config";

const isStatus = (e, code) => e && (e.code === code || e.statusCode === code);

// Strip Cosmos system properties and the partition key before anything leaves the store.
const toPublic = ({ _rid, _self, _etag, _attachments, _ts, type, ...rest }) => rest;

export function createCosmosStore({ endpoint, database, container }) {
  if (!endpoint || !database || !container) {
    throw new Error("Cosmos store needs COSMOS_ENDPOINT, COSMOS_DATABASE and COSMOS_CONTAINER.");
  }
  const client = new CosmosClient({ endpoint, aadCredentials: new DefaultAzureCredential() });
  const c = client.database(database).container(container);

  return {
    kind: "cosmos",

    async list() {
      const { resources } = await c.items
        .query({ query: "SELECT * FROM c WHERE c.type = @t", parameters: [{ name: "@t", value: OPP }] }, { partitionKey: OPP })
        .fetchAll();
      return resources.map(toPublic);
    },

    async get(id) {
      try {
        const { resource, etag } = await c.item(id, OPP).read();
        return resource ? { doc: toPublic(resource), etag } : null;
      } catch (e) {
        if (isStatus(e, 404)) return null;
        throw e;
      }
    },

    async create(doc) {
      const { resource } = await c.items.create({ ...doc, type: OPP });
      return toPublic(resource);
    },

    async replace(id, doc, etag) {
      try {
        const { resource } = await c.item(id, OPP).replace(
          { ...doc, id, type: OPP },
          { accessCondition: { type: "IfMatch", condition: etag } },
        );
        return toPublic(resource);
      } catch (e) {
        if (isStatus(e, 412)) throw new ConflictError();
        if (isStatus(e, 404)) return null;
        throw e;
      }
    },

    async upsert(doc) {
      const { resource } = await c.items.upsert({ ...doc, type: OPP });
      return toPublic(resource);
    },

    async remove(id) {
      try {
        await c.item(id, OPP).delete();
        return true;
      } catch (e) {
        if (isStatus(e, 404)) return false;
        throw e;
      }
    },

    async getSettings() {
      try {
        const { resource } = await c.item(SETTINGS_ID, SETTINGS).read();
        if (!resource) return null;
        const { id, ...rest } = toPublic(resource);
        return rest;
      } catch (e) {
        if (isStatus(e, 404)) return null;
        throw e;
      }
    },

    async putSettings(value) {
      await c.items.upsert({ ...value, id: SETTINGS_ID, type: SETTINGS });
      return value;
    },
  };
}
