// Parse a github.com URL into what the tree tracks.
//
// Issues and pull requests share one number space per repo, and GitHub
// redirects /issues/N to /pull/N when N is a PR, so both get the same key
// (`owner/name#N`): a visit through either URL lands on one tree entry.

// First path segments that are GitHub's own pages, not an owner.
const RESERVED = new Set([
  "about", "account", "apps", "codespaces", "collections", "contact", "copilot",
  "customer-stories", "dashboard", "enterprise", "events", "explore", "features",
  "gist", "github-copilot", "issues", "login", "logout", "marketplace", "new",
  "notifications", "orgs", "organizations", "pricing", "pulls", "readme",
  "search", "security", "sessions", "settings", "signup", "sponsors", "stars",
  "team", "topics", "trending", "users",
]);

const LISTS = { issues: "issues", pulls: "pulls", actions: "actions" };

export function repoKey(repo) {
  return repo.toLowerCase();
}

/**
 * @returns null when the URL is not a page inside a github.com repository;
 * otherwise { repo, kind, key, url, path } where kind is one of
 * "issue" | "pull" | "run" | "workflow" (tracked items),
 * "list" (with list: "issues" | "pulls" | "actions") or "repo" (any other page).
 * `url` is the canonical item URL; `path` is the visited path without query or hash.
 */
export function parseGitHubUrl(href) {
  let u;
  try { u = new URL(href); } catch { return null; }
  if (u.protocol !== "https:" || u.hostname !== "github.com") return null;
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts.length < 2 || RESERVED.has(parts[0].toLowerCase())) return null;
  const [owner, name, section, a, b] = parts;
  const repo = `${owner}/${name}`;
  const base = `https://github.com/${repo}`;
  const path = `/${parts.join("/")}`;
  const rk = repoKey(repo);

  if ((section === "issues" || section === "pull") && /^\d+$/.test(a ?? "")) {
    const number = Number(a);
    const kind = section === "pull" ? "pull" : "issue";
    return { repo, kind, number, key: `${rk}#${number}`, url: `${base}/${section}/${number}`, path };
  }
  if (section === "actions" && a === "runs" && /^\d+$/.test(b ?? "")) {
    return { repo, kind: "run", id: Number(b), key: `${rk}@run:${b}`, url: `${base}/actions/runs/${b}`, path };
  }
  if (section === "actions" && a === "workflows" && b) {
    return { repo, kind: "workflow", file: b, key: `${rk}@workflow:${b}`, url: `${base}/actions/workflows/${b}`, path };
  }
  if (LISTS[section] && parts.length === 3) {
    return { repo, kind: "list", list: LISTS[section], key: `${rk}@list:${section}`, url: `${base}/${section}`, path };
  }
  return { repo, kind: "repo", key: `${rk}@repo`, url: base, path };
}

export const isItem = (p) => p != null && ["issue", "pull", "run", "workflow"].includes(p.kind);

// Titles GitHub shows while a page is not (yet) the item: an error, a sign-in wall.
const PLACEHOLDER_TITLES = new Set(["GitHub", "Page not found", "Sign in to GitHub", "Unicorn!", "Server Error"]);

/** "Fix the thing · Pull Request #12 · owner/repo" → "Fix the thing". */
export function titleFromTab(tabTitle, parsed) {
  const t = String(tabTitle ?? "").trim();
  if (!t || /^https?:\/\//.test(t)) return null;
  const first = t.split(" · ")[0].trim();
  if (PLACEHOLDER_TITLES.has(first)) return null;
  if (parsed?.number != null && new RegExp(`^(Issue|Pull Request) #${parsed.number}$`, "i").test(first)) return null;
  return first || null;
}
