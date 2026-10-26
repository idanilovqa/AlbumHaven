'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {F} = require('./foobar-enhanced-v4-fixture.cjs');

test('ES01 static actual import owner keeps direct File transport explicit mapping and long SQLite deadline', () => {
  const source = F.read('music_app/static/js/foobar-import/controller.mjs');
  assert.match(source, /command\?\.mapping_name===ENHANCED_MAPPING\?610000:60000/);
  assert.match(source, /application\/vnd\.sqlite3/); assert.match(source, /body:command\?\(retained\?'':body\):JSON\.stringify\(body\)/);
  assert.match(source, /const retained=command&&temporarySource!==null&&body===temporaryFile/);
  assert.match(source, /mapping_name:state\.mapping/); assert.match(source, /file!==reviewFile/);
  assert.doesNotMatch(source, /\.arrayBuffer\(|new ArrayBuffer|FileReader|localStorage|sessionStorage|indexedDB/);
});
test('ES02 static Enhanced cursor window bypasses TSV row cap and never appends checkpoint history', () => {
  const source = F.read('music_app/static/js/foobar-history/controller.mjs');
  assert.match(source, /HISTORY_WINDOW_PAGES = 5, HISTORY_PAGE_SIZE = 20/);
  assert.ok(source.includes("const enhanced=family==='local_entries'"));
  assert.match(source, /if\s*\(!enhanced&&\(index \* HISTORY_PAGE_SIZE/);
  assert.match(source, /if\(!enhanced\)\{\s*if \(page\.next_cursor\) checkpoints\[index \+ 1\] = page\.next_cursor/);
  assert.match(source, /state\.pages\.at\(-1\)\?\.page\.next_cursor/); assert.match(source, /state\.pages\[0\]\?\.page\.previous_cursor/);
  assert.doesNotMatch(source, /checkpoints\.push|cursorHistory|visitedPages/);
});
test('ES03 static cumulative Home preserves Foobar lifecycle navigation and Lastfm command forwarding together', () => {
  const index = F.read('music_app/static/js/home-friends/index-native.mjs'), bridge = F.read('music_app/static/js/runtime/home-friends-bridge.js'), app = F.read('music_app/static/js/home-friends/app.mjs');
  for (const fragment of ["import {createFoobarHistoryOwner}", "import {createFoobarHistoryNativeActions}", 'previous.foobarHistoryOwner?.dispose()', 'foobarHistoryOwner: current.foobarHistoryOwner', 'accountRoot.dataset.accountFoobarContext === accountContext', "typeof TrackActionsRuntime === 'undefined' ? null : TrackActionsRuntime"]) assert.ok(index.includes(fragment), fragment);
  assert.match(index, /canRetryActivityScrobble, lastfmHistoryCommand, \.\.\.publicProviders/);
  assert.match(index, /configureActivityProvider\?\.\(\{readActivity, resolveActivityTrack, resolveActivityNativeTarget, retryActivityScrobble, canRetryActivityScrobble, lastfmHistoryCommand\}\)/);
  assert.ok(bridge.includes("['recent', 'queue', 'goals', 'foobar']")); assert.match(bridge, /canImportLastfmHistory, importLastfmHistory, refreshLastfmHistory, lastfmImportProgress/);
  assert.match(app, /mountFoobarHistoryPanel/); assert.match(app, /createNativeActions:props\.createFoobarNativeActions/); assert.match(app, /selectionEnabled\s*=\s*section\s*===\s*'recent'\s*&&\s*homeSection\s*===\s*'recent'/);
});
test('ES04 static latest private-position shell preserves current account history and ordinary listening flags', () => {
  const web = F.read('music_app/routes/web_asgi.py'), shell = F.read('music_app/templates/index.html'), boundary = F.read('music_app/services/private_route_boundary.py');
  assert.match(web, /position_capture_enabled/); assert.match(web, /listening_selections_enabled/);
  for (const flag of ['data-position-capture-enabled', 'data-listening-selections-enabled', 'data-account-foobar-history-allowed', 'data-account-foobar-context', 'data-native-library-id']) assert.ok(shell.includes(flag), flag);
  assert.match(boundary, /foobar_account_enhanced_history_v1/); assert.match(boundary, /foobar_account_history_native_v1/); assert.match(boundary, /playback\/capture\/album-selection/);
});
