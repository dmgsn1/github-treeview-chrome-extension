// Per-repository views over the open issues and PRs fetched from GitHub: the
// counts on each row and the sub-levels under Issues and Pull requests. Pure.

const labelsOf = (x) => (x.labels || []).map((l) => l?.name || l);
const hasBatch = (labels) => labels.some((l) => l.startsWith("batch:"));

/**
 * Which share of the Issues count an issue is in. The three are disjoint, so
 * "X = claimed + parked + new" always adds up: parked wins over a batch label
 * (the label normalizer makes the two exclusive anyway), and new is what is in
 * neither.
 */
export function issueShare(issue) {
  const labels = labelsOf(issue);
  if (labels.includes("parked")) return "parked";
  if (hasBatch(labels)) return "claimed";
  return "new";
}

export const SIZES = ["S", "M", "L", "XL"];

// CheckRun conclusions that count as red; NEUTRAL and SKIPPED do not.
const RED = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);
const ROLLUP = { SUCCESS: "ready", PENDING: "checking", EXPECTED: "checking", FAILURE: "failed", ERROR: "failed" };

/**
 * A PR's share of the Pull requests count: "ready" (green, no checks, or in the
 * merge queue), "checking" (anything still running), "failed" (anything red), or
 * "unknown" when the token may not read checks.
 * A held PR's require-label is red because of the hold, which is not a failure
 * of the PR, so it is left out for held PRs.
 */
export function prShare(pr) {
  if (pr.queued) return "ready";
  if (pr.checksUnknown) return "unknown";
  const held = labelsOf(pr).includes("hold:operator");
  if (!pr.contexts) return ROLLUP[pr.rollup] ?? "ready";
  const counted = pr.contexts.filter((c) => !(held && c.name === "require-label"));
  if (counted.some((c) => c.state === "failed")) return "failed";
  if (pr.withheld) {
    // Some check runs were withheld (fine-grained tokens cannot have Checks):
    // the rollup still covers them. Red on a held PR may be only its hold, so
    // there the Actions jobs decide, or it stays unknown.
    if (pr.rollup === "SUCCESS") return "ready";
    if (pr.rollup === "PENDING" || pr.rollup === "EXPECTED") return "checking";
    if (pr.rollup === "FAILURE" || pr.rollup === "ERROR") return held ? pr.actions ?? "unknown" : "failed";
    return "unknown";
  }
  if (counted.some((c) => c.state === "pending")) return "checking";
  return "ready";
}

/** CheckRun / StatusContext → { name, state: "passed" | "pending" | "failed" }. */
export function contextState(node) {
  if (node.__typename === "StatusContext") {
    const state = node.state === "SUCCESS" ? "passed" : ["PENDING", "EXPECTED"].includes(node.state) ? "pending" : "failed";
    return { name: node.context, state };
  }
  if (node.status !== "COMPLETED") return { name: node.name, state: "pending" };
  return { name: node.name, state: RED.has(node.conclusion) ? "failed" : "passed" };
}

/** "3 issues | 2 PRs" */
export function repoSummary(data) {
  const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  return `${n(data.issues.length, "issue", "issues")} | ${n(data.prs.length, "PR", "PRs")}`;
}

/** "(12 = 5 claimed + 3 parked + 4 new)" */
export function issueSummary(issues) {
  const c = { claimed: 0, parked: 0, new: 0 };
  for (const i of issues) c[issueShare(i)]++;
  return `${issues.length} = ${c.claimed} claimed + ${c.parked} parked + ${c.new} new`;
}

/** "(6 = 3 ready/queued + 2 checking + 1 failed)" */
export function prSummary(prs) {
  const c = { ready: 0, checking: 0, failed: 0, unknown: 0 };
  for (const p of prs) c[prShare(p)]++;
  return `${prs.length} = ${c.ready} ready/queued + ${c.checking} checking + ${c.failed} failed${c.unknown ? ` + ${c.unknown} unknown` : ""}`;
}

const q = (s) => encodeURIComponent(s).replace(/%20/g, "+");
const listUrl = (repo, kind, query) => `https://github.com/${repo}/${kind}?q=${q(query)}`;

/**
 * Sub-levels under Issues: open (visited), blocked on me (blocked:operator),
 * parked, unclaimed, S, M, L, XL.
 * `visited` are the tree's items for this repo that are issues.
 * Each: { id, label, items, url } — url is the matching GitHub list.
 */
export function issueLevels(repo, issues, visited) {
  const batches = [...new Set(issues.flatMap((i) => labelsOf(i).filter((l) => l.startsWith("batch:"))))].sort();
  const sized = (s) => issues.filter((i) => labelsOf(i).includes(`size:${s}`));
  return [
    { id: "open", label: "open", items: visited, url: null },
    { id: "blocked", label: "blocked on me", items: issues.filter((i) => labelsOf(i).includes("blocked:operator")), url: listUrl(repo, "issues", 'is:issue is:open label:"blocked:operator"') },
    { id: "parked", label: "parked", items: issues.filter((i) => issueShare(i) === "parked"), url: listUrl(repo, "issues", "is:issue is:open label:parked") },
    {
      id: "unclaimed", label: "unclaimed", items: issues.filter((i) => issueShare(i) === "new"),
      // GitHub search has no "no label with this prefix", so name the batches this repo has.
      url: listUrl(repo, "issues", ["is:issue is:open -label:parked", ...batches.map((b) => `-label:"${b}"`)].join(" ")),
    },
    ...SIZES.map((s) => ({ id: `size-${s}`, label: s, items: sized(s), url: listUrl(repo, "issues", `is:issue is:open label:size:${s}`) })),
  ];
}

/**
 * Sub-levels under Pull requests: open (visited), held, blocked on me, failed.
 * A PR is blocked on me when it carries needs-review or asks for my review
 * (blocked:operator is an issue label; PRs wait through hold:operator).
 */
export function prLevels(repo, prs, visited, { me = null } = {}) {
  const blocked = (p) => labelsOf(p).includes("needs-review") || (me != null && (p.reviewers || []).includes(me));
  return [
    { id: "open", label: "open", items: visited, url: null },
    { id: "held", label: "held", items: prs.filter((p) => labelsOf(p).includes("hold:operator")), url: listUrl(repo, "pulls", "is:pr is:open label:hold:operator") },
    { id: "blocked", label: "blocked on me", items: prs.filter(blocked), url: `https://github.com/${repo}/pulls` },
    { id: "failed", label: "failed", items: prs.filter((p) => prShare(p) === "failed"), url: listUrl(repo, "pulls", "is:pr is:open status:failure") },
  ];
}

/**
 * The repo order to show: the stored order first (dropping repos no longer
 * present), then repos not yet placed, alphabetically.
 */
export function orderRepos(stored, repos) {
  const present = new Map(repos.map((r) => [r.toLowerCase(), r]));
  const out = [];
  for (const k of stored || []) {
    const r = present.get(k.toLowerCase());
    if (r && !out.includes(r)) out.push(r);
  }
  const rest = repos.filter((r) => !out.includes(r)).sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
  return [...out, ...rest];
}

/** Move `repo` to sit before `before` (or last when `before` is null). */
export function moveRepo(order, repo, before) {
  const without = order.filter((r) => r !== repo);
  const at = before == null ? without.length : without.indexOf(before);
  without.splice(at < 0 ? without.length : at, 0, repo);
  return without;
}

/**
 * What the lift dialog shows for a held PR, and whether it starts ticked.
 * A light version of a full lift check (head, checks, conflicts): `Safe to lift: not yet…` can't be ticked (a rework hold among them);
 * `now` starts ticked unless the head moved after the hold comment; anything
 * else is left for the operator to tick after reading the reason.
 */
export function liftAdvice(h) {
  const safe = (h.safe || "").trim();
  if (/^not yet/i.test(safe)) return { tick: false, locked: true, note: `Safe to lift: ${safe}` };
  const notes = [];
  if (h.pushedAfterHold) notes.push("pushed since the hold comment");
  if (h.pushedAfterHold == null) notes.push("could not check for pushes since the hold comment (the token needs Contents → Read-only)");
  if (h.armed === false) notes.push("auto-merge not armed: lifting merges nothing");
  if (!safe) notes.push("no Safe to lift line");
  else if (!/^now\b/i.test(safe)) notes.push(`Safe to lift: ${safe}`);
  return { tick: /^now\b/i.test(safe) && h.pushedAfterHold === false, locked: false, note: notes.join(" · ") };
}

/**
 * How a repository is named in the panel: owner/name, or just the name when
 * the owner is hidden — unless another listed repository has the same name,
 * where the owner is what tells them apart.
 */
export function repoLabel(repo, allRepos, showOwner) {
  if (showOwner) return repo;
  const name = repo.split("/")[1] ?? repo;
  const clash = allRepos.some((r) => r.toLowerCase() !== repo.toLowerCase() && (r.split("/")[1] ?? "").toLowerCase() === name.toLowerCase());
  return clash ? repo : name;
}

/**
 * The entries of a row's filter menu: every level except "open" (whose items
 * are listed under the row itself), with its count. An entry opens its GitHub
 * list; one GitHub cannot express as a filter ("blocked on me") opens its
 * items instead.
 */
export function filterEntries(levels) {
  return levels.filter((l) => l.id !== "open").map((l) => ({
    id: l.id,
    label: `${l.label} (${l.items.length})`,
    url: l.url && !l.url.endsWith("/pulls") ? l.url : null,
    items: l.items,
  }));
}

/** The first `n` of a most-recent-first list, and how many more there are. */
export function topRecent(list, n = 5) {
  const all = list || [];
  return { shown: all.slice(0, n), more: Math.max(0, all.length - n) };
}

/**
 * GitHub's search page for a cross-repository list, scoped to the owners the
 * panel scans ("org:x user:y" — GitHub ORs owner qualifiers).
 * @param type "issues" | "pullrequests"
 */
export function searchUrl(type, query, scope = []) {
  return `https://github.com/search?type=${type}&q=${q([query, ...scope].join(" "))}`;
}
