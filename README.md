# NHSCC Meeting Check-In

Digital self-service attendance system for the [North Hills Sports Car Club](https://nhscc.org) monthly autocross meetings. Members scan a QR code or follow a link to sign themselves in — no paper, no clipboard.

**Live page:** https://meetings.nhscc.com

---

## How it works

1. Before the meeting, the organizer uses the **NHSCC → New Meeting** menu item in the club Google Sheet. This generates a unique token and a 4-digit backup code, creates a per-meeting attendance tab, and shows a QR code + URL + code to share.
2. Members scan the QR code or paste the link into Zoom chat. They start typing their name, pick themselves from the member list, choose *In person* or *Zoom*, and tap **Check In**. Picking from the list captures their timing-software barcode automatically.
3. **No QR code?** Members can go to the [live page](https://meetings.nhscc.com) directly and type the 4-digit code (read aloud at the meeting) to reach the same check-in screen.
4. The roster updates live on-screen every 12 seconds. The club's existing points tracker reads directly from the same Google Sheet — no export step needed.
5. After the meeting, the points admin uses **NHSCC → Show Attendance** to get the present members' barcode IDs, sorted, to scroll alongside the timing software — plus a short list of any unmatched names to handle by hand.

---

## Repository layout

```
index.html          — Static check-in page (hosted on GitHub Pages)
apps-script/
  Code.gs           — Google Apps Script web app (deployed via ./deploy.sh)
  appsscript.json   — Apps Script project manifest (web-app settings)
deploy.sh           — One-command backend deploy (clasp), self-verifying
.clasp.json         — clasp config (Script ID)
tests/              — Unit suite, run with: node --test tests/*.test.js
```

---

## Components

### Static check-in page (`index.html`)

Vanilla HTML/CSS/JS — no framework, no build step. Hosted on GitHub Pages at the URL above.

- Reads the meeting token from the `?m=` query parameter
- With no token, shows a 4-digit code entry box that resolves the code to a token and redirects into the check-in flow
- Name field is a typeahead over the `Members` directory; picking a member tags the check-in with their barcode ID (barcodes stay server-side and are never sent to the browser)
- Fetches the roster on load and polls every 12 seconds
- Submits check-ins via POST to the Apps Script web app

### Google Apps Script (`apps-script/Code.gs`)

Deployed as a Web App via `./deploy.sh` ("Execute as: me", "Who has access: Anyone" — codified in `apps-script/appsscript.json`). Bound to the club Google Sheet.

| Function | Description |
|---|---|
| `doGet(e)` | Returns meeting name, status, and check-in list as JSON (cached ~10s); reports `notYetOpen` + the open time before a meeting's Opens At; `action=resolve&code=NNNN` maps a backup code to a token; `action=members` returns the directory names for the typeahead (requires an open meeting's token); `action=version` reports the deployed git hash |
| `doPost(e)` | Validates token, checks open/closed status, matches the member to a barcode, appends a check-in row |
| `onOpen()` | Adds the **NHSCC** custom menu to the spreadsheet |
| `createMeeting()` | Prompts for name and optional open/close times, generates a UUID token and a unique 4-digit code, creates the per-meeting tab, and shows the QR code + code dialog |
| `closeMeeting()` | Sets a meeting's status to `closed`; subsequent check-ins are rejected |
| `reopenMeeting()` | Reopens a closed meeting — re-issues the backup code if another open meeting took it, and clears a passed Closes At time |
| `showAttendance()` | Shows a meeting's present barcode IDs (sorted) plus any unmatched names, for the points admin |
| `fixMeetingTab()` | Repairs an existing meeting tab — fixes ID text formatting and re-pulls each check-in's barcode/Unique ID from the Members directory by name |
| `matchMember()` | Resolves a check-in to a member barcode via the picked row index or a normalized full-name match |
| `syncMembers()` | Fetches the timing-software CSV export from a (remembered, re-promptable) URL and rewrites the Members tab |
| `setup()` | One-time setup — creates the Meetings index and Members directory tabs with headers |

### Google Sheet (datastore)

**Meetings tab** (index):

| Token | Meeting Name | Tab Name | Status | Opens At | Closes At | Created At | Check-in URL | Code |
|---|---|---|---|---|---|---|---|---|

**Members tab** (directory — populated by **NHSCC → Sync Members**, not edited by hand):

| Unique ID | Barcode | Name |
|---|---|---|

Synced from the timing-software CSV export (`UniqueID, Barcode, CarID, FirstName, LastName`). Only those identity columns are pulled in — the export's PII columns (address, email, phone) are ignored. The export URL changes per export (dated filename), so **Sync Members** prompts for it and remembers the last one used.

One additional tab is auto-created per meeting with columns: Timestamp, Name, Source, Barcode ID, Unique ID, Notes. The ID columns are text-formatted so values like `083` or `ALBERS-MARK` keep their exact form. `Notes` is never written by the system — it's a free column for the points master to annotate by hand.

---

## Development

- `node --test tests/*.test.js` runs the unit suite — `Code.gs` is evaluated in a sandbox against in-memory mocks of the Apps Script services (`tests/gas-mocks.js`).
- GitHub Actions (`.github/workflows/ci.yml`) runs the tests plus `node --check` syntax checks on every push.

---

## Setup (first time)

This stands up the whole system from scratch — it has already been done for the club's sheet. Day-to-day code changes only need `./deploy.sh` (see Deployment).

1. Create a new Google Sheet for the club, then open **Extensions → Apps Script** to create its bound script project (it can start empty).
2. Copy the Script ID (**Project Settings → Script ID**) into `.clasp.json`, then push the code: `npx -y @google/clasp@2 login` followed by `npx -y @google/clasp@2 push` (see Deployment for the one-time clasp setup).
3. In the Apps Script editor, run `setup()` once (creates the Meetings and Members tabs) and `authorizeExternalRequest()` once (grants the URL-fetch permission Sync Members needs).
4. Deploy as a Web App (Deploy → New deployment → Web app, "Execute as: me", "Who has access: Anyone"). Copy the deployment ID into `DEPLOYMENT_ID` in `deploy.sh`, and the `/exec` URL into `index.html` as the `API` constant.
5. Push `index.html` to the `main` branch — GitHub Pages serves it automatically.

## Running a meeting

1. Open the Google Sheet and go to **NHSCC → New Meeting**.
2. Enter the meeting name (e.g. `May 2026 Autocross`).
3. Optionally enter open/close times (MM/DD/YYYY HH:MM). Leave blank to open immediately / close manually. With both times set, the meeting runs itself — you can create a whole year of meetings in advance: before the open time the page tells visitors when check-in starts (and flips to the form automatically); after the close time check-ins are rejected and the code stops resolving.
4. Copy the URL from the dialog and paste it into Zoom chat. Project the QR code for in-person members, and read the 4-digit backup code aloud for anyone who can't scan it.
5. When sign-in is complete, use **NHSCC → Close Meeting**. (Closed by mistake? **NHSCC → Reopen Meeting** undoes it.)

---

## Deployment

- **Static page:** push to `main` — GitHub Pages deploys automatically, no build step.
- **Apps Script:** run `./deploy.sh` after any `Code.gs` change. It pushes `apps-script/` to the script project and updates the live web-app deployment in place — the `/exec` URL never changes, so `index.html` needs no edits.

### Apps Script deploy — one-time setup

Uses [clasp](https://github.com/google/clasp) via `npx` (no install). Once per machine/account:

1. Enable the Apps Script API for your account: https://script.google.com/home/usersettings
2. `npx -y @google/clasp@2 login` (opens a browser for Google OAuth)
3. In the Apps Script editor: **Project Settings → Script ID** — paste it into `.clasp.json`
4. `npx -y @google/clasp@2 pull` once. This fetches `appsscript.json` (the project manifest — commit it) into `apps-script/`. It also overwrites `Code.gs` with what's currently deployed; run `git diff` after — any diff is drift between the repo and the live script, resolve it before your first push.
5. `npx -y @google/clasp@2 deployments` — copy the web app's deployment ID (the line ending in `- web app`, **not** `@HEAD`) into `DEPLOYMENT_ID` in `deploy.sh`

After that, every deploy is just `./deploy.sh`.

Manual fallback: paste `Code.gs` into script.google.com and Deploy → Manage deployments → edit → Deploy.
