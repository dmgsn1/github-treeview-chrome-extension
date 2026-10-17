// Tab decisions, kept pure so they can be tested without a browser. The
// service worker gathers the facts (tabs, windows, settings), asks these
// functions what to do, and performs it with the chrome.* APIs.

import { parseGitHubUrl } from "./github-url.js";

/**
 * What makes two tabs "the same page": for an issue or PR, the item plus the
 * sub-page (/files, /commits…), ignoring query and hash — /issues/N and
 * /pull/N are the same; for anything else (lists, repo pages) the full path
 * and query, because a filtered list is a different view.
 */
export function pageId(href) {
  const p = parseGitHubUrl(href);
  if (!p) return null;
  if (p.kind === "issue" || p.kind === "pull") {
    const rest = p.path.split("/").slice(5).join("/").toLowerCase();
    return `${p.key}/${rest}`;
  }
  const u = new URL(href);
  return `${p.path.toLowerCase()}${u.search}`;
}

/**
 * Decide what to do with a tab that was just opened (a link from Claude, from
 * another app, or a new tab from a page) once it reaches a GitHub URL.
 *
 * @param tab   { id, windowId, url }
 * @param tabs  every other open tab: [{ id, windowId, url }]
 * @param mainWindowId  the window GitHub tabs are gathered into (null = none)
 * @param settings { gather, dedupe, group }
 * @returns null, or { focus?: { tabId, windowId, url? }, close?: tabId,
 *          move?: { tabId, windowId }, group?: { tabId, repo, windowId }, activate?: { tabId, windowId } }
 */
export function planNewTab({ tab, tabs, mainWindowId, settings }) {
  const parsed = parseGitHubUrl(tab.url);
  if (!parsed) return null;
  const id = pageId(tab.url);

  if (settings.dedupe) {
    const same = tabs.filter((t) => t.id !== tab.id && pageId(t.url) === id);
    const dup = same.find((t) => t.windowId === mainWindowId) ?? same[0];
    if (dup) {
      const focus = { tabId: dup.id, windowId: dup.windowId };
      if (dup.url !== tab.url) focus.url = tab.url; // e.g. a link to one comment: go there
      return { focus, close: tab.id };
    }
  }

  const plan = {};
  let windowId = tab.windowId;
  if (settings.gather && mainWindowId != null && tab.windowId !== mainWindowId) {
    plan.move = { tabId: tab.id, windowId: mainWindowId };
    windowId = mainWindowId;
  }
  if (settings.group) plan.group = { tabId: tab.id, repo: parsed.repo, windowId };
  if (plan.move) plan.activate = { tabId: tab.id, windowId };
  return Object.keys(plan).length ? plan : null;
}

/**
 * The window to gather into: the one the user chose while it still exists;
 * otherwise (window ids do not survive a browser restart) the window holding
 * the most GitHub tabs; otherwise the focused one.
 */
export function chooseMainWindow({ stored, windows, tabs }) {
  const normal = windows.filter((w) => w.type === "normal" && !w.incognito);
  if (stored != null && normal.some((w) => w.id === stored)) return stored;
  if (!normal.length) return null;
  const count = new Map(normal.map((w) => [w.id, 0]));
  for (const t of tabs) if (count.has(t.windowId) && parseGitHubUrl(t.url)) count.set(t.windowId, count.get(t.windowId) + 1);
  const best = [...count.entries()].sort((a, b) => b[1] - a[1])[0];
  if (best[1] > 0) return best[0];
  return (normal.find((w) => w.focused) ?? normal[0]).id;
}

/** Tab-group title for a repo: its short name, or owner/name when the short name is ambiguous. */
export function groupTitle(repo, knownRepos) {
  const short = repo.split("/")[1];
  const clash = knownRepos.some((r) => r.toLowerCase() !== repo.toLowerCase() && r.split("/")[1]?.toLowerCase() === short.toLowerCase());
  return clash ? repo : short;
}

const COLORS = ["blue", "green", "purple", "orange", "cyan", "pink", "red", "yellow", "grey"];
/** A stable colour per repo, so a repo's group looks the same in every session. */
export function groupColor(repo) {
  let h = 0;
  for (const ch of repo.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

/**
 * Find the tab already showing a tree entry, preferring the main window: an
 * item matches on its key (any sub-page of it will do), a list or repo page
 * on its exact view.
 */
export function findTabFor({ key, url }, tabs, mainWindowId) {
  const want = key && !/@(list|repo)/.test(key) ? key : null;
  const matches = tabs.filter((t) => {
    const p = parseGitHubUrl(t.url);
    if (!p) return false;
    if (want) return p.key === want;
    return pageId(t.url) === pageId(url);
  });
  return matches.find((t) => t.windowId === mainWindowId) ?? matches[0] ?? null;
}
