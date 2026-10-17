import assert from "node:assert/strict";
import { test } from "node:test";
import { tokenAdvice, tokenKind } from "../src/token-advice.js";

test("token kind from its prefix", () => {
  assert.equal(tokenKind("github_pat_11AB"), "fine-grained");
  assert.equal(tokenKind("ghp_abc"), "classic");
  assert.equal(tokenKind("gho_abc"), "classic");
  assert.equal(tokenKind("something"), "other");
});

// Planted violation: a token that reaches only its own account passes silently,
// which in the panel reads as "nothing loads".
test("advice: silent when other owners are reachable; names the cause when only the account or nothing is", () => {
  assert.equal(tokenAdvice("github_pat_x", { login: "me", owners: ["me", "acme"], repoCount: 9 }), null);
  assert.match(tokenAdvice("github_pat_x", { login: "me", owners: ["me"], repoCount: 3 }), /Resource owner/);
  assert.match(tokenAdvice("ghp_x", { login: "me", owners: ["Me"], repoCount: 3 }), /read:org|SSO/);
  assert.match(tokenAdvice("github_pat_x", { login: "me", owners: ["me"], repoCount: 0 }), /cannot read any repository/);
});
