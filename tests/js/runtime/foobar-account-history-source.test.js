'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const H = require('./foobar-account-history-fixture.cjs');
test('H36 static account bootstrap and caller wiring remain own-account nonlibrary read only', () => {
  const entry = H.read('music_app/static/js/foobar-history/account-entry.mjs'), template = H.read('music_app/templates/account-foobar-history.html'), route = H.read('music_app/routes/foobar_account_ui_asgi.py');
  assert.match(entry, /window\.fetch\(\.\.\.args\)/); assert.match(entry, /account\.self\.foobar\.read/); assert.doesNotMatch(entry, /createImportController|mountFoobarImport|mountHomeFriends|library_id/);
  assert.match(template, /session-csrf-fetch\.js/); assert.match(template, /type="module" src="\/static\/js\/foobar-history\/account-entry\.mjs/); assert.match(template, /data-account-foobar-history-allowed/); assert.match(template, /connected music library is not required/);
  assert.match(route, /@router\.get\("\/account\/foobar-history"/); assert.match(route, /account\.self\.foobar\.read/); assert.match(route, /issue_session_csrf/);
});
test('H37 static Home integration isolates Foobar section from native measured Recent actions', () => {
  const app = H.read('music_app/static/js/home-friends/app.mjs'), index = H.read('music_app/static/js/home-friends/index-native.mjs'), bridge = H.read('music_app/static/js/runtime/home-friends-bridge.js');
  assert.match(app, /mountFoobarHistoryPanel/); assert.match(app, /homeSection\s*===\s*'recent'/); assert.match(index, /createFoobarHistoryOwner/); assert.match(bridge, /foobar/);
  assert.match(app, /selectionEnabled\s*=\s*section\s*===\s*'recent'\s*&&\s*homeSection\s*===\s*'recent'/);
  assert.match(app, /const activityVisible\s*=\s*homeSection\s*===\s*'recent'/);
  assert.match(app, /badgeVisible[^;\n]*homeSection\s*===\s*'recent'/);
  const panel = H.read('music_app/static/js/foobar-history/panel.mjs'); assert.doesNotMatch(panel, /localStorage|sessionStorage|indexedDB|innerHTML|insertAdjacentHTML|data-track-id|data-selection-key/);
  const provider = H.read('music_app/static/js/foobar-history/provider.mjs'); assert.doesNotMatch(provider, /readRecent|readActivity|source\/create|readLastFm/);
});
test('H38 static scrolling state is finite cursor-only with no fabricated total-height spacer', () => {
  const controller = H.read('music_app/static/js/foobar-history/controller.mjs'), panel = H.read('music_app/static/js/foobar-history/panel.mjs'), css = H.read('music_app/static/css/foobar-history.css');
  assert.match(controller, /HISTORY_WINDOW_PAGES = 5/); assert.match(controller, /200000 : 100000/); assert.match(controller, /checkpoints\[index \+ 1\] = page\.next_cursor/); assert.match(controller, /page\.source_revision !== pinned/); assert.doesNotMatch(controller, /checkpoints.*push\(page\)/);
  assert.match(panel, /getBoundingClientRect/); assert.match(panel, /canCommit/); assert.match(panel, /visible\(\)\.every/); assert.match(panel, /total unknown/); assert.doesNotMatch(panel + css, /IntersectionObserver|style\.height|scrollHeight\s*=|virtual-spacer|totalHeight/);
});
test('H39 actual import contract recognizes nonretryable source capacity without removing prior errors', async () => {
  const {ERRORS} = await require('./foobar-account-import-fixture.cjs').load('contract.mjs'); assert.match(ERRORS.foobar_source_quota_exceeded, /No automatic retry/); for (const key of ['authentication_required', 'forbidden', 'invalid_import_request', 'stale_import', 'unavailable', 'commit_uncertain', 'source_choice_required']) assert.equal(typeof ERRORS[key], 'string');
});
