# Username and password sign in — overlay

Adds real sign in to the tracker: individual accounts, not a shared password. There is no Entra ID
here (this is a dev tenant with no app registration available), so this is username and password,
hashed with Node's built in `scrypt`, sessions as opaque tokens in Cosmos. There is no admin role
and no user management screen in the app on purpose — accounts are created, reset and revoked with
`scripts/manage-users.mjs`, run from your own machine against Cosmos with your own `az login`, the
same trust boundary `scripts/seed-sample.mjs` already uses.

As a necessary consequence, every `/api/*` route except `health` and `me` now refuses an
anonymous caller (`403 Sign in to see or change pipeline data.`) unless `ALLOW_ANONYMOUS_BULK=true`
is set. Previously only import, export and transcript analysis were gated; everything else relied
on Azure's platform level sign in redirect, which does not exist in this tenant. This overlay closes
that gap at the application level.

## Apply

From the root of your `zones-ai-pipeline` checkout, with Claude Code:

```
Apply this overlay: copy every file under this zip into the matching path in the project,
overwriting what is there. Then run npm test and confirm all tests pass.
```

Or by hand: copy each file in this zip to the same relative path in the project, overwriting
the existing one. New files: `src/lib/auth.js`, `scripts/manage-users.mjs`, `test/auth.test.mjs`.
Everything else replaces a file that is already there.

## Verify

```powershell
npm test              # 135 tests, was 112 before this overlay
npm run dev            # http://localhost:7071, data is open by default (no sign in needed)
```

To see the real sign in screen locally, without Cosmos:

```powershell
$env:ALLOW_ANONYMOUS_BULK="false"
$env:DEV_LOGIN_USER="don"
$env:DEV_LOGIN_PASSWORD="a password at least 12 characters"
npm run dev
```

Then open http://localhost:7071 — you should land on a Sign in screen, not the tracker. Sign in
with the account above and you should see the tracker, a "Connected as don" indicator, and
Change password / Sign out controls next to it.

## Do this right after you deploy it — do not skip

`ALLOW_ANONYMOUS_BULK` is off by default on the deployed app (as it always has been), and this
overlay now gates *everything*, not just import and export. That means the moment this deploys,
sign in is required and **nobody has an account yet**. Run this as the very last step of the
deploy, before you send the URL to anyone:

```powershell
./scripts/deploy.ps1 -TenantId <tid> -SubscriptionId <sid> -SkipInfra
npm run users create <your-username>
```

It prints a generated password once. Write it down, sign in with it, then use Change password in
the app to set one only you know. From then on, `npm run users create <name>` makes an account for
anyone else who needs one. See the README's new "Sign in" section for the rest of the commands
(`reset-password`, `unlock`, `revoke`, `list`).

## What changed, file by file

| File | What changed |
| --- | --- |
| `src/lib/auth.js` | New. Password hashing, session tokens, lockout, cookie helpers. |
| `src/lib/store-memory.js`, `src/lib/store-cosmos.js` | Added `user` and `session` document types and their get/put/delete/list methods. |
| `src/lib/handlers.js` | `resolveActor` now checks the session cookie first, the Entra header second. New `login`/`logout`/`change-password` routes. A blanket sign in gate in `handleApi` now protects every pipeline data route, not just bulk import/export. |
| `src/functions/router.js` | Comment update only, explaining the new gate lives in `handlers.js`, not at the platform layer. No behavior change. |
| `dev/server.mjs` | `secureCookies: false` for local http. New optional `DEV_LOGIN_USER`/`DEV_LOGIN_PASSWORD` to seed a real test account. |
| `scripts/manage-users.mjs` | New. Account lifecycle: `create`, `reset-password`, `unlock`, `revoke`, `list`. |
| `scripts/import-from-excel.mjs` | Comment update only (the old one said "the MVP has no sign in," which stopped being true). |
| `package.json` | New `npm run users` script. |
| `web/index.html`, `web/app.js`, `web/app.css` | Sign in gate, Change password dialog, Sign out, a "Sign in" button and user pill in the top bar. |
| `test/api.test.mjs`, `test/sellers-api.test.mjs` | `setup()` now passes `allowAnonymousBulk: true` so existing CRUD tests are unaffected by the new gate; one test explicitly turns it off to check the signed out `/api/me` response. |
| `test/auth.test.mjs` | New. 23 tests: hashing, sessions, lockout, cookies, the sign in gate itself, and the full login/logout/change password/revoke flow through the HTTP handler. |
| `README.md`, `CLAUDE.md` | New "Sign in" section, updated "Before real customer data," updated hard rules and architecture notes. |

## Verified before packaging

* `npm test`: 135/135 pass (112 before this overlay, +23 new).
* Browser regression, signed out and gated (`ALLOW_ANONYMOUS_BULK=false`): sign in gate on load,
  wrong password and unknown username give the identical generic error, correct login clears the
  gate and loads data, session survives a reload, change password (wrong current password, mismatched
  confirmation, too short, and a real change) all work, sign out brings the gate back, the old
  password stops working and the new one signs in, 5 wrong attempts lock the account so even the
  correct password is refused, no horizontal overflow at 390px, no console or CSP errors. 22/22 checks.
* Browser regression, default local dev (`ALLOW_ANONYMOUS_BULK` unset, i.e. open): dashboard, seller
  email prompt, and transcript flows all still pass unchanged: 25/25, 17/17, 31/31.
