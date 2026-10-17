import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGitHubUrl, titleFromTab } from "../src/github-url.js";

test("issues and PRs share one key, so the /issues/N → /pull/N redirect is one entry", () => {
  const i = parseGitHubUrl("https://github.com/Acme/Widgets/issues/42");
  const p = parseGitHubUrl("https://github.com/acme/widgets/pull/42/files#diff-abc");
  assert.equal(i.kind, "issue");
  assert.equal(p.kind, "pull");
  assert.equal(i.key, "acme/widgets#42");
  assert.equal(p.key, i.key);
  assert.equal(p.url, "https://github.com/acme/widgets/pull/42");
  assert.equal(p.path, "/acme/widgets/pull/42/files");
});

test("workflow runs and workflow files are items; lists and other repo pages are not", () => {
  const run = parseGitHubUrl("https://github.com/o/r/actions/runs/123/job/456?pr=7");
  assert.deepEqual([run.kind, run.id, run.key, run.url], ["run", 123, "o/r@run:123", "https://github.com/o/r/actions/runs/123"]);
  const wf = parseGitHubUrl("https://github.com/o/r/actions/workflows/check.yml?query=branch%3Amain");
  assert.deepEqual([wf.kind, wf.file], ["workflow", "check.yml"]);
  assert.equal(parseGitHubUrl("https://github.com/o/r/issues?q=is%3Aopen").kind, "list");
  assert.equal(parseGitHubUrl("https://github.com/o/r/pulls").list, "pulls");
  assert.equal(parseGitHubUrl("https://github.com/o/r/blob/main/README.md").kind, "repo");
  assert.equal(parseGitHubUrl("https://github.com/o/r/issues/new").kind, "repo");
});

// Planted violations: GitHub's own pages read as an owner, or another host accepted.
test("non-repository pages and other hosts are ignored", () => {
  for (const u of [
    "https://github.com/notifications",
    "https://github.com/pulls/assigned",
    "https://github.com/orgs/acme/projects/1",
    "https://github.com/settings/tokens",
    "https://github.com/acme",
    "https://gist.github.com/o/abc",
    "https://api.github.com/repos/o/r/issues/1",
    "http://github.com/o/r/issues/1",
    "chrome://newtab/",
    "not a url",
  ]) assert.equal(parseGitHubUrl(u), null, u);
});

test("tab titles: GitHub's suffixes are dropped, placeholder titles are refused", () => {
  const p = parseGitHubUrl("https://github.com/o/r/pull/12");
  assert.equal(titleFromTab("Fix the gate · Pull Request #12 · o/r", p), "Fix the gate");
  assert.equal(titleFromTab("Pull Request #12 · o/r", p), null);
  assert.equal(titleFromTab("https://github.com/o/r/pull/12", p), null);
  assert.equal(titleFromTab("", p), null);
  assert.equal(titleFromTab("Page not found · GitHub", p), null);
});
