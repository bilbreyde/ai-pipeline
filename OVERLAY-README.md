# Request update: summary + ask for missing fields — overlay

Changes what the **Request update** button puts in the draft email. It used to send a short "send
a status update" note with account, stage, and close/next step only if they happened to be set.
Now it sends a full summary of everything the tracker has on that deal (account, opportunity,
stage, deal size, expected close, next step, and segment/lead when set), and any of deal size,
expected close or next step that is blank is shown as "Not on file", with the opening line asking
the seller to fill those in. This lets the seller both correct anything wrong in the summary and
fill in what is missing, in one email.

Nothing about how the email is sent changed: it is still only a `mailto:` link built in the
browser, nothing is stored or sent from the server.

## Apply

Two files, both replace what is already there:

```
web/app.js
README.md
```

## Verify

```powershell
npm test        # 135 tests, unaffected by this change
npm run dev
```

Open an opportunity with every field filled in (Fabrikam Logistics in the sample data) and click
Request update: the draft should show every field with real values, no "Not on file" anywhere.
Then try one with a gap, like Wingtip Retail (has a size and a next step, no close date): the
draft should read "Expected close: Not on file" while the other two show their real values.

## What changed

`updateMailBody` in `web/app.js` is the only function touched. `README.md`'s "Request update from
the seller" section describes the new email content.
