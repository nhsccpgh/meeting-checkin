# NHSCC Meeting Check-In

Digital self-service attendance system for the [North Hills Sports Car Club](https://nhscc.org) monthly autocross meetings. Members scan a QR code or follow a link to sign themselves in — no paper, no clipboard.

**Live page:** https://meetings.nhscc.com

---

## How it works

1. Before the meeting, the organizer uses the **NHSCC → New Meeting** menu item in the club Google Sheet. This generates a unique token and a 4-digit backup code, creates a per-meeting attendance tab, and shows a QR code + URL + code to share.
2. Members scan the QR code or paste the link into Zoom chat. They enter their name, choose *In person* or *Zoom*, and tap **Check In**.
3. **No QR code?** Members can go to the [live page](https://meetings.nhscc.com) directly and type the 4-digit code (read aloud at the meeting) to reach the same check-in screen.
4. The roster updates live on-screen every 12 seconds. The club's existing points tracker reads directly from the same Google Sheet — no export step needed.

---

## Repository layout

```
index.html          — Static check-in page (hosted on GitHub Pages)
apps-script/
  Code.gs           — Google Apps Script web app (deployed from script.google.com)
```

---

## Components

### Static check-in page (`index.html`)

Vanilla HTML/CSS/JS — no framework, no build step. Hosted on GitHub Pages at the URL above.

- Reads the meeting token from the `?m=` query parameter
- With no token, shows a 4-digit code entry box that resolves the code to a token and redirects into the check-in flow
- Fetches the roster on load and polls every 12 seconds
- Submits check-ins via POST to the Apps Script web app

### Google Apps Script (`apps-script/Code.gs`)

Deployed from [script.google.com](https://script.google.com) as a Web App ("Execute as: me", "Who has access: Anyone"). Bound to the club Google Sheet.

| Function | Description |
|---|---|
| `doGet(e)` | Returns meeting name, status, and check-in list as JSON; `action=resolve&code=NNNN` maps a backup code to a token |
| `doPost(e)` | Validates token, checks open/closed status, appends a check-in row |
| `onOpen()` | Adds the **NHSCC** custom menu to the spreadsheet |
| `createMeeting()` | Prompts for name and optional open/close times, generates a UUID token and a unique 4-digit code, creates the per-meeting tab, and shows the QR code + code dialog |
| `closeMeeting()` | Sets a meeting's status to `closed`; subsequent check-ins are rejected |
| `setup()` | One-time setup — creates the Meetings index tab with headers |

### Google Sheet (datastore)

**Meetings tab** (index):

| Token | Meeting Name | Tab Name | Status | Opens At | Closes At | Created At | Check-in URL | Code |
|---|---|---|---|---|---|---|---|---|

One additional tab is auto-created per meeting with columns: Timestamp, Name, Source.

---

## Setup (first time)

1. Create a new Google Sheet for the club.
2. Open **Extensions → Apps Script**, paste in `Code.gs`, and save.
3. Run the `setup()` function once from the editor to create the Meetings tab.
4. Deploy as a Web App (Deploy → New deployment → Web app). Copy the deployment URL.
5. Paste the deployment URL into `index.html` as the `API` constant.
6. Push `index.html` to the `main` branch — GitHub Pages serves it automatically.

## Running a meeting

1. Open the Google Sheet and go to **NHSCC → New Meeting**.
2. Enter the meeting name (e.g. `May 2026 Autocross`).
3. Optionally enter open/close times (MM/DD/YYYY HH:MM). Leave blank to open immediately / close manually.
4. Copy the URL from the dialog and paste it into Zoom chat. Project the QR code for in-person members, and read the 4-digit backup code aloud for anyone who can't scan it.
5. When sign-in is complete, use **NHSCC → Close Meeting**.

---

## Deployment

- **Apps Script:** redeploy from script.google.com after any code changes (Deploy → Manage deployments → edit → Deploy). The web app URL does not change between redeployments.
- **Static page:** push to `main` — GitHub Pages deploys automatically, no build step.
