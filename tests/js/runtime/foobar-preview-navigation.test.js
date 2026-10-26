'use strict';
// Explicit adoption of the three prior N4 navigation cases. Historical preview
// controller tests stay unchanged; active Settings now requires account authority.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../../..');
function navigation(actions) {
  const context = vm.createContext({state: {utility: {integrations: [{key: 'lastfm', title: 'Last.FM'}, {key: 'foobar', title: 'Foobar2000'}, {key: 'local_playlist_import', title: 'Import Local Playlist'}]}}, document: {readyState: 'complete', getElementById: id => id === 'capability-bootstrap' ? {textContent: JSON.stringify({allowed_actions: actions, available_tabs: ['integrations']})} : null, querySelectorAll: () => []}});
  context.window = context;
  for (const filename of ['capability-ui.js', 'runtime/library-settings.js']) vm.runInContext(fs.readFileSync(path.join(root, 'music_app/static/js', filename), 'utf8'), context);
  return Array.from(context.buildUtilityIntegrationItems(), item => item.title);
}
test('N01 account-only simulated user sees Foobar, not Library or Last.fm administration', () => {
  assert.deepEqual(navigation({'account.self.foobar.write': true}), ['Foobar2000']);
  assert.deepEqual(navigation({'library.browse.read': true}), []);
});
test('N02 no account or administration grants means no integration navigation rows', () => {
  assert.deepEqual(navigation({}), []);
});
test('N03 properly permissioned account and navigation user retains exactly the four approved names', () => {
  assert.deepEqual(navigation({'account.self.foobar.write': true, 'integration.settings.read': true, 'library.settings.read': true}), ['Library', 'Scrobbling', 'Foobar2000', 'Import Local Playlist']);
  assert.deepEqual(navigation({'integration.settings.read': true, 'library.settings.read': true}), ['Library', 'Scrobbling', 'Import Local Playlist']);
});
