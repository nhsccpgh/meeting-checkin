'use strict';
// In-memory mocks of the Apps Script services Code.gs touches, plus a loader
// that evaluates Code.gs in a vm sandbox wired to them.
//
// The mock sheet is deliberately dumb: it stores exactly what you write and
// does NOT reproduce Google Sheets' coercions (auto-dates, leading-zero loss,
// number formats). Tests here cover Code.gs logic; Sheets' quirks still need
// a smoke test against the real sheet.

const fs   = require('node:fs');
const path = require('node:path');
const vm   = require('node:vm');

class MockRange {
  constructor(sheet, row, col, numRows = 1, numCols = 1) {
    this.sheet = sheet;
    this.row = row;
    this.col = col;
    this.numRows = numRows;
    this.numCols = numCols;
  }
  setNumberFormat() { return this; }
  setWrapStrategy() { return this; }
  setValue(v) { return this.setValues([[v]]); }
  setValues(vals) {
    this.sheet._ensure(this.row - 1 + vals.length, this.col - 1 + Math.max(...vals.map(r => r.length)));
    vals.forEach((rowVals, i) => rowVals.forEach((v, j) => {
      this.sheet.data[this.row - 1 + i][this.col - 1 + j] = v;
    }));
    return this;
  }
  getValue() { return this.getValues()[0][0]; }
  getValues() {
    const out = [];
    for (let i = 0; i < this.numRows; i++) {
      const row = [];
      for (let j = 0; j < this.numCols; j++) {
        const v = (this.sheet.data[this.row - 1 + i] || [])[this.col - 1 + j];
        row.push(v === undefined ? '' : v);
      }
      out.push(row);
    }
    return out;
  }
  getDisplayValues() {
    return this.getValues().map(r => r.map(v => {
      if (v instanceof Date) return v.toLocaleString('en-US');
      return String(v ?? '');
    }));
  }
}

let nextSheetId = 100;

class MockSheet {
  constructor(name) {
    this.name = name;
    this.id   = nextSheetId++;
    this.data = []; // 2D array, row 0 = sheet row 1
  }
  getSheetId() { return this.id; }
  _ensure(rows, cols) {
    while (this.data.length < rows) this.data.push([]);
    this.data.forEach(r => { while (r.length < cols) r.push(''); });
  }
  getName() { return this.name; }
  getLastRow() { return this.data.length; }
  getMaxRows() { return Math.max(this.data.length, 1000); }
  getRange(row, col, numRows = 1, numCols = 1) { return new MockRange(this, row, col, numRows, numCols); }
  getDataRange() {
    const cols = Math.max(1, ...this.data.map(r => r.length), 0);
    return new MockRange(this, 1, 1, Math.max(this.data.length, 1), cols);
  }
  appendRow(row) {
    // Array.from re-realms rows the vm hands us, so tests' deepStrictEqual
    // (which compares prototypes) sees ordinary host arrays.
    this.data.push(Array.from(row));
    const cols = Math.max(...this.data.map(r => r.length));
    this._ensure(this.data.length, cols);
    return this;
  }
  clearContents() { this.data = []; return this; }
  setFrozenRows() { return this; }
  setColumnWidth() { return this; }
}

class MockSpreadsheet {
  constructor() { this.sheets = new Map(); }
  getUrl() { return 'https://sheets.test/spreadsheet'; }
  getSheetByName(name) { return this.sheets.get(name) || null; }
  insertSheet(name) {
    const sheet = new MockSheet(name);
    this.sheets.set(name, sheet);
    return sheet;
  }
}

class MockCache {
  constructor() { this.map = new Map(); }
  get(k) { return this.map.has(k) ? this.map.get(k) : null; }
  put(k, v) { this.map.set(k, String(v)); }
  remove(k) { this.map.delete(k); }
}

// Evaluate Code.gs against fresh mocks. Returns { api, ss, cache } where api
// holds the script's functions bound to this sandbox.
function loadCode() {
  const ss      = new MockSpreadsheet();
  const cache   = new MockCache();
  const props   = new Map(); // script properties
  const fetches = [];        // recorded UrlFetchApp calls
  const sandbox = {
    // Date must be the host's so `instanceof Date` works on test-seeded values.
    Date,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      getUi: () => { throw new Error('getUi() is not available in tests — menu functions are untested by design'); },
      WrapStrategy: { CLIP: 'CLIP', WRAP: 'WRAP', OVERFLOW: 'OVERFLOW' },
    },
    CacheService: { getScriptCache: () => cache },
    LockService:  { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: text => ({
        _text: text,
        setMimeType() { return this; },
        getContent() { return this._text; },
      }),
    },
    Utilities: {
      getUuid: () => 'mock-uuid-' + Math.random().toString(36).slice(2),
      parseCsv: () => { throw new Error('parseCsv not mocked'); },
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => (props.has(k) ? props.get(k) : null),
        setProperty(k, v) { props.set(k, String(v)); },
        deleteProperty(k) { props.delete(k); },
      }),
    },
    HtmlService: { createHtmlOutput: html => ({ html, setWidth() { return this; }, setHeight() { return this; } }) },
    UrlFetchApp: {
      fetch: (url, opts) => {
        fetches.push({ url, opts });
        return { getResponseCode: () => 200, getContentText: () => '' };
      },
    },
    Logger: { log() {} },
  };

  const src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  const api = vm.runInNewContext(
    src + '\n;({ doGet, doPost, findMeeting, findMeetingByCode, isMeetingOpen, matchMember, listMembers, generateMeetingCode, normName, newMeetingTab, setup, createMeetingRecord, thirdWednesday, meetingNameExists, bulkCreateMonthly, closeExpiredMeetings })',
    sandbox,
    { filename: 'Code.gs' }
  );
  return { api, ss, cache, props, fetches };
}

module.exports = { loadCode };
