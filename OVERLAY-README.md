# Transcripts overlay

Adds "From transcript" to the existing AI Practice Pipeline site: paste or drop a meeting transcript, review what the
AI proposes, and either update an existing opportunity or create a new one. It builds on the Import and Export overlay
and the Themes and Dashboard overlay, so those must already be applied.

It does not contain infra/, scripts/deploy.ps1, host.json or .env.deploy. The one new script, scripts/setup-foundry.ps1,
is standalone and creates the Foundry resource without touching your Bicep.

## Task for Claude Code (run from the repo root, C:\Users\DBilbrey\Azure\ai-pipeline)

1. Read CLAUDE.md in the repo first and follow its hard rules, including the new rule 7. Verify the Azure tenant and
   subscription with `az account show` before any `az` command that changes something.
2. Copy every file in this overlay into the repo at the same relative path, overwriting the existing file.
   Before overwriting each existing file, compare it with the local copy. If the local copy has changes that are
   not part of this feature (someone edited it), stop and show me the diff instead of overwriting.
   Do not restyle, reformat or refactor anything. Do not touch infra/ or scripts/deploy.ps1.
3. Run `npm ci` (jszip is now a direct dependency), then `npm test`. Expect 102 tests, all passing. If anything fails,
   fix the cause in the code you were given, not by weakening a test.
4. Run `npm run dev`, open http://localhost:7071 and confirm:
   * The From transcript button opens a dialog with a "Demo mode" banner (the dev server uses a stand in matcher).
   * Paste any text that names one of the sample accounts plus a dollar amount, for example
     "Avery: Fabrikam Logistics review. Priya: Budget is $310,000 and we want the order placed before Nov 20, 2026.
     Avery: Next step is Zones sends the revised proposal by Friday." Analyze shows a review step with checkboxes,
     editable values and a quote under each change.
   * Save updates the row and the row's edit panel shows a Meeting history entry. The Notes field is unchanged.
   * "A new opportunity" with "Customer: Adventure Works" plus a dollar amount creates a new row.
5. Set up Foundry. First run `./scripts/setup-foundry.ps1 -TenantId 573e37c4-c2a8-4397-a860-6979128f5ac3 -SubscriptionId 7d70637f-bd34-4728-b41e-5a5c9f652d5d -DryRun`
   in PowerShell 7 (pwsh) and show me the output. Only after I approve, run it without -DryRun. The default model is gpt-5.4-mini and the script picks the newest version and the
   Data Zone SKU your region offers, so check that the DryRun output shows a DataZoneStandard or Standard SKU and tell me if it shows
   GlobalStandard (prompts may then be processed outside the US). If it says the model or SKU is not offered in eastus2, show me
   the list it prints and ask which to use. Do not guess. If quota is short, rerun with a lower -Capacity, not a different model.
6. Deploy code only: `./scripts/deploy.ps1 -TenantId 573e37c4-c2a8-4397-a860-6979128f5ac3 -SubscriptionId 7d70637f-bd34-4728-b41e-5a5c9f652d5d -SkipInfra`,
   confirm the health check passes, then hard refresh (Ctrl+F5) the site once.
7. Real model check, using fictional text only: on the deployed site (with ALLOW_ANONYMOUS_BULK=true still set for
   testing) run one analysis. If it fails, read the message shown, then the Function App log for a line starting
   "Foundry error". Report the exact status and message. Common causes are role propagation (wait a few minutes) and
   a model that does not support strict structured outputs. Also report how long the analysis took and whether it filled the fields you expected. If it is slow or thin, try `FOUNDRY_REASONING_EFFORT=medium` on the app before changing model.
8. Report which files changed, the test result, the setup result and the deploy result. Do not commit or push unless asked.

## What the feature does, so you can review it

* POST /api/transcript/analyze reads the text or file, calls Foundry, and returns a proposal. It writes nothing.
  POST /api/transcript/apply saves what the person reviewed, through the same validators as a manual edit. Only that
  route can write the new `activity` list (meeting history). GET /api/opps/:id/activity returns the entries.
* Both routes are refused (403) unless a user is signed in, the same gate as import and export. ALLOW_ANONYMOUS_BULK=true
  lifts it for testing with fictional data only. /api/me now also returns ai, aiWhy and (in dev) aiDemo.
* Auth to Foundry is Entra ID only through DefaultAzureCredential. No API key exists anywhere, and the setup script
  disables key access on the resource.
* Every proposed value is re-validated, an invented opportunity id is ignored, and each supporting quote is checked
  against the transcript. The transcript is never stored or logged (logs carry lengths and counts).
* The model is configuration, not code: `-Model` on the setup script deploys a replacement next to the old deployment and
  repoints the app. Reasoning models (gpt-5 family) need the 16000 token cap and low effort setting included here, because their
  hidden thinking counts against the cap.
* New dependency: jszip (already present through exceljs), used to read .docx transcripts with a zip bomb guard.
