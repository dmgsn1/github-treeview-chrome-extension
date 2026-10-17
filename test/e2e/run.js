// End-to-end: load the unpacked extension into Chromium, serve fake github.com
// pages, and drive tabs from the service worker the way an outside link would
// arrive. Proves the behaviours unit tests cannot: real chrome.tabs/tabGroups
// moves across windows, duplicate closing, visit recording, and the panel.
//
//   node test/e2e/run.js [--shots <dir>]
// CHROMIUM=<path> picks the browser (default: Playwright's own Chromium).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { api, invalidQueries, lifted, page, TOKEN } from "./fake-github.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : null;
const profile = mkdtempSync(join(tmpdir(), "github-tree-e2e-"));
const PR = "https://github.com/acme/widgets/pull/12";
const ISSUE = "https://github.com/acme/widgets/issues/7";

// github.com and api.github.com are answered by a local HTTPS server: every
// tab and every API call resolves there, so nothing can reach the real site.
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=github.com", "-days", "1",
  "-keyout", join(profile, "key.pem"), "-out", join(profile, "cert.pem")], { stdio: "ignore" });
const server = createServer({ key: readFileSync(join(profile, "key.pem")), cert: readFileSync(join(profile, "cert.pem")) },
  (req, res) => (req.headers.host === "api.github.com" ? api : page)(req, res));
await new Promise((r) => server.listen(0, "127.0.0.1", r));

const context = await chromium.launchPersistentContext(join(profile, "chrome"), {
  // Extensions need full Chromium; without channel, headless runs use the headless shell, which cannot load them.
  ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : { channel: "chromium" }),
  headless: true,
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, "--headless=new",
    `--host-resolver-rules=MAP github.com 127.0.0.1:${server.address().port}, MAP api.github.com 127.0.0.1:${server.address().port}`, "--no-proxy-server", "--ignore-certificate-errors"],
  viewport: { width: 420, height: 900 },
});

let failed = false;
const step = async (name, fn) => {
  try { await fn(); console.log(`ok - ${name}`); } catch (e) { failed = true; console.log(`not ok - ${name}\n  ${e.stack || e}`); }
};

try {
  const ours = (w) => w.url().endsWith("/src/background.js");
  const sw = context.serviceWorkers().find(ours) ?? (await context.waitForEvent("serviceworker", { predicate: ours }));
  // Playwright's worker.evaluate runs without the extension's chrome.* APIs, so
  // the test drives Chrome from an extension page, which has the same ones.
  const extensionId = sw.url().split("/")[2];
  const driver = await context.newPage();
  await driver.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`);
  const inSw = (fn, arg) => driver.evaluate(fn, arg);
  // Generous: CI runners are slower than a laptop, and it only waits as long as needed.
  const until = async (what, fn, ms = 15000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const tabsAt = (url) => inSw((u) => chrome.tabs.query({}).then((ts) => ts.filter((t) => t.url.startsWith(u))), url);

  const mainId = await inSw(async () => {
    const [w] = await chrome.windows.getAll();
    await chrome.storage.session.set({ mainWindowId: w.id });
    return w.id;
  });
  const otherId = await inSw(async () => (await chrome.windows.create({ url: "about:blank" })).id);
  await new Promise((r) => setTimeout(r, 300));

  await step("a GitHub link opened in another window moves to the main window, into its repo group", async () => {
    await inSw(({ windowId, url }) => chrome.tabs.create({ windowId, url }), { windowId: otherId, url: PR });
    const [tab] = await until("the PR tab in the main window", async () => {
      const ts = await tabsAt(PR);
      return ts.length === 1 && ts[0].windowId === mainId && ts[0].groupId > -1 ? ts : null;
    });
    assert.equal(tab.active, true);
    const group = await inSw((id) => chrome.tabGroups.get(id), tab.groupId);
    assert.equal(group.title, "widgets");
  });

  await step("the visit is recorded with the page's title", async () => {
    const items = await until("the recorded item", async () => {
      const { items = {} } = await inSw(() => chrome.storage.local.get("items"));
      return items["acme/widgets#12"]?.title ? items : null;
    });
    assert.equal(items["acme/widgets#12"].kind, "pull");
    assert.equal(items["acme/widgets#12"].title, "Fake pull request 12");
  });

  await step("opening the same PR again closes the new tab and focuses the open one", async () => {
    await inSw(() => chrome.tabs.create({ url: "about:blank", active: true })); // move focus off the PR
    await inSw(({ windowId, url }) => chrome.tabs.create({ windowId, url }), { windowId: otherId, url: `${PR}#issuecomment-5` });
    const [tab] = await until("one PR tab, active, at the comment", async () => {
      const ts = await tabsAt(PR);
      return ts.length === 1 && ts[0].active && ts[0].url.endsWith("#issuecomment-5") ? ts : null;
    });
    assert.equal(tab.windowId, mainId);
  });

  await step("a second item from the same repo joins the same group", async () => {
    await inSw(({ windowId, url }) => chrome.tabs.create({ windowId, url }), { windowId: otherId, url: ISSUE });
    const issueTab = await until("the issue tab grouped in the main window", async () => {
      const [t] = await tabsAt(ISSUE);
      return t && t.windowId === mainId && t.groupId > -1 ? t : null;
    });
    const [prTab] = await tabsAt(PR);
    assert.equal(issueTab.groupId, prTab.groupId);
  });

  await step("a tab that navigates to GitHub later (not just opened) is left where it is", async () => {
    const old = await inSw((windowId) => chrome.tabs.create({ windowId, url: "about:blank" }), otherId);
    await new Promise((r) => setTimeout(r, 16_000)); // past the "just opened" window
    await inSw((id) => chrome.tabs.update(id, { url: "https://github.com/acme/widgets/pull/99" }), old.id);
    await new Promise((r) => setTimeout(r, 1500));
    const [t] = await tabsAt("https://github.com/acme/widgets/pull/99");
    assert.equal(t.windowId, otherId);
    assert.equal(t.groupId, -1);
  });

  await step("GitHub tabs that were open before the tree knew them are recorded on refresh", async () => {
    await inSw(() => chrome.storage.local.set({ items: {} }));
    await inSw(() => chrome.runtime.sendMessage({ type: "refresh" }));
    await until("the open tabs back in the tree", async () => {
      const { items = {} } = await inSw(() => chrome.storage.local.get("items"));
      return items["acme/widgets#12"] && items["acme/widgets#7"];
    });
  });

  let panel;
  await step("with no token, the panel opens on settings and the how-to", async () => {
    panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`);
    await panel.locator("#settings").waitFor({ state: "visible" });
    assert.equal(await panel.locator("#toggle-settings").getAttribute("aria-expanded"), "true");
    assert.equal(await panel.locator("#token-help").evaluate((d) => d.open), true);
    await panel.getByText("Generate new token (classic)").waitFor();
  });

  await step("a wrong token is reported in words when saved", async () => {
    await panel.locator("input[name=token]").fill("not-the-token");
    await panel.locator("#save").click();
    await panel.getByText("Saved, but the token did not work: GitHub rejected the token (401)", { exact: false }).waitFor();
  });

  await step("a good token: the check names the account and owners, and both lists load from an org found only by discovery", async () => {
    await panel.locator("input[name=token]").fill(TOKEN);
    await panel.locator("#save").click();
    await panel.getByText("✓ Signed in as me. The token can read 4 repositories across me, other-org, acme.", { exact: false }).waitFor();
    await panel.locator("#held").getByText("Rename the config loader").waitFor();
    await panel.getByText("needs: plug in the pixel and run the probe").waitFor();
    await panel.getByText("Lists cover me, other-org (org), acme (org).", { exact: false }).waitFor();
    assert.equal(await panel.locator("#held-count").textContent(), "2");
    assert.equal(await panel.locator("#worker").isHidden(), true); // a current worker shows no reload banner
    if (shots) await panel.screenshot({ path: join(shots, "settings.png"), fullPage: true });
  });

  await step("settings close on ⚙ and the panel shows the tree; clicking an item focuses its open tab", async () => {
    await panel.locator("#toggle-settings").click();
    // Visibility, not the attribute: a CSS display rule once kept a [hidden] form on screen.
    await panel.locator("#settings").waitFor({ state: "hidden", timeout: 2000 });
    assert.equal(await panel.locator("#toggle-settings").getAttribute("aria-expanded"), "false");
    await panel.locator("#tree").getByText("Fake pull request 12").first().waitFor();
    await panel.locator("#toggle-settings").click();
    await panel.locator("#settings").waitFor({ state: "visible", timeout: 2000 });
    await panel.locator("#toggle-settings").click();
    await panel.locator("#tree").getByText("Fake pull request 12").first().click();
    await until("the PR tab active again", async () => (await tabsAt(PR))[0]?.active);
    assert.equal((await tabsAt(PR)).length, 1);
  });

  const repoRow = (repo) => panel.locator(`#tree li.repo[data-repo="${repo}"]`);
  const nodeNote = (id) => panel.locator(`#tree li[data-node="${id}"] > .node .note-inline`);
  const treeOrder = () => panel.locator("#tree > li.repo").evaluateAll((lis) => lis.map((li) => li.dataset.repo));
  // Collapsed nodes build their children only when opened, as a user would open them.
  const expand = async (id) => {
    const li = panel.locator(`#tree li[data-node="${id}"]`);
    if (await li.evaluate((e) => e.classList.contains("collapsed"))) await li.locator("> .node > .chev").click();
    await panel.locator(`#tree li[data-node="${id}"]:not(.collapsed)`).waitFor();
  };

  await step("every readable repository is listed — archived ones not — in bold, with issue and PR counts", async () => {
    await until("all three repositories", async () => (await treeOrder()).length === 3);
    assert.deepEqual(await treeOrder(), ["acme/widgets", "me/dotfiles", "other-org/tools"]);
    assert.equal(await repoRow("acme/widgets").locator("> .node .label").evaluate((e) => getComputedStyle(e).fontWeight), "700");
    assert.equal(await nodeNote("repo:acme/widgets").textContent(), "(3 issues | 3 PRs)");
    // acme/widgets has a withheld check run (as a fine-grained token sees it): no error, no permission to ask for.
    const errors = await panel.locator("#errors").textContent();
    assert.doesNotMatch(errors, /Cannot read|withheld|permission/i, errors);
    assert.equal(await nodeNote("repo:me/dotfiles").textContent(), "(0 issues | 0 PRs)");
    assert.equal(await nodeNote("repo:acme/widgets/issues").textContent(), "(3 = 1 claimed + 1 parked + 1 new)");
    assert.equal(await nodeNote("repo:acme/widgets/pulls").textContent(), "(3 = 1 ready/queued + 1 checking + 1 failed)");
    // The held PR's require-label is red because of the hold: not a failure.
    await expand("repo:other-org/tools");
    assert.equal(await nodeNote("repo:other-org/tools/pulls").textContent(), "(2 = 1 ready/queued + 1 checking + 0 failed)");
  });

  await step("Issues and Pull requests list the visited items, with a filter menu at the right instead of sub-level rows", async () => {
    const menu = (id) => panel.locator(`#tree li[data-node="${id}"] > .node select.filter`);
    const entries = (id) => menu(id).locator("option").evaluateAll((os) => os.slice(1).map((o) => o.textContent));
    assert.deepEqual(await entries("repo:acme/widgets/issues"), ["blocked on me (1)", "parked (1)", "unclaimed (1)", "S (1)", "M (1)", "L (0)", "XL (1)"]);
    assert.deepEqual(await entries("repo:acme/widgets/pulls"), ["held (0)", "blocked on me (1)", "failed (1)"]);
    assert.deepEqual(await entries("repo:other-org/tools/pulls"), ["held (2)", "blocked on me (0)", "failed (0)"]);
    // No sub-level rows: the visited items sit directly under the row.
    assert.equal(await panel.locator('#tree li[data-node="repo:acme/widgets/issues"] > ul > li[data-node]').count(), 0);
    await panel.locator('#tree li[data-node="repo:acme/widgets/issues"] > ul .item', { hasText: "Fake issue 7" }).waitFor();
    // An entry opens its filtered GitHub list, and the menu goes back to its prompt.
    await menu("repo:acme/widgets/issues").selectOption({ label: "parked (1)" });
    await until("the parked list tab", async () => (await tabsAt("https://github.com/acme/widgets/issues?q=")).some((t) => decodeURIComponent(t.url).includes("label:parked")));
    assert.equal(await menu("repo:acme/widgets/issues").inputValue(), "");
    // "blocked on me" has no single GitHub filter: it opens the PR itself.
    await menu("repo:acme/widgets/pulls").selectOption({ label: "blocked on me (1)" });
    await until("PR 99 active", async () => (await tabsAt("https://github.com/acme/widgets/pull/99"))[0]?.active);
  });

  await step("Blocked on you: blocked:operator issues, the five most recent, then Show all on GitHub", async () => {
    assert.equal(await panel.locator("#blocked-count").textContent(), "6");
    const rows = panel.locator("#blocked .item");
    assert.equal(await rows.count(), 5);
    assert.match(await rows.first().textContent(), /Fake issue 7.*needs: plug in the pixel/);
    await panel.locator("#blocked .show-all").getByText("Show all 6 on GitHub").click();
    await until("the GitHub search tab", async () => (await tabsAt("https://github.com/search?type=issues")).some((t) =>
      decodeURIComponent(t.url.replace(/\+/g, " ")).includes('label:"blocked:operator"')));
    // Held has two: no Show all.
    assert.equal(await panel.locator("#held .show-all").count(), 0);
  });

  await step("the owner can be hidden from repository names, in the tree and the lists", async () => {
    await panel.locator("#toggle-settings").click();
    await panel.locator("input[name=showOwner]").uncheck();
    await panel.locator("#save").click();
    await until("short names", async () => (await repoRow("acme/widgets").locator("> .node .label").textContent()) === "widgets");
    assert.equal(await panel.locator("#held .meta").first().textContent().then((t) => t.split(" · ")[0]), "tools#31");
    // The coverage line lives in settings now, not on the main view.
    await panel.locator("#settings #scope").getByText("Lists cover").waitFor();
    await panel.locator("#toggle-settings").click();
    await panel.locator("#settings").waitFor({ state: "hidden" });
    // The main-window line shows only in a window that is not the main one.
    const { mainWindowId } = await inSw(() => chrome.storage.session.get("mainWindowId"));
    const here = await panel.evaluate(async () => (await chrome.windows.getCurrent()).id);
    assert.equal(await panel.locator("#main-window").isVisible(), mainWindowId !== here);
  });

  await step("repositories reorder by drag and drop and by Alt+arrow, and the order is kept — even with a refresh running", async () => {
    // A refresh writes as it goes and the panel re-renders on each write: the
    // drag must survive that (it once dropped the drop, and then held renders forever).
    await inSw(() => { chrome.runtime.sendMessage({ type: "refresh" }); });
    await repoRow("other-org/tools").locator("> .node").dragTo(repoRow("acme/widgets").locator("> .node"), { targetPosition: { x: 20, y: 2 } });
    await until("other-org/tools first", async () => (await treeOrder())[0] === "other-org/tools");
    assert.deepEqual(await treeOrder(), ["other-org/tools", "acme/widgets", "me/dotfiles"]);
    await repoRow("other-org/tools").locator("> .node .label").focus();
    await panel.keyboard.press("Alt+ArrowDown");
    await until("other-org/tools second", async () => (await treeOrder())[1] === "other-org/tools");
    const { repoOrder } = await inSw(() => chrome.storage.local.get("repoOrder"));
    assert.deepEqual(repoOrder, ["acme/widgets", "other-org/tools", "me/dotfiles"]);
    await panel.reload();
    await until("the order after reopening", async () => (await treeOrder()).join() === "acme/widgets,other-org/tools,me/dotfiles");
  });

  await step("× on an open item closes its tab and takes it off the open list", async () => {
    assert.equal((await tabsAt(PR)).length, 1);
    const item = panel.locator('#tree li[data-node="repo:acme/widgets/pulls"] > ul .item', { hasText: "Fake pull request 12" });
    await item.hover();
    await item.locator(".dismiss").click();
    await until("the PR tab closed", async () => (await tabsAt(PR)).length === 0);
    await until("PR 12 gone from open", async () => (await item.count()) === 0);
  });

  await step("Lift holds: 'now' is ticked, 'not yet' is locked, and only the ticked hold is removed", async () => {
    if (shots) await panel.screenshot({ path: join(shots, "panel.png"), fullPage: true });
    await panel.locator("#lift-open").click();
    const box = (n) => panel.locator(`#lift input[data-key="other-org/tools#${n}"]`);
    assert.equal(await box(31).isChecked(), true);
    assert.equal(await box(32).isChecked(), false);
    assert.equal(await box(32).isDisabled(), true);
    await panel.locator("#lift").getByText("Safe to lift: not yet — x9 is reworking").waitFor();
    if (shots) await panel.screenshot({ path: join(shots, "lift.png"), fullPage: true });
    await panel.locator("#lift button.go").click();
    await panel.locator("#lift").getByText("✓ other-org/tools#31: lifted").waitFor();
    assert.deepEqual(lifted, ["other-org/tools#31 hold:operator"]);
  });
  await step("every GraphQL query the extension sent is valid against GitHub's schema", async () => {
    assert.deepEqual(invalidQueries, []);
  });
} finally {
  await context.close();
  server.close();
  rmSync(profile, { recursive: true, force: true });
}

if (failed) process.exit(1);
