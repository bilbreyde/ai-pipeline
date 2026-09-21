import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanAccount, mapLead, mapStage, mapTw, parseSize, slug } from "../src/lib/import-mapping.js";

test("mapStage reads wording, blocked and RFP beat generic active", () => {
  const cases = {
    "Active pursuit/RFP": "Proposal / RFP",
    "Active RFP Response": "Proposal / RFP",
    "Proposal development": "Proposal / RFP",
    "Active pilot / blocked": "Blocked",
    "Active engagement": "Qualified",
    "Qualified opportunity": "Qualified",
    "Active discussion": "Qualified",
    "Early stage": "Identified",
    "Opportunity identified": "Identified",
    "Discovery stage": "Discovery",
    "Solution framework developed": "Discovery",
    "": "Discovery",
    "Closed won": "Won",
    "Lost to incumbent": "Lost",
    "Wonderful progress": "Discovery",
  };
  for (const [input, want] of Object.entries(cases)) assert.equal(mapStage(input), want, input);
});

test("mapTw and mapLead", () => {
  assert.equal(mapTw("Yes - actively engaged"), "Engaged");
  assert.equal(mapTw("Yes - identified as strong TW fit"), "Strong fit");
  assert.equal(mapTw("Target opportunity for TW involvement"), "Target");
  assert.equal(mapTw("Potential fit"), "Potential");
  assert.equal(mapTw("No, Zones lead"), "Zones only");
  assert.equal(mapTw("Not currently engaged"), "Not indicated");
  assert.equal(mapLead("Thoughtworks"), "Thoughtworks");
  assert.equal(mapLead("Zones"), "Zones");
  assert.equal(mapLead(""), "");
});

test("parseSize handles numbers, K suffix, and bare thousands", () => {
  assert.deepEqual(parseSize(1000000), { size: 1000000, heuristic: false });
  assert.deepEqual(parseSize("In Discovery (200K)"), { size: 200000, heuristic: false });
  assert.deepEqual(parseSize("In Discovery (100)"), { size: 100000, heuristic: true });
  assert.deepEqual(parseSize("In Discovery"), { size: null, heuristic: false });
  assert.deepEqual(parseSize(""), { size: null, heuristic: false });
});

test("cleanAccount and slug", () => {
  assert.equal(cleanAccount("Example Utility ("), "Example Utility");
  assert.equal(cleanAccount("  Plain Name "), "Plain Name");
  assert.equal(slug("H&R Block"), "h-r-block");
  assert.equal(slug("Name (D365)"), "name-d365");
});
