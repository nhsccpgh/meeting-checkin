# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

NHSCC Meeting Check-In System — digital self-service attendance for the North Hills Sports Car Club's monthly autocross meetings. Replaces paper sign-in sheets. Members scan a QR code (or enter a 4-digit code read aloud) and check themselves in; the points admin matches attendance to timing-software barcodes afterward.

Deliberately **out of scope**: MotorsportReg (MSR) integration and Google Forms. Do not add them.

## Architecture

Three independent components with no shared build toolchain:

### 1. Static check-in page (`index.html`)
- Vanilla HTML/CSS/JS in one file, no framework, no build step; GitHub Pages serves it at meetings.nhscc.com
- Parameterized by `?m=<uuid>` token; with no token it shows a 4-digit backup-code entry that resolves to a token via `action=resolve`
- Renders the form optimistically before the first roster fetch returns (Apps Script round-trips are ~1.7s); `loadRoster()` corrects if the token is bad or the meeting closed
- Name field is a typeahead over the member directory (`action=members`); picking an entry sends `memberIndex` so the server can attach the exact barcode
- Polls the roster every ~12s, pauses while the tab is hidden, resumes on visibilitychange; successful check-ins update the roster optimistically
- Remembers the last name used in `localStorage` key `nhscc-name`
- QR codes render client-side with qrcodejs from CDN (do NOT use Google's retired Chart API QR endpoint)

### 2. Google Apps Script web app (`apps-script/Code.gs`)
- Google's JavaScript runtime — deployed as a Web App via `./deploy.sh` (clasp; see Deployment)
- Deploy settings ("Execute as: me", "Who has access: Anyone") are codified in `apps-script/appsscript.json`
- `doGet(e)` — returns meeting name, status, and check-ins as JSON (cached ~10s per token in CacheService); a future Opens At reports status `notYetOpen` plus `opensAt` (ISO) so the page can show when check-in starts; `action=meta` for metadata only; `action=resolve&code=NNNN` maps a backup code to a token (open meetings only); `action=members` returns directory names for the typeahead — **requires an open meeting's token** so the club roster can't be enumerated, and never includes barcodes; `action=version` reports the deployed git hash
- `doPost(e)` — validates token, status, and open/close time window; resolves the member (picked `memberIndex` first, normalized-name match as fallback, ambiguous names left unmatched); duplicate names return `ok: true, alreadyCheckedIn: true` (not an error); appends under a LockService lock, then busts the roster cache
- Organizer menu (`onOpen`): New Meeting, Bulk Create Meetings (checkbox picker → standing monthly meetings: 3rd Wednesday, sign-ins 7–9 PM, named "Month Year"; skips existing/passed months), Show QR, Close Meeting, Reopen Meeting (undoes an accidental close — re-issues the backup code if reused, clears a passed Closes At), Show Attendance (sorted barcodes for the points admin), Repair Barcodes (re-derives ID columns from the directory), Sync Members (imports the timing-software CSV from a remembered URL)
- `createMeetingRecord()` — shared creation core (UUID token + unique 4-digit code + tab + index row) used by both New Meeting and bulk create; never reuses an existing tab (suffixes "(2)" instead — reuse would interleave two meetings' check-ins) and text-formats the index row before writing so "July 2026" doesn't become a Date

### 3. Google Sheet (datastore)
- `Meetings` tab (index): Token, Meeting Name, Tab Name, Status, Opens At, Closes At, Created At, Check-in URL, Code
- `Members` tab (directory): Unique ID, Barcode, Name — rewritten by Sync Members from the timing-software CSV (`UniqueID, Barcode, CarID, FirstName, LastName`); PII columns from the export are deliberately not imported; not edited by hand
- One auto-created tab per meeting: Timestamp, Name, Source (`In person` or `Zoom`), Barcode ID, Unique ID, Device, Notes. `Notes` is never written by the system and must stay the LAST column — it's the points admin's free annotation column (`doPost` writes columns 1–5 and 6 separately to keep it untouched; add any future column before it). `Device` is a random per-browser tag (localStorage `nhscc-device`) so Show Attendance can flag one device checking in several people — an audit hint, not identity, and deliberately record-don't-block (families legitimately share a phone). Client IPs are NOT obtainable in Apps Script; don't try.
- The club's points tracker reads this sheet directly

## Implementation gotchas

- **CORS preflight**: send `POST` body as `text/plain` — Apps Script does not handle OPTIONS preflights. Plain `GET` returning JSON is CORS-clean.
- **Concurrent writes**: row appends stay wrapped in `LockService`; the duplicate guard runs inside the lock.
- **Sheets mangles values**: "May 2026" auto-converts to a Date and "083" loses its zero. ID/name columns are text-formatted (`@`), and reads use `getDisplayValues()` where the string form matters. `appendRow` does not reliably honor column formats — format the exact target row before `setValues` (see `doPost` and `createMeetingRecord`).
- **Caching**: CacheService holds the roster ~10s per token (busted by `doPost`) and the members list 6h (busted by Sync Members). If you add a write path, bust the matching key, or check-ins will look delayed.
- **Safari Contacts AutoFill**: the name field is `type="search"` with id `who-input` and no "name"/contact vocabulary in the id, label, or placeholder. Safari ignores `autocomplete="off"` and overlays its Contacts panel on anything that heuristically looks like a name field — keep it this way.
- **Barcodes never reach the browser**: `action=members` sends names only; barcode/Unique ID attachment happens server-side in `matchMember`.
- **Duplicated helpers**: `normName()` and the HTML-escape function exist in both `Code.gs` and `index.html` and must stay in sync — the server matches on its copy, the client filters on its own.
- **Token security**: UUIDs stop guessing; open/close time windows limit sharing. The 4-digit code is brute-forceable by design tradeoff — it only resolves open meetings, so don't widen what it unlocks.
- **Polling, not push**: Apps Script cannot push; the roster polls ~12s.
- **Status vs closesAt**: a passed `Closes At` blocks check-ins, hides the meeting from `action=resolve` and Show QR, and makes `doGet` report `closed` (all via `isMeetingOpen`) — but the Status cell stays `open` until Close Meeting flips it. Close Meeting deliberately lists those expired-but-open rows so they can be tidied up.
- **Opens At is deliberately NOT symmetric to Closes At**: meetings are created up to a year in advance, so a future `Opens At` still resolves via code and shows in Show QR (QRs/codes get shared early) — only `doGet` flags it (`notYetOpen`) and `doPost` rejects it. The page shows the open time and re-checks at that moment (clamped to ≤6h per timer; `setTimeout` overflows past ~24 days). Don't fold `opensAt` into `isMeetingOpen`.
- **Typeahead Enter ordering**: `wireTypeahead()`'s keydown listener must stay registered before `renderForm`'s submit-on-Enter listener — it consumes Enter with `stopImmediatePropagation()` when a suggestion is highlighted.

## Testing

- `node --test tests/*.test.js` runs the unit suite. `tests/gas-mocks.js` evaluates `Code.gs` in a vm sandbox against in-memory mocks of SpreadsheetApp/LockService/CacheService/ContentService; `tests/code.test.js` covers `doPost`/`doGet`, member matching, code resolution, time windows, and cache busting. Menu/dialog functions (anything touching `getUi()`) are untested by design.
- `tests/helpers-sync.test.js` extracts the duplicated `normName`/HTML-escape helpers from BOTH `Code.gs` and `index.html` and asserts identical behavior — if you edit either copy, edit both or this fails CI.
- CI (`.github/workflows/ci.yml`) runs the suite plus `node --check` syntax checks on both files on every push.
- The mocks deliberately do NOT reproduce Sheets' quirks (date coercion, format-ignoring appends, vm-realm arrays are normalized in `appendRow`) — after meaningful `Code.gs` changes, still smoke-test against the live sheet: create a throwaway meeting, check in, delete the tab and index row.

## Deployment

- **Apps Script — run `./deploy.sh` after any `Code.gs` change.** It uses clasp (via `npx -y @google/clasp@2`, nothing installed) to push `apps-script/` to the script project, then repoints the **existing** web-app deployment to a new version. The `/exec` URL baked into `index.html` never changes, so a backend deploy never requires a frontend change. Do NOT tell the user to copy-paste code into script.google.com — that workflow is retired.
- Where the pieces live: `.clasp.json` (Script ID + `rootDir: apps-script`), `deploy.sh` (the web-app deployment ID, hardcoded — it is not a secret), `apps-script/appsscript.json` (project manifest; the web app's `executeAs: USER_DEPLOYING` / `access: ANYONE_ANONYMOUS` settings live here and deploy with the code).
- Auth is per-machine: `npx -y @google/clasp@2 login` (credentials land in `~/.clasprc.json`, never in the repo). One-time setup steps are documented in the README's Deployment section. clasp is pinned to `@2` because 3.x renamed commands.
- **The repo is the source of truth.** `clasp push` overwrites the entire online project, silently discarding any edits made in the script.google.com editor — never edit there. To check for suspected drift: `clasp pull` fetches the live code over the local files; inspect `git diff`, then `git restore apps-script/Code.gs` to keep the repo version.
- Each deployment is tagged with the git short hash + commit subject, so Apps Script's "Manage deployments" history maps back to repo commits.
- Deploys self-verify: `deploy.sh` bakes the git short hash into `DEPLOY_VERSION` in the deployed copy (the local file is restored afterward, so the repo never shows the hash) and then curls `<exec URL>?action=version` until the live endpoint reports that hash, failing loudly if it never does. A live response of `"version":"dev"` means someone pushed outside `./deploy.sh`.
- Manual fallback only if clasp/auth is broken: paste `Code.gs` into script.google.com, then Deploy → Manage deployments → edit → Deploy.
- **Static page**: push `index.html` to `main` — GitHub Pages serves it at meetings.nhscc.com automatically, no build step.
- **Sheet**: created once manually; all per-meeting tabs are auto-created by the script.
