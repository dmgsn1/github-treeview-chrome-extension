// The visited-items model: pure functions over a plain { key: item } object,
// which the service worker keeps in chrome.storage.local.

import { isItem, titleFromTab } from "./github-url.js";

export const DAY = 24 * 60 * 60 * 1000;
/** A finished workflow run stays this long after your last look at it. */
export const RUN_LINGER = DAY;

/** Record a visit to a tracked page. Returns a new object; non-items are ignored. */
export function recordVisit(items, parsed, tabTitle, now) {
  if (!isItem(parsed)) return items;
  const prev = items[parsed.key];
  const title = titleFromTab(tabTitle, parsed) ?? prev?.title ?? null;
  // A later /pull/N visit corrects an /issues/N one (GitHub redirects PRs there).
  const kind = prev && prev.kind === "pull" && parsed.kind === "issue" ? "pull" : parsed.kind;
  const url = kind === parsed.kind ? parsed.url : prev.url;
  const item = {
    ...prev,
    key: parsed.key, repo: parsed.repo, kind, url, title,
    firstSeen: prev?.firstSeen ?? now,
    lastVisited: now,
  };
  for (const f of ["number", "id", "file"]) if (parsed[f] != null) item[f] = parsed[f];
  return { ...items, [parsed.key]: item };
}

export function dismiss(items, key) {
  const { [key]: _gone, ...rest } = items;
  return rest;
}

/**
 * Apply fetched states. `states` maps key → { kind?, state, title?, draft?, labels?, status?, conclusion?, unreadable? }.
 * Closed/merged issues and PRs leave the tree; a completed run leaves once it
 * has not been visited for RUN_LINGER. Keys absent from `states` are untouched
 * (a failed or skipped fetch never deletes anything).
 */
export function applyStates(items, states, now) {
  const out = {};
  for (const [key, item] of Object.entries(items)) {
    const s = states[key];
    if (!s) { out[key] = item; continue; }
    // Unreadable (deleted, transferred, or outside the token's reach) is flagged,
    // never pruned: a token scoped too narrowly must not empty the tree.
    const next = { ...item, unreadable: !!s.unreadable, ...pick(s, ["state", "draft", "labels", "status", "conclusion"]) };
    if (s.title) next.title = s.title;
    if (s.kind === "pull" && next.kind === "issue") {
      next.kind = "pull";
      next.url = next.url.replace(/\/issues\/(\d+)$/, "/pull/$1");
    }
    if ((next.kind === "issue" || next.kind === "pull") && s.state && s.state !== "OPEN") continue;
    if (next.kind === "run" && s.status === "completed" && now - item.lastVisited > RUN_LINGER) continue;
    out[key] = next;
  }
  return out;
}

const pick = (o, ks) => Object.fromEntries(ks.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
