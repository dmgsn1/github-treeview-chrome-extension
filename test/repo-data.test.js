import assert from "node:assert/strict";
import { test } from "node:test";
import { contextState, filterEntries, issueLevels, issueShare, issueSummary, liftAdvice, moveRepo, orderRepos, prLevels, prShare, prSummary, repoLabel, repoSummary, searchUrl, topRecent } from "../src/repo-data.js";

const issue = (number, labels = []) => ({ number, labels });
const pr = (number, { labels = [], contexts = [], queued = false, rollup = null, reviewers = [] } = {}) => ({ number, labels, contexts, queued, rollup, reviewers });
const ctx = (name, state) => ({ name, state });

// Planted violation: overlapping shares, so the parts do not add up to the total.
test("issue shares are disjoint and add up: parked beats a batch label, new is neither", () => {
  const issues = [issue(1, ["batch:a"]), issue(2, ["batch:a", "parked"]), issue(3, ["parked"]), issue(4), issue(5, ["inbox", "size:S"])];
  assert.deepEqual(issues.map(issueShare), ["claimed", "parked", "parked", "new", "new"]);
  assert.equal(issueSummary(issues), "5 = 1 claimed + 2 parked + 2 new");
});

// Planted violations: a held PR counted failed for its require-label, or a red check missed.
test("PR shares: queued and green are ready; a running check is checking; a red one is failed — except a held PR's require-label", () => {
  const prs = [
    pr(1, { contexts: [ctx("check", "passed")] }),
    pr(2, { contexts: [] }),
    pr(3, { queued: true, contexts: [ctx("check", "failed")] }),
    pr(4, { contexts: [ctx("check", "pending"), ctx("lint", "passed")] }),
    pr(5, { contexts: [ctx("check", "failed"), ctx("lint", "pending")] }),
    pr(6, { labels: ["hold:operator"], contexts: [ctx("check", "passed"), ctx("require-label", "failed")] }),
    pr(7, { contexts: [ctx("check", "passed"), ctx("require-label", "failed")] }),
    pr(8, { contexts: null, rollup: "PENDING" }),
    { ...pr(9, { contexts: null }), checksUnknown: true },
  ];
  assert.deepEqual(prs.map(prShare), ["ready", "ready", "ready", "checking", "failed", "ready", "failed", "checking", "unknown"]);
  assert.equal(prSummary(prs), "9 = 4 ready/queued + 2 checking + 2 failed + 1 unknown");
  assert.equal(prSummary(prs.slice(0, 8)), "8 = 4 ready/queued + 2 checking + 2 failed"); // no "unknown" when there is none
});

test("check contexts: CheckRun and StatusContext reduce to passed/pending/failed", () => {
  assert.deepEqual(contextState({ __typename: "CheckRun", name: "a", status: "IN_PROGRESS", conclusion: null }), ctx("a", "pending"));
  assert.deepEqual(contextState({ __typename: "CheckRun", name: "a", status: "COMPLETED", conclusion: "SKIPPED" }), ctx("a", "passed"));
  assert.deepEqual(contextState({ __typename: "CheckRun", name: "a", status: "COMPLETED", conclusion: "TIMED_OUT" }), ctx("a", "failed"));
  assert.deepEqual(contextState({ __typename: "StatusContext", context: "s", state: "EXPECTED" }), ctx("s", "pending"));
  assert.deepEqual(contextState({ __typename: "StatusContext", context: "s", state: "ERROR" }), ctx("s", "failed"));
});

test("repo summary: singular and plural", () => {
  assert.equal(repoSummary({ issues: [issue(1)], prs: [] }), "1 issue | 0 PRs");
  assert.equal(repoSummary({ issues: [], prs: [pr(1), pr(2)] }), "0 issues | 2 PRs");
});

test("repo order: stored order first, new repos appended alphabetically, gone repos dropped", () => {
  assert.deepEqual(orderRepos(["o/b", "gone/x", "O/A"], ["o/a", "o/b", "o/d", "o/c"]), ["o/b", "o/a", "o/c", "o/d"]);
  assert.deepEqual(orderRepos(undefined, ["o/b", "o/a"]), ["o/a", "o/b"]);
});

test("move: before another repo, or to the end", () => {
  assert.deepEqual(moveRepo(["a", "b", "c", "d"], "d", "b"), ["a", "d", "b", "c"]);
  assert.deepEqual(moveRepo(["a", "b", "c"], "a", null), ["b", "c", "a"]);
  assert.deepEqual(moveRepo(["a", "b", "c"], "a", "c"), ["b", "a", "c"]);
});

// Planted violations: a rework hold tickable, or a "now" ticked after a later push.
test("lift advice: now is ticked; not yet is locked; anything else, or a push since, waits for the operator's tick", () => {
  assert.deepEqual(liftAdvice({ safe: "now", armed: true, pushedAfterHold: false }), { tick: true, locked: false, note: "" });
  // A push that could not be checked is not "no push".
  const unchecked = liftAdvice({ safe: "now", armed: true, pushedAfterHold: null });
  assert.equal(unchecked.tick, false);
  assert.match(unchecked.note, /Contents/);
  assert.deepEqual(liftAdvice({ safe: "not yet — x9 is reworking", armed: true }), { tick: false, locked: true, note: "Safe to lift: not yet — x9 is reworking" });
  assert.equal(liftAdvice({ safe: "now", pushedAfterHold: true, armed: true }).tick, false);
  assert.equal(liftAdvice({ safe: "after #5 merges", armed: true, pushedAfterHold: false }).tick, false);
  assert.match(liftAdvice({ safe: null, armed: false }).note, /no Safe to lift line/);
  assert.match(liftAdvice({ safe: "now", armed: false, pushedAfterHold: false }).note, /not armed/);
});

test("repo label: the owner can be hidden, except where two owners share a name", () => {
  const all = ["acme/gadgets", "acme/widgets", "fork/gadgets", "acme/tools"];
  assert.equal(repoLabel("acme/tools", all, true), "acme/tools");
  assert.equal(repoLabel("acme/tools", all, false), "tools");
  assert.equal(repoLabel("acme/gadgets", all, false), "acme/gadgets");
  assert.equal(repoLabel("fork/Gadgets", all, false), "fork/Gadgets");
});


const decodeQ = (url) => decodeURIComponent(url.split("q=")[1].replace(/\+/g, " "));

test("issue levels: open, blocked on me (blocked:operator), parked, unclaimed, S–XL, each with its GitHub list", () => {
  const issues = [issue(1, ["batch:a", "size:S"]), issue(2, ["parked", "size:XL"]), issue(3, ["size:S", "blocked:operator"]), issue(4, ["batch:b"])];
  const levels = issueLevels("o/r", issues, [{ number: 9 }]);
  assert.deepEqual(levels.map((l) => [l.label, l.items.map((i) => i.number)]), [
    ["open", [9]], ["blocked on me", [3]], ["parked", [2]], ["unclaimed", [3]], ["S", [1, 3]], ["M", []], ["L", []], ["XL", [2]],
  ]);
  assert.equal(decodeQ(levels[1].url), 'is:issue is:open label:"blocked:operator"');
  assert.equal(decodeQ(levels[3].url), 'is:issue is:open -label:parked -label:"batch:a" -label:"batch:b"');
  assert.equal(levels[0].url, null);
});

test("PR levels: held, blocked on me (needs-review or my review), failed", () => {
  const prs = [
    pr(1, { labels: ["hold:operator"] }),
    pr(2, { labels: ["needs-review"] }),
    pr(3, { reviewers: ["me"] }),
    pr(4, { reviewers: ["someone"] }),
    pr(5, { contexts: [ctx("check", "failed")] }),
  ];
  const levels = prLevels("o/r", prs, [], { me: "me" });
  assert.deepEqual(levels.map((l) => [l.id, l.items.map((p) => p.number)]), [["open", []], ["held", [1]], ["blocked", [2, 3]], ["failed", [5]]]);
});

// Planted violations: "open" offered as a filter, or a PR "blocked on me" sent to a list that is not it.
test("filter entries: every level but open, with counts; the issue one is a filter, the PR one opens the PRs", () => {
  const entries = filterEntries(prLevels("o/r", [pr(1, { labels: ["hold:operator"] }), pr(2, { labels: ["needs-review"] })], [{ number: 9 }], {}));
  assert.deepEqual(entries.map((e) => e.label), ["held (1)", "blocked on me (1)", "failed (0)"]);
  assert.match(decodeQ(entries[0].url), /label:hold:operator/);
  assert.equal(entries[1].url, null);
  assert.deepEqual(entries[1].items.map((p) => p.number), [2]);
  const issueEntries = filterEntries(issueLevels("o/r", [issue(1, ["size:M"])], []));
  assert.deepEqual(issueEntries.map((e) => e.label), ["blocked on me (0)", "parked (0)", "unclaimed (1)", "S (0)", "M (1)", "L (0)", "XL (0)"]);
  assert.ok(issueEntries.every((e) => e.url));
});

// Planted violations: more than five shown, or "more" miscounted.
test("top lists: five most recent, and how many more", () => {
  const list = Array.from({ length: 7 }, (_, i) => ({ n: i }));
  assert.deepEqual(topRecent(list).shown.map((x) => x.n), [0, 1, 2, 3, 4]);
  assert.equal(topRecent(list).more, 2);
  assert.deepEqual(topRecent(list.slice(0, 5)), { shown: list.slice(0, 5), more: 0 });
  assert.deepEqual(topRecent(undefined), { shown: [], more: 0 });
});

test("show-all links: GitHub search scoped to the scanned owners", () => {
  const url = searchUrl("issues", 'is:open is:issue label:"blocked:operator"', ["org:acme", "user:me"]);
  assert.match(url, /^https:\/\/github\.com\/search\?type=issues&q=/);
  assert.equal(decodeQ(url), 'is:open is:issue label:"blocked:operator" org:acme user:me');
});
