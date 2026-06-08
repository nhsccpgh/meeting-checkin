// Replace with your GitHub Pages URL (no trailing slash)
const CHECKIN_PAGE_URL = 'https://meetings.nhscc.com';
const MEETINGS_TAB = 'Meetings';

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

// Run once from the Apps Script editor (Run → setup) after pasting this file.
// Safe to run again — will not overwrite existing data.
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
  Logger.log('Setup complete. Meetings tab is ready.');
}

// ── Organizer menu ────────────────────────────────────────────────────────────

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('NHSCC')
    .addItem('New Meeting',  'createMeeting')
    .addItem('Show QR',      'showQR')
    .addItem('Close Meeting','closeMeeting')
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
  const tabName   = meetingName.replace(/[\/\\?\*\[\]:]/g, '').substring(0, 100).trim();
  const now       = new Date();
  const opensAt   = opensText  ? new Date(opensText)  : '';
  const closesAt  = closesText ? new Date(closesText) : '';
  const checkinUrl = `${CHECKIN_PAGE_URL}?m=${token}`;

  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // Create the per-meeting tab
  let meetingSheet = ss.getSheetByName(tabName);
  if (!meetingSheet) {
    meetingSheet = ss.insertSheet(tabName);
    meetingSheet.appendRow(['Timestamp', 'Name', 'Source']);
    meetingSheet.setFrozenRows(1);
  }

  // Append to the Meetings index
  ss.getSheetByName(MEETINGS_TAB)
    .appendRow([token, meetingName, tabName, 'open', opensAt, closesAt, now, checkinUrl, code]);

  ui.showModalDialog(meetingDialogHtml(meetingName, checkinUrl, code), 'Meeting Created');
}

function closeMeeting() {
  const ui = SpreadsheetApp.getUi();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(MEETINGS_TAB);
  if (!sheet) { ui.alert('Meetings tab not found.'); return; }

  const data = sheet.getDataRange().getValues();
  const open = [];
  for (let i = 1; i < data.length; i++) {
    if (data[i][COL.STATUS - 1] === 'open') {
      open.push({ row: i + 1, name: data[i][COL.MEETING_NAME - 1] });
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
  ui.alert(`"${open[idx].name}" is now closed.`);
}

function showQR() {
  const ui    = SpreadsheetApp.getUi();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(MEETINGS_TAB);
  if (!sheet) { ui.alert('Meetings tab not found.'); return; }

  const data = sheet.getDataRange().getDisplayValues();
  const open = [];
  for (let i = 1; i < data.length; i++) {
    if (data[i][COL.STATUS - 1] === 'open') {
      open.push({
        name: data[i][COL.MEETING_NAME - 1],
        url:  data[i][COL.CHECKIN_URL - 1],
        code: data[i][COL.CODE - 1],
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
  <h3 style="margin-top:0">${name}</h3>
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

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      let meetingSheet = ss.getSheetByName(tabName);
      if (!meetingSheet) {
        meetingSheet = ss.insertSheet(tabName);
        meetingSheet.appendRow(['Timestamp', 'Name', 'Source']);
        meetingSheet.setFrozenRows(1);
      }
      // Duplicate guard — case-insensitive name match
      if (meetingSheet.getLastRow() > 1) {
        const names = meetingSheet.getRange(2, 2, meetingSheet.getLastRow() - 1, 1).getValues();
        const nameLower = name.trim().toLowerCase();
        if (names.some(r => String(r[0]).toLowerCase() === nameLower)) {
          return jsonResponse({ ok: false, error: 'Already checked in' });
        }
      }
      meetingSheet.appendRow([now, name.trim(), source]);
    } finally {
      lock.releaseLock();
    }

    return jsonResponse({ ok: true });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message });
  }
}

// Return the roster (or just metadata if action=meta).
function doGet(e) {
  try {
    if (!e || !e.parameter) return jsonResponse({ ok: false, error: 'No request parameters' });

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

    const meeting = findMeeting(token);
    if (!meeting) return jsonResponse({ ok: false, error: 'Unknown meeting' });

    const [, meetingName, tabName, status] = meeting.data;

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

    return jsonResponse({ ok: true, meetingName, status, checkins });
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

// Look up an open meeting by its 6-digit backup code. Returns { token } or null.
// Only matches open meetings, so a code freed by a closed meeting can be reused safely.
function findMeetingByCode(code) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(MEETINGS_TAB);
  if (!sheet) return null;
  // Single read: token, status, and code are all plain strings, so the
  // display values are sufficient (no need for a second getValues() call).
  const display = sheet.getDataRange().getDisplayValues();
  const wanted  = String(code).trim();
  for (let i = 1; i < display.length; i++) {
    if (display[i][COL.STATUS - 1] === 'open' &&
        String(display[i][COL.CODE - 1]).trim() === wanted) {
      return { token: display[i][COL.TOKEN - 1] };
    }
  }
  return null;
}

// Generate a 6-digit code unique among currently-open meetings.
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
