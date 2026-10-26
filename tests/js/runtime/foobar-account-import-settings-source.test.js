'use strict';
// Actual navigation/detail owners run in the existing VM convention. Dynamic
// import loader, served runtime bundle and browser history remain held: no new
// vm-module flags, source substitutions or fake import-success owner are used.
const test = require('node:test');
const assert = require('node:assert/strict');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');
const F = require('./foobar-account-import-fixture.cjs');

test('I45 actual Settings detail exposes only account-authorized native host, never legacy preview', () => {
  const env = createNativeHomeRuntime(), c = env.context; c.state = {utility: {}};
  let allowed = true; c.AlbumHavenCapabilities = {allows: action => allowed && action === 'account.self.foobar.write'};
  F.vm.runInContext(F.read('music_app/static/js/runtime/utility-list-builders.js'), c, {filename: 'utility-list-builders.js'});
  const html = c.buildUtilityIntegrationDetail({key: 'foobar', title: 'Foobar2000'});
  assert.match(html, /data-foobar-import-host/); assert.doesNotMatch(html, /data-foobar-preview-host|data-foobar-help|data-foobar-format|Sync is unavailable|import-unavailable/);
  const host = env.document.createElement('div'); host.innerHTML = html; assert.ok(host.querySelector('[data-foobar-import-host]'));
  allowed = false; const denied = c.buildUtilityIntegrationDetail({key: 'foobar'}); assert.doesNotMatch(denied, /data-foobar-import-host/); assert.match(denied, /unavailable/);
});
test('I46 actual utility Table adapter delegates to real CompactDataTable without alternate renderer', () => {
  const env = createNativeHomeRuntime(), c = env.context;
  F.vm.runInContext(F.read('music_app/static/js/runtime/compact-data-table.js'), c);
  F.vm.runInContext(F.read('music_app/static/js/runtime/utility-list-builders.js'), c);
  const config = {id: 'foobar-fixture-table', columnsConfig: [{key: 'count', label: 'Source rows'}], rows: [{key: 'a', cells: {count: '2'}}]};
  assert.equal(c.buildUtilityCompactTable(config), c.buildCompactDataTable(config));
});
test('I47 Settings mount source binds actual sibling shell/modal identities, context and current CSRF fetch', () => {
  const source = F.read('music_app/static/js/runtime/utility-renderers-and-actions.js');
  const mount = source.slice(source.indexOf('function mountUtilityFoobarPreview('), source.indexOf('function renderUtilityIntegrations('));
  const loader = source.slice(source.indexOf('function loadUtilityFoobarImportModule('), source.indexOf('function renderUtilityIntegrations('));
  assert.match(loader, /return import\(`\/static\/js\/foobar-import\/index\.mjs\?v=\$\{version\}`\)/);
  assert.match(mount, /loadUtilityFoobarImportModule\(version\)\.then\(module\s*=>/);
  assert.match(mount, /module\.mountFoobarImport\(host,/); assert.match(mount, /fetch:\s*\(\.\.\.args\)\s*=>\s*window\.fetch\(\.\.\.args\)/);
  assert.match(mount, /renderButton:\s*options\s*=>\s*window\.ButtonComponent\.renderButton\(options\)/);
  assert.match(mount, /renderTable:\s*options\s*=>\s*buildUtilityCompactTable\(options\)/);
  for (const required of ["document.getElementById('app-shell') === contextRoot", "document.getElementById('utility-modal') === els.overlay", 'contextRoot.ownerDocument === host.ownerDocument', 'getUtilityModalElements().detail === els.detail', 'els.overlay.contains(els.detail)', 'els.detail.contains(host)', "els.detail.querySelector('[data-foobar-import-host]') === host", 'state.utility === utility', "utility.activeTab === 'integrations'", "utility.selectedIntegrationKey === 'foobar'", 'contextRoot.dataset.accountFoobarContext === marker', 'contextRoot.dataset.accountFoobarScope === scope']) assert.ok(mount.includes(required), required);
  assert.doesNotMatch(mount, /contextRoot\.contains\((?:host|els\.overlay|els\.detail)\)|AlbumHavenPrivateUITransport|\/foobar-preview\//);
});
test('I48 native Settings source retires loading/close/change owners and fences late module completion', () => {
  const source = F.read('music_app/static/js/runtime/utility-renderers-and-actions.js');
  assert.match(source, /function disposeUtilityFoobarPreview\([\s\S]*?utilityFoobarPreviewOwner\s*=\s*null[\s\S]*?owner\.observer\?\.disconnect\(\)[\s\S]*?owner\.mounted\?\.dispose\(\)/);
  assert.match(source, /if\s*\(state\.utility\.integrationsLoading\)\s*\{\s*disposeUtilityFoobarPreview\(\)/);
  assert.match(source, /\.then\(module\s*=>\s*\{\s*if\s*\(!isCurrent\(\)\)/);
  assert.match(source, /if\s*\(!isCurrent\(\)\)\s*\{\s*mounted\.dispose\(\);\s*owner\.retire\(\)/);
  assert.match(source, /if\s*\(utilityFoobarPreviewOwner\s*===\s*owner\)/);
  for (const event of ['pagehide', 'album-haven:policy-invalidated', 'album-haven:session-changed']) assert.ok(source.includes(event));
  assert.match(source, /removedNodes/); assert.match(source, /attributeFilter:\s*\['hidden',\s*'data-account-foobar-context'/);
  const modalOwner = F.read('music_app/static/js/runtime/utility-loaders-and-cover-lookup.js');
  assert.match(modalOwner, /disposeUtilityFoobarPreview/);
});
test('I49 account page loads shared CSRF before native entry and Back restoration does not remount stale owner', () => {
  const page = F.read('music_app/templates/account-foobar.html'), entry = F.read('music_app/static/js/foobar-import/account-entry.mjs');
  assert.ok(page.indexOf('session-csrf-fetch.js') < page.indexOf('foobar-import/account-entry.mjs'));
  assert.match(page, /data-account-foobar-context/); assert.match(page, /data-account-foobar-scope/); assert.match(page, /data-foobar-import-host/);
  assert.match(entry, /fetch:\s*\(\.\.\.args\)\s*=>\s*window\.fetch\(\.\.\.args\)/);
  assert.match(entry, /window\.addEventListener\('pagehide',\s*retire\)/); assert.match(entry, /mounted\?\.dispose\(\)/);
  assert.match(entry, /contextRoot\.dataset\.accountFoobarMatchingLibraryId\s*===\s*matchingLibraryId/);
  assert.doesNotMatch(entry, /addEventListener\('pageshow'|localStorage|sessionStorage|history\.(?:pushState|replaceState)/);
  const navigation = F.read('music_app/static/js/settings-navigation.js');
  assert.match(navigation, /settingsDocumentNavigation/);
});
test('I50 production renderer has explicit disclosure and no client-side invented matching/history authority', () => {
  const source = F.read('music_app/static/js/foobar-import/index.mjs');
  assert.match(source, /raw upload is temporary/); assert.match(source, /Play counts and dates remain source observations/);
  assert.match(source, /Protected local values are not replaced/); assert.match(source, /blanket override/);
  assert.match(source, /role', 'status'/); assert.match(source, /aria-live', 'polite'/); assert.match(source, /role', 'alert'/);
  assert.doesNotMatch(source, /(?:localStorage|sessionStorage|indexedDB)\s*\.|\.arrayBuffer\(|\.text\(\)/);
});
