import { test } from "node:test";
import assert from "node:assert/strict";
import { OPEN_STAGES, STAGES, validateOpp } from "../src/lib/validate.js";

test("Prospecting and Unqualified are accepted stages, first and last in order", () => {
  for (const stage of ["Prospecting", "Unqualified"]) {
    const r = validateOpp({ account: "Fictional Co", stage, size: 120000 });
    assert.deepEqual(r.errors, [], stage);
    assert.equal(r.value.stage, stage);
    assert.equal(r.value.size, 120000);
  }
  assert.equal(STAGES[0], "Prospecting");
  assert.equal(STAGES.indexOf("Unqualified"), STAGES.indexOf("Lost") + 1);
  assert.ok(!OPEN_STAGES.includes("Prospecting") && !OPEN_STAGES.includes("Unqualified"));
  assert.ok(validateOpp({ account: "Fictional Co", stage: "Disqualified" }).errors.length);
});
