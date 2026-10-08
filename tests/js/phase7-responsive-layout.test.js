const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');


const css = fs.readFileSync(
  path.join(__dirname, '..', '..', 'music_app', 'static', 'css', 'admin-members.css'),
  'utf8',
);

test('Phase 7 Members retains accessible table columns within the mobile container', () => {
  const markup = fs.readFileSync(path.join(__dirname, '../../music_app/templates/admin-members.html'), 'utf8');
  assert.match(markup, /class="members-table" role="table" aria-label="Managed users"/);
  assert.deepEqual([...markup.matchAll(/role="columnheader">([^<]+)</g)].map(match => match[1]),
    ['User', 'Role / access', 'Status', 'Sessions', 'Invitation', 'Actions']);
  const mobile = css.slice(css.indexOf('@media (max-width: 900px)'));
  assert.match(mobile, /\.members-table\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;[^}]*overflow:\s*visible/);
  assert.match(mobile, /\.members-row\s*\{[^}]*min-width:\s*0;[^}]*grid-template-columns:\s*minmax\(0, 1\.1fr\) minmax\(0, 1fr\) 40px/);
  assert.match(mobile, /\.members-table-head\s*\{[^}]*display:\s*grid/);
  assert.match(mobile, /\.member-identity[^}]*min-width:\s*0/);
  assert.match(mobile, /\.member-mobile-status\s*\{[^}]*display:\s*block/);
});
