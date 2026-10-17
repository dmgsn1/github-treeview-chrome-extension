import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseMainWindow, findTabFor, groupColor, groupTitle, pageId, planNewTab } from "../src/tabs.js";

const ALL_ON = { gather: true, dedupe: true, group: true };
const PR = "https://github.com/o/r/pull/12";

test("pageId: an item's sub-page counts, its query and hash do not; a list's query does", () => {
  assert.equal(pageId(PR), pageId("https://github.com/o/r/issues/12"));
  assert.equal(pageId(PR), pageId(`${PR}#issuecomment-1`));
  assert.notEqual(pageId(PR), pageId(`${PR}/files`));
  assert.notEqual(pageId("https://github.com/o/r/issues?q=is%3Aopen"), pageId("https://github.com/o/r/issues?q=is%3Aclosed"));
  assert.equal(pageId("https://example.com/"), null);
});

test("a new GitHub tab in another window is moved to the main window, grouped and brought forward", () => {
  const plan = planNewTab({ tab: { id: 9, windowId: 2, url: PR }, tabs: [], mainWindowId: 1, settings: ALL_ON });
  assert.deepEqual(plan, {
    move: { tabId: 9, windowId: 1 },
    group: { tabId: 9, repo: "o/r", windowId: 1 },
    activate: { tabId: 9, windowId: 1 },
  });
});

test("a new GitHub tab already in the main window is only grouped", () => {
  const plan = planNewTab({ tab: { id: 9, windowId: 1, url: PR }, tabs: [], mainWindowId: 1, settings: ALL_ON });
  assert.deepEqual(plan, { group: { tabId: 9, repo: "o/r", windowId: 1 } });
});

// Planted violation: opening a page that is already open adds a second tab.
test("a duplicate is closed and the open tab focused — in the main window first", () => {
  const tabs = [{ id: 3, windowId: 2, url: PR }, { id: 4, windowId: 1, url: PR }];
  const plan = planNewTab({ tab: { id: 9, windowId: 2, url: PR }, tabs, mainWindowId: 1, settings: ALL_ON });
  assert.deepEqual(plan, { focus: { tabId: 4, windowId: 1 }, close: 9 });
});

test("a link to one comment of an open PR takes the open tab to that comment", () => {
  const url = `${PR}#issuecomment-77`;
  const plan = planNewTab({ tab: { id: 9, windowId: 1, url }, tabs: [{ id: 4, windowId: 1, url: PR }], mainWindowId: 1, settings: ALL_ON });
  assert.deepEqual(plan, { focus: { tabId: 4, windowId: 1, url }, close: 9 });
});

test("a different sub-page of an open PR is a new tab, not a duplicate", () => {
  const plan = planNewTab({ tab: { id: 9, windowId: 1, url: `${PR}/files` }, tabs: [{ id: 4, windowId: 1, url: PR }], mainWindowId: 1, settings: ALL_ON });
  assert.equal(plan.close, undefined);
  assert.ok(plan.group);
});

test("settings switch each behaviour off; non-GitHub tabs are never touched", () => {
  const tab = { id: 9, windowId: 2, url: PR };
  const tabs = [{ id: 4, windowId: 1, url: PR }];
  assert.equal(planNewTab({ tab, tabs, mainWindowId: 1, settings: { gather: false, dedupe: false, group: false } }), null);
  assert.deepEqual(planNewTab({ tab, tabs, mainWindowId: 1, settings: { gather: true, dedupe: false, group: false } }),
    { move: { tabId: 9, windowId: 1 }, activate: { tabId: 9, windowId: 1 } });
  assert.equal(planNewTab({ tab: { id: 9, windowId: 2, url: "https://example.com" }, tabs, mainWindowId: 1, settings: ALL_ON }), null);
});

test("main window: the chosen one while it exists, else the one with most GitHub tabs, else the focused one", () => {
  const windows = [{ id: 1, type: "normal" }, { id: 2, type: "normal", focused: true }, { id: 3, type: "popup" }];
  const tabs = [{ windowId: 1, url: PR }, { windowId: 3, url: PR }, { windowId: 3, url: PR }];
  assert.equal(chooseMainWindow({ stored: 2, windows, tabs }), 2);
  assert.equal(chooseMainWindow({ stored: 99, windows, tabs }), 1);
  assert.equal(chooseMainWindow({ stored: null, windows, tabs: [] }), 2);
  assert.equal(chooseMainWindow({ stored: 3, windows, tabs }), 1); // a popup is never the main window
  assert.equal(chooseMainWindow({ stored: null, windows: [], tabs: [] }), null);
});

test("group titles use the short name unless two owners share it; colours are stable", () => {
  assert.equal(groupTitle("o/r", ["o/r", "o/other"]), "r");
  assert.equal(groupTitle("o/r", ["o/r", "fork/R"]), "o/r");
  assert.equal(groupColor("o/r"), groupColor("O/R"));
});

test("findTabFor: items match any sub-page; lists match their exact view", () => {
  const tabs = [
    { id: 1, windowId: 2, url: `${PR}/files` },
    { id: 2, windowId: 1, url: `${PR}/commits` },
    { id: 3, windowId: 1, url: "https://github.com/o/r/issues?q=label%3Abug" },
  ];
  assert.equal(findTabFor({ key: "o/r#12", url: PR }, tabs, 1).id, 2);
  assert.equal(findTabFor({ key: "o/r@list:issues", url: "https://github.com/o/r/issues" }, tabs, 1), null);
  assert.equal(findTabFor({ key: "o/r@list:issues", url: "https://github.com/o/r/issues?q=label%3Abug" }, tabs, 1).id, 3);
});
