// Replace with your GitHub Pages URL (no trailing slash)
const CHECKIN_PAGE_URL = 'https://meetings.nhscc.com';
const MEETINGS_TAB = 'Meetings';
const MEMBERS_TAB  = 'Members';

// Overwritten with the git short hash by deploy.sh at deploy time (the local
// file is restored afterward). 'dev' in a live response means the code was
// pushed outside ./deploy.sh.
const DEPLOY_VERSION = 'dev';

// 1-based column positions in the Members directory tab.
// Synced from the timing-software CSV export via NHSCC → Sync Members.
const MCOL = {
  UNIQUE_ID: 1,
  BARCODE:   2,
  NAME:      3, // full name (FirstName + LastName from the export)
};

// Source CSV columns (0-based) in the timing-software export:
//   UniqueID, Barcode, CarID, FirstName, LastName
const CSV = { UNIQUE_ID: 0, BARCODE: 1, FIRST_NAME: 3, LAST_NAME: 4 };

// 1-based column positions in the Meetings tab
const COL = {
  TOKEN:        1,
  MEETING_NAME: 2,
  TAB_NAME:     3,
  STATUS:       4,
  OPENS_AT:     5,
  CLOSES_AT:    6,
  CREATED_AT:   7,
  CHECKIN_URL:  8,
  CODE:         9,
};

// ── One-time setup ────────────────────────────────────────────────────────────

// Run once from the Apps Script editor (Run → setup) after the first clasp
// push. Safe to run again — will not overwrite existing data.
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(MEETINGS_TAB);
  if (!sheet) {
    sheet = ss.insertSheet(MEETINGS_TAB, 0);
  }
  // Only write headers if the sheet is empty
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['Token', 'Meeting Name', 'Tab Name', 'Status', 'Opens At', 'Closes At', 'Created At', 'Check-in URL', 'Code']);
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(COL.TOKEN, 280);
    sheet.setColumnWidth(COL.CHECKIN_URL, 340);
  } else if (!sheet.getRange(1, COL.CODE).getValue()) {
    // Existing sheet from before the backup-code feature — add the header.
    sheet.getRange(1, COL.CODE).setValue('Code');
  }
  // Force text format on columns Sheets would otherwise mangle:
  // Meeting Name / Tab Name ("May 2026" → Date) and Code (preserves leading style).
  sheet.getRange(1, COL.MEETING_NAME, sheet.getMaxRows()).setNumberFormat('@');
  sheet.getRange(1, COL.TAB_NAME,     sheet.getMaxRows()).setNumberFormat('@');
  sheet.getRange(1, COL.CODE,         sheet.getMaxRows()).setNumberFormat('@');

  // Members directory — populated by NHSCC → Sync Members from the CSV export.
  let members = ss.getSheetByName(MEMBERS_TAB);
  if (!members) {
    members = ss.insertSheet(MEMBERS_TAB);
    members.appendRow(['Unique ID', 'Barcode', 'Name']);
    members.setFrozenRows(1);
    members.setColumnWidth(MCOL.NAME, 240);
  }
  // Keep ID columns as text so leading zeros and long IDs survive.
  members.getRange(1, MCOL.UNIQUE_ID, members.getMaxRows()).setNumberFormat('@');
  members.getRange(1, MCOL.BARCODE,   members.getMaxRows()).setNumberFormat('@');

  Logger.log('Setup complete. Meetings and Members tabs are ready. Run "Sync Members" to populate the directory.');
}

// ── Organizer menu ────────────────────────────────────────────────────────────

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('NHSCC')
    .addItem('New Meeting',     'createMeeting')
    .addItem('Show QR',         'showQR')
    .addItem('Close Meeting',   'closeMeeting')
    .addItem('Reopen Meeting',  'reopenMeeting')
    .addSeparator()
    .addItem('Show Attendance', 'showAttendance')
    .addItem('Repair Barcodes', 'fixMeetingTab')
    .addItem('Sync Members',    'syncMembers')
    .addToUi();
}

function createMeeting() {
  const ui = SpreadsheetApp.getUi();

  const nameResult = ui.prompt(
    'New Meeting',
    'Enter meeting name (e.g. "June 2026 — Points Event 4"):',
    ui.ButtonSet.OK_CANCEL
  );
  if (nameResult.getSelectedButton() !== ui.Button.OK) return;
  const meetingName = nameResult.getResponseText().trim();
  if (!meetingName) { ui.alert('Meeting name cannot be empty.'); return; }

  const opensResult = ui.prompt(
    'Opens At (optional)',
    'Enter open time as MM/DD/YYYY HH:MM, or leave blank to open immediately:',
    ui.ButtonSet.OK_CANCEL
  );
  if (opensResult.getSelectedButton() !== ui.Button.OK) return;
  const opensText = opensResult.getResponseText().trim();

  const closesResult = ui.prompt(
    'Closes At (optional)',
    'Enter close time as MM/DD/YYYY HH:MM, or leave blank (manual close only):',
    ui.ButtonSet.OK_CANCEL
  );
  if (closesResult.getSelectedButton() !== ui.Button.OK) return;
  const closesText = closesResult.getResponseText().trim();

  const token     = Utilities.getUuid();
  const code      = generateMeetingCode();
  const now       = new Date();
  const opensAt   = opensText  ? new Date(opensText)  : '';
  const closesAt  = closesText ? new Date(closesText) : '';
  const checkinUrl = `${CHECKIN_PAGE_URL}?m=${token}`;

  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // Never reuse an existing tab — that would interleave two meetings' check-ins
  // in one sheet. If the name is taken (e.g. a recreated meeting), suffix it.
  const baseTabName = meetingName.replace(/[\/\\?\*\[\]:]/g, '').substring(0, 94).trim();
  let tabName = baseTabName;
  for (let n = 2; ss.getSheetByName(tabName); n++) {
    tabName = `${baseTabName} (${n})`;
  }
  newMeetingTab(ss, tabName);

  // Append to the Meetings index
  ss.getSheetByName(MEETINGS_TAB)
    .appendRow([token, meetingName, tabName, 'open', opensAt, closesAt, now, checkinUrl, code]);

  ui.showModalDialog(meetingDialogHtml(meetingName, checkinUrl, code), 'Meeting Created');
}

function closeMeeting() {
  const ui = SpreadsheetApp.getUi();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(MEETINGS_TAB);
  if (!sheet) { ui.alert('Meetings tab not found.'); return; }

  // Status-only filter (no closesAt check) so a time-expired meeting can still
  // be tidied up to 'closed' here.
  const range   = sheet.getDataRange();
  const data    = range.getValues();
  const display = range.getDisplayValues();
  const open = [];
  for (let i = 1; i < data.length; i++) {
    if (data[i][COL.STATUS - 1] === 'open') {
      open.push({ row: i + 1, name: display[i][COL.MEETING_NAME - 1], token: data[i][COL.TOKEN - 1] });
    }
  }

  if (open.length === 0) { ui.alert('No open meetings.'); return; }

  const list = open.map((m, i) => `${i + 1}. ${m.name}`).join('\n');
  const result = ui.prompt(
    'Close Meeting',
    `Open meetings:\n${list}\n\nEnter the number to close:`,
    ui.ButtonSet.OK_CANCEL
  );
  if (result.getSelectedButton() !== ui.Button.OK) return;

  const idx = parseInt(result.getResponseText().trim(), 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= open.length) {
    ui.alert('Invalid selection.');
    return;
  }

  sheet.getRange(open[idx].row, COL.STATUS).setValue('closed');
  CacheService.getScriptCache().remove('roster:' + open[idx].token); // phones see the close on the next poll
  ui.alert(`"${open[idx].name}" is now closed.`);
}

function reopenMeeting() {
  const ui = SpreadsheetApp.getUi();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(MEETINGS_TAB);
  if (!sheet) { ui.alert('Meetings tab not found.'); return; }

  const range   = sheet.getDataRange();
  const data    = range.getValues();
  const display = range.getDisplayValues();
  const closed = [];
  for (let i = 1; i < data.length; i++) {
    if (data[i][COL.STATUS - 1] === 'closed') {
      closed.push({
        row:      i + 1,
        name:     display[i][COL.MEETING_NAME - 1],
        token:    data[i][COL.TOKEN - 1],
        code:     String(display[i][COL.CODE - 1]).trim(),
        closesAt: data[i][COL.CLOSES_AT - 1],
      });
    }
  }

  if (closed.length === 0) { ui.alert('No closed meetings.'); return; }

  const list = closed.map((m, i) => `${i + 1}. ${m.name}`).join('\n');
  const result = ui.prompt(
    'Reopen Meeting',
    `Closed meetings:\n${list}\n\nEnter the number to reopen:`,
    ui.ButtonSet.OK_CANCEL
  );
  if (result.getSelectedButton() !== ui.Button.OK) return;

  const idx = parseInt(result.getResponseText().trim(), 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= closed.length) { ui.alert('Invalid selection.'); return; }
  const meeting = closed[idx];
  const notes = [];

  // Backup codes are only unique among open meetings, so this one's code may
  // have been reused while it was closed — issue a fresh one if so.
  for (let i = 1; i < data.length; i++) {
    if (data[i][COL.STATUS - 1] === 'open' && String(display[i][COL.CODE - 1]).trim() === meeting.code) {
      const newCode = generateMeetingCode();
      sheet.getRange(meeting.row, COL.CODE).setValue(newCode);
      notes.push(`Its backup code was taken by another open meeting — new code: ${newCode}`);
      break;
    }
  }

  // A passed Closes At would keep rejecting check-ins despite the reopen.
  const closes = meeting.closesAt instanceof Date ? meeting.closesAt : (meeting.closesAt ? new Date(meeting.closesAt) : null);
  if (closes && !isNaN(closes.getTime()) && new Date() > closes) {
    sheet.getRange(meeting.row, COL.CLOSES_AT).setValue('');
    notes.push('Its Closes At time had already passed and was cleared — close it manually when done.');
  }

  sheet.getRange(meeting.row, COL.STATUS).setValue('open');
  CacheService.getScriptCache().remove('roster:' + meeting.token);
  ui.alert(`"${meeting.name}" is open again.` + (notes.length ? '\n\n' + notes.join('\n') : ''));
}

function showQR() {
  const ui    = SpreadsheetApp.getUi();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(MEETINGS_TAB);
  if (!sheet) { ui.alert('Meetings tab not found.'); return; }

  const range   = sheet.getDataRange();
  const data    = range.getValues();
  const display = range.getDisplayValues();
  const open = [];
  for (let i = 1; i < data.length; i++) {
    if (isMeetingOpen(data[i])) { // skips time-expired meetings, not just closed ones
      open.push({
        name: display[i][COL.MEETING_NAME - 1],
        url:  display[i][COL.CHECKIN_URL - 1],
        code: display[i][COL.CODE - 1],
      });
    }
  }

  if (open.length === 0) { ui.alert('No open meetings.'); return; }

  let meeting;
  if (open.length === 1) {
    meeting = open[0];
  } else {
    const list   = open.map((m, i) => `${i + 1}. ${m.name}`).join('\n');
    const result = ui.prompt('Show QR', `Open meetings:\n${list}\n\nEnter number:`, ui.ButtonSet.OK_CANCEL);
    if (result.getSelectedButton() !== ui.Button.OK) return;
    const idx = parseInt(result.getResponseText().trim(), 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= open.length) { ui.alert('Invalid selection.'); return; }
    meeting = open[idx];
  }

  ui.showModalDialog(meetingDialogHtml(meeting.name, meeting.url, meeting.code), 'Check-in QR');
}

// Shared QR + URL + backup-code dialog used by createMeeting and showQR.
function meetingDialogHtml(name, url, code) {
  const safeUrl = url.replace(/'/g, '%27');
  return HtmlService.createHtmlOutput(`<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;padding:16px;margin:0">
  <h3 style="margin-top:0">${esc_(name)}</h3>
  <p style="word-break:break-all"><strong>Check-in URL:</strong><br>
    <a href="${url}" target="_blank">${url}</a>
  </p>
  <div id="qr"></div>
  <div style="margin-top:14px;padding:12px;background:#faf6e8;border:1px solid #e8dca8;border-radius:8px;text-align:center">
    <div style="font-size:12px;color:#666;text-transform:uppercase;letter-spacing:.05em">Backup code</div>
    <div style="font-size:30px;font-weight:700;letter-spacing:.18em;margin-top:4px">${code}</div>
    <div style="font-size:12px;color:#666;margin-top:4px">No QR? Go to ${CHECKIN_PAGE_URL} and enter this 4-digit code.</div>
  </div>
  <p style="font-size:12px;color:#666;margin-top:12px">
    Save or screenshot this. Project the QR at the meeting and paste the link in Zoom chat;
    read the backup code aloud for anyone who can't scan it.
  </p>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
  <script>new QRCode(document.getElementById('qr'), {text:'${safeUrl}',width:240,height:240});</script>
</body>
</html>`).setWidth(340).setHeight(560);
}

// ── Web app endpoints ─────────────────────────────────────────────────────────

// Receive a check-in.
// Body is sent as text/plain JSON to avoid CORS preflight.
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const { token, source } = body;
    // Title-case the name so "rick" → "Rick", "matt simmons" → "Matt Simmons"
    const name = (body.name || '').trim().replace(/\b\w/g, c => c.toUpperCase());

    if (!token || !name || !source) {
      return jsonResponse({ ok: false, error: 'Missing fields' });
    }

    const meeting = findMeeting(token);
    if (!meeting) {
      return jsonResponse({ ok: false, error: 'Unknown meeting' });
    }

    const [, , tabName, status, opensAt, closesAt] = meeting.data;

    if (status !== 'open') {
      return jsonResponse({ ok: false, error: 'Meeting is closed' });
    }

    const now = new Date();
    const opensAtDate  = opensAt  instanceof Date ? opensAt  : (opensAt  ? new Date(opensAt)  : null);
    const closesAtDate = closesAt instanceof Date ? closesAt : (closesAt ? new Date(closesAt) : null);
    if (opensAtDate  && now < opensAtDate)  return jsonResponse({ ok: false, error: 'Meeting has not opened yet' });
    if (closesAtDate && now > closesAtDate) return jsonResponse({ ok: false, error: 'Meeting has closed' });

    // Resolve the member directory: prefer the typeahead's selection, fall back
    // to a normalized name/nickname match. A miss is fine — recorded as unmatched.
    const match     = matchMember(body.memberIndex, name);
    const finalName = match ? match.name : name;
    const barcode   = match ? match.barcode : '';
    const uniqueId  = match ? match.uniqueId : '';

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      let meetingSheet = ss.getSheetByName(tabName);
      if (!meetingSheet) {
        meetingSheet = newMeetingTab(ss, tabName);
      }
      // Duplicate guard — case-insensitive match on the canonical name
      if (meetingSheet.getLastRow() > 1) {
        const names = meetingSheet.getRange(2, 2, meetingSheet.getLastRow() - 1, 1).getValues();
        const nameLower = finalName.trim().toLowerCase();
        // Already on the list — that's success from the member's point of view.
        if (names.some(r => String(r[0]).toLowerCase() === nameLower)) {
          return jsonResponse({ ok: true, alreadyCheckedIn: true });
        }
      }
      // Format the target row's ID cells as text BEFORE writing, so values like
      // "083" or "ALBERS-MARK" are preserved even on tabs created before the
      // text-format fix (appendRow doesn't reliably honor a column's format).
      const targetRow = meetingSheet.getLastRow() + 1;
      meetingSheet.getRange(targetRow, 1).setNumberFormat('M/d/yyyy H:mm:ss'); // setValues doesn't auto-format dates
      meetingSheet.getRange(targetRow, 4, 1, 2).setNumberFormat('@');          // Barcode ID + Unique ID (preserve "083")
      meetingSheet.getRange(targetRow, 1, 1, 5)
        .setValues([[now, finalName.trim(), source, barcode, uniqueId]]);
    } finally {
      lock.releaseLock();
    }

    // Bust the roster cache so the next poll shows this check-in immediately.
    CacheService.getScriptCache().remove('roster:' + token);

    return jsonResponse({ ok: true });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message });
  }
}

// Return the roster (or just metadata if action=meta).
function doGet(e) {
  try {
    if (!e || !e.parameter) return jsonResponse({ ok: false, error: 'No request parameters' });

    // Deployed-version marker for deploy.sh's post-deploy verification.
    if (e.parameter.action === 'version') {
      return jsonResponse({ ok: true, version: DEPLOY_VERSION });
    }

    // Member directory for the check-in typeahead (names only — no barcodes leave
    // the server). Requires an open meeting's token so the directory can't be
    // enumerated from the bare API URL.
    if (e.parameter.action === 'members') {
      const meeting = findMeeting(e.parameter.token);
      if (!meeting || meeting.data[COL.STATUS - 1] !== 'open') {
        return jsonResponse({ ok: false, error: 'Unknown meeting' });
      }
      return jsonResponse({ ok: true, members: listMembers() });
    }

    // Resolve a verbal backup code to a meeting token (open meetings only).
    if (e.parameter.action === 'resolve') {
      const code = (e.parameter.code || '').trim();
      if (!/^\d{4}$/.test(code)) return jsonResponse({ ok: false, error: 'Enter the 4-digit code.' });
      const match = findMeetingByCode(code);
      if (!match) return jsonResponse({ ok: false, error: 'No open meeting matches that code.' });
      return jsonResponse({ ok: true, token: match.token });
    }

    const token = e.parameter.token;
    if (!token) return jsonResponse({ ok: false, error: 'Missing token' });

    // Serve the roster from cache when fresh — every phone polls every ~12s and
    // would otherwise do a full spreadsheet read. doPost busts this on check-in,
    // so only no-op polls hit the cache.
    const cache = CacheService.getScriptCache();
    if (e.parameter.action !== 'meta') {
      const hit = cache.get('roster:' + token);
      if (hit) return jsonResponse(JSON.parse(hit));
    }

    const meeting = findMeeting(token);
    if (!meeting) return jsonResponse({ ok: false, error: 'Unknown meeting' });

    let [, meetingName, tabName, status] = meeting.data;
    // A passed Closes At means closed, even though the Status cell still says
    // 'open' — keeps the page from offering a form that doPost would reject.
    if (status === 'open' && !isMeetingOpen(meeting.data)) status = 'closed';

    if (e.parameter.action === 'meta') {
      return jsonResponse({ ok: true, meetingName, status });
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const meetingSheet = ss.getSheetByName(tabName);
    const checkins = [];

    if (meetingSheet) {
      const rows = meetingSheet.getDataRange().getValues();
      for (let i = 1; i < rows.length; i++) {
        checkins.push({
          timestamp: rows[i][0] ? new Date(rows[i][0]).toISOString() : '',
          name:      rows[i][1],
          source:    rows[i][2],
        });
      }
    }

    const payload = { ok: true, meetingName, status, checkins };
    cache.put('roster:' + token, JSON.stringify(payload), 10);
    return jsonResponse(payload);
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function findMeeting(token) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(MEETINGS_TAB);
  if (!sheet) return null;
  const range = sheet.getDataRange();
  const data    = range.getValues();
  const display = range.getDisplayValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][COL.TOKEN - 1] === token) {
      const row = data[i].slice();
      // Meeting Name and Tab Name can be auto-converted to Dates by Sheets
      // (e.g. "May 2026"); use display values to get the actual strings.
      row[COL.MEETING_NAME - 1] = display[i][COL.MEETING_NAME - 1];
      row[COL.TAB_NAME - 1]     = display[i][COL.TAB_NAME - 1];
      return { row: i + 1, data: row };
    }
  }
  return null;
}

// True if a Meetings index row is accepting check-ins right now: Status is
// 'open' AND the Closes At time (if any) hasn't passed. Expects a getValues()
// row, where Closes At is a Date (or '' when blank). An unparseable Closes At
// is treated as no close time rather than locking the meeting shut.
function isMeetingOpen(rowValues, now) {
  if (rowValues[COL.STATUS - 1] !== 'open') return false;
  const raw    = rowValues[COL.CLOSES_AT - 1];
  const closes = raw instanceof Date ? raw : (raw ? new Date(raw) : null);
  if (!closes || isNaN(closes.getTime())) return true;
  return (now || new Date()) <= closes;
}

// Look up an open meeting by its 4-digit backup code. Returns { token } or null.
// Only matches meetings still accepting check-ins (open status AND inside the
// close window), so a code freed by a closed or expired meeting is safe to reuse.
function findMeetingByCode(code) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(MEETINGS_TAB);
  if (!sheet) return null;
  // Token, status, and code are all text-formatted, so getValues() returns the
  // exact strings — and Closes At comes back as a real Date for isMeetingOpen.
  const data   = sheet.getDataRange().getValues();
  const wanted = String(code).trim();
  for (let i = 1; i < data.length; i++) {
    if (isMeetingOpen(data[i]) && String(data[i][COL.CODE - 1]).trim() === wanted) {
      return { token: data[i][COL.TOKEN - 1] };
    }
  }
  return null;
}

// Normalize a name for matching: lowercase, strip punctuation, collapse spaces.
function normName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Member list for the check-in typeahead. Returns [{ i, name, q }] where i is the
// Members-tab row number and q is the lowercase name for searching.
// Barcodes are deliberately NOT included so they never reach the browser.
function listMembers() {
  // The directory only changes on Sync Members (which busts this), so cache it
  // hard — this is fetched by every phone on page load.
  const cache = CacheService.getScriptCache();
  const hit = cache.get('members');
  if (hit) return JSON.parse(hit);

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(MEMBERS_TAB);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const rows = sheet.getDataRange().getDisplayValues();
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const name = String(rows[i][MCOL.NAME - 1]).trim();
    if (!name) continue;
    out.push({ i: i + 1, name, q: name.toLowerCase() });
  }
  if (out.length) cache.put('members', JSON.stringify(out), 21600); // 6h
  return out;
}

// Build a member object from a Members-tab display row.
function memberFromRow(row) {
  return {
    uniqueId: String(row[MCOL.UNIQUE_ID - 1]).trim(),
    barcode:  String(row[MCOL.BARCODE - 1]).trim(),
    name:     String(row[MCOL.NAME - 1]).trim(),
  };
}

// Resolve a check-in to a member. Tries the typeahead's row index first (verified
// against the submitted name in case the sheet shifted), then a normalized
// full-name match. Returns { uniqueId, barcode, name } or null if unmatched or
// ambiguous (multiple members share the name — left for the admin to sort out).
function matchMember(memberIndex, name) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(MEMBERS_TAB);
  if (!sheet || sheet.getLastRow() < 2) return null;
  const rows   = sheet.getDataRange().getDisplayValues();
  const target = normName(name);

  const idx = parseInt(memberIndex, 10);
  if (idx >= 2 && idx <= rows.length) {
    const m = memberFromRow(rows[idx - 1]);
    if (normName(m.name) === target) return m;
  }

  if (!target) return null;
  const hits = [];
  for (let i = 1; i < rows.length; i++) {
    if (normName(rows[i][MCOL.NAME - 1]) === target) hits.push(memberFromRow(rows[i]));
  }
  return hits.length === 1 ? hits[0] : null;
}

// Create a per-meeting attendance tab with the right headers and text-formatted
// ID columns (so barcodes like "083" or "ALBERS-MARK" keep their exact value).
function newMeetingTab(ss, tabName) {
  const sheet = ss.insertSheet(tabName);
  // 'Notes' is intentionally left blank by the system — it's a free column for
  // the points master to annotate check-ins by hand.
  sheet.appendRow(['Timestamp', 'Name', 'Source', 'Barcode ID', 'Unique ID', 'Notes']);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 4, sheet.getMaxRows(), 2).setNumberFormat('@'); // Barcode ID + Unique ID
  sheet.setColumnWidth(6, 280); // Notes
  return sheet;
}

// Run this ONCE from the Apps Script editor (Run → authorizeExternalRequest) to
// grant the UrlFetchApp permission. It uses no UI, so it completes instantly and
// triggers Google's consent screen instead of hanging like a menu function would.
function authorizeExternalRequest() {
  const resp = UrlFetchApp.fetch('https://www.google.com', { muteHttpExceptions: true });
  Logger.log('External requests authorized. Test fetch returned HTTP ' + resp.getResponseCode());
}

// Pull the member directory from the timing-software CSV export and rewrite the
// Members tab. The export URL changes each time (dated filename), so this prompts
// for it and remembers the last one used.
function syncMembers() {
  const ui    = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();
  const saved = props.getProperty('MEMBERS_CSV_URL') || '';

  const res = ui.prompt('Sync Members',
    (saved ? `Last URL:\n${saved}\n\n` : '') +
    'Paste the CSV export URL (or leave blank to reuse the last one):',
    ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;

  const url = res.getResponseText().trim() || saved;
  if (!url) { ui.alert('No URL provided.'); return; }

  let text;
  try {
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    if (resp.getResponseCode() !== 200) {
      ui.alert(`Could not fetch the CSV (HTTP ${resp.getResponseCode()}). Check the URL is correct and public.`);
      return;
    }
    text = resp.getContentText();
  } catch (err) {
    ui.alert('Fetch failed: ' + err.message);
    return;
  }

  const table = Utilities.parseCsv(text);
  if (!table || table.length < 2) { ui.alert('The CSV looks empty.'); return; }

  // Row 0 is the header (UniqueID, Barcode, CarID, FirstName, LastName).
  const out = [];
  for (let i = 1; i < table.length; i++) {
    const r = table[i];
    if (!r || r.length <= CSV.LAST_NAME) continue;
    const name = (String(r[CSV.FIRST_NAME] || '').trim() + ' ' + String(r[CSV.LAST_NAME] || '').trim()).trim();
    if (!name) continue;
    out.push([
      String(r[CSV.UNIQUE_ID] || '').trim(),
      String(r[CSV.BARCODE]   || '').trim(),
      name,
    ]);
  }
  if (out.length === 0) { ui.alert('No member rows found in the CSV.'); return; }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(MEMBERS_TAB);
  if (!sheet) sheet = ss.insertSheet(MEMBERS_TAB);

  sheet.clearContents();
  sheet.getRange(1, MCOL.UNIQUE_ID, sheet.getMaxRows()).setNumberFormat('@');
  sheet.getRange(1, MCOL.BARCODE,   sheet.getMaxRows()).setNumberFormat('@');
  sheet.getRange(1, 1, 1, 3).setValues([['Unique ID', 'Barcode', 'Name']]);
  sheet.getRange(2, 1, out.length, 3).setValues(out);
  sheet.setFrozenRows(1);

  props.setProperty('MEMBERS_CSV_URL', url);
  CacheService.getScriptCache().remove('members'); // typeahead picks up the new list
  ui.alert(`Synced ${out.length} members from the CSV.`);
}

// Prompt the organizer to choose a meeting. Returns { name, tab } or null.
function pickMeeting(title) {
  const ui    = SpreadsheetApp.getUi();
  const index = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(MEETINGS_TAB);
  if (!index) { ui.alert('Meetings tab not found.'); return null; }

  const data = index.getDataRange().getDisplayValues();
  const meetings = [];
  for (let i = 1; i < data.length; i++) {
    if (data[i][COL.MEETING_NAME - 1]) {
      meetings.push({ name: data[i][COL.MEETING_NAME - 1], tab: data[i][COL.TAB_NAME - 1] });
    }
  }
  if (meetings.length === 0) { ui.alert('No meetings yet.'); return null; }
  if (meetings.length === 1) return meetings[0];

  const list   = meetings.map((m, i) => `${i + 1}. ${m.name}`).join('\n');
  const result = ui.prompt(title, `Meetings:\n${list}\n\nEnter number:`, ui.ButtonSet.OK_CANCEL);
  if (result.getSelectedButton() !== ui.Button.OK) return null;
  const idx = parseInt(result.getResponseText().trim(), 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= meetings.length) { ui.alert('Invalid selection.'); return null; }
  return meetings[idx];
}

// Name → member map from the Members tab, excluding names shared by 2+ members
// (ambiguous, so we can't safely auto-assign a barcode).
function membersByName() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(MEMBERS_TAB);
  const map = {}, dupes = {};
  if (!sheet || sheet.getLastRow() < 2) return map;
  const rows = sheet.getDataRange().getDisplayValues();
  for (let i = 1; i < rows.length; i++) {
    const key = normName(rows[i][MCOL.NAME - 1]);
    if (!key) continue;
    if (map[key]) { dupes[key] = true; continue; }
    map[key] = memberFromRow(rows[i]);
  }
  Object.keys(dupes).forEach(k => delete map[k]);
  return map;
}

// Repair an existing meeting tab: ensure the headers and text formatting are
// correct, then re-pull each check-in's Barcode ID and Unique ID from the
// Members directory by matching on name. Fixes leading-zero loss (83 → 083) and
// backfills the Unique ID column on tabs created before it existed.
function fixMeetingTab() {
  const ui = SpreadsheetApp.getUi();
  const meeting = pickMeeting('Repair Barcodes');
  if (!meeting) return;

  const tab = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(meeting.tab);
  if (!tab) { ui.alert(`Tab "${meeting.tab}" not found.`); return; }

  // Normalize headers + formatting.
  tab.getRange(1, 1, 1, 6).setValues([['Timestamp', 'Name', 'Source', 'Barcode ID', 'Unique ID', 'Notes']]);
  tab.setFrozenRows(1);
  tab.getRange(2, 1, Math.max(tab.getMaxRows() - 1, 1), 1).setNumberFormat('M/d/yyyy H:mm:ss'); // reveal stored time
  tab.getRange(1, 4, tab.getMaxRows(), 2).setNumberFormat('@'); // Barcode ID + Unique ID

  const last = tab.getLastRow();
  if (last < 2) { ui.alert(`No check-ins recorded for "${meeting.name}".`); return; }

  const map     = membersByName();
  const names   = tab.getRange(2, 2, last - 1, 1).getValues();
  const current = tab.getRange(2, 4, last - 1, 2).getDisplayValues();
  const out = [];
  let matched = 0, corrected = 0, unmatched = 0;

  for (let i = 0; i < names.length; i++) {
    const m = map[normName(names[i][0])];
    if (m) {
      matched++;
      if (String(current[i][0]).trim() !== m.barcode || String(current[i][1]).trim() !== m.uniqueId) corrected++;
      out.push([m.barcode, m.uniqueId]);
    } else {
      unmatched++;
      out.push([current[i][0], current[i][1]]); // leave as-is
    }
  }

  tab.getRange(2, 4, out.length, 2).setValues(out);
  ui.alert(`Repaired "${meeting.name}":\n\n${matched} matched to a member\n${corrected} barcode/ID values corrected\n${unmatched} left as-is (not in directory)`);
}

// Organizer view: pick a meeting and see its present barcodes sorted (to scroll
// alongside the timing software), plus any unmatched names to handle by hand.
function showAttendance() {
  const ui      = SpreadsheetApp.getUi();
  const meeting = pickMeeting('Show Attendance');
  if (!meeting) return;

  const tab = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(meeting.tab);
  if (!tab || tab.getLastRow() < 2) { ui.alert(`No check-ins recorded for "${meeting.name}".`); return; }

  const rows     = tab.getDataRange().getDisplayValues(); // Timestamp, Name, Source, Barcode ID, Unique ID
  const matched   = [];
  const unmatched = [];
  for (let i = 1; i < rows.length; i++) {
    const name     = String(rows[i][1] || '').trim();
    const barcode  = String(rows[i][3] || '').trim();
    const uniqueId = String(rows[i][4] || '').trim();
    if (!name) continue;
    if (barcode || uniqueId) matched.push({ barcode, uniqueId, name });
    else                     unmatched.push(name);
  }

  matched.sort((a, b) => a.barcode.localeCompare(b.barcode, undefined, { numeric: true }));
  const barcodeText = ['Barcode\tUnique ID\tName']
    .concat(matched.map(m => `${m.barcode}\t${m.uniqueId}\t${m.name}`))
    .join('\n');
  const unmatchedHtml = unmatched.length
    ? `<p style="margin-top:14px;color:#b8400a"><strong>${unmatched.length} unmatched (not in directory — add to Members or mark by hand):</strong><br>${unmatched.map(esc_).join('<br>')}</p>`
    : `<p style="margin-top:14px;color:#2a7a2a">All ${matched.length} check-ins matched a member.</p>`;

  const html = HtmlService.createHtmlOutput(`<!DOCTYPE html>
<html><body style="font-family:sans-serif;padding:16px;margin:0">
  <h3 style="margin-top:0">${esc_(meeting.name)}</h3>
  <p style="font-size:13px;color:#666">${matched.length} present, sorted by barcode. Copy to scroll alongside the timing software.</p>
  <textarea readonly style="width:100%;height:240px;font-family:monospace;font-size:13px"
            onclick="this.select()">${esc_(barcodeText)}</textarea>
  ${unmatchedHtml}
</body></html>`).setWidth(420).setHeight(460);

  ui.showModalDialog(html, 'Attendance');
}

// HTML-escape for organizer dialogs (server side).
function esc_(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

// Generate a 4-digit code unique among currently-open meetings.
function generateMeetingCode() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(MEETINGS_TAB);
  const taken = new Set();
  if (sheet) {
    const data = sheet.getDataRange().getDisplayValues();
    for (let i = 1; i < data.length; i++) {
      if (data[i][COL.STATUS - 1] === 'open') taken.add(String(data[i][COL.CODE - 1]).trim());
    }
  }
  let code;
  do {
    code = String(Math.floor(1000 + Math.random() * 9000)); // 1000–9999, no leading zero
  } while (taken.has(code));
  return code;
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
