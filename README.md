# AI Practice Pipeline

A shared tracker for the Zones and Thoughtworks AI practice pipeline. Opportunities, stages, deal size, estimated and weighted margin, data gap flags, and a plain warning when one deal dominates the total. It replaces the Excel tracker and the Power BI attempt with something people edit directly.

**Status: beta. No sign in yet. Fictional sample data only.**

## Architecture

```
Browser ──► Function App (Flex Consumption, Node 24, managed identity)
              serves  /          the page (web/)
              serves  /api/*     the REST API (src/)
                          │
                          ▼  Entra ID token, no keys
                    Cosmos DB (serverless, key auth disabled)
```

Everything lives in one resource group in your tenant. Customer data never leaves it. There are no connection strings, keys or secrets anywhere: the Function App's managed identity holds a Cosmos data role, and Cosmos has local (key) authentication turned off, so a leaked string would be worthless because none exists.

The page and the API are decoupled (the page only calls relative `/api/...` URLs), so moving to Static Web Apps in front of a linked Function App later needs no code changes.

## Layout

| Path | What it is |
| --- | --- |
| `web/` | The UI. Plain HTML, CSS and JS, no build step, no third party requests (strict CSP). |
| `web/dash-calc.js` | Margin and rollup math for the whole page. One source of truth, shared by the table and the Dashboard, tested in Node. |
| `web/dash.js` | The Dashboard tab. Hand built SVG charts, no chart library. |
| `web/theme.js` | Applies the saved colour theme before first paint, so there is no flash. |
| `src/lib/handlers.js` | All routing and rules. Framework free, so tests and the dev server run the same code as Azure. |
| `src/functions/router.js` | The thin Azure Functions adapter. |
| `src/lib/store-cosmos.js` | Cosmos access with Entra ID only. |
| `src/lib/validate.js` | Field rules for opportunities, settings and the seller directory. |
| `infra/main.bicep` | Function App, Cosmos, storage, monitoring, role assignments. |
| `scripts/deploy.ps1` | Tenant guarded deploy. |
| `scripts/seed-sample.mjs` | Loads fictional demo rows. |
| `src/lib/xlsx.js` | Spreadsheet export, and the import parser, planner and writer. Used by the page and the script. |
| `src/lib/transcript.js` | Reads pasted text, .txt, .vtt, .srt and .docx into plain text. |
| `src/lib/transcript-analysis.js` | The prompt, the answer schema, and the checks that turn a model answer into a reviewable proposal. |
| `src/lib/ai.js` | Microsoft Foundry client. Entra ID only, no API key. |
| `web/transcript-ui.js` | The From transcript dialog. |
| `dev/mock-ai.mjs` | Stand in model for `npm run dev` and tests, so the flow works without Azure. |
| `scripts/setup-foundry.ps1` | Creates the Foundry resource and model deployment and wires the Function App to it. |
| `scripts/import-from-excel.mjs` | Command line import of a workbook. Gated, see below. |

## Run it locally (no Azure needed)

```powershell
npm ci
npm test
npm run dev          # http://localhost:7071, in memory, fictional data
```

`DEV_USER=you@example.com npm run dev` simulates a signed in user so you can see the audit fields.

## Deploy

You need PowerShell 7, Azure CLI, Node 24, and permission to create resources and role assignments in the target subscription. Core Tools (`func`) is optional.

```powershell
./scripts/deploy.ps1 -TenantId <tenant-guid> -SubscriptionId <subscription-guid>
npm run seed:sample
```

The script will not use whatever `az` happens to be logged into. It switches to the tenant and subscription you pass, prints what it resolved, and makes you type the subscription name before it changes anything. It ends with a health check that expects `store: cosmos`. Rerun with `-SkipInfra` to redeploy code only.

The Cosmos data role for you personally is assigned during deploy and can take a few minutes to propagate. A 403 from `seed:sample` right after deploy means wait and rerun.

## Themes and Dashboard

The Theme menu (top right) has System, Light, Dark, Warm low glare and High contrast. The choice is saved in the browser only. Every theme uses the same colourblind safe chart palette (blue and orange, checked for the common colour vision types). High contrast adds hatch texture to two colour charts, and printing forces the light theme with texture on and hides the controls.

The Dashboard tab sits next to Pipeline (`#dashboard` in the URL is linkable). One row of controls scopes every chart: the measure (estimated margin, weighted margin or deal size), lead, and segment. Charts cover margin by stage and by seller, the expected close timeline, Zones versus Thoughtworks, the largest open deals, and data quality. Every chart has a Table view button that swaps the graphic for the same numbers as a table.

Read the numbers with two caveats. Open deals with no size are counted in deal counts but cannot add to any dollar figure, and the cards say how many were left out. There is also no trend over time, because the app stores the current state only. Trends need weekly snapshots, which is a separate piece of work.

## Transcripts

The **From transcript** button takes meeting notes or a Teams transcript and turns them into a reviewable proposal. Paste text, choose a file (`.txt`, `.vtt`, `.srt`, `.docx`), or drop a file anywhere on the page. Two modes:

* **An existing opportunity.** Pick the row, or leave it on "Detect it from the transcript" and the model chooses from your list, which you then confirm. It proposes changes to stage, deal size, GM%, expected close, next step, seller, lead, segment and Thoughtworks involvement, and a meeting summary with decisions, action items and risks.
* **A new opportunity.** It proposes an account and every field the transcript supports. If the account looks like one you already track, the dialog warns you and offers to update that row instead.

Nothing is saved until you press Save on the review step. Every proposed change is a checkbox with an editable value and the exact quote from the transcript that supports it. The server checks each quote against the transcript. A quote that is not really there is flagged in amber and left unticked. Stage changes to Won or Lost are labelled "Closes the deal". The meeting summary is editable and is saved to that opportunity's **Meeting history**, which shows in the row's edit panel and never touches the free text Notes field. Each opportunity keeps its newest 25 meetings.

What is and is not kept: the transcript itself is analysed in memory and is not stored by this app. Only the fields you ticked and the summary you approved are saved. If someone else changes the row while you are reviewing, Save is refused with a message and you re-run the analysis, so you never overwrite something you have not seen.

### Set up Foundry once

```powershell
# Prints every az command and changes nothing. Read it first.
./scripts/setup-foundry.ps1 -TenantId <tid> -SubscriptionId <sid> -DryRun
./scripts/setup-foundry.ps1 -TenantId <tid> -SubscriptionId <sid>
```

The script is standalone (it does not touch `infra/` or `deploy.ps1`). It creates a Foundry resource with a custom subdomain, deploys `gpt-5.4-mini` (the newest version your region offers) using the first deployment SKU your region offers from DataZoneStandard, Standard, GlobalStandard, turns off API key access, gives the Function App's managed identity **Cognitive Services OpenAI User** (and you, for local testing), and sets `FOUNDRY_ENDPOINT`, `FOUNDRY_DEPLOYMENT` and, for gpt-5 and o-series models, `FOUNDRY_REASONING_EFFORT=low` on the Function App. Then deploy the code with `deploy.ps1 -SkipInfra`. Until Foundry is set up the button explains that instead of failing.

To try it against the real model from your machine, the script prints the exact `$env:` lines. Without them `npm run dev` uses a demo matcher and the page says so on every step. `AI=off npm run dev` shows the not set up state.

### Swapping the model (models retire every 12 to 18 months)

The model is not baked into the code. It is two things: which deployment `FOUNDRY_DEPLOYMENT` points at, and a few request settings. To move to a newer model, rerun the script with `-Model`. It deploys the new model next to the old one, points the app at it, and prints the command to delete the old deployment once you are satisfied. Nothing is renamed and there is no downtime.

```powershell
./scripts/setup-foundry.ps1 -TenantId <tid> -SubscriptionId <sid> -Model gpt-5.5 -DryRun
```

Deployments are named after the model (`transcripts-gpt-5-4-mini`), so the name never lies about what is behind it. See what your subscription can deploy with `az cognitiveservices model list -l eastus2`. Prefer a small, fast model: this job is extracting fields from text, not reasoning through a hard problem, so a bigger model mostly adds cost and seconds. Reasoning models (gpt-5 family, o-series) count their hidden thinking against the output token cap, which is why the client asks for 16000 and the script sets low effort.

### Before you point real transcripts at it

* **Sign in first.** Like import and export, transcript analysis is refused unless a user is signed in, because it sends customer conversations to a model and costs money per call. `ALLOW_ANONYMOUS_BULK=true` lifts that for testing with fictional transcripts only.
* **Data handling is a Zones decision, not a code one.** The model runs in your tenant and the app uses Entra ID only. Deployment type still matters: GlobalStandard can process prompts in any Azure region, DataZoneStandard stays inside the US or EU data zone, Standard stays in the resource's region. Microsoft's default abuse monitoring can also retain prompts for a limited time unless your organisation has been approved for modified abuse monitoring. Confirm both against current Microsoft documentation and your customer contracts before real transcripts go in.
* **Transcripts are untrusted text.** Someone can say "ignore your instructions" in a meeting. The model has no tools and returns schema constrained JSON, every value is re-validated by the same rules as a manual edit, and nothing saves without your review. The residual risk is a bad proposal that you tick without reading, which is why quotes are shown next to every change.
* **Limits.** 200,000 characters of text, 4 MB per file, one analysis takes roughly 10 to 40 seconds.

## Request update from the seller

Open an opportunity and click **Request update**. If the seller has an email on file, a draft opens in your own mail client, addressed to them, with the account, stage, expected close and next step already filled in. You review it and send it yourself, from your own mailbox. Nothing here sends mail automatically and nothing is queued: the button only builds a `mailto:` link.

The first time you use it for a given seller, you are asked for their email once. It is saved to a small seller directory (name to email), not copied onto every opportunity row, so the next request for that seller, on any deal, needs no prompt. The Seller field itself stays free text; the match against the directory ignores case, so "Avery" and "avery" are the same seller.

This needs nothing new in Azure: no email service, no secrets, no new role assignment. The address is stored the same way Settings is, in one small Cosmos document, and everything else happens in the browser.

## Import and export

The page has Export and Import buttons. Both are turned off until a user is signed in, because each moves the whole data set in one request and the beta has no sign in. They work locally (`npm run dev`) because the dev server has fictional data only.

**Export** downloads `ai-pipeline-YYYY-MM-DD.xlsx` with two sheets. `Pipeline` has one row per opportunity, dropdowns on Stage, Lead and Thoughtworks, and live formulas for Est. margin and Weighted margin. `Assumptions` holds the margin basis, default GM and stage probabilities those formulas read, plus open pipeline totals. Changing Assumptions in Excel changes that workbook only. The app does not read them back.

**Import** takes an .xlsx and shows a preview (new, updated, unchanged, skipped, with a reason for every skipped row) before anything is saved. It never deletes a row. It reads two layouts:

* **An export from this page.** Rows are matched by the Id column, or by account plus opportunity if Id is blank. Matched rows are updated, and a blank cell clears that field. Rows with no match are added. Edit in Excel, add rows, re-import.
* **The original AI Practice Progress Sheet** (an `Accounts` tab). Status text is mapped to stages by wording, `(100)` is read as $100K and flagged. This layout only adds new accounts. Anything already in the tracker is left alone, so re-running it cannot revert edits your team made in the app.

Limits: 1,000 rows and 4 MB per file, .xlsx only (no .xls or CSV). Test the buttons on the deployed beta with fictional data only:

```powershell
# Confirm you are in the right tenant and subscription first: az account show
az functionapp config appsettings set -g rg-zones-ai-pipeline -n <FUNCTION_APP_NAME from .env.deploy> --settings ALLOW_ANONYMOUS_BULK=true
# When done testing, remove it:
az functionapp config appsettings delete -g rg-zones-ai-pipeline -n <FUNCTION_APP_NAME> --setting-names ALLOW_ANONYMOUS_BULK
```

Once sign in is on, no setting is needed. Anyone who is signed in can import and export.

## Margin, so nobody is surprised

Estimated margin = deal size × GM%, where GM% is a default (30%) with an optional override per row. The Assumptions panel can switch to a cost basis (size ÷ (1 − GM) − size) if deal size is really your cost. The old workbook mixed both, which is why its total was inflated. Weighted margin multiplies by a per stage win probability. The starting probabilities are guesses. Replace them with your real close rates.

Resale heavy deals (hardware, licences) do not carry consulting margins. Set a real GM% on those rows, or the total is fiction. The page warns when one deal is over a third of the margin.

## Before real customer data

The beta has no sign in. Anyone with the URL can read and edit. Do these in order, then import:

1. Turn on App Service Authentication on the Function App with the Microsoft provider, single tenant (issuer `https://login.microsoftonline.com/<tenant-id>/v2.0`), unauthenticated requests redirected to login. No code change is needed. The API already records the signed in user from the `x-ms-client-principal-name` header.
2. In Entra, open the app's enterprise application, set **Assignment required** to Yes, and assign a security group. Without this, every user in the tenant can sign in.
3. Consider Cosmos private endpoint plus VNet integration on the Function App, then set Cosmos public network access to disabled.
4. Import the workbook, from the page (Import button) or the script. It stays outside the repo. The page shows a preview first. The script does a dry run first and prints counts only:

```powershell
node scripts/import-from-excel.mjs "C:\path\to\AI Practice Progress Sheet.xlsx"
node scripts/import-from-excel.mjs "C:\path\to\AI Practice Progress Sheet.xlsx" --apply --confirm-secured
```

The importer maps the old free text Status to fixed stages by wording, not by account name, so the code holds no customer data. It reads a size like `(100)` as thousands and tells you when it did, so check those rows. Uploaded workbooks are parsed in memory on the server and are not stored anywhere.

## Things worth knowing

* Flex Consumption scales to zero. The first request after idle can take several seconds. If that bothers people, set an always ready instance on the Function App.
* Two people editing different fields of one row do not overwrite each other. Edits merge using Cosmos etags. The page refreshes itself every 20 seconds and when the tab regains focus.
* Deleting a row is permanent. If that needs an undo, add soft delete before adding many users.
