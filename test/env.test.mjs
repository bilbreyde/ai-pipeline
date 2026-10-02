import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAzureContext } from "../scripts/env.mjs";

const TENANT = "11111111-1111-1111-1111-111111111111";
const SUB = "22222222-2222-2222-2222-222222222222";
const ENV = { COSMOS_ENDPOINT: "https://example.documents.azure.com:443/", TENANT_ID: TENANT, SUBSCRIPTION_ID: SUB };

test("the matching tenant and subscription pass, with the default database and container", () => {
  assert.deepEqual(checkAzureContext(ENV, { tenantId: TENANT, id: SUB }), {
    endpoint: ENV.COSMOS_ENDPOINT, database: "pipeline", container: "items",
  });
});

test("a different tenant is refused and the message says how to switch", () => {
  assert.throws(() => checkAzureContext(ENV, { tenantId: "99999999-9999-9999-9999-999999999999", id: SUB }), (e) =>
    e.message.includes(`az login --tenant ${TENANT}`));
});

test("the right tenant with a different subscription is refused", () => {
  assert.throws(() => checkAzureContext(ENV, { tenantId: TENANT, id: "99999999-9999-9999-9999-999999999999" }), (e) =>
    e.message.includes(`az account set --subscription ${SUB}`));
});

test("no az login is refused", () => {
  assert.throws(() => checkAzureContext(ENV, null), /signed in to tenant \(none\)/);
});

test("missing tenant or subscription settings are refused rather than skipping the check", () => {
  assert.throws(() => checkAzureContext({ ...ENV, TENANT_ID: "" }, { tenantId: TENANT, id: SUB }), /TENANT_ID and SUBSCRIPTION_ID/);
  assert.throws(() => checkAzureContext({ ...ENV, SUBSCRIPTION_ID: undefined }, { tenantId: TENANT, id: SUB }), /TENANT_ID and SUBSCRIPTION_ID/);
});

test("a missing endpoint is refused", () => {
  assert.throws(() => checkAzureContext({ ...ENV, COSMOS_ENDPOINT: "" }, { tenantId: TENANT, id: SUB }), /COSMOS_ENDPOINT/);
});
