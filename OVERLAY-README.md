# Import and Export overlay

This folder holds ONLY the files that add spreadsheet Import and Export to the existing AI Practice Pipeline site.
It deliberately does not contain infra/, scripts/deploy.ps1, host.json, .env.deploy or anything else about how the
site is deployed, so none of your local deployment fixes are touched.

## Task for Claude Code (run from the repo root, C:\Users\DBilbrey\Azure\ai-pipeline)

1. Read CLAUDE.md in the repo first and follow its hard rules. Verify the Azure tenant and subscription with
   `az account show` before any `az` command that changes something.
2. Copy every file in this overlay into the repo at the same relative path, overwriting the existing file.
   Before overwriting each existing file, compare it with the local copy. If the local copy has changes that are
   not part of this feature (someone edited it), stop and show me the diff instead of overwriting.
   Do not restyle, reformat or refactor anything. Do not touch infra/ or scripts/deploy.ps1.
3. Delete scripts/import-mapping.mjs. It moved to src/lib/import-mapping.js and the old copy is unused.
4. Run `npm ci`, then `npm test`. Expect 34 tests, all passing. If anything fails, fix the cause in the code
   you were given, not by weakening a test.
5. Run `npm run dev`, open http://localhost:7071, and confirm the Import and Export buttons work: Export
   downloads an .xlsx, Import shows a preview before saving.
6. Deploy code only: `./scripts/deploy.ps1 -TenantId 573e37c4-c2a8-4397-a860-6979128f5ac3 -SubscriptionId 7d70637f-bd34-4728-b41e-5a5c9f652d5d -SkipInfra`
   in PowerShell 7 (pwsh). Confirm the health check passes.
7. Report which files changed, the test result, and the deploy result. Do not commit or push unless asked.

## What the feature does, so you can review it

* GET /api/export returns an .xlsx. POST /api/import/preview and POST /api/import/apply take {data: base64 xlsx}.
* Import and export are refused (403) unless a user is signed in (x-ms-client-principal-name header). The Function
  App setting ALLOW_ANONYMOUS_BULK=true lifts that, for testing with fictional data only. Real customer data must not
  be imported until sign in is enabled.
* Import never deletes. Preview writes nothing. Apply re-parses the upload and writes through the same etag retry
  path as PATCH (src/lib/mutate.js).
* Two layouts are read: an export from this app (updates rows by Id) and the original AI Practice Progress Sheet
  (adds new accounts only, leaves existing rows alone).
* exceljs moved from devDependencies to dependencies. It is loaded on demand inside src/lib/xlsx.js.
