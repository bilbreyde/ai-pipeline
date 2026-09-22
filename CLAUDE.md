# CLAUDE.md

Context for Claude Code working on this repo. Read this before changing anything or running az commands.

## What this is

AI Practice Pipeline tracker for Zones LLC. One Azure Function App (Flex Consumption, Node 24) serves a static UI from `web/` and a REST API under `/api`. Storage is Cosmos DB serverless with key auth disabled. The owner is Don Bilbrey, solutions architect, who works across multiple Azure tenants.

## Hard rules

1. **Customer data stays in the Zones tenant.** Never send it to any third party, never commit it. The real workbook lives outside the repo. `.gitignore` blocks xlsx, xls and csv. Fictional sample data only until sign in is enabled.
2. **No secrets.** Cosmos has `disableLocalAuth: true`. Do not turn key auth on, do not add connection strings or keys to app settings, code, or scripts. Auth is managed identity in Azure and `az login` locally, both through DefaultAzureCredential.
3. **Verify the tenant before every `az` command that changes something.** Run `az account show` and compare tenant and subscription to what the user gave you. `scripts/deploy.ps1` already enforces this. Do not bypass it.
4. **Node 24 or later.** Never Node 20. PowerShell on Windows is the shell.
5. No sign in yet by design (MVP). Do not import real data until the README "Before real customer data" steps are done and the user confirms.
6. Import and export are refused unless a user is signed in (`x-ms-client-principal-name` present). `ALLOW_ANONYMOUS_BULK=true` lifts that for testing with fictional data only. Never set it while real data is in Cosmos, and never make it the default.
7. Transcript analysis may call only the Microsoft Foundry resource inside the Zones tenant, with Entra ID (managed identity). Never add another model provider, an API key, or a call that sends transcript text anywhere else. The transcript itself is never stored or logged. Logs carry lengths and counts only.

## Commands

```powershell
npm ci
npm test                       # 102 tests, no Azure needed
npm run dev                    # local server, in memory, http://localhost:7071
./scripts/deploy.ps1 -TenantId <tid> -SubscriptionId <sid>
./scripts/deploy.ps1 -TenantId <tid> -SubscriptionId <sid> -SkipInfra   # code only
npm run seed:sample
```

## Architecture notes

* `src/lib/handlers.js` holds all routing, validation calls and security headers. `src/functions/router.js` is a thin adapter with one catch all route. `dev/server.mjs` and the tests call the same `handle()`.
* `host.json` sets `routePrefix` to an empty string so `/` serves the page and `/api/*` the API.
* Cosmos container `items`, partition key `/type` (`opp` or `settings`). Updates read, merge, then replace with an etag and retry on conflict.
* `src/lib/xlsx.js` owns spreadsheet export and import. `exceljs` is loaded with a dynamic `import()` inside its functions so ordinary page loads never pay for it. Import is parse, plan (read only), then apply, and apply re-parses the upload rather than trusting the preview. Updates go through `src/lib/mutate.js` (`mergeUpdate`), the same etag retry path as PATCH. Import never deletes.
* `web/dash-calc.js` is the single source of margin math (`marginOf`, `weightedOf`, `gapsOf`, rollups). `web/app.js` delegates to it, so the table and the Dashboard cannot disagree. It has no DOM access and is unit tested in Node through `vm`. Change math there, never in `app.js` or `dash.js`.
* `web/dash.js` builds charts as inline SVG with `createElementNS` and `textContent`. No chart library, no `innerHTML` with data. Marks are at most 24px thick with a 4px rounded data end and a 2px gap between stacked segments. Every card has a Table view twin, so a tooltip is never the only way to read a value.
* Themes are `data-theme` on `<html>` (light, dark, warm, contrast). No attribute means follow the OS. `web/theme.js` is a separate synchronous script in `<head>` (CSP forbids inline script) so the page never flashes the wrong theme. `test/theme-contrast.test.mjs` parses the real `app.css` and asserts WCAG ratios per theme, so a token edit that hurts readability fails `npm test`.
* Chart colours are tokens (`--c1`, `--c2`, `--cg`, `--o1` to `--o4`). Do not add a ninth categorical hue. Orange on the warm and high contrast surfaces is 2.89:1, which is relieved by direct labels and the Table view. Hatch texture is only on for High contrast and print.
* New static files must be added to `STATIC_FILES` in `src/lib/handlers.js`, otherwise they 404.
* Transcripts: `POST /api/transcript/analyze` reads the text (`src/lib/transcript.js`), calls the model (`src/lib/ai.js`) and returns a proposal that is never written. `POST /api/transcript/apply` re-validates what the person reviewed with `validateOpp`, exactly like a manual edit, and is the only route that can write the `activity` list (meeting history). `activity` is not in `OPP_FIELDS` on purpose, so PATCH and import cannot touch it. List responses carry `activityCount` and `lastActivityAt` only. Entries load from `GET /api/opps/:id/activity`. History keeps the newest 25 entries per opportunity.
* The model's answer is constrained by `ANALYSIS_SCHEMA` (strict mode, so every property is required and there are no extras) and then distrusted anyway: `interpretAnalysis` coerces and re-validates every value, drops the unusable ones with a notice, ignores an invented `oppId`, never renames an account in update mode, and marks any quote that is not verbatim in the transcript as `quoteFound: false`. Do not loosen these checks to make a model look better. `notes` is deliberately not in `AI_FIELDS`.
* Apply for an update sends `baseUpdatedAt`. `mergeUpdate` accepts a function patch so the stale check and the history append run against the freshly read row on every etag retry. A changed row returns 409.
* `dev/mock-ai.mjs` is a regex stand in for the model. `npm run dev` uses it unless `FOUNDRY_ENDPOINT` and `FOUNDRY_DEPLOYMENT` are set, and the page shows a demo banner (`/api/me` returns `aiDemo`). Tests inject fake models and a fake `fetch`, so nothing touches Azure.
* CSP is strict: scripts and styles from self only. Do not add CDN links or inline scripts. Fonts are system fonts on purpose.

## Not verified from the authoring environment (no az, no Bicep, no Azure access there)

The API, UI, importer mapping and tests were run for real against an in memory store. The Azure side was written from documentation and has never been deployed. On first deploy, expect to check these:

1. **Bicep compiles.** Run `az bicep build --file infra/main.bicep` first. Fix any API version or property complaints.
2. **Flex Consumption Node 24.** `runtime.version: '24'` must be accepted in your region. Check with `az functionapp list-flexconsumption-runtimes --location <region> --runtime node`. Confirm the region supports Flex Consumption at all.
3. **Root route.** Confirm `GET /` returns the page. The catch all route `{*rest}` is expected to match the empty path. If not, add a second function with route `""` that calls the same handler.
4. **Deployment with shared key access disabled** on the storage account. If `func azure functionapp publish` or the zip deploy fails on storage auth, check the Function App identity has Storage Blob Data Owner, and only then consider relaxing `allowSharedKeyAccess`.
5. **Role propagation.** Cosmos and storage role assignments can take minutes. A 403 or a health check that reports an error right after deploy is usually this. Wait and retry before debugging code.
6. **`@azure/cosmos` etag option.** `replace` uses `accessCondition: { type: "IfMatch", condition: etag }`. If the installed SDK version renamed it, conflict handling silently degrades to last writer wins. Confirm with a two tab edit test.

7. **Binary response through the Functions adapter.** `GET /api/export` returns a Buffer body. The SDK types accept `ArrayBufferView`, and tests cover the handler, but confirm a real download from the deployed app opens in Excel.
8. **exceljs on Flex Consumption.** First import or export after idle loads exceljs on demand, so expect a slower first call. Confirm a 500 row import finishes well inside the request timeout with real Cosmos latency.

9. **Foundry v1 chat completions.** `src/lib/ai.js` posts to `https://<resource>.openai.azure.com/openai/v1/chat/completions` with `model` set to the deployment name and `response_format: json_schema` in strict mode. That shape and the token audience come from Microsoft's documentation and were only exercised against a fake `fetch`. The client tries the `https://cognitiveservices.azure.com/.default` audience first and `https://ai.azure.com/.default` on a 401, and retries with `max_tokens` if a deployment rejects `max_completion_tokens`, and drops `reasoning_effort` if a deployment rejects it. On first use, confirm one real analysis returns a proposal, and check the app log for `Foundry error` lines if not. If the model you deploy does not support strict structured outputs, the request fails with a 400: choose a model that does.
10. **`scripts/setup-foundry.ps1`.** It parses with PowerShell 7 and its logic was run against a fake `az`, never against Azure. Run it with `-DryRun` first. The `az cognitiveservices model list` output shape (`model.name`, `model.version`, `model.skus[].name`) and `az resource update --set properties.disableLocalAuth=true` are from documentation.
11. **.docx zip bomb guard.** `src/lib/transcript.js` reads the declared uncompressed size from `entry._data.uncompressedSize`, an internal JSZip field, before unpacking. A test covers it. If a JSZip upgrade renames it, the guard fails closed (it refuses every .docx), so the test will catch it.
12. **App settings and infra deploys.** `FOUNDRY_ENDPOINT`, `FOUNDRY_DEPLOYMENT` and `FOUNDRY_REASONING_EFFORT` are set by the script, not by Bicep. A later infrastructure deploy may reset app settings, so add them to `infra/main.bicep` before you rely on `deploy.ps1` without `-SkipInfra`.
13. **Request time.** A long transcript can take 30 to 60 seconds. The model call has a 120 second timeout, under the 230 second limit on HTTP triggers, but confirm with a real two hour transcript.

14. **Reasoning models.** The default model (`gpt-5.4-mini`) is a reasoning model. Hidden reasoning tokens count against `max_completion_tokens`, so `src/lib/ai.js` and `transcript-analysis.js` ask for 16000, and `FOUNDRY_REASONING_EFFORT=low` (set by the script) is sent as `reasoning_effort`. The client drops `reasoning_effort` on a 400 that names it, which covers a non reasoning model and a level the model does not accept. Only a real run shows whether `low` gives enough quality and how long it takes. If a proposal misses fields, try `medium` before switching models. The model name, version and Data Zone SKU the script picked come from `az cognitiveservices model list`, so confirm them in the DryRun output rather than trusting the defaults in this file.
15. **Swapping models.** Rerun `scripts/setup-foundry.ps1 -Model <name>`. The default deployment name includes the model, so a new model gets a new deployment and the app is repointed. The script refuses to reuse a deployment name that runs a different model. It prints, and never runs, the delete command for the old deployment.

## When hardening (adding sign in)

Follow the README. The API reads the user from `x-ms-client-principal-name`, which App Service Authentication sets. If you later move to Static Web Apps with a linked Function App, the page and API paths do not change. Microsoft's docs do not confirm Flex Consumption as a linked backend, so test that link before committing to it.
