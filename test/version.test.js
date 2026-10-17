import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BUILD, workerProblem } from "../src/version.js";

test("the build constant matches manifest.json and package.json", () => {
  assert.equal(JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url))).version, BUILD);
  assert.equal(JSON.parse(readFileSync(new URL("../package.json", import.meta.url))).version, BUILD);
});

// Planted violations: an unanswered ping (an old worker with no ping handler
// resolves undefined) or an older build read as healthy.
test("a worker that is silent, failing or older is a problem; the current one is not", () => {
  assert.match(workerProblem(undefined), /not answering/);
  assert.match(workerProblem({ ok: false, error: "Could not establish connection" }), /not answering/);
  assert.match(workerProblem({ ok: true, result: { build: "0.1.0" } }), /older version/);
  assert.match(workerProblem({ ok: true, result: undefined }), /older version/);
  assert.equal(workerProblem({ ok: true, result: { build: BUILD } }), null);
});
