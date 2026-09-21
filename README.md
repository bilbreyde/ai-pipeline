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
| `src/lib/handlers.js` | All routing and rules. Framework free, so tests and the dev server run the same code as Azure. |
| `src/functions/router.js` | The thin Azure Functions adapter. |
| `src/lib/store-cosmos.js` | Cosmos access with Entra ID only. |
| `infra/main.bicep` | Function App, Cosmos, storage, monitoring, role assignments. |
| `scripts/deploy.ps1` | Tenant guarded deploy. |
| `scripts/seed-sample.mjs` | Loads fictional demo rows. |
| `src/lib/xlsx.js` | Spreadsheet export, and the import parser, planner and writer. Used by the page and the script. |
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
