import assert from "node:assert/strict";
import { test } from "node:test";
import { assertValidQuery } from "./support/github-schema.js";
import { prShare } from "../src/repo-data.js";
import { actionsVerdict, client, discoverOwners, forbiddenField, fetchBlocked, fetchHeld, fetchRepoData, liftHold, missingPermissions, fetchItemStates, GitHubError, issueStatesQuery, ownerQualifiers, parseIssueStates } from "../src/github-api.js";

/** A fake fetch: `routes` maps a matcher over (url, body) to a JSON body, or { http, json } for an error status. */
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    if (url.endsWith("/graphql")) assertValidQuery(body.query); // every query must be one GitHub accepts
    calls.push({ url, body, headers: init.headers, init });
    for (const [match, respond] of routes) {
      if (match(url, body)) {
        const r = await respond(url, body);
        const status = r?.http ?? 200;
        return { ok: status < 400, status, json: async () => r?.json ?? r };
      }
    }
    throw new Error(`unrouted ${url} ${body?.query?.slice(0, 60)}`);
  };
  fn.calls = calls;
  return fn;
}
const gqlHas = (needle) => (url, body) => url.endsWith("/graphql") && body.query.includes(needle);

test("state query: one aliased query per repo, owner and name escaped as strings", () => {
  const { query, aliases } = issueStatesQuery([{ repo: "o/r", number: 1 }, { repo: "O/R", number: 2 }, { repo: 'x/"y', number: 3 }]);
  assert.match(query, /r0: repository\(owner: "o", name: "r"\) \{ i0: issueOrPullRequest\(number: 1\).* i1: issueOrPullRequest\(number: 2\)/);
  assert.match(query, /r1: repository\(owner: "x", name: "\\"y"\)/);
  assert.deepEqual(aliases.map((a) => a.alias.join(".")), ["r0.i0", "r0.i1", "r1.i0"]);
});

test("state parse: PR fields read; an unresolved repo or number is unreadable, not closed", () => {
  const { aliases } = issueStatesQuery([{ repo: "o/r", number: 1 }, { repo: "o/r", number: 2 }, { repo: "gone/repo", number: 3 }]);
  const out = parseIssueStates({
    r0: { i0: { __typename: "PullRequest", prState: "OPEN", title: "T", url: "u", isDraft: true, labels: { nodes: [{ name: "hold:operator" }] } }, i1: null },
    r1: null,
  }, aliases);
  assert.deepEqual(out["o/r#1"], { kind: "pull", state: "OPEN", title: "T", url: "u", draft: true, labels: ["hold:operator"] });
  assert.deepEqual(out["o/r#2"], { unreadable: true });
  assert.deepEqual(out["gone/repo#3"], { unreadable: true });
});

test("item states: issues by GraphQL in chunks, runs and workflows by REST, the token sent as a bearer", async () => {
  const items = {};
  for (let n = 1; n <= 45; n++) items[`o/r#${n}`] = { key: `o/r#${n}`, repo: "o/r", kind: "issue", number: n };
  items["o/r@run:7"] = { key: "o/r@run:7", repo: "o/r", kind: "run", id: 7 };
  items["o/r@run:8"] = { key: "o/r@run:8", repo: "o/r", kind: "run", id: 8 };
  items["o/r@workflow:ci.yml"] = { key: "o/r@workflow:ci.yml", repo: "o/r", kind: "workflow", file: "ci.yml" };
  const fetch = fakeFetch([
    [gqlHas("issueOrPullRequest"), (_u, b) => {
      const data = { r0: {} };
      for (const m of b.query.matchAll(/(i\d+): issueOrPullRequest\(number: (\d+)\)/g)) data.r0[m[1]] = { __typename: "Issue", issueState: "OPEN", title: `#${m[2]}`, url: "" };
      return { data };
    }],
    [(u) => u.endsWith("/actions/runs/7"), () => ({ status: "completed", conclusion: "failure", display_title: "CI" })],
    [(u) => u.endsWith("/actions/runs/8"), () => ({ http: 404, json: {} })],
    [(u) => u.endsWith("/actions/workflows/ci.yml"), () => ({ name: "check" })],
  ]);
  const out = await fetchItemStates(client(fetch, "tok"), items);
  assert.equal(fetch.calls.filter((c) => c.url.endsWith("/graphql")).length, 2);
  assert.equal(fetch.calls[0].headers.Authorization, "Bearer tok");
  assert.equal(out["o/r#45"].title, "#45");
  assert.deepEqual(out["o/r@run:7"], { status: "completed", conclusion: "failure", title: "CI" });
  assert.deepEqual(out["o/r@run:8"], { unreadable: true });
  assert.deepEqual(out["o/r@workflow:ci.yml"], { title: "check" });
});

// Planted violation: a partial GraphQL failure read as an empty result.
test("errors: HTTP failures and non-NOT_FOUND GraphQL errors throw", async () => {
  const api = client(fakeFetch([[gqlHas("viewer"), () => ({ http: 401, json: {} })]]), "t");
  await assert.rejects(api.gql("query { viewer { login } }"), GitHubError);
  const api2 = client(fakeFetch([[gqlHas("viewer"), () => ({ data: null, errors: [{ type: "RATE_LIMITED", message: "slow down" }] })]]), "t");
  await assert.rejects(api2.gql("query { viewer { login } }"), /slow down/);
  const api3 = client(fakeFetch([[gqlHas("viewer"), () => ({ data: { r0: null }, errors: [{ type: "NOT_FOUND", message: "x" }] })]]), "t");
  assert.deepEqual(await api3.gql("query { viewer { login } }"), { r0: null });
});

test("owners: org: for organisations, user: for users, unknown logins skipped", async () => {
  const fetch = fakeFetch([[gqlHas("repositoryOwner"), (_u, b) => ({ data: { repositoryOwner: { acme: { __typename: "Organization", login: "acme" }, me: { __typename: "User", login: "me" } }[b.variables.l] ?? null } })]]);
  assert.deepEqual(await ownerQualifiers(client(fetch, "t"), ["acme", "me", "nobody"]), ["org:acme", "user:me"]);
});

/** A fake GitHub search: `results` maps a query fragment to nodes; pages of `pageSize`. */
function searchWorld(results, { pageSize = 100 } = {}) {
  const log = { searches: [], pages: [] };
  const fetch = fakeFetch([[gqlHas("search("), (_u, b) => {
    log.searches.push(b.variables.q);
    const nodes = Object.entries(results).find(([frag]) => b.variables.q.includes(frag))?.[1] ?? [];
    const from = Number(b.variables.after || 0);
    log.pages.push(from);
    return { data: { search: { pageInfo: { hasNextPage: from + pageSize < nodes.length, endCursor: String(from + pageSize) }, nodes: nodes.slice(from, from + pageSize) } } };
  }]]);
  return { api: client(fetch, "t"), log };
}

const blockedIssue = (n, updatedAt, comments = []) => ({
  number: n, title: `Issue ${n}`, url: `u${n}`, updatedAt, repository: { nameWithOwner: "o/r" },
  comments: { nodes: comments.map(([body, createdAt]) => ({ body, createdAt })) },
});

// Planted violations: scanning comments instead of the label, or losing the order.
test("blocked: the blocked:operator label decides; each carries its latest Needs line; most recent first", async () => {
  const { api, log } = searchWorld({ 'label:"blocked:operator"': [
    blockedIssue(4, "2026-10-01T00:00:00Z", [["**Needs:** run the probe on the pixel 8", "2026-10-01"]]),
    blockedIssue(9, "2026-10-05T00:00:00Z", [["**Needs:** old ask", "2026-10-02"], ["chatter", "2026-10-03"], ["**Needs:**\nrotate the staging key", "2026-10-04"]]),
    blockedIssue(6, null),
  ] });
  const out = await fetchBlocked(api, ["org:o"]);
  assert.deepEqual(out.map((b) => [b.number, b.needs]), [[9, "rotate the staging key"], [4, "run the probe on the pixel 8"], [6, null]]);
  assert.deepEqual(log.searches, ['is:open is:issue label:"blocked:operator" org:o']);
  assert.equal(out[0].key, "o/r#9");
});

test("searches page past 100 results", async () => {
  const many = Array.from({ length: 7 }, (_, i) => blockedIssue(i + 1, `2026-10-0${(i % 9) + 1}T00:00:00Z`));
  const { api, log } = searchWorld({ "blocked:operator": many }, { pageSize: 3 });
  // search() asks for 100 per page; the fake serves 3 to make paging visible.
  assert.equal((await fetchBlocked(api, ["user:me"])).length, 7);
  assert.deepEqual(log.pages, [0, 3, 6]);
});

test("held: reasons, closed references dropped, most recent first", async () => {
  const heldPr = (n, updatedAt) => ({
    number: n, title: `PR ${n}`, url: `pr${n}`, isDraft: false, updatedAt, repository: { nameWithOwner: "o/r" },
    closingIssuesReferences: { nodes: [
      { number: 7, title: "Seven", url: "u7", state: "OPEN", repository: { nameWithOwner: "o/r" } },
      { number: 8, title: "Eight", url: "u8", state: "CLOSED", repository: { nameWithOwner: "o/r" } }] },
    comments: { nodes: [{ body: "**Held:** check the copy", createdAt: "2026-10-01" }] },
  });
  const { api } = searchWorld({ "hold:operator": [heldPr(20, "2026-10-01T00:00:00Z"), heldPr(21, "2026-10-09T00:00:00Z")] });
  const held = await fetchHeld(api, ["user:me"]);
  assert.deepEqual(held.map((h) => h.number), [21, 20]);
  assert.deepEqual(held[1], { key: "o/r#20", repo: "o/r", number: 20, title: "PR 20", url: "pr20", draft: false, updatedAt: "2026-10-01T00:00:00Z",
    reason: "check the copy", safe: null, pushedAfterHold: null, armed: false, closes: [{ repo: "o/r", number: 7, title: "Seven", url: "u7" }] });
});

/** A GitHub where each way of listing repositories can be set to answer, come back empty, or fail. */
function discoveryWorld({ orgs, viewerRepos, userRepos, ownerRepos = {} }) {
  const reply = (v, ok) => (v instanceof Error ? { data: null, errors: [{ type: "FORBIDDEN", message: v.message }] } : ok(v));
  return fakeFetch([
    [gqlHas("viewer { login }"), () => ({ data: { viewer: { login: "me" } } })],
    [gqlHas("organizations("), () => reply(orgs, (o) => ({ data: { viewer: { organizations: { nodes: o.map((login) => ({ login })) } } } }))],
    [gqlHas("viewer { repositories("), (_u, b) => reply(viewerRepos, (list) => {
      const from = Number(b.variables.after || 0);
      const page = list.slice(from, from + 2); // two per page, so paging shows
      return { data: { viewer: { repositories: { pageInfo: { hasNextPage: from + 2 < list.length, endCursor: String(from + 2) },
        nodes: page.map(([nameWithOwner, isArchived]) => ({ nameWithOwner, isArchived: !!isArchived })) } } } };
    })],
    [(u) => u.includes("/user/repos"), () => (userRepos instanceof Error ? { http: 403, json: {} } : userRepos.map(([full_name, archived]) => ({ full_name, archived: !!archived })))],
    [gqlHas("repositoryOwner(login: $l) { repositories"), (_u, b) => {
      const list = ownerRepos[b.variables.l];
      if (!list) return { data: { repositoryOwner: null } };
      return { data: { repositoryOwner: { repositories: { pageInfo: { hasNextPage: false }, nodes: list.map(([nameWithOwner, isArchived]) => ({ nameWithOwner, isArchived: !!isArchived })) } } } };
    }],
  ]);
}

test("discovery: the GraphQL listing, the REST listing and each owner's repositories are joined; archived repos counted, not listed", async () => {
  const fetch = discoveryWorld({
    orgs: ["acme"],
    viewerRepos: [["me/a"], ["acme/b"], ["acme/old", true]],
    userRepos: [["acme/b"], ["other/c"]],
    ownerRepos: { acme: [["acme/b"], ["acme/d"]] },
  });
  const out = await discoverOwners(client(fetch, "t"));
  assert.deepEqual(out.repos.sort(), ["acme/b", "acme/d", "me/a", "other/c"]);
  assert.deepEqual(out.owners, ["me", "acme", "other"]);
  assert.equal(out.repoCount, 5);
  assert.deepEqual(out.notes, []);
});

// Planted violation (the 0.5.0 regression): trusting viewer.repositories alone.
// A fine-grained token scoped to an organisation reads its repositories while
// that listing — and here the REST one too — comes back without them.
test("discovery: an organisation's repositories are found through the owner even when both listings miss them", async () => {
  const fetch = discoveryWorld({
    orgs: new Error("Resource not accessible by personal access token"),
    viewerRepos: [],
    userRepos: new Error("forbidden"),
    ownerRepos: { acme: [["acme/widgets"], ["acme/gadgets"]] },
  });
  const out = await discoverOwners(client(fetch, "t"), { extraOwners: ["acme"] });
  assert.deepEqual(out.repos, ["acme/widgets", "acme/gadgets"]);
  assert.deepEqual(out.owners, ["me", "acme"]);
  assert.equal(out.notes.length, 2);
  assert.match(out.notes.join(" "), /organisation list unavailable.*accessible repositories unavailable/);
});

test("discovery: with no way in, it says so instead of failing", async () => {
  const fetch = discoveryWorld({ orgs: [], viewerRepos: [], userRepos: [] });
  const out = await discoverOwners(client(fetch, "t"));
  assert.deepEqual([out.login, out.repoCount, out.repos], ["me", 0, []]);
});

test("a rejected token says so in words", async () => {
  const api = client(fakeFetch([[gqlHas("viewer"), () => ({ http: 401, json: {} })]]), "t");
  await assert.rejects(api.gql("query { viewer { login } }"), /rejected the token \(401\)/);
});

test("held: Safe-to-lift line, armed state, and a push after the hold comment are read", async () => {
  const fetch = fakeFetch([[gqlHas("search("), () => ({ data: { search: { pageInfo: { hasNextPage: false }, nodes: [{
    number: 3, title: "T", url: "u", isDraft: false, repository: { nameWithOwner: "o/r" }, closingIssuesReferences: { nodes: [] },
    autoMergeRequest: { enabledAt: "2026-10-01T00:00:00Z" },
    commits: { nodes: [{ commit: { committedDate: "2026-10-03T00:00:00Z" } }] },
    comments: { nodes: [{ body: "**Held:** copy check\n**Safe to lift:** now", createdAt: "2026-10-02T00:00:00Z" }] },
  }] } } })]]);
  const [h] = await fetchHeld(client(fetch, "t"), ["user:me"]);
  assert.deepEqual([h.reason, h.safe, h.armed, h.pushedAfterHold], ["copy check", "now", true, true]);
});

test("lift: removes exactly hold:operator via the issues labels endpoint; a missing label is not an error", async () => {
  const calls = [];
  const fetch = fakeFetch([[(u) => u.includes("/labels/"), (u) => { calls.push(u); return u.includes("/9/") ? { http: 404, json: {} } : []; }]]);
  const api = client(fetch, "t");
  assert.equal(await liftHold(api, "o/r", 8), true);
  assert.equal(await liftHold(api, "o/r", 9), false);
  assert.deepEqual(calls, ["https://api.github.com/repos/o/r/issues/8/labels/hold%3Aoperator", "https://api.github.com/repos/o/r/issues/9/labels/hold%3Aoperator"]);
  assert.equal(fetch.calls[0].init?.method ?? "DELETE", "DELETE");
});

test("lift: a token that cannot write labels is reported in words", async () => {
  const api = client(fakeFetch([[(u) => u.includes("/labels/"), () => ({ http: 403, json: {} })]]), "t");
  await assert.rejects(liftHold(api, "o/r", 8), /refused the request \(403\)/);
});

test("repo data: issues and PRs paged; PR checks reduced to states; a PR page that times out is halved", async () => {
  const prSizes = [];
  const fetch = fakeFetch([
    [gqlHas("issues(states: OPEN"), (_u, b) => b.variables.after
      ? { data: { repository: { issues: { pageInfo: { hasNextPage: false }, nodes: [{ number: 2, title: "b", url: "u2", labels: { nodes: [] } }] } } } }
      : { data: { repository: { issues: { pageInfo: { hasNextPage: true, endCursor: "x" }, nodes: [{ number: 1, title: "a", url: "u1", labels: { nodes: [{ name: "parked" }] } }] } } } }],
    [gqlHas("pullRequests(states: OPEN"), (_u, b) => {
      prSizes.push(b.variables.first);
      if (b.variables.first > 10) return { http: 504, json: {} };
      return { data: { repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes: [{
        number: 5, title: "p", url: "u5", isDraft: false, isInMergeQueue: false, labels: { nodes: [{ name: "hold:operator" }] },
        reviewRequests: { nodes: [{ requestedReviewer: { login: "me" } }, { requestedReviewer: {} }] },
        commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE", contexts: { pageInfo: { hasNextPage: false }, nodes: [
          { __typename: "CheckRun", name: "check", status: "COMPLETED", conclusion: "SUCCESS" },
          { __typename: "StatusContext", context: "require-label", state: "FAILURE" }] } } } }] },
      }] } } } };
    }],
  ]);
  const d = await fetchRepoData(client(fetch, "t"), "o/r");
  assert.deepEqual(d.issues.map((i) => [i.number, i.labels]), [[1, ["parked"]], [2, []]]);
  assert.deepEqual(prSizes, [25, 12, 6]);
  assert.deepEqual(d.prs[0].reviewers, ["me"]);
  assert.deepEqual(d.prs[0].contexts, [{ name: "check", state: "passed" }, { name: "require-label", state: "failed" }]);
});

// Planted violation (the 0.5.2 regression): a field the token may not read
// (FORBIDDEN, with the rest of the data present) failed the whole repository.
test("a withheld field costs the detail, not the repository: PRs load with checks unknown, and the permission is named", async () => {
  const fetch = fakeFetch([
    [gqlHas("issues(states: OPEN"), () => ({ data: { repository: { issues: { pageInfo: { hasNextPage: false }, nodes: [] } } } })],
    [gqlHas("pullRequests(states: OPEN"), () => ({
      data: { repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes: [{
        number: 5, title: "p", url: "u5", isDraft: false, isInMergeQueue: false, labels: { nodes: [] }, reviewRequests: { nodes: [] },
        commits: { nodes: [null] },
      }] } } },
      errors: [{ type: "FORBIDDEN", path: ["repository", "pullRequests", "nodes", 0, "commits", "nodes", 0, "commit"], message: "Resource not accessible by personal access token" }],
    })],
  ]);
  const api = client(fetch, "t");
  const d = await fetchRepoData(api, "o/r");
  assert.equal(d.prs.length, 1);
  assert.equal(d.prs[0].checksUnknown, true);
  assert.deepEqual([...api.forbidden], ["commit"]);
  assert.deepEqual(missingPermissions(api.forbidden), ["Contents"]);
  assert.deepEqual(missingPermissions(new Set(["statusCheckRollup", "weird", "checkRuns"])), ["Commit statuses", 'the permission for "weird"']);
});

test("errors other than NOT_FOUND and FORBIDDEN still fail the query", async () => {
  const api = client(fakeFetch([[gqlHas("viewer"), () => ({ data: { viewer: null }, errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] })]]), "t");
  await assert.rejects(api.gql("query { viewer { login } }"), /rate limit/);
});

const checkRun = (name, conclusion) => ({ __typename: "CheckRun", name, status: "COMPLETED", conclusion });
/** One PR page as a fine-grained token sees it: check runs withheld as null entries, statuses readable. */
function withheldPrPage(prs) {
  return {
    data: { repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes: prs.map((p) => ({
      number: p.number, title: `#${p.number}`, url: `u${p.number}`, isDraft: false, isInMergeQueue: false, headRefOid: `sha${p.number}`,
      labels: { nodes: (p.labels || []).map((name) => ({ name })) }, reviewRequests: { nodes: [] },
      commits: { nodes: [{ commit: { statusCheckRollup: { state: p.rollup, contexts: { pageInfo: { hasNextPage: false },
        nodes: [null, null, { __typename: "StatusContext", context: "deploy", state: "SUCCESS" }] } } } }] },
    })) } } },
    errors: prs.flatMap((_, i) => [0, 1].map((j) => ({ type: "FORBIDDEN", message: "Resource not accessible by personal access token",
      path: ["repository", "pullRequests", "nodes", i, "commits", "nodes", 0, "commit", "statusCheckRollup", "contexts", "nodes", j] }))),
  };
}

// Planted violation (the 0.5.3 regression): a withheld check run is a null
// entry in contexts.nodes, and reading it threw "Cannot read properties of null
// (reading '__typename')" for every repository with open PRs.
test("withheld check runs: null entries are counted, not read; the rollup decides; nothing asks for Checks", async () => {
  const actionsCalls = [];
  const fetch = fakeFetch([
    [gqlHas("issues(states: OPEN"), () => ({ data: { repository: { issues: { pageInfo: { hasNextPage: false }, nodes: [] } } } })],
    [gqlHas("pullRequests(states: OPEN"), () => withheldPrPage([
      { number: 1, rollup: "SUCCESS" },
      { number: 2, rollup: "PENDING" },
      { number: 3, rollup: "FAILURE" },
      { number: 4, rollup: "FAILURE", labels: ["hold:operator"] }, // only its hold is red
      { number: 5, rollup: "FAILURE", labels: ["hold:operator"] }, // something else is red too
    ])],
    [(u) => u.includes("/actions/runs?head_sha="), (u) => { actionsCalls.push(u); return { workflow_runs: [{ id: u.includes("sha4") ? 40 : 50, status: "completed", conclusion: "failure" }] }; }],
    [(u) => u.includes("/actions/runs/40/jobs"), () => ({ jobs: [{ name: "require-label", conclusion: "failure" }, { name: "check", conclusion: "success" }] })],
    [(u) => u.includes("/actions/runs/50/jobs"), () => ({ jobs: [{ name: "require-label", conclusion: "failure" }, { name: "check", conclusion: "failure" }] })],
  ]);
  const api = client(fetch, "t");
  const d = await fetchRepoData(api, "o/r");
  assert.deepEqual(d.prs.map((p) => [p.number, p.withheld, p.contexts.length]), [[1, 2, 1], [2, 2, 1], [3, 2, 1], [4, 2, 1], [5, 2, 1]]);
  assert.deepEqual(d.prs.map(prShare), ["ready", "checking", "failed", "ready", "failed"]);
  assert.equal(actionsCalls.length, 2); // only the held, red PRs ask Actions
  assert.deepEqual([...api.forbidden], ["checkRuns"]);
  assert.deepEqual(missingPermissions(api.forbidden), []); // nothing to ask for
});

test("forbidden field names: inside a rollup's contexts is checkRuns, else the last field", () => {
  assert.equal(forbiddenField(["repository", "pullRequests", "nodes", 0, "commits", "nodes", 0, "commit", "statusCheckRollup", "contexts", "nodes", 3]), "checkRuns");
  assert.equal(forbiddenField(["repository", "pullRequests", "nodes", 0, "commits", "nodes", 0, "commit"]), "commit");
  assert.equal(forbiddenField(undefined), "?");
});

test("actions verdict: an unfinished run is checking; only require-label red is ready; any other red job is failed", async () => {
  const world = (runs, jobs) => client(fakeFetch([
    [(u) => u.includes("/actions/runs?head_sha="), () => ({ workflow_runs: runs })],
    [(u) => u.includes("/jobs"), () => ({ jobs })],
  ]), "t");
  assert.equal(await actionsVerdict(world([{ id: 1, status: "in_progress", conclusion: null }], []), "o/r", "s"), "checking");
  assert.equal(await actionsVerdict(world([{ id: 1, status: "completed", conclusion: "failure" }], [{ name: "gate / require-label", conclusion: "failure" }]), "o/r", "s"), "ready");
  assert.equal(await actionsVerdict(world([{ id: 1, status: "completed", conclusion: "failure" }], [{ name: "check", conclusion: "cancelled" }]), "o/r", "s"), "failed");
  assert.equal(await actionsVerdict(world([], []), "o/r", "s"), "ready");
});
