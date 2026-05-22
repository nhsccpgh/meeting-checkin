# NHSCC Meeting Check-In System — Build Plan

## Context for Claude Code

This is a build spec for a small attendance check-in system for the North Hills
Sports Car Club (NHSCC), an autocross club. The club meets monthly and currently
records attendance for points on a physical paper sign-in sheet; a separate
person also has to manually write down Zoom attendees. This system replaces that
with a self-service digital check-in.

Build the three components described below. There is no existing codebase —
start fresh. Ask before assuming anything not specified here.

---

## Goal

Members check in by scanning a QR code (or, for Zoom attendees, opening a link),
typing their name, and submitting. Attendance lands automatically in a Google
Sheet that the club's points tracker reads. No manual transcription.

Deliberately **out of scope**: MotorsportReg (MSR) integration and Google Forms.
Both were considered and rejected. Do not add them.

---

## Architecture

Three pieces:

1. **Static check-in page** — hosted on GitHub Pages. Plain HTML/CSS/JS, no
   framework (the page is small). One single page, parameterized by a URL token;
   there is NOT a separate page per meeting.
2. **Google Apps Script web app** — the backend. Handles both writes
   (`doPost` = a check-in) and reads (`doGet` = the current roster). Also hosts a
   custom menu in the Sheet for the organizer's monthly workflow.
3. **Google Sheet** — the datastore. One `Meetings` index tab plus one tab per
   meeting. The points tracker reads this directly.

Data flow: QR/link → static page → `POST` to Apps Script → row appended to that
meeting's tab. The page also polls `GET` on the same web app to show a live
roster of who has checked in.

---

## Component 1: Google Sheet

### `Meetings` tab (index / control table)

One row per meeting. Columns:

- `Token` — UUID, the unguessable meeting identifier (see Security below)
- `Meeting Name` — human-readable, e.g. "June 2026 — Points Event 4"
- `Tab Name` — name of the per-meeting tab this maps to
- `Status` — `open` or `closed`
- `Opens At` — optional timestamp for auto-open
- `Closes At` — optional timestamp for auto-close
- `Created At` — timestamp
- `Check-in URL` — the full URL for convenience

### Per-meeting tabs

One tab per meeting, created automatically. Friendly name (from `Tab Name`), NOT
named after the ugly token. Columns:

- `Timestamp`
- `Name` — what the attendee typed
- `Source` — `In person` or `Zoom`

---

## Component 2: Apps Script web app

### `onOpen()`
Adds a custom menu "NHSCC" to the Sheet with two items: "New Meeting" and
"Close Meeting".

### `createMeeting()` — menu action
The organizer's main monthly action:
1. Prompt for meeting name and (optionally) open/close times.
2. Generate a token with `Utilities.getUuid()`.
3. Create a new per-meeting tab with the friendly name and header row.
4. Append a row to the `Meetings` index (status = `open`).
5. Show a dialog with the check-in URL and a rendered QR code to save/screenshot.

### `closeMeeting()` — menu action
Lets the organizer pick a meeting and set its `Status` to `closed`. After this,
the token is dead and no further check-ins are accepted (prevents back-filling).

### `doPost(e)` — receive a check-in
1. Parse `token`, `name`, `source` from the request.
2. Look up `token` in the `Meetings` index. If not found → reject.
3. Check `Status` is `open` and current time is within `Opens At`/`Closes At`
   if set. Otherwise → reject.
4. Acquire a `LockService` lock so concurrent submits don't clobber rows.
5. Append the row to that meeting's tab.
6. Return JSON success/failure.

### `doGet(e)` — return the roster
1. Parse `token`. Validate against the index (same as above).
2. Return JSON: the meeting name, status, and the list of check-ins for the
   live roster. Optionally support an `action=meta` mode that returns just the
   meeting name/status.

### Helper
- `findMeeting(token)` — looks up the index row for a token, returns it or null.

### Deployment
- Deploy as **Web App**: "Execute as: me", "Who has access: Anyone".
- The resulting web app URL goes into the static page's JS config. It is NOT a
  secret — it is just an endpoint — so it is safe in client-side code.

---

## Component 3: Static check-in page (GitHub Pages)

Single `index.html` (vanilla HTML/CSS/JS). Behavior:

1. Read the meeting token from the `m` query param (`…/checkin/?m=<uuid>`).
2. On load, `GET` the web app to fetch the meeting name + current roster.
   Render the meeting name and the list of who's already checked in.
3. Show a form: a name text input, an "In person / Zoom" toggle, a submit button.
4. On submit, `POST` the check-in, then refresh the roster.
5. Poll the `GET` endpoint every ~12 seconds so the roster stays live.
6. Handle edge states gracefully: missing token, invalid/unknown token, and
   closed meeting should each show a clear friendly message instead of a form.
7. QR code: render client-side with a small library (e.g. qrcodejs from a CDN) —
   do NOT use Google's old Chart API QR endpoint, which has been retired. An
   optional display/admin mode can render a large QR for projecting at the
   meeting.

---

## Security / anti-abuse

- **Meeting tokens are UUIDs** (`Utilities.getUuid()`), not dates or sequential
  IDs — so meeting URLs cannot be guessed.
- **Server-side validation is the real enforcement.** The token is trusted only
  because it matches a row in the `Meetings` index, not merely because it is
  long. Unknown tokens are rejected.
- **Open/close status** stops attendance back-filling after a meeting and limits
  the damage if someone shares a valid QR/link — a closed or time-expired token
  no longer works. (Randomness stops guessing; it does not stop sharing — the
  open/close window is the mitigation for sharing.)
- The honor system plus a small, self-policing club is otherwise acceptable;
  do not over-engineer beyond the above.

---

## Implementation gotchas

- **CORS preflight:** send the `POST` body as `text/plain` (or form-encoded) so
  the browser skips the preflight request — Apps Script does not handle
  preflights well. A plain `GET` returning JSON is CORS-clean and needs no trick.
- **Concurrent writes:** wrap the row append in `LockService` so two
  simultaneous scans don't collide.
- **Tab creation is lazy/automatic:** `createMeeting()` makes the tab up front;
  `doPost` can also create it defensively if missing.
- **Polling, not push:** Apps Script can't push updates, so the live roster is
  poll-based (~12s). That is fine for a meeting check-in.

---

## Organizer's monthly workflow (the target UX)

1. Open the Google Sheet, click **NHSCC ▸ New Meeting**.
2. Enter the meeting name (and optional open/close times).
3. Script auto-creates the tab, the index row, and the token.
4. Dialog shows the check-in URL + QR — save/screenshot it.
5. Project the QR at the meeting; drop the same link in the Zoom chat.
6. After the meeting, it auto-closes (if a time was set) or click
   **NHSCC ▸ Close Meeting**.

No GitHub or code changes are ever needed month to month — only the Sheet menu.

---

## Suggested build order

1. Create the Google Sheet with the `Meetings` tab and column headers.
2. Apps Script skeleton: `doPost` + automatic tab creation + `LockService`.
3. `onOpen()` menu + `createMeeting()` (token, tab, index row, URL/QR dialog).
4. Static check-in page: token parsing, the form, the `POST`.
5. `doGet()` + the live polling roster on the page.
6. `closeMeeting()` + the open/close time-window checks.
7. QR rendering, edge-state handling, and visual polish.

---

## Tech stack

- Static page: vanilla HTML/CSS/JS, plus a client-side QR library (e.g. qrcodejs).
- Backend: Google Apps Script (Google's JavaScript runtime).
- Datastore: a single Google Sheet.
- Hosting: GitHub Pages for the static page.
