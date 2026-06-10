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

const MEETINGS_HEADER = ['Token', 'Meeting Name', 'Tab Name', 'Status', 'Opens At', 'Closes At', 'Created At', 'Check-in URL', 'Code', 'Reminder Sent'];

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
  assert.deepEqual(tab.data[0], ['Timestamp', 'Name', 'Source', 'Barcode ID', 'Unique ID', 'Device', 'Notes']);
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

test('doPost records a sanitized device tag in column 6 and never touches Notes (last column)', () => {
  const { api, ss } = loadCode();
  seedMeeting(ss);

  post(api, { token: 'tok-1', name: 'Ann Yu', source: 'Zoom', device: 'abc-DEF_123' });
  post(api, { token: 'tok-1', name: 'Bo Diaz', source: 'Zoom', device: ' we<i>rd $tag!! ' });
  post(api, { token: 'tok-1', name: 'Cy Moss', source: 'Zoom' }); // no device — allowed

  const tab = ss.getSheetByName('June 2026');
  assert.equal(tab.data[1][5], 'abc-DEF_123');
  assert.equal(tab.data[2][5], 'weirdtag', 'device tag is stripped to word chars and dashes');
  assert.equal(tab.data[3][5] ?? '', '');
  for (const row of [tab.data[1], tab.data[2], tab.data[3]]) {
    // ?? '' because the mock leaves never-written trailing cells undefined,
    // where real Sheets reads ''.
    assert.equal(row[6] ?? '', '', 'Notes column stays untouched');
  }
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

test('doGet reports notYetOpen with the open time for a future Opens At', () => {
  const { api, ss } = loadCode();
  const opens = future();
  seedMeeting(ss, { opensAt: opens });

  const res = get(api, { token: 'tok-1' });
  assert.equal(res.status, 'notYetOpen');
  assert.equal(res.opensAt, opens.toISOString());
  assert.equal(get(api, { token: 'tok-1', action: 'meta' }).status, 'notYetOpen');
});

test('a passed Opens At is plain open', () => {
  const { api, ss } = loadCode();
  seedMeeting(ss, { opensAt: past() });

  const res = get(api, { token: 'tok-1' });
  assert.equal(res.status, 'open');
  assert.equal(res.opensAt, '');
});

test('a not-yet-open meeting still resolves by code, so QRs/codes work in advance', () => {
  const { api, ss } = loadCode();
  seedMeeting(ss, { token: 'early-tok', opensAt: future(), code: '4321' });

  assert.deepEqual(get(api, { action: 'resolve', code: '4321' }), { ok: true, token: 'early-tok' });
});

test('doGet reports a time-expired meeting as closed even though Status still says open', () => {
  const { api, ss } = loadCode();
  seedMeeting(ss, { closesAt: past() });

  assert.equal(get(api, { token: 'tok-1' }).status, 'closed');
  assert.equal(get(api, { token: 'tok-1', action: 'meta' }).status, 'closed');
});

test('action=version reports the baked deploy marker', () => {
  const { api } = loadCode();
  assert.deepEqual(get(api, { action: 'version' }), { ok: true, version: 'dev' });
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

test('thirdWednesday lands on the third Wednesday at the given time', () => {
  const { api } = loadCode();
  for (const [y, m] of [[2026, 0], [2026, 5], [2026, 11], [2027, 1], [2028, 1]]) {
    const d = api.thirdWednesday(y, m, 19, 0);
    assert.equal(d.getFullYear(), y);
    assert.equal(d.getMonth(), m);
    assert.equal(d.getDay(), 3, 'must be a Wednesday');
    assert.equal(d.getHours(), 19);
    // Independent check: it must be the 3rd Wednesday, counted from the 1st.
    let wednesdays = 0;
    for (let day = 1; day <= d.getDate(); day++) {
      if (new Date(y, m, day).getDay() === 3) wednesdays++;
    }
    assert.equal(wednesdays, 3);
  }
});

test('createMeetingRecord writes the index row and suffixes a taken tab name', () => {
  const { api, ss } = loadCode();
  api.setup();

  const a = api.createMeetingRecord('July 2026', '', '');
  const b = api.createMeetingRecord('July 2026', '', '');
  assert.equal(a.tabName, 'July 2026');
  assert.equal(b.tabName, 'July 2026 (2)');
  assert.ok(ss.getSheetByName('July 2026 (2)'), 'suffixed tab exists');

  const idx = ss.getSheetByName('Meetings');
  assert.equal(idx.getLastRow(), 3); // header + 2 meetings
  const row = idx.data[1];
  assert.equal(row[1], 'July 2026');
  assert.equal(row[3], 'open');
  assert.ok(String(row[7]).includes(a.token), 'check-in URL embeds the token');
  assert.match(String(row[8]), /^\d{4}$/);
});

test('bulkCreateMonthly creates 7–9 PM third-Wednesday meetings and skips existing/passed/bad months', () => {
  const { api, ss } = loadCode();
  api.setup();
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const keyFor = monthsAhead => {
    const d = new Date(now.getFullYear(), now.getMonth() + monthsAhead, 1);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  };

  const created = api.bulkCreateMonthly([keyFor(2), keyFor(3), 'garbage']);
  assert.match(created[0], /: created — code \d{4}$/);
  assert.match(created[1], /: created — code \d{4}$/);
  assert.match(created[2], /skipped \(bad month\)/);

  const idx = ss.getSheetByName('Meetings');
  assert.equal(idx.getLastRow(), 3); // header + 2 created
  for (const row of [idx.data[1], idx.data[2]]) {
    assert.equal(row[3], 'open');
    assert.equal(row[4].getDay(), 3, 'opens on a Wednesday');
    assert.equal(row[4].getHours(), 19);
    assert.equal(row[5].getHours(), 21);
    assert.equal(row[4].getDate(), row[5].getDate(), 'opens and closes the same day');
  }

  // Re-running the same months must not duplicate.
  const again = api.bulkCreateMonthly([keyFor(2), keyFor(36)]);
  assert.match(again[0], /skipped \(already exists\)/);
  assert.match(again[1], /: created — code \d{4}$/); // far future is fine
  assert.match(String(api.bulkCreateMonthly([`${now.getFullYear() - 1}-01`])[0]), /skipped \(already passed\)/);
  assert.equal(idx.getLastRow(), 4);
});

test('a bulk-created meeting is checkin-able end to end inside its window', () => {
  const { api, ss } = loadCode();
  api.setup();
  // Seed a normal meeting through the shared creation path, then force its
  // window open and verify doPost accepts a check-in against it.
  const rec = api.createMeetingRecord('Window Test', new Date(Date.now() - HOUR), new Date(Date.now() + HOUR));
  const res = post(api, { token: rec.token, name: 'Ann Yu', source: 'In person' });
  assert.deepEqual(res, { ok: true });
  assert.equal(ss.getSheetByName('Window Test').getLastRow(), 2);
});

test('closeExpiredMeetings flips expired meetings to closed and announces to Discord', () => {
  const { api, ss, cache, props, fetches } = loadCode();
  props.set('DISCORD_WEBHOOK_URL', 'https://discord.com/api/webhooks/test');

  seedMeeting(ss, { token: 'expired-tok', name: 'June 2026', tab: 'June 2026', closesAt: past(), code: '1111' });
  seedMeeting(ss, { token: 'future-tok', tab: 'T2', closesAt: future(), code: '2222' });
  seedMeeting(ss, { token: 'manual-tok', tab: 'T3', code: '3333' }); // no Closes At — manual close only
  const tab = ss.insertSheet('June 2026');
  tab.appendRow(['Timestamp', 'Name', 'Source', 'Barcode ID', 'Unique ID', 'Device', 'Notes']);
  tab.appendRow([new Date(), 'Ann Yu', 'In person', '011', '1', '', '']);
  tab.appendRow([new Date(), 'Bo Diaz', 'Zoom', '', '', '', '']); // unmatched
  cache.put('roster:expired-tok', '{"ok":true}');

  api.closeExpiredMeetings();

  const idx = ss.getSheetByName('Meetings');
  assert.equal(idx.data[1][3], 'closed', 'expired meeting flipped');
  assert.equal(idx.data[2][3], 'open', 'future meeting untouched');
  assert.equal(idx.data[3][3], 'open', 'no-Closes-At meeting untouched');
  assert.ok(!cache.map.has('roster:expired-tok'), 'roster cache busted');

  assert.equal(fetches.length, 1);
  const payload = JSON.parse(fetches[0].opts.payload);
  assert.ok(payload.content.includes('June 2026'), 'announces the meeting name');
  assert.ok(payload.content.includes('2 checked in (1 in person, 1 Zoom)'), 'announces the counts');
  assert.ok(payload.content.includes('1 unmatched name'), 'announces unmatched count');
  assert.ok(payload.content.includes('https://sheets.test/spreadsheet#gid='), 'links to the tab');

  // Idempotent: a second run finds nothing open+expired, so no second post.
  api.closeExpiredMeetings();
  assert.equal(fetches.length, 1);
});

test('postToDiscord_ retries through a 429 rate limit and reports the final status', () => {
  const { api, props, fetches, fetchResults } = loadCode();
  props.set('DISCORD_WEBHOOK_URL', 'https://discord.com/api/webhooks/test');

  fetchResults.push(429, 204); // rate-limited once, then accepted
  assert.equal(api.postToDiscord_('hello'), 204);
  assert.equal(fetches.length, 2, 'retried after the 429');

  fetchResults.push(429, 429, 429); // persistently rate-limited
  assert.equal(api.postToDiscord_('hello again'), 429, 'gives up after 3 attempts and reports it');
  assert.equal(fetches.length, 5);
});

test('the janitor posts a reminder with link and code in the hour before a meeting opens, once', () => {
  const { api, ss, props, fetches } = loadCode();
  props.set('DISCORD_WEBHOOK_URL', 'https://discord.com/api/webhooks/test');

  const soon = new Date(Date.now() + 30 * 60 * 1000); // opens in 30 minutes
  seedMeeting(ss, { token: 'soon-tok', name: 'June 2026', tab: 'June 2026', opensAt: soon, closesAt: future(), code: '4242' });
  seedMeeting(ss, { token: 'later-tok', tab: 'T2', opensAt: new Date(Date.now() + 3 * 3600 * 1000), code: '5555' });

  api.closeExpiredMeetings();

  assert.equal(fetches.length, 1, 'only the imminent meeting is announced');
  const content = JSON.parse(fetches[0].opts.payload).content;
  assert.ok(content.includes('June 2026'));
  assert.ok(content.includes('4242'), 'includes the backup code');
  assert.ok(content.includes('soon-tok'), 'includes the check-in link');
  assert.ok(ss.getSheetByName('Meetings').data[1][9] instanceof Date, 'Reminder Sent is stamped');

  api.closeExpiredMeetings();
  assert.equal(fetches.length, 1, 'no duplicate reminder on the next run');
});

test('a rate-limited reminder is not marked sent, so the next run retries it', () => {
  const { api, ss, props, fetches, fetchResults } = loadCode();
  props.set('DISCORD_WEBHOOK_URL', 'https://discord.com/api/webhooks/test');
  seedMeeting(ss, { opensAt: new Date(Date.now() + 30 * 60 * 1000), closesAt: future() });

  fetchResults.push(429, 429, 429); // Discord rejects all three attempts
  api.closeExpiredMeetings();
  assert.equal(ss.getSheetByName('Meetings').data[1][9] ?? '', '', 'not marked sent');

  api.closeExpiredMeetings(); // next 15-min run, Discord healthy again
  assert.equal(fetches.length, 4);
  assert.ok(ss.getSheetByName('Meetings').data[1][9] instanceof Date);
});

test('closeExpiredMeetings without a webhook closes silently', () => {
  const { api, ss, fetches } = loadCode();
  seedMeeting(ss, { closesAt: past() });

  api.closeExpiredMeetings();

  assert.equal(ss.getSheetByName('Meetings').data[1][3], 'closed');
  assert.equal(fetches.length, 0);
});

test('setup creates the Meetings and Members tabs with headers, and is idempotent', () => {
  const { api, ss } = loadCode();
  api.setup();
  api.setup();
  assert.deepEqual(ss.getSheetByName('Meetings').data[0], MEETINGS_HEADER);
  assert.deepEqual(ss.getSheetByName('Members').data[0], ['Unique ID', 'Barcode', 'Name']);
  assert.equal(ss.getSheetByName('Meetings').getLastRow(), 1);
});
