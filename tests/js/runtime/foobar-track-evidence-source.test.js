'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const F = require('./foobar-account-import-fixture.cjs');
test('BS01 actual modal retains S3 Full pacing native controls and the sole declared evidence asset loader', () => {
  const source = F.read('music_app/static/js/runtime/tag-editor-and-optimistic-updates.js');
  assert.match(source, /function loadFoobarTrackEvidencePresenter\(\)/);
  assert.ok(source.includes('return import(`/static/js/foobar-history/track-evidence.mjs?v=${version}`)'));
  assert.match(source, /void loadFoobarTrackEvidencePresenter\(\)\.then/);
  assert.match(source, /mountTrackModalFoobarEvidence\(album,searchRenderReceipt,albumPreferenceRenderGeneration\)/);
  assert.match(source, /receipt\.rows\.length!==receipt\.nodes\.length/); assert.match(source, /source\?\.inventory_track_ref/);
  assert.match(source, /renderTrackModalLocalListening\(album, els\.header, albumPreferenceRenderGeneration\)/);
  assert.match(source, /album-metrics\/advance/); assert.match(source, /projectLocalAlbumFullProgress/);
  assert.match(source, /NativePlaytables\.mount\('album-tracks', els\.list\)/); assert.match(source, /attachSharedPlayer\(\)/);
});
test('BS02 current Top shell and perimeter compose rather than replacing Foobar and ordinary listening ownership', () => {
  const web = F.read('music_app/routes/web_asgi.py'), shell = F.read('music_app/templates/index.html'), boundary = F.read('music_app/services/private_route_boundary.py');
  for (const flag of ['top_listening_presentation_enabled', 'position_capture_enabled', 'listening_selections_enabled', 'account_foobar_history_allowed']) assert.ok(web.includes(flag), flag);
  for (const flag of ['data-top-listening-presentation-enabled', 'data-position-capture-enabled', 'data-listening-selections-enabled', 'data-account-foobar-context', 'data-native-library-id']) assert.ok(shell.includes(flag), flag);
  for (const route of ['/playback/capture/position/top-metrics', '/playback/capture/position/top-metrics/advance', '/playback/capture/position/album-metrics/advance', '/integrations/foobar/account/history/native/evidence']) assert.ok(boundary.includes(route), route);
  for (const protocol of ['foobar_account_history_native_v1', 'foobar_account_enhanced_history_v1', 'foobar_account_track_evidence_v1']) assert.ok(boundary.includes(protocol), protocol);
});
test('BS03 evidence wire stays closed and backend page owner remains current bounded and nonmutating evidence input', () => {
  const route = F.read('music_app/routes/foobar_account_import_asgi.py'), service = F.read('music_app/services/foobar_account_track_evidence.py');
  assert.match(route, /def _track_evidence_semantics\(item\)/); assert.match(route, /not _track_evidence_semantics\(item\)/);
  assert.match(route, /current_page_refresh_to_restart/); assert.match(service, /PAGE_SIZE = 20/); assert.match(service, /maximum=PAGE_SIZE\+1/);
  assert.match(service, /with current_library_transaction/); assert.match(service, /pg_catalog\.pg_index/);
  assert.doesNotMatch(service, /create\s+(?:unique\s+)?index\b|delete\s+from\b|insert\s+into\b/i);
});
test('BS04 detail owner never adds evidence to providers or exposes storage playback taste and path mechanisms', () => {
  const source = F.read('music_app/static/js/foobar-history/track-evidence.mjs');
  assert.match(source, /items\.replaceChildren\(\)/); assert.match(source, /r\.items\.length>20/); assert.match(source, /page=result;paint\(result\)/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|innerHTML|insertAdjacentHTML|activateSharedTrackButton|playTrackFromPayload|readLastFm|data-track-path|inventory_track_ref/);
  assert.match(source, /never added to Last\.fm or Album Haven listening, or summed across sources/);
  assert.match(source, /Refresh from the beginning after imports or match changes/);
});
