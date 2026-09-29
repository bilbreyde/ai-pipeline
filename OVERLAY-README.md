# Opportunity # — overlay

Adds an **Opportunity #** field: a free text reference number from wherever the deal is
tracked elsewhere (your CRM, a quoting tool). The tracker doesn't assign or validate it,
it just stores it and lets you search by it, so you can cross reference a row here with
the same deal in that other system. It is optional; a blank one is not a data gap.

Where it shows up:

* A new field in the opportunity drawer, right under Opportunity.
* The table: shown in small muted text next to the account name when set, nothing shown
  when it's blank.
* Search: typing a number in the search box now matches it, same as account or seller.
* Export/Import: a new "Opportunity #" column in the Pipeline sheet, round trips both
  ways, matched by its own header text so it can't be confused with the "Opportunity"
  column regardless of column order.
* Request update email: included as its own line when set, same treatment as the
  Opportunity line (not flagged "Not on file" when blank — it's optional context, not
  something every deal has).

## Apply

Nine files. All replace what is already there:

```
src/lib/validate.js
src/lib/xlsx.js
src/lib/sample-data.js
test/xlsx.test.mjs
web/index.html
web/app.js
web/app.css
README.md
CLAUDE.md
```

## Verify

```powershell
npm test        # 136 tests (one new xlsx test added for this feature)
npm run dev
```

In the browser: open Fabrikam Logistics, confirm Opportunity # shows "CRM-10391" in the
drawer and next to the account name in the table. Search "CRM-10391" and confirm only
that row shows. Add a new opportunity, set an Opportunity #, save, and confirm it shows
in the table and survives a reopen. Click Request update on a row with an Opportunity #
set and confirm the draft email includes an "Opportunity #:" line.

Export the pipeline to Excel and confirm the new "Opportunity #" column is there,
separate from "Opportunity". Edit a cell, re-import, confirm it updates that one field.

## What changed

`src/lib/validate.js` — new `oppNumber` field: optional text, 40 characters max.

`src/lib/xlsx.js` — new "Opportunity #" export column, placed right before the computed
Est. margin column (kept the index shifts in the existing tests small). The header
matcher was hardened to check for an exact header match before falling back to its
fuzzy prefix match, since "Opportunity #" is a superstring of "Opportunity"'s match
prefix — without that fix, column order in an uploaded sheet could cross the two fields.

`src/lib/sample-data.js` — five of the eleven sample opportunities now carry a
representative Opportunity #, the rest are left blank to show the optional state.

`test/xlsx.test.mjs` — two existing tests' hardcoded column indices shifted for the new
column, plus a new test that builds a sheet with Opportunity # before Opportunity in
column order and confirms import still maps each to the right field.

`web/index.html`, `web/app.js`, `web/app.css` — the drawer field, table display, search,
and the Request update email line described above.

`README.md`, `CLAUDE.md` — documented the field and, in CLAUDE.md, the header-matching
trap so a future column addition doesn't reintroduce it.
