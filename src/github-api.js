// GitHub reads. Everything takes a `fetch`-compatible function so tests can run
// it against canned responses; nothing here writes to GitHub.

import { holdComment, needsLine } from "./blocked.js";
import { contextState } from "./repo-data.js";

const API = "https://api.github.com";
const CHUNK = 40; // items per state query; keeps GraphQL node cost well under the limit

export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** GitHub gave up on a query that was too heavy (502/504) or briefly unavailable (503). */
export const isTimeout = (e) => [502, 503, 504].includes(e?.status);

/**
 * Which token permission a withheld GraphQL field needs, in the words of the
 * fine-grained token form. Unknown fields are named as they are.
 */
const PERMISSION_FOR = { commit: "Contents", commits: "Contents", statusCheckRollup: "Commit statuses", contexts: "Commit statuses" };
/**
 * The permissions worth asking for. Withheld check runs ("checkRuns") are left
 * out: fine-grained tokens are not offered the Checks permission at all, and
 * the panel works around them (rollup state, Actions jobs for held PRs).
 */
export function missingPermissions(forbidden) {
  return [...new Set([...forbidden].filter((f) => f !== "checkRuns").map((f) => PERMISSION_FOR[f] ?? `the permission for "${f}"`))];
}

/** A withheld field's name: "checkRuns" for one inside a check rollup's contexts, else the last field on its path. */
export function forbiddenField(path) {
  const names = (path || []).filter((p) => typeof p === "string");
  if (names.includes("contexts")) return "checkRuns";
  return names.at(-1) ?? "?";
}

/** What an HTTP failure means to the person holding the token. */
export function httpProblem(status) {
  if (status === 401) return "GitHub rejected the token (401): it is mistyped, expired or revoked";
  if (status === 403) return "GitHub refused the request (403): a rate limit, an organisation policy, or a token without permission for this";
  if (status === 502 || status === 504) return `GitHub timed out answering (${status}); it is asked again in smaller pieces next time`;
  return `GitHub answered HTTP ${status}`;
}

export function client(fetchFn, token) {
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" };
  const forbidden = new Set(); // fields GitHub withheld for want of a permission
  async function gql(query, variables = {}) {
    const res = await fetchFn(`${API}/graphql`, { method: "POST", headers, body: JSON.stringify({ query, variables }) });
    if (!res.ok) throw new GitHubError(httpProblem(res.status), res.status);
    const json = await res.json();
    // NOT_FOUND on one alias still returns the rest. FORBIDDEN on a field the
    // token lacks a permission for (a commit, its checks) also returns the rest,
    // with that field null: record it and carry on, so one missing permission
    // costs a detail, not the repository. Anything else is a failure.
    const errors = json.errors || [];
    for (const e of errors) if (e.type === "FORBIDDEN") forbidden.add(forbiddenField(e.path));
    const fatal = errors.filter((e) => e.type !== "NOT_FOUND" && e.type !== "FORBIDDEN");
    if (fatal.length || !json.data) throw new GitHubError(fatal[0]?.message || errors[0]?.message || "GraphQL returned no data");
    return json.data;
  }
  async function rest(path) {
    const res = await fetchFn(`${API}${path}`, { headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new GitHubError(`${httpProblem(res.status)} (${path})`, res.status);
    return res.json();
  }
  /** DELETE; 404 (already gone) is not an error. */
  async function del(path) {
    const res = await fetchFn(`${API}${path}`, { method: "DELETE", headers });
    if (res.status === 404) return false;
    if (!res.ok) throw new GitHubError(`${httpProblem(res.status)} (${path})`, res.status);
    return true;
  }
  return { gql, rest, del, forbidden };
}

const splitRepo = (repo) => { const [owner, name] = repo.split("/"); return { owner, name }; };
const q = (s) => JSON.stringify(s); // a GraphQL string literal is a JSON string literal

/** Build one aliased query reading issue-or-PR state for refs [{ repo, number }]. */
export function issueStatesQuery(refs) {
  const byRepo = new Map();
  for (const r of refs) {
    const k = r.repo.toLowerCase();
    if (!byRepo.has(k)) byRepo.set(k, { repo: r.repo, numbers: [] });
    byRepo.get(k).numbers.push(r.number);
  }
  const aliases = [];
  const parts = [...byRepo.values()].map(({ repo, numbers }, ri) => {
    const { owner, name } = splitRepo(repo);
    const fields = numbers.map((n, ni) => {
      aliases.push({ alias: [`r${ri}`, `i${ni}`], repo, number: n });
      return `i${ni}: issueOrPullRequest(number: ${Number(n)}) { __typename ` +
        // Aliased: Issue.state and PullRequest.state have different types, and GitHub rejects the query otherwise.
        `... on Issue { issueState: state title url } ` +
        `... on PullRequest { prState: state title url isDraft labels(first: 20) { nodes { name } } } }`;
    }).join(" ");
    return `r${ri}: repository(owner: ${q(owner)}, name: ${q(name)}) { ${fields} }`;
  });
  return { query: `query { ${parts.join(" ")} }`, aliases };
}

/** key → state record for applyStates; unreadable when the repo or number did not resolve. */
export function parseIssueStates(data, aliases) {
  const out = {};
  for (const { alias: [r, i], repo, number } of aliases) {
    const node = data?.[r]?.[i];
    const key = `${repo.toLowerCase()}#${number}`;
    if (!node) { out[key] = { unreadable: true }; continue; }
    const s = { kind: node.__typename === "PullRequest" ? "pull" : "issue", state: node.issueState ?? node.prState, title: node.title, url: node.url };
    if (s.kind === "pull") {
      s.draft = !!node.isDraft;
      s.labels = (node.labels?.nodes || []).map((l) => l.name);
    }
    out[key] = s;
  }
  return out;
}

export async function fetchIssueStates(api, refs) {
  const out = {};
  for (let i = 0; i < refs.length; i += CHUNK) {
    const { query, aliases } = issueStatesQuery(refs.slice(i, i + CHUNK));
    Object.assign(out, parseIssueStates(await api.gql(query), aliases));
  }
  return out;
}

/** States for every tracked item: issues/PRs by GraphQL, runs and workflows by REST. */
export async function fetchItemStates(api, items) {
  const list = Object.values(items);
  const out = await fetchIssueStates(api, list.filter((i) => i.kind === "issue" || i.kind === "pull"));
  for (const i of list) {
    if (i.kind === "run") {
      const run = await api.rest(`/repos/${i.repo}/actions/runs/${i.id}`);
      out[i.key] = run ? { status: run.status, conclusion: run.conclusion, title: run.display_title || run.name } : { unreadable: true };
    } else if (i.kind === "workflow") {
      const wf = await api.rest(`/repos/${i.repo}/actions/workflows/${encodeURIComponent(i.file)}`);
      out[i.key] = wf ? { title: wf.name } : { unreadable: true };
    }
  }
  return out;
}

/** `user:x` or `org:x` — search wants the right one for each owner. */
export async function ownerQualifiers(api, owners) {
  const out = [];
  for (const login of owners) {
    const d = await api.gql(`query($l: String!) { repositoryOwner(login: $l) { __typename login } }`, { l: login });
    const o = d.repositoryOwner;
    if (o) out.push(`${o.__typename === "Organization" ? "org" : "user"}:${o.login}`);
  }
  return out;
}

const SEARCH_PAGES = 5; // up to 500 results per search

async function search(api, query, fields, pageSize = 100) {
  const out = [];
  let after = null;
  for (let page = 0; page < SEARCH_PAGES; page++) {
    const d = await api.gql(
      `query($q: String!, $after: String) { search(type: ISSUE, query: $q, first: ${pageSize}, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${fields} } } }`,
      { q: query, after },
    );
    out.push(...(d.search?.nodes || []).filter((n) => n && Object.keys(n).length));
    if (!d.search?.pageInfo?.hasNextPage) break;
    after = d.search.pageInfo.endCursor;
  }
  return out;
}

const HELD_FIELDS = `... on PullRequest { number title url isDraft updatedAt repository { nameWithOwner }
  autoMergeRequest { enabledAt } commits(last: 1) { nodes { commit { committedDate } } }
  closingIssuesReferences(first: 10) { nodes { number title url state repository { nameWithOwner } } }
  comments(last: 30) { nodes { body createdAt } } }`;

/** Open PRs labelled hold:operator, with the hold comment, and the open issues they close. */
export async function fetchHeld(api, qualifiers) {
  const out = [];
  for (const who of qualifiers) {
    for (const n of await search(api, `is:open is:pr label:"${HELD_LABEL}" ${who}`, HELD_FIELDS)) {
      const hold = holdComment(n.comments?.nodes);
      const head = n.commits?.nodes?.[0]?.commit?.committedDate ?? null;
      out.push({
        key: `${n.repository.nameWithOwner.toLowerCase()}#${n.number}`,
        repo: n.repository.nameWithOwner, number: n.number, title: n.title, url: n.url, draft: !!n.isDraft,
        updatedAt: n.updatedAt ?? null, reason: hold?.held ?? null, safe: hold?.safe ?? null,
        // Unknown (null) when the head commit was withheld: never read as "no push".
        pushedAfterHold: head ? !!(hold?.at && head > hold.at) : null,
        armed: !!n.autoMergeRequest,
        closes: (n.closingIssuesReferences?.nodes || [])
          .filter((c) => c.state === "OPEN")
          .map((c) => ({ repo: c.repository.nameWithOwner, number: c.number, title: c.title, url: c.url })),
      });
    }
  }
  return byRecent(dedupe(out));
}

/** Remove hold:operator from a PR — the operator's own lift, from the panel. False when it was already gone. */
export async function liftHold(api, repo, number) {
  return api.del(`/repos/${repo}/issues/${Number(number)}/labels/${encodeURIComponent("hold:operator")}`);
}

// The search itself stays light: comments are what make it heavy, and an issue
// whose updatedAt has not moved since the last refresh does not need them again.
const BLOCKED_FIELDS = `... on Issue { number title url updatedAt repository { nameWithOwner } comments(last: 10) { nodes { body createdAt } } }`;

/**
 * Open issues labelled blocked:operator — the flag for an issue that waits on
 * an act only the operator can do (README, "Conventions"). Each carries its
 * latest **Needs:** line, most recently updated first.
 */
export async function fetchBlocked(api, qualifiers) {
  const out = [];
  for (const who of qualifiers) {
    for (const n of await search(api, `is:open is:issue label:"${BLOCKED_LABEL}" ${who}`, BLOCKED_FIELDS)) {
      const repo = n.repository.nameWithOwner;
      out.push({ key: `${repo.toLowerCase()}#${n.number}`, repo, number: n.number, title: n.title, url: n.url, kind: "issue",
        updatedAt: n.updatedAt ?? null, needs: needsLine(n.comments?.nodes) });
    }
  }
  return byRecent(dedupe(out));
}

export const BLOCKED_LABEL = "blocked:operator";
export const HELD_LABEL = "hold:operator";

/** Most recently updated first; entries without a date last. */
export const byRecent = (list) => [...list].sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));

export async function viewerLogin(api) {
  return (await api.gql(`query { viewer { login } }`)).viewer.login;
}

const REPO_PAGES = 10; // up to 1,000 repositories per way of listing them

/**
 * Every repository this token can read, and so every owner worth scanning.
 * GitHub has no one listing that works for every kind of token: a
 * fine-grained token scoped to an organisation can read that organisation's
 * repositories while viewer.repositories lists none of them, and a classic
 * token without read:org cannot list its organisations. So three ways are
 * tried and their results joined; any one failing is a note, never fatal:
 *   1. viewer.repositories (GraphQL), with every affiliation;
 *   2. GET /user/repos (REST), the repositories the token can access;
 *   3. each known owner's own repositories: its organisations, the owners the
 *      first two found, and `extraOwners` (configured, or from the tree).
 * @returns { login, owners, repoCount, repos: [owner/name, not archived], notes }
 */
export async function discoverOwners(api, { extraOwners = [] } = {}) {
  const login = await viewerLogin(api);
  const notes = [];
  const all = new Map(); // lower-case name → { name, archived }
  const add = (name, archived) => { if (name && !all.has(name.toLowerCase())) all.set(name.toLowerCase(), { name, archived: !!archived }); };
  const tryIt = async (what, fn) => { try { await fn(); } catch (e) { notes.push(`${what} unavailable (${e.message})`); } };

  const orgs = [];
  await tryIt("organisation list", async () => {
    const d = await api.gql(`query { viewer { organizations(first: 100) { nodes { login } } } }`);
    for (const o of d.viewer.organizations?.nodes || []) orgs.push(o.login);
  });
  await tryIt("repository list", async () => {
    let after = null;
    for (let page = 0; page < REPO_PAGES; page++) {
      const d = await api.gql(
        `query($after: String) { viewer { repositories(first: 100, after: $after, affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER], ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]) { pageInfo { hasNextPage endCursor } nodes { nameWithOwner isArchived } } } }`,
        { after },
      );
      const r = d.viewer.repositories;
      for (const n of r.nodes) add(n.nameWithOwner, n.isArchived);
      if (!r.pageInfo.hasNextPage) break;
      after = r.pageInfo.endCursor;
    }
  });
  await tryIt("accessible repositories", async () => {
    for (let page = 1; page <= REPO_PAGES; page++) {
      const list = await api.rest(`/user/repos?per_page=100&page=${page}`);
      for (const r of list || []) add(r.full_name, r.archived);
      if (!list || list.length < 100) break;
    }
  });
  const ownersSoFar = [...all.values()].map((r) => r.name.split("/")[0]);
  const byOwner = [...new Map([login, ...orgs, ...ownersSoFar, ...extraOwners].map((o) => [o.toLowerCase(), o])).values()];
  for (const owner of byOwner) {
    await tryIt(`${owner}'s repositories`, async () => {
      let after = null;
      for (let page = 0; page < REPO_PAGES; page++) {
        const d = await api.gql(
          `query($l: String!, $after: String) { repositoryOwner(login: $l) { repositories(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { nameWithOwner isArchived } } } }`,
          { l: owner, after },
        );
        const r = d.repositoryOwner?.repositories;
        if (!r) break;
        for (const n of r.nodes) add(n.nameWithOwner, n.isArchived);
        if (!r.pageInfo.hasNextPage) break;
        after = r.pageInfo.endCursor;
      }
    });
  }

  const found = [...all.values()];
  const owners = [...new Map([login, ...orgs, ...found.map((r) => r.name.split("/")[0])].map((o) => [o.toLowerCase(), o])).values()];
  return { login, owners, repoCount: found.length, repos: found.filter((r) => !r.archived).map((r) => r.name), notes };
}

/**
 * Page through a connection, halving the page size while GitHub times out.
 * `query(first, after)` returns the connection { pageInfo, nodes }.
 */
async function pagedWithBackoff(query, size, maxItems) {
  const out = [];
  let after = null;
  while (out.length < maxItems) {
    let conn;
    try {
      conn = await query(size, after);
    } catch (e) {
      if (!isTimeout(e) || size === 1) throw e;
      size = Math.max(1, Math.floor(size / 2));
      continue;
    }
    out.push(...(conn?.nodes || []));
    if (!conn?.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return out;
}

const MAX_ISSUES = 2000;
const MAX_PRS = 500;
const PR_FIELDS = `number title url isDraft isInMergeQueue headRefOid labels(first: 20) { nodes { name } }
  reviewRequests(first: 10) { nodes { requestedReviewer { ... on User { login } } } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 50) { pageInfo { hasNextPage }
    nodes { __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state } } } } } } }`;

/** Every open issue and PR of one repository, reduced to what the panel counts and lists. */
export async function fetchRepoData(api, repo) {
  const { owner, name } = splitRepo(repo);
  const vars = (first, after) => ({ o: owner, n: name, first, after });
  const issues = await pagedWithBackoff(async (first, after) => (await api.gql(
    `query($o: String!, $n: String!, $first: Int!, $after: String) { repository(owner: $o, name: $n) { issues(states: OPEN, first: $first, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) { pageInfo { hasNextPage endCursor } nodes { number title url labels(first: 20) { nodes { name } } } } } }`,
    vars(first, after))).repository?.issues, 100, MAX_ISSUES);
  const prs = await pagedWithBackoff(async (first, after) => (await api.gql(
    `query($o: String!, $n: String!, $first: Int!, $after: String) { repository(owner: $o, name: $n) { pullRequests(states: OPEN, first: $first, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) { pageInfo { hasNextPage endCursor } nodes { ${PR_FIELDS} } } } }`,
    vars(first, after))).repository?.pullRequests, 25, MAX_PRS);
  // A withheld commit or check rollup leaves those fields null, which would read
  // as "no checks": mark the PRs' checks unknown instead.
  const checksWithheld = ["commit", "commits", "statusCheckRollup", "contexts"].some((f) => api.forbidden?.has(f));
  const out = {
    issues: issues.filter(Boolean).map((i) => ({ number: i.number, title: i.title, url: i.url, labels: (i.labels?.nodes || []).filter(Boolean).map((l) => l.name) })),
    prs: prs.filter(Boolean).map((p) => {
      const rollup = p.commits?.nodes?.[0]?.commit?.statusCheckRollup;
      const ctx = rollup?.contexts;
      // A withheld check run comes back as a null entry: count it, read the rest.
      const nodes = ctx?.nodes || [];
      return {
        number: p.number, title: p.title, url: p.url, draft: !!p.isDraft, queued: !!p.isInMergeQueue, head: p.headRefOid ?? null,
        labels: (p.labels?.nodes || []).filter(Boolean).map((l) => l.name),
        reviewers: (p.reviewRequests?.nodes || []).map((r) => r?.requestedReviewer?.login).filter(Boolean),
        rollup: rollup?.state ?? null,
        // A truncated context list falls back to the rollup state.
        contexts: ctx && !ctx.pageInfo?.hasNextPage ? nodes.filter(Boolean).map(contextState) : null,
        withheld: nodes.filter((n) => n == null).length,
        ...(checksWithheld && !rollup ? { checksUnknown: true } : {}),
      };
    }),
  };
  // A held PR's rollup is red because of the hold; with its check runs withheld,
  // only the Actions jobs can say whether anything else failed.
  for (const p of out.prs) {
    if (p.labels.includes("hold:operator") && p.withheld && p.head && (p.rollup === "FAILURE" || p.rollup === "ERROR")) {
      p.actions = await actionsVerdict(api, repo, p.head).catch(() => null);
    }
  }
  return out;
}

/**
 * What the Actions jobs on a commit say, ignoring require-label: "failed" when
 * any other job failed, "checking" when any run is unfinished, else "ready".
 * Reads only Actions (a permission fine-grained tokens can have).
 */
export async function actionsVerdict(api, repo, sha) {
  const runs = (await api.rest(`/repos/${repo}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=50`))?.workflow_runs || [];
  if (runs.some((r) => r.status !== "completed")) return "checking";
  for (const r of runs.filter((r) => !["success", "skipped", "neutral"].includes(r.conclusion))) {
    const jobs = (await api.rest(`/repos/${repo}/actions/runs/${r.id}/jobs?per_page=100`))?.jobs || [];
    const red = jobs.filter((j) => j.conclusion && !["success", "skipped", "neutral"].includes(j.conclusion));
    if (red.some((j) => !/require-label/i.test(j.name))) return "failed";
  }
  return "ready";
}

function dedupe(list) {
  const seen = new Map();
  for (const e of list) seen.set(e.key, e);
  return [...seen.values()];
}
