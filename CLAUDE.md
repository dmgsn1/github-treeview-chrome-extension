# CLAUDE.md — github-tree

A Chrome (MV3) side-panel extension; see [`README.md`](README.md) for what it does.

- **`npm run check` is the definition of done**: syntax, the unit tests and the
  end-to-end run against a local fake github.com. CI runs the same command.
- Logic lives in the pure modules under `src/` (everything except `background.js`)
  and is unit-tested there; `background.js` and `sidepanel/` only connect it to
  Chrome. A behaviour change comes with a test that fails without it.
- The labels and comment markers the panel follows are listed in README.md,
  "Conventions". A change to one changes that table in the same commit.
- The extension's one write to GitHub is removing `hold:operator` (Lift holds,
  `liftHold` in `src/github-api.js`), and only for the PRs the operator ticked.
  Adding another write, or a host permission beyond `api.github.com`, is a
  design change: say so in the PR.
