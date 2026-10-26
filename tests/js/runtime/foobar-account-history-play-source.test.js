'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const H = require('./foobar-account-history-fixture.cjs');

test('HS01 static Home bootstrap uses genuine lexical runtime and exact view continuity', () => {
  const index = H.read('music_app/static/js/home-friends/index-native.mjs'), app = H.read('music_app/static/js/home-friends/app.mjs');
  assert.match(index, /import \{createFoobarHistoryNativeActions\} from '\.\.\/foobar-history\/native-actions\.mjs'/);
  assert.match(index, /typeof TrackActionsRuntime === 'undefined' \? null : TrackActionsRuntime/); assert.doesNotMatch(index, /window\.TrackActionsRuntime/);
  for (const source of ['viewCurrent() && session === current', 'current.generation === providerGeneration', 'accountRoot?.isConnected === true',
    "accountRoot.dataset.accountFoobarScope === 'account-foobar-v1'", 'accountRoot.dataset.accountFoobarContext === accountContext',
    'window.AlbumHavenPrivateUITransport === transport && TrackActionsRuntime === tracks', 'runtime.snapshot().scopeKey === current.scopeKey',
    "(runtime.snapshot().entryKey ?? 'initial') === entryKey"]) assert.ok(index.includes(source), source);
  assert.match(app, /createNativeActions:props\.createFoobarNativeActions/); assert.match(app, /homeSection==='foobar'/);
});
test('HS02 static account page imports no native action dispatcher or hidden media shell', () => {
  const entry = H.read('music_app/static/js/foobar-history/account-entry.mjs'), template = H.read('music_app/templates/account-foobar-history.html');
  assert.doesNotMatch(entry + template, /native-actions|TrackActionsRuntime|track-actions\.js|private-ui-transport\.js|player-loop-playback|app-shell/);
  assert.match(entry, /mountFoobarHistoryPanel/); assert.doesNotMatch(entry, /createNativeActions/);
});
test('HS03 static native adapter keeps only proof requests and private target stack', () => {
  const source = H.read('music_app/static/js/foobar-history/native-actions.mjs');
  assert.match(source, /foobar_account_history_native_v1/);
  assert.match(source, /function originalRevision\(row\)\s*\{\s*return row\.enhanced \? row\.enhanced\.observation_revision : row\.projection\?\.source_revision;\s*\}/);
  assert.match(source, /!decimal\(originalRevision\(row\)\)/);
  assert.match(source, /revision: state\.page\.source_revision/);
  assert.match(source, /const body = \{version: VERSION, source_ref: captured\.source, source_revision: captured\.revision,\s*observations: \[\[row\.observation_ref, originalRevision\(row\)\]\]\};/);
  assert.match(source, /tracks\.canPlay\(target\) !== true \|\| !active\(\)/); assert.match(source, /tracks\.play\(target\)/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|innerHTML|setInterval|queueMicrotask|createAlbumListeningIntent|beginOrdinaryAlbumListening/);
  assert.match(source, /grant = null/); assert.match(source, /pending\?\.abort\.abort\(\)/);
});
test('HS04 static native caller route protocol keeps real library authority distinct from account display', () => {
  const route = H.read('music_app/routes/foobar_account_import_asgi.py'), boundary = H.read('music_app/services/private_route_boundary.py');
  assert.match(route, /foobar_account_history_native_v1/); assert.match(route, /history\/native\/eligibility/); assert.match(route, /history\/native\/play/);
  assert.match(route, /library\.browse\.read/); assert.match(route, /account\.self\.foobar\.read/); assert.match(route, /X-AlbumHaven-Context/i);
  assert.match(boundary, /foobar_account_history_native_v1/); assert.match(boundary, /playback\/capture\/album-selection/);
});
test('HS05 static ordinary-album web and shell feature flags survive native caller composition', () => {
  const web = H.read('music_app/routes/web_asgi.py'), shell = H.read('music_app/templates/index.html');
  assert.match(web, /listening_selections_enabled/); assert.match(shell, /data-listening-selections-enabled/);
  assert.match(shell, /data-account-foobar-history-allowed/); assert.match(shell, /data-native-library-id/);
});
