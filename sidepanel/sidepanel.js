// Side panel: renders the tree and the two operator lists from extension
// storage, and asks the service worker to open, dismiss, refresh.

import { client, discoverOwners, liftHold } from "../src/github-api.js";
import { parseGitHubUrl } from "../src/github-url.js";
import { filterEntries, issueLevels, issueSummary, liftAdvice, moveRepo, orderRepos, prLevels, prShare, prSummary, repoLabel, repoSummary, searchUrl, topRecent } from "../src/repo-data.js";
import { tokenAdvice } from "../src/token-advice.js";
import { BUILD, workerProblem } from "../src/version.js";

const DEFAULTS = { token: "", owners: "", gather: true, dedupe: true, group: true, showOwner: true };
const FLAGS = ["gather", "dedupe", "group", "showOwner"];
const $ = (id) => document.getElementById(id);
const ANSWER_MS = 90_000;
/** Ask the service worker; never throws, and a missing or late answer is { ok: false }. */
async function send(msg) {
  try {
    const reply = await Promise.race([
      chrome.runtime.sendMessage(msg),
      new Promise((r) => setTimeout(() => r({ ok: false, error: "timed out" }), ANSWER_MS)),
    ]);
    return reply ?? { ok: false, error: "no answer" };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/** Show the reload banner when the worker is missing or older than this panel. */
async function checkWorker() {
  const problem = workerProblem(await send({ type: "ping" }));
  const w = $("worker");
  w.hidden = !problem;
  if (problem) {
    w.replaceChildren(problem, " ",
      el("button", { onclick: () => chrome.runtime.reload() }, "Reload the extension"),
      " (the panel closes; open it again from the toolbar), or press ↻ on its ",
      el("button", { onclick: () => chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` }) }, "card in chrome://extensions"),
      ".");
  }
  return !problem;
}

let nodeState = {}; // node id → true (expanded) / false (collapsed); absent = its default
let thisWindowId = null;

// ---- small DOM helpers ---------------------------------------------------

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null) n.append(c);
  return n;
}

const SVG = {
  pull: '<circle cx="4" cy="3.5" r="1.7"/><circle cx="4" cy="12.5" r="1.7"/><circle cx="12" cy="12.5" r="1.7"/><path d="M4 5.2v5.6M12 10.8V6.5a2 2 0 0 0-2-2H7.2M8.8 2.9 7.2 4.5l1.6 1.6"/>',
  issue: '<circle cx="8" cy="8" r="6.2"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/>',
  run: '<circle cx="8" cy="8" r="6.2"/><path d="M6.6 5.4v5.2L10.6 8z" fill="currentColor" stroke="none"/>',
  workflow: '<rect x="1.8" y="1.8" width="5" height="4" rx="1"/><rect x="9.2" y="10.2" width="5" height="4" rx="1"/><path d="M4.3 5.8v3.4a1.5 1.5 0 0 0 1.5 1.5h3.4"/>',
};
function icon(kind, tone) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 16 16");
  s.setAttribute("class", `kind ${tone}`);
  s.setAttribute("fill", "none");
  s.setAttribute("stroke", "currentColor");
  s.setAttribute("stroke-width", "1.5");
  s.setAttribute("aria-hidden", "true");
  s.innerHTML = SVG[kind] ?? SVG.issue; // constant markup, never data
  return s;
}

function tone(item) {
  if (item.kind === "pull") {
    if ((item.labels || []).includes("hold:operator")) return "held";
    return item.draft ? "draft" : "open";
  }
  if (item.kind === "run") {
    if (item.status && item.status !== "completed") return "running";
    if (item.conclusion === "success") return "open";
    if (item.conclusion && !["skipped", "neutral"].includes(item.conclusion)) return "failed";
    return "neutral";
  }
  return item.kind === "issue" ? "open" : "neutral";
}

function ago(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

function row({ kind, toneName, title, meta, reason, open, onOpen, onClose, closeLabel, warn }) {
  const li = el("li", { class: "item", role: "link", tabindex: "0", title: [title, reason].filter(Boolean).join("\n"),
    onclick: onOpen, onkeydown: (e) => { if (e.key === "Enter") onOpen(); } },
  icon(kind, toneName),
  el("span", { class: "body" },
    el("span", { class: "title" }, title),
    el("span", { class: "meta" }, warn ? el("span", { class: "warn" }, `${warn} · `) : null, meta,
      reason ? el("span", { class: "reason" }, ` · ${reason}`) : null)),
  el("span", { class: `dot${open ? "" : " off"}`, title: open ? "Open in a tab" : null }));
  if (onClose) {
    li.append(el("button", { class: "dismiss", title: closeLabel, "aria-label": closeLabel,
      onclick: (e) => { e.stopPropagation(); onClose(); } }, "×"));
  }
  return li;
}

// ---- render --------------------------------------------------------------

async function openKeys() {
  const keys = new Set();
  for (const t of await chrome.tabs.query({})) {
    const p = parseGitHubUrl(t.url || t.pendingUrl || "");
    if (p) keys.add(p.key);
  }
  return keys;
}

/** Close every tab showing this item. */
async function closeTabs(key) {
  const ids = (await chrome.tabs.query({})).filter((t) => parseGitHubUrl(t.url || t.pendingUrl || "")?.key === key).map((t) => t.id);
  if (ids.length) await chrome.tabs.remove(ids);
}

const isOpen = (id, dflt) => nodeState[id] ?? dflt;
function toggle(id, dflt) {
  nodeState[id] = !isOpen(id, dflt);
  chrome.storage.local.set({ ui: { nodes: nodeState } });
  render();
}

function itemMeta(i) {
  if (i.kind === "run") return `run · ${i.status && i.status !== "completed" ? i.status.replace("_", " ") : i.conclusion || "status unknown"} · ${ago(i.lastVisited)}`;
  if (i.kind === "workflow") return `workflow · ${i.file}`;
  return `#${i.number}${i.draft ? " · draft" : ""} · ${ago(i.lastVisited)}`;
}

const CHECK_WORDS = { ready: "checks green", checking: "checks running", failed: "checks failed", unknown: "checks unknown" };
function fetchedMeta(x, kind) {
  const labels = (x.labels || []).filter((l) => !l.startsWith("batch:") || kind === "issue");
  const words = [`#${x.number}`];
  if (kind === "pull") words.push(x.queued ? "queued" : CHECK_WORDS[prShare(x)]);
  if (x.draft) words.push("draft");
  if (labels.length) words.push(labels.join(", "));
  return words.join(" · ");
}

/**
 * A tree node: chevron, label (a link when it has a URL), and a muted note.
 * `children` is a function, called only when the node is expanded: a
 * repository can hold hundreds of issues behind collapsed sub-levels.
 */
function node(id, dflt, { label, url, linkKey, note, strong, drag, menu }, children) {
  const expanded = isOpen(id, dflt);
  const head = el("div", { class: `node${strong ? " strong" : ""}`, draggable: drag ? "true" : null },
    el("button", { class: "chev", "aria-expanded": String(expanded), "aria-label": `Expand or collapse ${label}`, onclick: () => toggle(id, dflt) }),
    url
      ? el("button", { class: "label link", title: `Open ${label} on GitHub`, onclick: () => send({ type: "open", key: linkKey, url }) }, label)
      : el("button", { class: "label", onclick: () => toggle(id, dflt) }, label),
    note != null ? el("span", { class: "note-inline" }, note) : null,
    menu ? filterMenu(menu, label) : null);
  return el("li", { class: expanded ? null : "collapsed", "data-node": id }, head, el("ul", { class: "tree" }, expanded ? children() : []));
}

const prTone = (p) => (prShare(p) === "failed" ? "failed" : (p.labels || []).includes("hold:operator") ? "held" : p.draft ? "draft" : "open");

/**
 * The filter menu at the right of an Issues or Pull requests row: each entry
 * opens its filtered GitHub list; one with no GitHub filter opens its items.
 */
function filterMenu(entries, label) {
  const select = el("select", { class: "filter", title: `Open a filtered list of ${label.toLowerCase()} on GitHub`, "aria-label": `Filter ${label.toLowerCase()}` },
    el("option", { value: "" }, "filter…"),
    ...entries.map((e) => el("option", { value: e.id, disabled: !e.url && !e.items.length }, e.label)));
  select.addEventListener("click", (ev) => ev.stopPropagation());
  select.addEventListener("change", () => {
    const e = entries.find((x) => x.id === select.value);
    select.value = "";
    if (!e) return;
    if (e.url) send({ type: "open", key: "@list:filter", url: e.url }); // "@list": reuse a tab on exactly this view
    else for (const x of e.items) send({ type: "open", key: x.key ?? `${x.repo.toLowerCase()}#${x.number}`, url: x.url });
  });
  return select;
}

function itemRows(list, kind, open, { visited }) {
  return list.map((x) => {
    const key = x.key ?? `${x.repo.toLowerCase()}#${x.number}`;
    const tabOpen = open.has(key);
    const onClose = visited
      ? async () => { await closeTabs(key); await send({ type: "dismiss", key }); }
      : tabOpen ? () => closeTabs(key) : null;
    return row({
      // A visited item borrows the fetched PR's check state and labels when there is one.
      kind: x.kind ?? kind,
      toneName: x.fetched && x.kind === "pull" ? prTone(x.fetched) : x.kind ? tone(x) : kind === "pull" ? prTone(x) : "open",
      title: x.fetched?.title || x.title || x.url,
      meta: visited ? (x.fetched ? `${fetchedMeta(x.fetched, x.kind)} · ${ago(x.lastVisited)}` : itemMeta(x)) : fetchedMeta(x, kind),
      warn: x.unreadable ? "not readable with this token" : null, open: tabOpen,
      onOpen: () => send({ type: "open", key, url: x.url }), onClose,
      closeLabel: visited ? "Close its tab and remove it from open" : "Close its tab",
    });
  });
}

function renderRepo(repo, data, visitedAll, open, ctx) {
  const rk = repo.toLowerCase();
  const rid = `repo:${rk}`;
  const visited = visitedAll.filter((i) => i.repo.toLowerCase() === rk);
  const vIssues = visited.filter((i) => i.kind === "issue");
  const vPulls = visited.filter((i) => i.kind === "pull");
  const vActions = visited.filter((i) => i.kind === "run" || i.kind === "workflow");
  const withRepo = (list) => list.map((x) => ({ ...x, repo }));
  const menuOf = (levels) => filterEntries(levels).map((e) => ({ ...e, items: withRepo(e.items) }));

  const groups = [];
  if (data) {
    const byNumber = new Map([...data.issues, ...data.prs].map((x) => [x.number, x]));
    for (const v of [...vIssues, ...vPulls]) v.fetched = byNumber.get(v.number);
    const issuesId = `${rid}/issues`;
    groups.push(node(issuesId, vIssues.length > 0,
      { label: "Issues", url: `https://github.com/${repo}/issues`, linkKey: `${rk}@list:issues`, note: `(${issueSummary(data.issues)})`,
        menu: menuOf(issueLevels(repo, data.issues, vIssues)) },
      () => itemRows(vIssues, "issue", open, { visited: true })));
    const prsId = `${rid}/pulls`;
    groups.push(node(prsId, vPulls.length > 0,
      { label: "Pull requests", url: `https://github.com/${repo}/pulls`, linkKey: `${rk}@list:pulls`, note: `(${prSummary(data.prs)})`,
        menu: menuOf(prLevels(repo, data.prs, vPulls, ctx)) },
      () => itemRows(vPulls, "pull", open, { visited: true })));
  } else {
    // Not fetched (yet): the visited items still show, as before.
    if (vIssues.length) groups.push(node(`${rid}/issues`, true, { label: "Issues", url: `https://github.com/${repo}/issues`, linkKey: `${rk}@list:issues`, note: `(${vIssues.length} open here)` }, () => itemRows(vIssues, "issue", open, { visited: true })));
    if (vPulls.length) groups.push(node(`${rid}/pulls`, true, { label: "Pull requests", url: `https://github.com/${repo}/pulls`, linkKey: `${rk}@list:pulls`, note: `(${vPulls.length} open here)` }, () => itemRows(vPulls, "pull", open, { visited: true })));
  }
  if (vActions.length) {
    groups.push(node(`${rid}/actions`, true, { label: "Actions", url: `https://github.com/${repo}/actions`, linkKey: `${rk}@list:actions`, note: `(${vActions.length})` },
      () => itemRows(vActions, null, open, { visited: true })));
  }
  const li = node(rid, visited.length > 0, { label: ctx.label(repo), url: `https://github.com/${repo}`, linkKey: `${rk}@repo`, note: data ? `(${repoSummary(data)})` : "(loading…)", strong: true, drag: true }, () => groups);
  li.classList.add("repo");
  li.dataset.repo = repo;
  return li;
}

// ---- repository order: drag and drop, or Alt+↑/↓ ------------------------

let currentOrder = [];
async function saveOrder(order) {
  currentOrder = order;
  await chrome.storage.local.set({ repoOrder: order });
}

function wireDragAndDrop(tree) {
  let dragging = null;
  tree.addEventListener("pointerdown", () => { heldSince = Date.now(); });
  for (const type of ["pointerup", "pointercancel", "drop", "dragend"]) document.addEventListener(type, release, true);
  tree.addEventListener("dragstart", (e) => {
    const li = e.target.closest?.("li.repo");
    if (!li) return;
    dragging = li.dataset.repo;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", dragging);
    li.classList.add("dragging");
  });
  tree.addEventListener("dragend", () => {
    dragging = null;
    release();
    for (const n of tree.querySelectorAll(".drop-before, .drop-after, .dragging")) n.classList.remove("drop-before", "drop-after", "dragging");
  });
  const target = (e) => {
    const li = e.target.closest?.("li.repo");
    if (!li || li.dataset.repo === dragging) return null;
    const box = li.firstElementChild.getBoundingClientRect();
    return { li, after: e.clientY > box.top + box.height / 2 };
  };
  tree.addEventListener("dragover", (e) => {
    if (!dragging) return;
    e.preventDefault();
    for (const n of tree.querySelectorAll(".drop-before, .drop-after")) n.classList.remove("drop-before", "drop-after");
    const t = target(e);
    if (t) t.li.classList.add(t.after ? "drop-after" : "drop-before");
  });
  tree.addEventListener("drop", async (e) => {
    if (!dragging) return;
    e.preventDefault();
    const t = target(e);
    if (!t) return;
    const i = currentOrder.indexOf(t.li.dataset.repo);
    const before = t.after ? currentOrder[i + 1] ?? null : t.li.dataset.repo;
    await saveOrder(moveRepo(currentOrder, dragging, before === dragging ? currentOrder[i + 2] ?? null : before));
    render();
  });
  tree.addEventListener("keydown", async (e) => {
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    const li = e.target.closest?.("li.repo");
    if (!li || e.target.closest(".node") !== li.firstElementChild) return;
    e.preventDefault();
    const repo = li.dataset.repo;
    const i = currentOrder.indexOf(repo);
    const before = e.key === "ArrowUp" ? currentOrder[i - 1] : currentOrder[i + 2] ?? null;
    if (e.key === "ArrowUp" && i === 0) return;
    await saveOrder(moveRepo(currentOrder, repo, before));
    await render();
    $("tree").querySelector(`li.repo[data-repo="${CSS.escape(repo)}"] .label`)?.focus();
  });
}

const LIST_LIMIT = 5;

/** A top list: its five most recently updated entries, then "Show all" on GitHub when there are more. */
function renderList(id, entries, toRow, emptyNote, allUrl) {
  const section = $(`${id}-section`);
  section.classList.toggle("collapsed", !isOpen(id, true));
  $(`${id}-count`).textContent = entries ? String(entries.length) : "";
  if (!entries?.length) {
    $(id).replaceChildren(el("li", { class: "note" }, entries ? emptyNote : "Not loaded yet."));
    return;
  }
  const { shown, more } = topRecent(entries, LIST_LIMIT);
  const rows = shown.map(toRow);
  if (more) {
    rows.push(el("li", { class: "show-all" }, el("button", { onclick: () => send({ type: "open", key: "@list:show-all", url: allUrl }) },
      `Show all ${entries.length} on GitHub`)));
  }
  $(id).replaceChildren(...rows);
}

/** "org:acme" → "acme (org)" */
const ownerWords = (scope) => scope.map((q) => { const [kind, login] = q.split(":"); return `${login}${kind === "org" ? " (org)" : ""}`; }).join(", ");
const RUNNING_STALE = 2 * 60 * 1000; // a refresh "running" longer than this died with its service worker

function openSettings() {
  if (!$("settings").hidden) return;
  $("toggle-settings").click();
}

async function render() {
  const [{ items = {}, held, blocked, refresh, settings, repoData = {}, repoOrder }, { mainWindowId }, open] = await Promise.all([
    chrome.storage.local.get(["items", "held", "blocked", "refresh", "settings", "repoData", "repoOrder"]),
    chrome.storage.session.get("mainWindowId"),
    openKeys(),
  ]);
  const s = { ...DEFAULTS, ...settings };

  const running = refresh?.running && Date.now() - refresh.running < RUNNING_STALE;
  $("status").textContent = running ? "Loading from GitHub…" : refresh?.at ? `Updated ${ago(refresh.at)}` : "Not loaded yet";
  $("refresh").classList.toggle("spinning", !!running);
  const errors = refresh?.errors || [];
  $("errors").hidden = !errors.length;
  $("errors").replaceChildren(...errors.map((e) => el("div", {}, e)));

  const scope = refresh?.scope;
  $("scope").hidden = !s.token || !scope;
  if (scope && !$("scope").hidden) {
    $("scope").replaceChildren(
      scope.length ? `Lists cover ${ownerWords(scope)}. ` : "The token reaches no owners, so the lists are empty. ",
      el("button", { onclick: openSettings }, s.owners ? "Change owners" : "Limit to some owners"));
  }

  // Only worth a line when this panel is not in the main window.
  const mw = $("main-window");
  mw.hidden = !s.gather || mainWindowId === thisWindowId;
  if (!mw.hidden) mw.replaceChildren("New GitHub tabs gather in another window. ", el("button", { onclick: () => send({ type: "setMain", windowId: thisWindowId }) }, "Gather here instead"));

  const allRepos = [...new Set([...Object.keys(repoData), ...Object.values(items).map((i) => i.repo)])];
  const label = (repo) => repoLabel(repo, allRepos, s.showOwner);
  const repoOf = (e) => `${label(e.repo)}#${e.number}`;
  const where = scope?.length ? ` in ${ownerWords(scope)}` : "";
  const closer = (key) => (open.has(key) ? () => closeTabs(key) : null);
  renderList("held", held, (h) => row({
    kind: "pull", toneName: "held", title: h.title, meta: repoOf(h), reason: h.reason, open: open.has(h.key),
    onOpen: () => send({ type: "open", key: h.key, url: h.url }), onClose: closer(h.key), closeLabel: "Close its tab",
  }), `No open PR labelled hold:operator${where}.`, searchUrl("pullrequests", 'is:open is:pr label:"hold:operator"', scope ?? []));
  $("lift-open").hidden = !held?.length;
  renderList("blocked", blocked, (b) => row({
    kind: "issue", toneName: "open", title: b.title || repoOf(b), meta: repoOf(b), reason: b.needs ? `needs: ${b.needs}` : null, open: open.has(b.key),
    onOpen: () => send({ type: "open", key: b.key, url: b.url }), onClose: closer(b.key), closeLabel: "Close its tab",
  }), `No open issue labelled blocked:operator${where}.`, searchUrl("issues", 'is:open is:issue label:"blocked:operator"', scope ?? []));

  const visited = Object.values(items);
  currentOrder = orderRepos(repoOrder, [...new Map([...Object.keys(repoData), ...visited.map((i) => i.repo)].map((r) => [r.toLowerCase(), r])).values()]);
  const ctx = {
    label,
    me: refresh?.me ?? null,
  };
  $("tree-empty").hidden = currentOrder.length > 0;
  const rows = currentOrder.map((repo) => renderRepo(repo, repoData[repo], visited, open, ctx));
  // Unchanged markup keeps the DOM it has: a refresh or a tab event that changes
  // nothing on screen must not replace the row under the pointer.
  const markup = rows.map((r) => r.outerHTML).join("");
  if (markup !== lastTreeMarkup) {
    lastTreeMarkup = markup;
    $("tree").replaceChildren(...rows);
  }
}

// Re-rendering replaces the tree's DOM, which drops a drag (or a click) in
// progress: a refresh landing mid-drag lost the drop. So a render waits while
// a button is held down in the tree. Any release anywhere ends the wait, and so
// does a timeout, because a drag whose source row was replaced never fires
// dragend on the tree and must not hold renders forever.
let pending = null;
let lastTreeMarkup = null;
let heldSince = 0;
const HOLD_MS = 10_000;
const holding = () => heldSince && Date.now() - heldSince < HOLD_MS;
function soon() {
  clearTimeout(pending);
  pending = setTimeout(() => (holding() ? soon() : render()), 120);
}
function release() {
  heldSince = 0;
}

// ---- lift holds ----------------------------------------------------------

async function openLift() {
  const { held = [] } = await chrome.storage.local.get("held");
  const f = $("lift");
  const boxes = held.map((h) => {
    const a = liftAdvice(h);
    return { h, a, box: el("input", { type: "checkbox", checked: a.tick, disabled: a.locked, "data-key": h.key }) };
  });
  const go = el("button", { type: "submit", class: "go" });
  const count = () => {
    const n = boxes.filter((b) => b.box.checked).length;
    go.textContent = `Lift ${n} hold${n === 1 ? "" : "s"}`;
    go.disabled = n === 0;
  };
  f.replaceChildren(
    el("p", {}, "Removing hold:operator lets an armed PR merge once its checks are green. Ticked: the ones whose hold comment says Safe to lift: now. Read the rest before ticking."),
    ...boxes.map(({ h, a, box }) => el("label", { class: a.locked ? "locked" : null }, box,
      el("span", { class: "what" },
        el("b", {}, `${h.repo}#${h.number} ${h.title}`),
        el("span", { class: "why" }, `Held: ${h.reason ?? "no Held comment"}`),
        a.note ? el("span", { class: "flag" }, a.note) : null))),
    el("div", { class: "row" }, go, el("button", { type: "button", onclick: closeLift }, "Cancel")),
    el("p", { class: "results" }));
  for (const b of boxes) b.box.addEventListener("change", count);
  count();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const chosen = boxes.filter((b) => b.box.checked).map((b) => b.h);
    go.disabled = true;
    go.textContent = "Lifting…";
    const { settings } = await chrome.storage.local.get("settings");
    const api = client(fetch.bind(globalThis), settings?.token || "");
    const lines = [];
    for (const h of chosen) {
      try {
        lines.push(el("div", { class: "result good" }, `✓ ${h.repo}#${h.number}: ${(await liftHold(api, h.repo, h.number)) ? "lifted" : "was already lifted"}`));
      } catch (err) {
        lines.push(el("div", { class: "result bad" }, `✗ ${h.repo}#${h.number}: ${err.message || err}`));
      }
    }
    f.querySelector(".results").replaceChildren(...lines);
    f.querySelector(".row").replaceChildren(el("button", { type: "button", onclick: closeLift }, "Done"));
    send({ type: "refresh" });
  };
  f.hidden = false;
}

function closeLift() {
  $("lift").hidden = true;
  $("lift").replaceChildren();
}

$("lift-open").addEventListener("click", () => ($("lift").hidden ? openLift() : closeLift()));

// ---- settings ------------------------------------------------------------

async function loadSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  const s = { ...DEFAULTS, ...settings };
  const f = $("settings");
  f.token.value = s.token;
  f.owners.value = s.owners;
  for (const k of FLAGS) f[k].checked = s[k];
}

function showCheck(text, tone) {
  const r = $("check-result");
  r.hidden = false;
  r.className = `check-result${tone ? ` ${tone}` : ""}`;
  r.textContent = text;
}

$("settings").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const save = $("save");
  const settings = {
    token: f.token.value.trim(), owners: f.owners.value.trim(),
    ...Object.fromEntries(FLAGS.map((k) => [k, f[k].checked])),
  };
  save.disabled = true;
  save.textContent = "Saving…";
  try {
    await chrome.storage.local.set({ settings });
    if (!settings.token) {
      showCheck("Saved. Add a token to load the two lists.", "bad");
      return;
    }
    save.textContent = "Checking token…";
    showCheck("Saved. Checking the token with GitHub…");
    // Checked here, not in the service worker, so a stale or stopped worker cannot swallow it.
    let found;
    try {
      const { items = {} } = await chrome.storage.local.get("items");
      const extraOwners = [...settings.owners.split(/[\s,]+/).filter(Boolean), ...Object.values(items).map((i) => i.repo.split("/")[0])];
      found = await discoverOwners(client(fetch.bind(globalThis), settings.token), { extraOwners });
    } catch (err) {
      showCheck(`Saved, but the token did not work: ${err.message || err}`, "bad");
      return;
    }
    const { login, owners, repoCount, notes } = found;
    const covered = settings.owners ? ` The lists are limited to: ${settings.owners}.` : "";
    const advice = tokenAdvice(settings.token, found);
    showCheck(`${advice ? "⚠" : "✓"} Signed in as ${login}. The token can read ${repoCount} repositories across ${owners.join(", ")}.${covered}` +
      (advice ? ` ${advice}` : "") + (notes.length ? ` (${notes.join("; ")})` : "") +
      ((await checkWorker()) ? " Loading the lists…" : ""), advice ? "bad" : "good");
  } finally {
    save.disabled = false;
    save.textContent = "Save";
  }
});

$("toggle-settings").addEventListener("click", async () => {
  const f = $("settings");
  if (f.hidden) {
    await loadSettings();
    $("check-result").hidden = true;
    $("token-help").open = !f.token.value;
  }
  f.hidden = !f.hidden;
  $("toggle-settings").setAttribute("aria-expanded", String(!f.hidden));
  if (!f.hidden) {
    f.scrollIntoView({ block: "start" });
    (f.token.value ? f.owners : f.token).focus();
  }
});

$("refresh").addEventListener("click", async () => {
  const b = $("refresh");
  b.classList.add("spinning");
  try {
    if (await checkWorker()) await send({ type: "refresh" });
  } finally { b.classList.remove("spinning"); }
});

for (const b of document.querySelectorAll("[data-collapse]")) b.addEventListener("click", () => toggle(b.dataset.collapse, true));

// ---- start ---------------------------------------------------------------

(async () => {
  thisWindowId = (await chrome.windows.getCurrent()).id;
  $("build").textContent = `Build ${BUILD}`;
  const { ui } = await chrome.storage.local.get("ui");
  nodeState = ui?.nodes || {};
  wireDragAndDrop($("tree"));
  const { settings } = await chrome.storage.local.get("settings");
  if (!settings?.token) openSettings();
  await render();
  chrome.storage.onChanged.addListener(soon);
  chrome.tabs.onUpdated.addListener((_id, c) => { if (c.url) soon(); });
  chrome.tabs.onRemoved.addListener(soon);
  chrome.tabs.onCreated.addListener(soon);
  setInterval(soon, 30_000);
  if (await checkWorker()) send({ type: "refresh" });
})();
