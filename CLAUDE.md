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

### 2. Google Apps Script web app (`apps-script/Code.gs` or similar)
- Google's JavaScript runtime — deployed from script.google.com as a Web App
- Deploy settings: "Execute as: me", "Who has access: Anyone"
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

- **Apps Script**: deploy/redeploy from script.google.com; the Web App URL goes into `index.html` JS config (it is not a secret)
- **Static page**: push to GitHub Pages — no build step, just the HTML file
- **Sheet**: create once manually; all subsequent per-meeting tabs are auto-created by the script
