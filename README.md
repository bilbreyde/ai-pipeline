# AI Practice Pipeline

A shared tracker for the Zones and Thoughtworks AI practice pipeline. Opportunities, stages, deal size, estimated margin, data gap flags, and a plain warning when one deal dominates the total. It replaces the Excel tracker and the Power BI attempt with something people edit directly.

**Status: beta. Username and password sign in. Fictional sample data only.**

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
| `src/lib/auth.js` | Username and password sign in: hashing, sessions, lockout, cookies. See Sign in below. |
| `infra/main.bicep` | Function App, Cosmos, storage, monitoring, role assignments. |
| `scripts/deploy.ps1` | Tenant guarded deploy. |
| `scripts/seed-sample.mjs` | Loads fictional demo rows. |
| `scripts/manage-users.mjs` | Create, reset, unlock and revoke accounts. See Sign in below. |
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

`DEV_USER=you@example.com npm run dev` simulates a signed in user (the Entra header) so you can see the audit fields, without going through the sign in screen.

`DEV_LOGIN_USER=don DEV_LOGIN_PASSWORD=something-long-enough npm run dev` instead creates a real account in the in memory store, so you can try the actual sign in screen, lockout, and change password, with no Cosmos needed. `npm run dev` on its own leaves pipeline data open (`ALLOW_ANONYMOUS_BULK` defaults on locally), so you do not have to sign in at all just to look at the tracker; add `ALLOW_ANONYMOUS_BULK=false` to see the sign in gate the deployed app shows by default.

## Deploy

You need PowerShell 7, Azure CLI, Node 24, and permission to create resources and role assignments in the target subscription. Core Tools (`func`) is optional.

```powershell
./scripts/deploy.ps1 -TenantId <tenant-guid> -SubscriptionId <subscription-guid>
npm run seed:sample
```

The script will not use whatever `az` happens to be logged into. It switches to the tenant and subscription you pass, prints what it resolved, and makes you type the subscription name before it changes anything. It ends with a health check that expects `store: cosmos`. Rerun with `-SkipInfra` to redeploy code only.

The Cosmos data role for you personally is assigned during deploy and can take a few minutes to propagate. A 403 from `seed:sample` right after deploy means wait and rerun.

## Sign in

This is a dev tenant with no app registration available, so there is no Entra ID sign in here, only a real username and password per person. The app enforces it itself: every `/api/*` route except `health` and `me` refuses an anonymous request (`403 Sign in to see or change pipeline data.`), so once this is deployed nobody can read or change data without an account, with no App Service Authentication needed in front of it.

There is deliberately no admin role and no user management screen in the app. Accounts are created, reset, and revoked with `scripts/manage-users.mjs`, run from your own machine against Cosmos with your own `az login` session, the same trust boundary `scripts/seed-sample.mjs` already uses: whoever can reach Cosmos controls who can sign in.

```powershell
node scripts/manage-users.mjs create don               # prints a generated password, shown once
node scripts/manage-users.mjs reset-password don        # forgot it, or handing the account to someone new; also signs out its open sessions
node scripts/manage-users.mjs unlock don                 # clears a lockout early, instead of waiting 15 minutes
node scripts/manage-users.mjs revoke don --confirm       # deletes the account; any open session for it stops working on its next request
node scripts/manage-users.mjs list                       # who has an account, and who is currently locked out
```

**Create the first account right after you deploy.** `ALLOW_ANONYMOUS_BULK` is off by default, so a fresh deployment has sign in required and, until you run `create`, nobody, including you, can sign in. Run `npm run users create <you>` (an alias for the command above) as the last step of standing this up, before sending the URL to anyone.

In the browser: Sign in top right, or a full sign in screen if the whole app requires it. Once signed in you get Change password and Sign out next to it. Changing your password signs out every other session for your account; the one you changed it from stays signed in. A locked out account (5 wrong passwords in a row) gives the same generic "Invalid username or password" as a wrong password, for 15 minutes, so a login attempt never reveals whether an account exists.

Under the hood: passwords are hashed with Node's built in `scrypt`, never logged or stored in the clear. A session is an opaque random token, not a signed one, stored in Cosmos and looked up on every request, which is what makes `revoke` an immediate, real revocation instead of a rotate-the-signing-key exercise. The session cookie is `HttpOnly`, `SameSite=Strict`, `Secure` everywhere except plain http local dev, and lasts 24 hours from sign in.

If this ever moves to a tenant where an Entra app registration is possible, turn on App Service Authentication with sign in required for every request, then pass `trustPrincipalHeader: true` to `createHandlers` in `src/functions/router.js`. Never set it before that: without Authentication in front, anyone can send the `x-ms-client-principal-name` header themselves, so the app accepts only its own session cookie by default.

## Themes and Dashboard

The Theme menu (top right) has System, Light, Dark, Warm low glare and High contrast. The choice is saved in the browser only. Every theme uses the same colourblind safe chart palette (blue and orange, checked for the common colour vision types). High contrast adds hatch texture to two colour charts, and printing forces the light theme with texture on and hides the controls.

The Dashboard tab sits next to Pipeline (`#dashboard` in the URL is linkable). One row of controls scopes every chart: the measure (estimated margin or deal size), lead, and segment. Charts cover margin by stage and by seller, the expected close timeline, Zones versus Thoughtworks, the largest open deals, and data quality. Every chart has a Table view button that swaps the graphic for the same numbers as a table.

Read the numbers with two caveats. Open deals with no size are counted in deal counts but cannot add to any dollar figure, and the cards say how many were left out. There is also no trend over time, because the app stores the current state only. Trends need weekly snapshots, which is a separate piece of work.

## Staleness flags

In the Pipeline table, the Updated column flags an open opportunity nobody has touched in a while, in three steps: light yellow at 7 days, red at 14, and flashing red at 21 and over. This is a nudge to check in on a deal that has gone quiet, not a data quality flag, so it never counts toward Rows with gaps or the gap tags on a row (No size, No seller, No next step). It also never applies to Won or Lost deals; a closed deal isn't going anywhere. Hover the date for the exact day count. The flashing on the 21+ tier respects your OS's reduced motion setting, and shows a steady outline instead.

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

Open an opportunity and click **Request update**. If the seller has an email on file, a draft opens in your own mail client, addressed to them, with a summary of everything the tracker has on that deal: account, opportunity number (if set), stage, deal size, expected close, next step, and segment or lead if set. Any of deal size, expected close or next step that is blank is shown as "Not on file", and the opening line asks the seller to fill those in, so a stale or missing field gets fixed instead of quietly staying wrong. When nothing is missing, it just asks them to confirm the summary. At Account planning no size or close date is expected, so those two appear only if set and are never chased. You review the draft and send it yourself, from your own mailbox. Nothing here sends mail automatically and nothing is queued: the button only builds a `mailto:` link.

The first time you use it for a given seller, you are asked for their email once. It is saved to a small seller directory (name to email), not copied onto every opportunity row, so the next request for that seller, on any deal, needs no prompt. The Seller field itself stays free text; the match against the directory ignores case, so "Avery" and "avery" are the same seller.

This needs nothing new in Azure: no email service, no secrets, no new role assignment. The address is stored the same way Settings is, in one small Cosmos document, and everything else happens in the browser.

## Import and export

The page has Export and Import buttons. Both are turned off until a user is signed in, because each moves the whole data set in one request. They work locally (`npm run dev`) without signing in because the dev server defaults to open, fictional data only (see Sign in above).

**Export** downloads `ai-pipeline-YYYY-MM-DD.xlsx` with two sheets. `Pipeline` has one row per opportunity, including an **Opportunity #** column for the reference number your CRM or quoting tool uses for the deal (free text, optional, so this tracker and that system can be cross referenced), dropdowns on Stage, Lead and Thoughtworks, and a live formula for Est. margin. `Assumptions` holds the margin basis and default GM those formulas read, plus open pipeline totals. Changing Assumptions in Excel changes that workbook only. The app does not read them back.

**Import** takes an .xlsx and shows a preview (new, updated, unchanged, skipped, with a reason for every skipped row) before anything is saved. It never deletes a row. It reads two layouts:

* **An export from this page.** Rows are matched by the Id column, or by account plus opportunity if Id is blank. Matched rows are updated, and a blank cell clears that field. Rows with no match are added. Edit in Excel, add rows, re-import.
* **The original AI Practice Progress Sheet** (an `Accounts` tab). Status text is mapped to stages by wording, `(100)` is read as $100K and flagged. This layout only adds new accounts. Anything already in the tracker is left alone, so re-running it cannot revert edits your team made in the app.

Limits: 1,000 rows and 4 MB per file, .xlsx only (no .xls or CSV). Sign in and both buttons work; see Sign in above for creating an account. To test them on the deployed beta without creating an account yet, fictional data only:

```powershell
# Confirm you are in the right tenant and subscription first: az account show
az functionapp config appsettings set -g rg-zones-ai-pipeline -n <FUNCTION_APP_NAME from .env.deploy> --settings ALLOW_ANONYMOUS_BULK=true
# When done testing, remove it:
az functionapp config appsettings delete -g rg-zones-ai-pipeline -n <FUNCTION_APP_NAME> --setting-names ALLOW_ANONYMOUS_BULK
```

## Margin, so nobody is surprised

Estimated margin = deal size × GM%, where GM% is a default (30%) with an optional override per row. The Assumptions panel can switch to a cost basis (size ÷ (1 − GM) − size) if deal size is really your cost. The old workbook mixed both, which is why its total was inflated. This tracker does not forecast or weight margin by win probability. That is a sales function, not something this tool computes.

Resale heavy deals (hardware, licences) do not carry consulting margins. Set a real GM% on those rows, or the total is fiction. The page warns when one deal is over a third of the margin.

**Account planning** is the earliest stage, before Identified. It tracks an account you plan to approach about AI, before there is a real opportunity. No size or margin is expected there, so a blank size on an Account planning row is not flagged as a data gap the way it would be at every later stage. It still counts as an open deal, and it still shows up in the Dashboard's by stage chart, in gray alongside Blocked, since neither has a place in the "darker means later in the sales process" order.

## Before real customer data

Sign in is already required by default (see Sign in above), so this is shorter than it used to be. Do these in order, then import:

1. Make sure `ALLOW_ANONYMOUS_BULK` is not set on the Function App (it should never have been set there; it is a local testing escape hatch only). Confirm with `az functionapp config appsettings list`.
2. Create a real account for everyone who should have access, with `scripts/manage-users.mjs create`, and only for them. Revoke anything you created for testing (`revoke --confirm`) or reset its password before real data goes in.
3. If this ever moves to a tenant where an Entra app registration is possible, App Service Authentication can be turned on in front of the Function App with no code change (see Sign in above); until then, the username and password accounts above are the access control.
4. Consider Cosmos private endpoint plus VNet integration on the Function App, then set Cosmos public network access to disabled.
5. Import the workbook, from the page (Import button) or the script. It stays outside the repo. The page shows a preview first. The script does a dry run first and prints counts only:

```powershell
node scripts/import-from-excel.mjs "C:\path\to\AI Practice Progress Sheet.xlsx"
node scripts/import-from-excel.mjs "C:\path\to\AI Practice Progress Sheet.xlsx" --apply --confirm-secured
```

The importer maps the old free text Status to fixed stages by wording, not by account name, so the code holds no customer data. It reads a size like `(100)` as thousands and tells you when it did, so check those rows. Uploaded workbooks are parsed in memory on the server and are not stored anywhere.

## Things worth knowing

* Flex Consumption scales to zero. The first request after idle can take several seconds. If that bothers people, set an always ready instance on the Function App.
* Two people editing different fields of one row do not overwrite each other. Edits merge using Cosmos etags. The page refreshes itself every 20 seconds and when the tab regains focus.
* Deleting a row is permanent. If that needs an undo, add soft delete before adding many users.
