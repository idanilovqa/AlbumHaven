const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');


const css = fs.readFileSync(
  path.join(__dirname, '..', '..', 'music_app', 'static', 'css', 'admin-members.css'),
  'utf8',
);

test('Phase 7 Members roster becomes a bounded mobile card list', () => {
  const mobile = css.match(/@media\s*\(max-width:\s*720px\)\s*\{([^]*)\}\s*$/)?.[1] || '';
  assert.match(mobile, /\.members-table\s*\{[^}]*overflow-x:\s*visible/s);
  assert.match(mobile, /\.members-row\s*\{[^}]*min-width:\s*0[^}]*grid-template-columns:\s*1fr\s+1fr/s);
  assert.match(mobile, /\.members-table-head\s*\{[^}]*display:\s*none/s);
  assert.match(mobile, /\.member-identity\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/s);
});
