// End-to-end: the update path. Unzipping a new build over an unpacked
// extension changes the panel (Chrome reads its files afresh) but not the
// running service worker, which stays on the old build until the extension is
// reloaded. That mismatch once surfaced as "no answer from the extension".
//
// Here: load a copy whose worker predates the ping, copy the current files over
// it without reloading, and check the panel says so, still checks a token on
// its own, and leads to the extension's card in chrome://extensions.
//
// Not proven here: the banner's "Reload the extension" (chrome.runtime.reload).
// In this harness the extension is loaded with --load-extension, and Chromium
// drops a command-line extension when it reloads, with or without changes;
// the Load-unpacked path (CDP Extensions.loadUnpacked) needs a pipe connection
// Playwright does not expose for a persistent context.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const work = mkdtempSync(join(tmpdir(), "github-tree-stale-"));
const ext = join(work, "ext");
const copy = () => cpSync(root, ext, { recursive: true, filter: (p) => !/[/\\](node_modules|\.git|test|docs)([/\\]|$)/.test(p.slice(root.length)) });

// The "old build": today's worker without its ping handler, as every build before 0.3.0.
copy();
const bg = join(ext, "src/background.js");
const old = readFileSync(bg, "utf8").replace(/^\s*ping: .*$/m, "");
assert.notEqual(old, readFileSync(bg, "utf8"), "fixture: the ping handler was not found to remove");
writeFileSync(bg, old);

const context = await chromium.launchPersistentContext(join(work, "chrome"), {
  executablePath: process.env.CHROMIUM || undefined,
  headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--headless=new", "--no-proxy-server"],
  viewport: { width: 420, height: 900 },
});

let failed = false;
const step = async (name, fn) => {
  try { await fn(); console.log(`ok - ${name}`); } catch (e) { failed = true; console.log(`not ok - ${name}\n  ${e.stack || e}`); }
};

try {
  const ours = (w) => w.url().endsWith("/src/background.js");
  const sw = context.serviceWorkers().find(ours) ?? (await context.waitForEvent("serviceworker", { predicate: ours }));
  const panelUrl = `chrome-extension://${sw.url().split("/")[2]}/sidepanel/sidepanel.html`;

  copy(); // the update lands on disk; nobody presses reload

  await step("after an update without a reload, the panel says the worker is stale and offers a reload", async () => {
    const panel = await context.newPage();
    await panel.goto(panelUrl);
    await panel.locator("#worker").getByText("not answering").waitFor({ timeout: 5000 });
    await panel.locator("#worker").getByRole("button", { name: "Reload the extension" }).waitFor();
  });

  await step("Save still checks the token without the worker (no 'no answer from the extension')", async () => {
    const panel = context.pages().at(-1);
    await panel.locator("input[name=token]").fill("bad-token");
    await panel.locator("#save").click();
    // api.github.com is unreachable here; what matters is that the check ran in the panel and said why.
    const text = await panel.locator("#check-result").filter({ hasText: "token did not work" }).textContent({ timeout: 15000 });
    assert.doesNotMatch(text, /no answer/);
  });

  await step("the banner links to the extension's card in chrome://extensions", async () => {
    const panel = context.pages().at(-1);
    const opened = context.waitForEvent("page", { timeout: 5000 });
    await panel.locator("#worker").getByRole("button", { name: "card in chrome://extensions" }).click();
    const page = await opened;
    await page.waitForURL(/^chrome:\/\/extensions\/\?id=/, { timeout: 5000 });
    assert.equal(new URL(page.url()).searchParams.get("id"), sw.url().split("/")[2]);
  });
} finally {
  await context.close();
  rmSync(work, { recursive: true, force: true });
}

if (failed) process.exit(1);
