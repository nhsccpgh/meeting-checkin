// Replace with your GitHub Pages URL (no trailing slash)
const CHECKIN_PAGE_URL = 'https://YOUR-GITHUB-USERNAME.github.io/nhscc-meeting';
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
    sheet.appendRow(['Token', 'Meeting Name', 'Tab Name', 'Status', 'Opens At', 'Closes At', 'Created At', 'Check-in URL']);
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(COL.TOKEN, 280);
    sheet.setColumnWidth(COL.CHECKIN_URL, 340);
  }
  Logger.log('Setup complete. Meetings tab is ready.');
}

// ── Organizer menu ────────────────────────────────────────────────────────────

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('NHSCC')
    .addItem('New Meeting', 'createMeeting')
    .addItem('Close Meeting', 'closeMeeting')
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
    .appendRow([token, meetingName, tabName, 'open', opensAt, closesAt, now, checkinUrl]);

  // Show URL + QR dialog
  const safeUrl = checkinUrl.replace(/'/g, '%27');
  const html = HtmlService.createHtmlOutput(`<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;padding:16px;margin:0">
  <h3 style="margin-top:0">${meetingName}</h3>
  <p style="word-break:break-all"><strong>Check-in URL:</strong><br>
    <a href="${checkinUrl}" target="_blank">${checkinUrl}</a>
  </p>
  <div id="qr"></div>
  <p style="font-size:12px;color:#666;margin-top:12px">
    Save or screenshot this QR code. Project it at the meeting and paste the link in Zoom chat.
  </p>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
  <script>new QRCode(document.getElementById('qr'), {text:'${safeUrl}',width:240,height:240});</script>
</body>
</html>`).setWidth(340).setHeight(460);

  ui.showModalDialog(html, 'Meeting Created');
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

// ── Web app endpoints ─────────────────────────────────────────────────────────

// Receive a check-in.
// Body is sent as text/plain JSON to avoid CORS preflight.
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const { token, name, source } = body;

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
    if (opensAt  && now < new Date(opensAt))  return jsonResponse({ ok: false, error: 'Meeting has not opened yet' });
    if (closesAt && now > new Date(closesAt)) return jsonResponse({ ok: false, error: 'Meeting has closed' });

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
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][COL.TOKEN - 1] === token) {
      return { row: i + 1, data: data[i] };
    }
  }
  return null;
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
