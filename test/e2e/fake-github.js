// The fake github.com and api.github.com behind the end-to-end run.
//
// The world: the token "test-token" belongs to user `me`, who owns nothing
// relevant. `acme` is reachable through a repository the token can read;
// `other-org` only through the organisation list, so a list entry from it
// proves owner discovery reached past the tree and the repository walk.
//
// The listings behave like a fine-grained token's: viewer.repositories names
// only the account's own repository and GET /user/repos is refused, so the
// organisations' repositories are found only by asking each owner for its own.

import { assertValidQuery } from "../support/github-schema.js";

export const TOKEN = "test-token";

/** Queries GitHub's schema would reject. GitHub answers those with an error, and so does this fake. */
export const invalidQueries = [];

/** Every label removal the extension asked for, as "owner/name#N label". */
export const lifted = [];

/** github.com pages: just a title shaped like GitHub's. */
export function page(req, res) {
  const path = new URL(req.url, "https://github.com").pathname;
  const n = path.split("/")[4];
  const kind = path.includes("/pull/") ? "Pull Request" : "Issue";
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<title>Fake ${kind.toLowerCase()} ${n} · ${kind} #${n} · acme/widgets</title><h1>${path}</h1>`);
}

/** api.github.com: the GraphQL calls the extension makes. */
export function api(req, res) {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { message: "Bad credentials" });
    const label = req.method === "DELETE" && req.url.match(/^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/labels\/(.+)$/);
    if (label) {
      lifted.push(`${label[1]}#${label[2]} ${decodeURIComponent(label[3])}`);
      return send(200, []);
    }
    if (req.url.startsWith("/user/repos")) return send(403, { message: "Resource not accessible by personal access token" });
    if (req.url !== "/graphql") return send(404, { message: "Not Found" });
    const { query, variables = {} } = JSON.parse(raw);
    try {
      assertValidQuery(query);
    } catch (e) {
      invalidQueries.push(e.message);
      return send(200, { errors: [{ message: e.message.split("\n")[1]?.trim() || e.message }] });
    }
    // As for a fine-grained token, which cannot have Checks: acme/widgets' check
    // runs include one withheld, a null entry plus a FORBIDDEN error.
    const errors = query.includes("pullRequests(states: OPEN") && variables.o === "acme"
      ? [{ type: "FORBIDDEN", message: "Resource not accessible by personal access token",
        path: ["repository", "pullRequests", "nodes", 0, "commits", "nodes", 0, "commit", "statusCheckRollup", "contexts", "nodes", 1] }]
      : undefined;
    send(200, { data: answer(query, variables), ...(errors ? { errors } : {}) });
  });
}

function answer(query, v) {
  if (query.includes("organizations(")) return { viewer: { organizations: { nodes: [{ login: "other-org" }] } } };
  const repo = (nameWithOwner, isArchived = false) => ({ nameWithOwner, isArchived });
  if (query.includes("repositoryOwner(login: $l) { repositories")) {
    const owned = { me: [repo("me/dotfiles")], acme: [repo("acme/widgets"), repo("acme/old", true)], "other-org": [repo("other-org/tools")] }[v.l];
    return { repositoryOwner: owned ? { repositories: { pageInfo: { hasNextPage: false }, nodes: owned } } : null };
  }
  if (query.includes("viewer { repositories(")) return { viewer: { repositories: { pageInfo: { hasNextPage: false }, nodes: [repo("me/dotfiles")] } } };
  if (query.includes("viewer { login }")) return { viewer: { login: "me" } };
  if (query.includes("repositoryOwner")) return { repositoryOwner: { __typename: v.l === "me" ? "User" : "Organization", login: v.l } };
  if (query.includes("search(")) return { search: { pageInfo: { hasNextPage: false }, nodes: search(v.q) } };
  if (query.includes("issues(states: OPEN")) return { repository: { issues: { pageInfo: { hasNextPage: false }, nodes: ISSUES[`${v.o}/${v.n}`] ?? [] } } };
  if (query.includes("pullRequests(states: OPEN")) return { repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes: PRS[`${v.o}/${v.n}`] ?? [] } } };
  if (query.includes("issueOrPullRequest")) return states(query);
  throw new Error(`fake GitHub has no answer for: ${query.slice(0, 80)}`);
}

const lbl = (...names) => ({ nodes: names.map((name) => ({ name })) });
const fakeIssue = (n, ...labels) => ({ number: n, title: `Fake issue ${n}`, url: `https://github.com/acme/widgets/issues/${n}`, labels: lbl(...labels) });
const check = (name, status, conclusion) => ({ __typename: "CheckRun", name, status, conclusion });
const fakePr = (repo, n, title, labels, checks, extra = {}) => ({
  number: n, title, url: `https://github.com/${repo}/pull/${n}`, isDraft: false, isInMergeQueue: false, labels: lbl(...labels),
  reviewRequests: { nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS", contexts: { pageInfo: { hasNextPage: false }, nodes: checks } } } }] },
  ...extra,
});
const ISSUES = {
  "acme/widgets": [fakeIssue(7, "batch:spring", "size:S", "blocked:operator"), fakeIssue(8, "parked", "size:XL"), fakeIssue(9, "size:M")],
};
const PRS = {
  "acme/widgets": [
    fakePr("acme/widgets", 12, "Fake pull request 12", [], [check("check", "COMPLETED", "SUCCESS"), null]),
    fakePr("acme/widgets", 13, "Still checking", [], [check("check", "IN_PROGRESS", null)]),
    fakePr("acme/widgets", 99, "Fake pull request 99", ["needs-review"], [check("check", "COMPLETED", "FAILURE")]),
  ],
  "other-org/tools": [
    fakePr("other-org/tools", 31, "Rename the config loader", ["hold:operator"], [check("check", "COMPLETED", "SUCCESS"), { __typename: "StatusContext", context: "require-label", state: "FAILURE" }]),
    fakePr("other-org/tools", 32, "Rework in progress", ["hold:operator"], [check("check", "IN_PROGRESS", null)]),
  ],
};

function search(q) {
  if (q.includes("hold:operator") && q.includes("org:other-org")) {
    const held = (n, title, heldLine, safe) => ({
      number: n, title, url: `https://github.com/other-org/tools/pull/${n}`, isDraft: false,
      repository: { nameWithOwner: "other-org/tools" }, autoMergeRequest: { enabledAt: "2026-10-01T00:00:00Z" },
      commits: { nodes: [{ commit: { committedDate: "2026-09-30T00:00:00Z" } }] },
      closingIssuesReferences: { nodes: [] },
      comments: { nodes: [{ body: `**Held:** ${heldLine}\n**Safe to lift:** ${safe}`, createdAt: "2026-10-01T00:00:00Z" }] },
    });
    return [held(31, "Rename the config loader", "waiting on the copy review", "now"), held(32, "Rework in progress", "not yet — x9 is reworking", "not yet — x9 is reworking")];
  }
  // Six blocked:operator issues — one more than the panel shows — #7 the most recent.
  if (q.includes('label:"blocked:operator"') && q.includes("org:acme")) {
    const blocked = (n, day, needs) => ({
      number: n, title: n === 7 ? "Fake issue 7" : `Blocked issue ${n}`, url: `https://github.com/acme/widgets/issues/${n}`,
      updatedAt: `2026-10-${String(day).padStart(2, "0")}T00:00:00Z`, repository: { nameWithOwner: "acme/widgets" },
      comments: { nodes: needs ? [{ body: `**Needs:** ${needs}`, createdAt: `2026-10-${String(day).padStart(2, "0")}T00:00:00Z` }] : [] },
    });
    return [blocked(40, 1), blocked(41, 2), blocked(7, 9, "plug in the pixel and run the probe"), blocked(42, 3), blocked(43, 4), blocked(44, 5)];
  }
  return [];
}

/** Every issue or PR asked about is open; /pull/ numbers above 10 are PRs. */
function states(query) {
  const data = {};
  for (const block of query.split(/(?=r\d+: repository\()/).slice(1)) {
    const r = block.match(/^(r\d+)/)[1];
    data[r] = {};
    for (const m of block.matchAll(/(i\d+): issueOrPullRequest\(number: (\d+)\)/g)) {
      const n = Number(m[2]);
      data[r][m[1]] = n > 10
        ? { __typename: "PullRequest", prState: "OPEN", title: `Fake pull request ${n}`, url: `https://github.com/acme/widgets/pull/${n}`, isDraft: false, labels: { nodes: [] } }
        : { __typename: "Issue", issueState: "OPEN", title: `Fake issue ${n}`, url: `https://github.com/acme/widgets/issues/${n}` };
    }
  }
  return data;
}
