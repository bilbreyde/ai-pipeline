# Overlay: Account planning stage

Adds a new stage, "Account planning", before Identified. It tracks an account you plan to approach about AI, before there is a real opportunity. No size or margin is expected there, and a blank size at that stage is not treated as a data gap. This only touches the files listed below.

## Before you start

1. Read `CLAUDE.md` in the project root first, especially the new note under Architecture notes about `STAGES` being defined in three places.
2. Make sure your working tree is clean (`git status`) so this overlay's diff is easy to review and easy to revert if needed.

## What changed and why

* `web/dash-calc.js` — `STAGES` and `OPEN` both get "Account planning" as the first entry. `gapsOf()` and `build()`'s gap counting no longer flag a missing size at this stage, since none is expected. Every other stage is unaffected: a missing size still flags a gap everywhere else.
* `src/lib/validate.js` — `STAGES` gets the same addition, so the API accepts it and the exporter's Stage dropdown includes it (that dropdown reads `STAGES` from here).
* `web/app.js` — this file keeps its own copy of `STAGES` and `OPEN` for the pipeline table's stage picker, sort order, and the Pipeline tab's own "by stage" bars. **This is the file most likely to get missed if this feature is ever touched again**: it does not delegate to `dash-calc.js` for these two arrays the way it does for the math functions. Both are updated here.
* `web/transcript-ui.js` — same story, its own `STAGES` copy for the transcript review dropdown. Updated.
* `web/dash.js` — `STAGE_CLS` maps "Account planning" to the existing gray token (`cg`), the same one Blocked already uses, rather than extending the blue sequential ramp. The lightest step of that ramp (`--o1`) already sits right at the readability floor this app's own contrast test enforces (about 2:1 against the surface in every theme), so there was no room to add a lighter step without either failing that test or shipping a bar nobody could see. Gray also reads correctly: Account planning isn't part of the "how close is this deal" story the blue ramp tells, so treating it like Blocked (also outside that story) is the more honest choice, not just the safer one. The chart's caption text was updated to say so. No new CSS colors were added.
* `src/lib/sample-data.js` — one new fictional record, Relecloud, stage Account planning, no size, so the walkthrough below has something real to look at.
* `test/dash-calc.test.mjs` — updated the `byStage` key order assertion, added a test covering the no-size exemption and confirming no-seller/no-next-step still flag normally.
* `README.md`, `CLAUDE.md` — document the new stage and, in CLAUDE.md, the three-places-define-STAGES trap above.

## Apply

Copy these files into the project, preserving their relative paths. Diff each one against what is already there before overwriting, since you may have made local edits since this overlay was built:

```
web/dash-calc.js
web/app.js
web/dash.js
web/transcript-ui.js
src/lib/validate.js
src/lib/sample-data.js
test/dash-calc.test.mjs
README.md
CLAUDE.md
```

Do not touch `infra/` or `scripts/deploy.ps1`. This overlay has no infrastructure or deployment changes.

## Verify

```powershell
npm test
```

Expect exactly `112 tests`, `112 pass`, `0 fail`.

Then a manual walkthrough (`npm run dev`, fictional sample data):

1. **Pipeline tab.** The Stage dropdown on every row, and the Stage filter dropdown above the table, both list "Account planning" first, before Identified. The sample row Relecloud is at Account planning with a blank deal size and margin, and shows no orange gap tags (not "No size").
2. **A row you set to Account planning yourself** with no seller: it should show a "No seller" gap tag, confirming only the size exemption is special, not the whole stage.
3. **Dashboard tab, Margin by stage card.** Account planning is the first row, shown in gray like Blocked, labeled "No size" rather than "$0". The caption below the chart explains why both are gray.
4. **KPI band and Data quality card.** The open opportunity count includes Account planning rows. The "No deal size" gap count does not include them.
5. **From transcript.** Open the dialog and confirm "Account planning" appears in the manual stage override dropdown.
6. **Export.** The Stage column's dropdown validation in the exported .xlsx includes Account planning.

If any of these checks fail, do not deploy. Stop and diff against this overlay's source files.
