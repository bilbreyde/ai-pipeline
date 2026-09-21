# Themes and Dashboard overlay

This folder holds ONLY the files that add colour themes and the Dashboard tab to the existing AI Practice Pipeline
site. It builds on the Import and Export overlay, so apply that one first. It does not contain infra/,
scripts/deploy.ps1, host.json, .env.deploy or anything about how the site is deployed.

## Task for Claude Code (run from the repo root, C:\Users\DBilbrey\Azure\ai-pipeline)

1. Read CLAUDE.md in the repo first and follow its hard rules. Verify the Azure tenant and subscription with
   `az account show` before any `az` command that changes something.
2. Copy every file in this overlay into the repo at the same relative path, overwriting the existing file.
   Before overwriting each existing file, compare it with the local copy. If the local copy has changes that are
   not part of this feature (someone edited it), stop and show me the diff instead of overwriting.
   Do not restyle, reformat or refactor anything. Do not touch infra/ or scripts/deploy.ps1.
3. No new npm packages. Run `npm ci` only if node_modules is missing, then `npm test`. Expect 52 tests, all
   passing. If anything fails, fix the cause in the code you were given, not by weakening a test.
4. Run `npm run dev` and open http://localhost:7071. Confirm:
   * The Theme menu switches System, Light, Dark, Warm low glare and High contrast, and the choice survives a reload.
   * The Dashboard tab shows six cards. The Measure, Lead and Segment controls change every chart.
   * Each card's Table view button swaps the chart for a table. "Show these rows" jumps to the Pipeline tab.
   * The browser console shows no CSP errors.
5. Deploy code only: `./scripts/deploy.ps1 -TenantId 573e37c4-c2a8-4397-a860-6979128f5ac3 -SubscriptionId 7d70637f-bd34-4728-b41e-5a5c9f652d5d -SkipInfra`
   in PowerShell 7 (pwsh). Confirm the health check passes, then hard refresh (Ctrl+F5) the site once so the
   browser drops the old app.js.
6. Report which files changed, the test result, and the deploy result. Do not commit or push unless asked.

## What the feature does, so you can review it

* New static files: web/theme.js, web/dash-calc.js, web/dash.js. They are whitelisted in STATIC_FILES in
  src/lib/handlers.js. Any file not on that list returns 404 by design.
* web/dash-calc.js is now the single source of margin math. web/app.js delegates to it, so the table and the
  Dashboard cannot disagree. The Pipeline tab totals are unchanged.
* Themes are a data-theme attribute on <html>. theme.js runs synchronously in <head> to avoid a flash, because the
  CSP forbids inline scripts. The choice is stored in the browser (localStorage), not on the server.
* Charts are inline SVG built in the browser. No chart library, no CDN, no new network calls. The CSP is unchanged.
* test/theme-contrast.test.mjs parses the real app.css and checks WCAG contrast per theme. It caught one real
  problem in the existing light theme (muted text was 4.11:1 on the page background) and that token was darkened.
