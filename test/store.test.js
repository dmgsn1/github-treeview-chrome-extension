import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGitHubUrl } from "../src/github-url.js";
import { applyStates, DAY, dismiss, recordVisit } from "../src/store.js";

const visit = (items, url, title, now) => recordVisit(items, parseGitHubUrl(url), title, now);

test("a visit records an item; list and repo pages are not recorded", () => {
  let items = visit({}, "https://github.com/o/r/issues/3", "Bug · Issue #3 · o/r", 1);
  items = visit(items, "https://github.com/o/r/issues", "Issues · o/r", 2);
  items = visit(items, "https://github.com/o/r", "o/r", 3);
  assert.deepEqual(Object.keys(items), ["o/r#3"]);
  assert.equal(items["o/r#3"].title, "Bug");
});

test("revisits keep firstSeen and the known title when the tab title is a placeholder", () => {
  let items = visit({}, "https://github.com/o/r/pull/5", "Add x · Pull Request #5 · o/r", 10);
  items = visit(items, "https://github.com/o/r/pull/5/files", "https://github.com/o/r/pull/5/files", 20);
  assert.equal(items["o/r#5"].title, "Add x");
  assert.equal(items["o/r#5"].firstSeen, 10);
  assert.equal(items["o/r#5"].lastVisited, 20);
});

// Planted violation: an /issues/N link to a PR downgrades the entry to an issue.
test("an /issues/N visit never turns a known PR back into an issue", () => {
  let items = visit({}, "https://github.com/o/r/pull/5", "Add x · Pull Request #5 · o/r", 1);
  items = visit(items, "https://github.com/o/r/issues/5", "", 2);
  assert.equal(items["o/r#5"].kind, "pull");
  assert.equal(items["o/r#5"].url, "https://github.com/o/r/pull/5");
});

test("closed and merged items leave the tree; open ones stay and take the fetched title", () => {
  let items = {};
  for (const n of [1, 2, 3]) items = visit(items, `https://github.com/o/r/issues/${n}`, "", n);
  const out = applyStates(items, {
    "o/r#1": { kind: "issue", state: "OPEN", title: "Still open" },
    "o/r#2": { kind: "issue", state: "CLOSED" },
    "o/r#3": { kind: "pull", state: "MERGED" },
  }, 100);
  assert.deepEqual(Object.keys(out), ["o/r#1"]);
  assert.equal(out["o/r#1"].title, "Still open");
});

test("an issue the API reports as a PR becomes one, URL included", () => {
  const items = visit({}, "https://github.com/o/r/issues/9", "", 1);
  const out = applyStates(items, { "o/r#9": { kind: "pull", state: "OPEN", draft: true, labels: ["hold:operator"] } }, 2);
  assert.equal(out["o/r#9"].kind, "pull");
  assert.equal(out["o/r#9"].url, "https://github.com/o/r/pull/9");
  assert.deepEqual(out["o/r#9"].labels, ["hold:operator"]);
});

// Planted violations: a failed fetch, or a token that cannot see a repo, empties the tree.
test("a missing or unreadable state never prunes", () => {
  const items = visit({}, "https://github.com/o/r/issues/1", "", 1);
  assert.deepEqual(applyStates(items, {}, 2), items);
  const out = applyStates(items, { "o/r#1": { unreadable: true } }, 2);
  assert.equal(out["o/r#1"].unreadable, true);
  assert.equal(applyStates(out, { "o/r#1": { state: "OPEN" } }, 3)["o/r#1"].unreadable, false);
});

test("a finished run lingers a day after the last look; a running one stays", () => {
  let items = visit({}, "https://github.com/o/r/actions/runs/7", "", 0);
  items = visit(items, "https://github.com/o/r/actions/runs/8", "", 0);
  const states = { "o/r@run:7": { status: "completed", conclusion: "success" }, "o/r@run:8": { status: "in_progress" } };
  assert.deepEqual(Object.keys(applyStates(items, states, DAY - 1)), ["o/r@run:7", "o/r@run:8"]);
  assert.deepEqual(Object.keys(applyStates(items, states, DAY + 1)), ["o/r@run:8"]);
});

test("dismiss removes one entry", () => {
  let items = visit({}, "https://github.com/o/r/issues/1", "", 1);
  items = visit(items, "https://github.com/o/r/issues/2", "", 2);
  assert.deepEqual(Object.keys(dismiss(items, "o/r#1")), ["o/r#2"]);
});
