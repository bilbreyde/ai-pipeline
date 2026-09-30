# Staleness flags — overlay

Flags an open opportunity in the Pipeline table that nobody has updated in a while, in
three escalating steps on the Updated column: light yellow at 7 days, red at 14, and
flashing red at 21 and over. Won and Lost deals are never flagged. Hovering the date
shows the exact day count (also there for screen readers, since color and the flash
alone shouldn't be the only signal).

This is a separate concept from the existing "Rows with gaps" data quality flags (No
size, No seller, No next step) and from the Dashboard's "Not updated in 14 days" insight
tile. Nothing about those changed. This is purely a visual nudge in the table: check in
on this deal, nothing more.

## Apply

Four files, all replace what is already there:

```
web/app.js
web/app.css
README.md
CLAUDE.md
```

## Verify

```powershell
npm test        # 136 tests, unaffected by this change
npm run dev
```

There's no fast way to see all three tiers on real data without waiting weeks, since
every sample row shares the same seeded "last updated" time. To actually see it: open
the browser console on the running app and run

```js
Date.now = () => Date.now() + 8 * 86400000   // pretend 8 days have passed
document.querySelector("#fStage").dispatchEvent(new Event("change"))
```

then bump the offset to `15 * 86400000` and `22 * 86400000` and re-run the second line
each time, to see the yellow, red, and flashing tiers in turn on the same table. Refresh
the page afterward to drop the fake clock.

## What changed

`web/app.js` — `renderTable` now computes a `staleTier` (0 to 3) from `daysAgo` at the
7/14/21 day marks, open opportunities only, and puts it on the Updated cell as
`stale-7`/`stale-14`/`stale-21`, with a `title` giving the exact day count.

`web/app.css` — the three tier styles. `stale-7` and `stale-14`/`stale-21` reuse the
existing `warn`/`warn-soft` and `crit`/`crit-soft` tokens, already contrast checked for
every theme by `test/theme-contrast.test.mjs`. `stale-21` adds a slow opacity pulse
(1.4s, not a rapid strobe) so the reading stays accessible; `prefers-reduced-motion`
turns that off and shows a steady outline instead.

`README.md` — new "Staleness flags" section. `CLAUDE.md` — a new architecture note
explaining this is deliberately separate from the data-gap and Dashboard staleness
concepts, plus a trap note on why the flash animates opacity and not background color.
