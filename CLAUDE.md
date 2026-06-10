# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

NHSCC Meeting Check-In System — digital self-service attendance for the North Hills Sports Car Club's monthly autocross meetings. Replaces paper sign-in sheets.

Deliberately **out of scope**: MotorsportReg (MSR) integration and Google Forms. Do not add them.

## Architecture

Three independent components with no shared build toolchain:

### 1. Static check-in page (`index.html`)
- Vanilla HTML/CSS/JS, no framework, no build step
- Hosted on GitHub Pages
- Single page parameterized by `?m=<uuid>` query token
- Fetches roster via `GET` on load, polls every ~12s; submits check-ins via `POST`
- Renders QR codes client-side using qrcodejs from CDN (do NOT use Google's retired Chart API QR endpoint)

### 2. Google Apps Script web app (`apps-script/Code.gs`)
- Google's JavaScript runtime — deployed as a Web App via `./deploy.sh` (clasp; see Deployment)
- Deploy settings ("Execute as: me", "Who has access: Anyone") are codified in `apps-script/appsscript.json`
- `doGet(e)` — returns meeting name, status, and check-ins list as JSON; supports `action=meta` for metadata only
- `doPost(e)` — validates token, checks open/close status and time window, acquires LockService lock, appends row to meeting tab
- `onOpen()` — adds "NHSCC" custom menu with "New Meeting" and "Close Meeting" items
- `createMeeting()` — prompts for name/times, generates UUID token (`Utilities.getUuid()`), creates per-meeting tab, appends Meetings index row, shows dialog with check-in URL + QR
- `closeMeeting()` — sets Status to `closed`; dead tokens reject further check-ins
- `findMeeting(token)` — helper that looks up index row by token, returns it or null

### 3. Google Sheet (datastore)
- `Meetings` tab (index): Token, Meeting Name, Tab Name, Status, Opens At, Closes At, Created At, Check-in URL
- One auto-created tab per meeting with columns: Timestamp, Name, Source (`In person` or `Zoom`)
- The club's points tracker reads this sheet directly

## Implementation gotchas

- **CORS preflight**: send `POST` body as `text/plain` or form-encoded — Apps Script does not handle OPTIONS preflights. Plain `GET` returning JSON is CORS-clean.
- **Concurrent writes**: wrap row appends in `LockService` to prevent row collisions from simultaneous scans.
- **Tab creation**: `createMeeting()` creates the tab up front; `doPost` can create it defensively if missing.
- **Polling, not push**: Apps Script cannot push; the live roster polls ~12s intervals.
- **Token security**: UUIDs stop guessing; open/close time windows mitigate sharing of valid tokens.

## Suggested build order

1. Google Sheet: `Meetings` tab with column headers
2. Apps Script skeleton: `doPost` + automatic tab creation + LockService
3. `onOpen()` + `createMeeting()` (token, tab, index row, URL/QR dialog)
4. Static check-in page: token parsing, form, `POST`
5. `doGet()` + live polling roster on page
6. `closeMeeting()` + open/close time-window enforcement
7. QR rendering, edge-state handling (missing token, invalid token, closed meeting), polish

## Deployment

- **Apps Script — run `./deploy.sh` after any `Code.gs` change.** It uses clasp (via `npx -y @google/clasp@2`, nothing installed) to push `apps-script/` to the script project, then repoints the **existing** web-app deployment to a new version. The `/exec` URL baked into `index.html` never changes, so a backend deploy never requires a frontend change. Do NOT tell the user to copy-paste code into script.google.com — that workflow is retired.
- Where the pieces live: `.clasp.json` (Script ID + `rootDir: apps-script`), `deploy.sh` (the web-app deployment ID, hardcoded — it is not a secret), `apps-script/appsscript.json` (project manifest; the web app's `executeAs: USER_DEPLOYING` / `access: ANYONE_ANONYMOUS` settings live here and deploy with the code).
- Auth is per-machine: `npx -y @google/clasp@2 login` (credentials land in `~/.clasprc.json`, never in the repo). One-time setup steps are documented in the README's Deployment section. clasp is pinned to `@2` because 3.x renamed commands.
- **The repo is the source of truth.** `clasp push` overwrites the entire online project, silently discarding any edits made in the script.google.com editor — never edit there. To check for suspected drift: `clasp pull` fetches the live code over the local files; inspect `git diff`, then `git restore apps-script/Code.gs` to keep the repo version.
- Each deployment is tagged with the git short hash + commit subject, so Apps Script's "Manage deployments" history maps back to repo commits.
- Verifying a deploy: `curl -sL '<exec URL>?action=members'` (no token) should return `{"ok":false,"error":"Unknown meeting"}`.
- Manual fallback only if clasp/auth is broken: paste `Code.gs` into script.google.com, then Deploy → Manage deployments → edit → Deploy.
- **Static page**: push `index.html` to `main` — GitHub Pages serves it at meetings.nhscc.com automatically, no build step.
- **Sheet**: created once manually; all per-meeting tabs are auto-created by the script.
