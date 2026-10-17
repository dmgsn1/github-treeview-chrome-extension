// Service worker: records visits, gathers new GitHub tabs into the main window,
// and refreshes item states and the two operator lists from GitHub.

import { client, discoverOwners, fetchBlocked, fetchHeld, fetchItemStates, fetchRepoData, missingPermissions, ownerQualifiers } from "./github-api.js";
import { BUILD } from "./version.js";
import { isItem, parseGitHubUrl } from "./github-url.js";
import { applyStates, dismiss, recordVisit } from "./store.js";
import { chooseMainWindow, findTabFor, groupColor, groupTitle, planNewTab } from "./tabs.js";

export const DEFAULT_SETTINGS = { token: "", owners: "", gather: true, dedupe: true, group: true };
const FRESH_MS = 15_000;    // a tab counts as "just opened" this long
const STARTUP_MS = 10_000;  // tabs restored at browser start are not "just opened"
const REFRESH_MINUTES = 5;

// ---- storage -------------------------------------------------------------

const local = chrome.storage.local;
const session = chrome.storage.session;

async function settings() {
  const { settings: s } = await local.get("settings");
  return { ...DEFAULT_SETTINGS, ...s };
}

let itemsChain = Promise.resolve();
/** Serialise read-modify-write on `items`: tab events arrive in bursts. */
function mutateItems(fn) {
  itemsChain = itemsChain.then(async () => {
    const { items = {} } = await local.get("items");
    const next = await fn(items);
    if (next !== items) await local.set({ items: next });
  }).catch((e) => console.error("items update failed", e));
  return itemsChain;
}

// ---- main window ---------------------------------------------------------

async function mainWindowId() {
  const { mainWindowId: stored } = await session.get("mainWindowId");
  const [windows, tabs] = await Promise.all([chrome.windows.getAll(), chrome.tabs.query({})]);
  const id = chooseMainWindow({ stored, windows, tabs });
  if (id !== stored) await session.set({ mainWindowId: id });
  return id;
}

async function focusWindow(windowId) {
  const w = await chrome.windows.get(windowId);
  await chrome.windows.update(windowId, w.state === "minimized" ? { state: "normal", focused: true } : { focused: true });
}

// ---- fresh tabs ----------------------------------------------------------

const fresh = new Map(); // tabId → created at

let startedAt = 0; // in memory as well: onStartup may land after the first restored tab
chrome.runtime.onStartup.addListener(() => {
  startedAt = Date.now();
  session.set({ startupAt: startedAt });
});

// Recorded synchronously: the tab's first onUpdated can arrive before any await here returns.
chrome.tabs.onCreated.addListener((tab) => { if (!tab.incognito) fresh.set(tab.id, Date.now()); });
chrome.tabs.onRemoved.addListener((tabId) => fresh.delete(tabId));

/** True once per tab, for a tab opened in the last FRESH_MS and not restored at browser start. */
async function takeFresh(tabId) {
  const at = fresh.get(tabId);
  if (at == null) return false;
  fresh.delete(tabId);
  if (Date.now() - at > FRESH_MS) return false;
  const { startupAt = 0 } = await session.get("startupAt");
  return at - Math.max(startupAt, startedAt) > STARTUP_MS;
}

// ---- tab events ----------------------------------------------------------

chrome.tabs.onUpdated.addListener(async (tabId, change, tab) => {
  if (tab.incognito || !(change.url || change.title)) return;
  const parsed = parseGitHubUrl(tab.url);
  if (!parsed) return;
  if (isItem(parsed)) await mutateItems((items) => recordVisit(items, parsed, tab.title, Date.now()));
  if (change.url && (await takeFresh(tabId))) await handleNewTab(tab);
});

async function handleNewTab(tab) {
  const s = await settings();
  const [all, main] = await Promise.all([chrome.tabs.query({}), mainWindowId()]);
  const plan = planNewTab({ tab, tabs: all.filter((t) => t.id !== tab.id && !t.incognito), mainWindowId: main, settings: s });
  if (plan) await perform(plan).catch((e) => console.error("tab plan failed", plan, e));
}

async function perform(plan) {
  if (plan.focus) {
    await chrome.tabs.update(plan.focus.tabId, plan.focus.url ? { active: true, url: plan.focus.url } : { active: true });
    await focusWindow(plan.focus.windowId);
  }
  if (plan.close != null) await chrome.tabs.remove(plan.close);
  if (plan.move) await chrome.tabs.move(plan.move.tabId, { windowId: plan.move.windowId, index: -1 });
  if (plan.group) await groupTab(plan.group);
  if (plan.activate) {
    await chrome.tabs.update(plan.activate.tabId, { active: true });
    await focusWindow(plan.activate.windowId);
  }
}

async function groupTab({ tabId, repo, windowId }) {
  const { items = {} } = await local.get("items");
  const title = groupTitle(repo, [...new Set(Object.values(items).map((i) => i.repo).concat(repo))]);
  const existing = (await chrome.tabGroups.query({ windowId })).find((g) => g.title === title);
  if (existing) {
    await chrome.tabs.group({ tabIds: [tabId], groupId: existing.id });
  } else {
    const groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId } });
    await chrome.tabGroups.update(groupId, { title, color: groupColor(repo) });
  }
}

/** Record every GitHub item already open: tabs from before the install, or from before a restart. */
async function recordOpenTabs() {
  const tabs = (await chrome.tabs.query({})).filter((t) => !t.incognito);
  await mutateItems((items) => {
    let next = items;
    for (const t of tabs) {
      const parsed = parseGitHubUrl(t.url || "");
      if (isItem(parsed) && !next[parsed.key]) next = recordVisit(next, parsed, t.title, Date.now());
    }
    return next;
  });
}

// ---- side panel requests -------------------------------------------------

async function openEntry({ key, url }) {
  const [all, main] = await Promise.all([chrome.tabs.query({}), mainWindowId()]);
  const tab = findTabFor({ key, url }, all.filter((t) => !t.incognito), main);
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    await focusWindow(tab.windowId);
    return;
  }
  // Opened in the main window; onCreated/onUpdated then group it like any new tab.
  await chrome.tabs.create(main != null ? { url, windowId: main, active: true } : { url, active: true });
  if (main != null) await focusWindow(main);
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const run = {
    open: () => openEntry(msg),
    dismiss: () => mutateItems((items) => dismiss(items, msg.key)),
    setMain: () => session.set({ mainWindowId: msg.windowId }),
    refresh: () => refresh(),
    ping: async () => ({ build: BUILD }),
  }[msg?.type];
  if (!run) return false;
  run().then((result) => reply({ ok: true, result }), (e) => reply({ ok: false, error: String(e?.message || e) }));
  return true; // reply asynchronously
});

// ---- refresh from GitHub -------------------------------------------------

let refreshing = null;
function refresh() {
  refreshing ??= doRefresh().finally(() => { refreshing = null; });
  return refreshing;
}

const configuredOwners = (s) => s.owners.split(/[\s,]+/).filter(Boolean);
const dedupeCase = (list) => [...new Map(list.map((r) => [r.toLowerCase(), r])).values()];

async function doRefresh() {
  const startedAt = Date.now();
  const { refresh: last } = await local.get("refresh");
  await local.set({ refresh: { ...last, running: startedAt } });
  await recordOpenTabs().catch((e) => console.error("recording open tabs failed", e));

  const s = await settings();
  if (!s.token) {
    await local.set({ refresh: { at: Date.now(), errors: ["No GitHub token yet: add one in Settings (⚙)."] } });
    return;
  }
  const api = client(fetch.bind(globalThis), s.token);
  const errors = [];
  const attempt = async (what, fn) => { try { return await fn(); } catch (e) { errors.push(`${what}: ${e.message || e}`); return undefined; } };

  const { items = {} } = await local.get("items");
  const states = await attempt("Item states", () => fetchItemStates(api, items));
  if (states) await mutateItems((current) => applyStates(current, states, Date.now()));

  // Blank owners means everything the token can read, plus whatever is in the tree.
  const treeRepos = Object.values(items).map((i) => i.repo);
  const extraOwners = [...configuredOwners(s), ...treeRepos.map((r) => r.split("/")[0])];
  const found = await attempt("Finding owners and repositories", () => discoverOwners(api, { extraOwners }));
  let owners = configuredOwners(s);
  if (!owners.length) owners = [...new Set([...(found?.owners ?? []), ...treeRepos.map((r) => r.split("/")[0])])];
  const ownerSet = new Set(owners.map((o) => o.toLowerCase()));
  const { repoData: lastData = {} } = await local.get("repoData");
  // Without a repository list this time, keep the last one rather than shrink the tree.
  const known = found ? found.repos.filter((r) => ownerSet.has(r.split("/")[0].toLowerCase())) : Object.keys(lastData);
  const repos = dedupeCase([...known, ...treeRepos]);

  // Every repo's open issues and PRs, saved as each arrives so the panel fills in;
  // a repo that fails keeps its last data.
  const repoData = {};
  for (const repo of repos) {
    const d = await attempt(repo, () => fetchRepoData(api, repo));
    if (d) repoData[repo] = { ...d, at: Date.now() };
    else if (lastData[repo]) repoData[repo] = lastData[repo];
    await local.set({ repoData: { ...lastData, ...repoData } });
  }

  const quals = (await attempt("Owners", () => ownerQualifiers(api, owners))) ?? [];
  const held = await attempt("Held for you", () => fetchHeld(api, quals));
  const blocked = await attempt("Blocked on you", () => fetchBlocked(api, quals));

  const missing = missingPermissions(api.forbidden); // withheld check runs need nothing: they are worked around
  if (missing.length) {
    errors.push(`GitHub withheld some details: add ${missing.join(", ")} → Read-only to the token (Settings → Developer settings → Fine-grained tokens → this token → Edit). Until then PR checks show as unknown.`);
  }
  const update = { repoData, refresh: { at: Date.now(), took: Date.now() - startedAt, errors, scope: quals, me: found?.login ?? last?.me ?? null } };
  if (held) update.held = held;
  if (blocked) update.blocked = blocked;
  await local.set(update);
  await local.remove("waitingCache"); // from builds that scanned comments for "Waiting on the operator"
  const n = (held?.length ?? 0) + (blocked?.length ?? 0);
  await chrome.action.setBadgeText({ text: n ? String(n) : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#bf3989" });
}

chrome.alarms.onAlarm.addListener((a) => { if (a.name === "refresh") refresh(); });

async function setup() {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  await recordOpenTabs();
  if (!(await chrome.alarms.get("refresh"))) chrome.alarms.create("refresh", { periodInMinutes: REFRESH_MINUTES, delayInMinutes: 0.1 });
}
chrome.runtime.onInstalled.addListener(setup);
chrome.runtime.onStartup.addListener(setup);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) refresh(); // a new token or owner list takes effect now
});
