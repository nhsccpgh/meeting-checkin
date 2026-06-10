'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadCode } = require('./gas-mocks');

const HOUR = 3600 * 1000;
const past   = () => new Date(Date.now() - HOUR);
const future = () => new Date(Date.now() + HOUR);

const parse = res => JSON.parse(res.getContent());
const get   = (api, params) => parse(api.doGet({ parameter: params }));
const post  = (api, body) => parse(api.doPost({ postData: { contents: JSON.stringify(body) } }));

const MEETINGS_HEADER = ['Token', 'Meeting Name', 'Tab Name', 'Status', 'Opens At', 'Closes At', 'Created At', 'Check-in URL', 'Code'];

function seedMeeting(ss, { token = 'tok-1', name = 'June 2026', tab = 'June 2026', status = 'open', opensAt = '', closesAt = '', code = '1234' } = {}) {
  let sheet = ss.getSheetByName('Meetings');
  if (!sheet) {
    sheet = ss.insertSheet('Meetings');
    sheet.appendRow(MEETINGS_HEADER);
  }
  sheet.appendRow([token, name, tab, status, opensAt, closesAt, new Date(), `https://meetings.nhscc.com?m=${token}`, code]);
}

function seedMembers(ss, rows) {
  const sheet = ss.insertSheet('Members');
  sheet.appendRow(['Unique ID', 'Barcode', 'Name']);
  rows.forEach(r => sheet.appendRow(r));
}

// ── doPost ────────────────────────────────────────────────────────────────────

test('check-in happy path: title-cases the name, matches the member, creates the tab', () => {
  const { api, ss } = loadCode();
  seedMeeting(ss);
  seedMembers(ss, [['7', '083', 'Matt Simmons']]);

  const res = post(api, { token: 'tok-1', name: 'matt simmons', source: 'In person' });
  assert.deepEqual(res, { ok: true });

  const tab = ss.getSheetByName('June 2026');
  assert.ok(tab, 'meeting tab is created defensively when missing');
  assert.deepEqual(tab.data[0], ['Timestamp', 'Name', 'Source', 'Barcode ID', 'Unique ID', 'Notes']);
  const [ts, name, source, barcode, uniqueId] = tab.data[1];
  assert.ok(ts instanceof Date);
  assert.equal(name, 'Matt Simmons'); // canonical directory name, title-cased input matched
  assert.equal(source, 'In person');
  assert.equal(barcode, '083');
  assert.equal(uniqueId, '7');
});

test('check-in via memberIndex attaches that exact member', () => {
  const { api, ss } = loadCode();
  seedMeeting(ss);
  seedMembers(ss, [['1', '011', 'Ann Yu'], ['2', '022', 'Bo Diaz']]);

  // Members-tab row 3 is Bo Diaz
  const res = post(api, { token: 'tok-1', name: 'Bo Diaz', source: 'Zoom', memberIndex: 3 });
  assert.deepEqual(res, { ok: true });
  assert.equal(ss.getSheetByName('June 2026').data[1][3], '022');
});

test('a mismatched memberIndex falls back to name matching', () => {
  const { api, ss } = loadCode();
  seedMeeting(ss);
  seedMembers(ss, [['1', '011', 'Ann Yu'], ['2', '022', 'Bo Diaz']]);

  // Index points at Ann but the name says Bo — the name wins.
  const res = post(api, { token: 'tok-1', name: 'Bo Diaz', source: 'Zoom', memberIndex: 2 });
  assert.deepEqual(res, { ok: true });
  assert.equal(ss.getSheetByName('June 2026').data[1][3], '022');
});

test('ambiguous member names record no barcode', () => {
  const { api, ss } = loadCode();
  seedMeeting(ss);
  seedMembers(ss, [['1', '011', 'Mike Smith'], ['2', '022', 'Mike Smith']]);

  const res = post(api, { token: 'tok-1', name: 'Mike Smith', source: 'In person' });
  assert.deepEqual(res, { ok: true });
  const row = ss.getSheetByName('June 2026').data[1];
  assert.equal(row[3], '');
  assert.equal(row[4], '');
});

test('duplicate check-in is success with alreadyCheckedIn, and writes no second row', () => {
  const { api, ss } = loadCode();
  seedMeeting(ss);

  assert.deepEqual(post(api, { token: 'tok-1', name: 'Rick Ortiz', source: 'In person' }), { ok: true });
  const res = post(api, { token: 'tok-1', name: 'RICK ortiz', source: 'Zoom' }); // case-insensitive
  assert.deepEqual(res, { ok: true, alreadyCheckedIn: true });
  assert.equal(ss.getSheetByName('June 2026').getLastRow(), 2); // header + one check-in
});

test('doPost rejects: missing fields, unknown token, closed status, time window', () => {
  const { api, ss } = loadCode();
  seedMeeting(ss, { token: 'closed-tok', tab: 'T1', status: 'closed', code: '1111' });
  seedMeeting(ss, { token: 'early-tok', tab: 'T2', opensAt: future(), code: '2222' });
  seedMeeting(ss, { token: 'late-tok', tab: 'T3', closesAt: past(), code: '3333' });

  assert.equal(post(api, { token: 'closed-tok', name: 'A', source: '' }).error, 'Missing fields');
  assert.equal(post(api, { token: 'nope', name: 'A B', source: 'Zoom' }).error, 'Unknown meeting');
  assert.equal(post(api, { token: 'closed-tok', name: 'A B', source: 'Zoom' }).error, 'Meeting is closed');
  assert.equal(post(api, { token: 'early-tok', name: 'A B', source: 'Zoom' }).error, 'Meeting has not opened yet');
  assert.equal(post(api, { token: 'late-tok', name: 'A B', source: 'Zoom' }).error, 'Meeting has closed');
});

// ── doGet ─────────────────────────────────────────────────────────────────────

test('doGet returns the roster', () => {
  const { api, ss } = loadCode();
  seedMeeting(ss);
  post(api, { token: 'tok-1', name: 'Ann Yu', source: 'Zoom' });

  const res = get(api, { token: 'tok-1' });
  assert.equal(res.ok, true);
  assert.equal(res.meetingName, 'June 2026');
  assert.equal(res.status, 'open');
  assert.equal(res.checkins.length, 1);
  assert.equal(res.checkins[0].name, 'Ann Yu');
  assert.equal(res.checkins[0].source, 'Zoom');
});

test('doGet reports a time-expired meeting as closed even though Status still says open', () => {
  const { api, ss } = loadCode();
  seedMeeting(ss, { closesAt: past() });

  assert.equal(get(api, { token: 'tok-1' }).status, 'closed');
  assert.equal(get(api, { token: 'tok-1', action: 'meta' }).status, 'closed');
});

test('doGet errors: no parameters, missing token, unknown token', () => {
  const { api } = loadCode();
  assert.equal(parse(api.doGet(undefined)).error, 'No request parameters');
  assert.equal(get(api, {}).error, 'Missing token');
  assert.equal(get(api, { token: 'nope' }).error, 'Unknown meeting');
});

test('action=members requires an open meeting token and never exposes barcodes', () => {
  const { api, ss } = loadCode();
  seedMeeting(ss);
  seedMeeting(ss, { token: 'closed-tok', tab: 'T1', status: 'closed', code: '5678' });
  seedMembers(ss, [['7', '083', 'Matt Simmons']]);

  assert.equal(get(api, { action: 'members' }).error, 'Unknown meeting');
  assert.equal(get(api, { action: 'members', token: 'closed-tok' }).error, 'Unknown meeting');

  const res = get(api, { action: 'members', token: 'tok-1' });
  assert.equal(res.ok, true);
  assert.equal(res.members.length, 1);
  assert.deepEqual(Object.keys(res.members[0]).sort(), ['i', 'name', 'q']); // no barcode/uniqueId
});

test('action=resolve maps a code to a token, but only while the meeting accepts check-ins', () => {
  const { api, ss } = loadCode();
  seedMeeting(ss, { token: 'open-tok', tab: 'T1', code: '1234' });
  seedMeeting(ss, { token: 'closed-tok', tab: 'T2', status: 'closed', code: '5678' });
  seedMeeting(ss, { token: 'expired-tok', tab: 'T3', closesAt: past(), code: '9012' });

  assert.equal(get(api, { action: 'resolve', code: '12' }).error, 'Enter the 4-digit code.');
  assert.deepEqual(get(api, { action: 'resolve', code: '1234' }), { ok: true, token: 'open-tok' });
  assert.equal(get(api, { action: 'resolve', code: '5678' }).ok, false);
  assert.equal(get(api, { action: 'resolve', code: '9012' }).ok, false, 'expired meeting must not resolve');
});

// ── Caching ───────────────────────────────────────────────────────────────────

test('roster is cached per token and busted by a check-in', () => {
  const { api, ss, cache } = loadCode();
  seedMeeting(ss);

  get(api, { token: 'tok-1' });
  assert.ok(cache.map.has('roster:tok-1'), 'first read populates the cache');

  // Cached responses are served verbatim, skipping the sheet read entirely.
  cache.put('roster:tok-1', JSON.stringify({ ok: true, sentinel: 'from-cache' }));
  assert.equal(get(api, { token: 'tok-1' }).sentinel, 'from-cache');

  post(api, { token: 'tok-1', name: 'Ann Yu', source: 'Zoom' });
  assert.ok(!cache.map.has('roster:tok-1'), 'check-in busts the cache');
  assert.equal(get(api, { token: 'tok-1' }).checkins.length, 1);
});

test('members list is cached', () => {
  const { api, ss, cache } = loadCode();
  seedMeeting(ss);
  seedMembers(ss, [['7', '083', 'Matt Simmons']]);

  get(api, { action: 'members', token: 'tok-1' });
  assert.ok(cache.map.has('members'));
});

// ── Helpers ───────────────────────────────────────────────────────────────────

test('isMeetingOpen: status and close-window combinations', () => {
  const { api } = loadCode();
  const row = (status, closesAt) => ['t', 'n', 'tab', status, '', closesAt, new Date(), 'url', '1234'];

  assert.equal(api.isMeetingOpen(row('open', '')), true);
  assert.equal(api.isMeetingOpen(row('open', future())), true);
  assert.equal(api.isMeetingOpen(row('open', past())), false);
  assert.equal(api.isMeetingOpen(row('closed', '')), false);
  assert.equal(api.isMeetingOpen(row('closed', future())), false);
  assert.equal(api.isMeetingOpen(row('open', 'not a date')), true, 'garbage Closes At must not lock the meeting');
});

test('generateMeetingCode avoids codes held by open meetings', () => {
  const { api, ss } = loadCode();
  seedMeeting(ss, { token: 't1', tab: 'T1', code: '1111' });
  seedMeeting(ss, { token: 't2', tab: 'T2', status: 'closed', code: '2222' });

  for (let i = 0; i < 200; i++) {
    const code = api.generateMeetingCode();
    assert.match(code, /^\d{4}$/);
    assert.notEqual(code, '1111');
  }
});

test('normName collapses case, punctuation, and spacing', () => {
  const { api } = loadCode();
  assert.equal(api.normName("  Mary-Jo  O'Brien "), 'mary jo o brien');
  assert.equal(api.normName('MATT SIMMONS'), 'matt simmons');
  assert.equal(api.normName(null), '');
});

test('setup creates the Meetings and Members tabs with headers, and is idempotent', () => {
  const { api, ss } = loadCode();
  api.setup();
  api.setup();
  assert.deepEqual(ss.getSheetByName('Meetings').data[0], MEETINGS_HEADER);
  assert.deepEqual(ss.getSheetByName('Members').data[0], ['Unique ID', 'Barcode', 'Name']);
  assert.equal(ss.getSheetByName('Meetings').getLastRow(), 1);
});
