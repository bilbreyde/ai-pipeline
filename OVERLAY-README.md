# Request update overlay

Adds a "Request update" button to the opportunity drawer: it opens a draft email, addressed to the seller, in
the person's own mail client, with the account, stage, expected close and next step already filled in. Nothing
is sent automatically; the person reviews the draft and sends it themselves. The first time it is used for a
given seller it asks for their email once and remembers it in a small seller directory, shared across every
opportunity that seller owns.

This builds on the Import and Export, Themes and Dashboard, and Transcripts overlays, so those must already be
applied. It needs no new Azure resource, no new app setting, and no change to `infra/` or `scripts/deploy.ps1`.

## Task for Claude Code (run from the repo root, C:\Users\DBilbrey\Azure\ai-pipeline)

1. Read CLAUDE.md in the repo first and follow its hard rules.
2. Copy every file in this overlay into the repo at the same relative path, overwriting the existing file.
   Before overwriting each existing file, compare it with the local copy. If the local copy has changes that
   are not part of this feature (someone edited it), stop and show me the diff instead of overwriting.
   Do not restyle, reformat or refactor anything. Do not touch infra/ or scripts/deploy.ps1.
3. Run `npm test`. Expect 110 tests, all passing. If anything fails, fix the cause in the code you were given,
   not by weakening a test.
4. Run `npm run dev`, open http://localhost:7071 and confirm:
   * Open any opportunity that has a Seller set. The drawer footer now has a "Request update" button between
     Cancel and Delete.
   * Click it. The first time, a small dialog asks for that seller's email. Type something that is not an
     email address and confirm the dialog explains the problem inline rather than closing. Then type a real
     looking address and click "Save and open email": your browser or OS should offer to open it with a mail
     app, addressed to that email, with a subject naming the account and a body asking for a status update.
   * Open a different opportunity with the same seller name (case does not have to match) and click
     "Request update" again: it should go straight to the mail draft, no prompt.
   * Open an opportunity whose Seller field is blank and click "Request update": expect a toast saying to set
     a seller first, not a prompt.
   * Open "Add opportunity" (a brand new, unsaved row): the button should not be there at all.
5. Deploy code only: `./scripts/deploy.ps1 -TenantId 573e37c4-c2a8-4397-a860-6979128f5ac3 -SubscriptionId 7d70637f-bd34-4728-b41e-5a5c9f652d5d -SkipInfra`,
   confirm the health check passes, then hard refresh (Ctrl+F5) the site once.
6. On the deployed site, repeat the walkthrough in step 4 for one real opportunity, using your own email address
   as the "seller" address so you can confirm the draft looks right without mailing anyone else.
7. Report which files changed, the test result and the deploy result. Do not commit or push unless asked.

## What the feature does, so you can review it

* `GET /api/sellers` returns the saved directory as `{ sellers: { "<name>": "<email>" } }`. `POST /api/sellers`
  with `{ name, email }` validates and saves one entry (case insensitive by name: saving "avery" then "Avery"
  updates the same entry, it does not create a second one). Both routes are open the same way opportunity
  reads and edits are in this MVP (no sign in yet); they do not move the whole data set, so they are not gated
  like import, export and transcripts are.
* Storage is one small Cosmos document, `type: "sellers"`, the same singleton pattern this app already uses
  for Settings. No new container, no new partition, no new role assignment.
* The button itself, and the mailto link it builds, are entirely client side (`web/app.js`). The server never
  sends an email and never sees the drafted message; it only ever stores an address someone typed in.
* Nothing about the opportunity itself changes. This does not touch `activity` (meeting history) or any
  `OPP_FIELDS`, so it cannot be confused with an edit, and it does not require a save.
