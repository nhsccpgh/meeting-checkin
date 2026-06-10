'use strict';
// The name-normalizer and HTML-escaper are deliberately duplicated between
// Code.gs (server: member matching, organizer dialogs) and index.html (client:
// typeahead filtering, roster rendering). They must behave identically — the
// server matches on its copy while the client filters on its own, so drift
// shows up as "the name I picked didn't match" at a meeting. This suite
// extracts both copies from their sources and asserts equal behavior, turning
// drift into a CI failure instead.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const vm   = require('node:vm');

const root    = path.join(__dirname, '..');
const gsSrc   = fs.readFileSync(path.join(root, 'apps-script', 'Code.gs'), 'utf8');
const html    = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const htmlSrc = (html.match(/<script>([\s\S]*)<\/script>/) || [, ''])[1];

// Pull a top-level `function name(...) { ... }` out of a source string and
// compile it to a callable. Matches up to the first `}` at column 0.
function extractFn(src, name, where) {
  const m = src.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(m, `function ${name}() not found in ${where} — if it moved or was renamed, update this test`);
  return vm.runInNewContext(`(${m[0]})`);
}

test('normName behaves identically in Code.gs and index.html', () => {
  const server = extractFn(gsSrc, 'normName', 'apps-script/Code.gs');
  const client = extractFn(htmlSrc, 'normName', 'index.html');
  const samples = [
    'Matt Simmons', '  MATT   SIMMONS  ', "Mary-Jo O'Brien", 'José García',
    'A.B. de la Cruz III', 'ALBERS-MARK', '083', 'Ke$ha!!', '', '   ',
    null, undefined, 42,
  ];
  for (const s of samples) {
    assert.equal(server(s), client(s), `normName drift for input ${JSON.stringify(s)}`);
  }
});

test('the HTML escaper behaves identically in Code.gs (esc_) and index.html (esc)', () => {
  const server = extractFn(gsSrc, 'esc_', 'apps-script/Code.gs');
  const client = extractFn(htmlSrc, 'esc', 'index.html');
  const samples = [
    '<script>alert("x")</' + 'script>', `Bob & Carol's <car>`, '5 > 4 & 3 < 4',
    'plain name', '"quoted"', '', null, undefined, 0,
  ];
  for (const s of samples) {
    assert.equal(server(s), client(s), `escape drift for input ${JSON.stringify(s)}`);
  }
});
