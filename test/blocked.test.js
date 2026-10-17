import assert from "node:assert/strict";
import { test } from "node:test";
import { holdComment, needsLine } from "../src/blocked.js";

const comment = (body, day) => ({ body, createdAt: `2026-10-${day}T00:00:00Z` });

test("hold comment: the latest **Held:** wins, with its Safe to lift line", () => {
  assert.deepEqual(holdComment([
    comment("**Held:** waiting on the schema decision\n**Safe to lift:** yes", "02"),
    comment("**Held:** not yet — abc is reworking\n**Safe to lift:** not yet — abc is reworking", "05"),
    comment("ordinary comment", "06"),
  ]), { held: "not yet — abc is reworking", safe: "not yet — abc is reworking", at: "2026-10-05T00:00:00Z" });
  assert.equal(holdComment([comment("no hold here", "01")]), null);
});

test("needs: the latest comment with a **Needs:** line; text on the line, or the next line when it stands alone", () => {
  assert.equal(needsLine([comment("**Needs:** plug in the pixel and run the probe", "01")]), "plug in the pixel and run the probe");
  assert.equal(needsLine([comment("**Needs:** first ask", "01"), comment("Context first\n**Needs:**\n\nrotate the staging key", "03"), comment("thanks", "04")]), "rotate the staging key");
  assert.equal(needsLine([comment("No marker here", "01"), comment("Needs: not bold, not the marker", "02")]), null);
  assert.equal(needsLine([]), null);
});
