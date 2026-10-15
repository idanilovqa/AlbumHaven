'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
// This is the only application/fixture code evaluated by this unit suite.
// Entry and native owner modules are read as text, never imported or evaluated.
const {nativeDelivery} = require('../../components/homeQueueNativeDelivery.cjs');
const root = path.resolve(__dirname, '../../..');
const componentRoot = path.join(root, 'tests/components');
const html = '<!doctype html><title>Native delivery unit document</title>';
const mime = 'text/javascript; charset=utf-8';
const graphs = {
  "homeNativeRowIdentityEntry.mjs": [
    "music_app/static/js/home-friends/artist-selection.mjs",
    "music_app/static/js/home-friends/detail-projection.mjs",
    "music_app/static/js/home-friends/friends-directory.mjs",
    "music_app/static/js/home-friends/model.mjs",
    "music_app/static/js/home-friends/native-controls.mjs",
    "music_app/static/js/home-friends/resource-target.mjs"
  ],
  "homeSharedHeaderEntry.mjs": [
    "music_app/static/js/home-friends/header-layout.mjs",
    "music_app/static/js/home-friends/model.mjs",
    "music_app/static/js/home-friends/native-controls.mjs",
    "music_app/static/js/home-friends/period.mjs",
    "music_app/static/js/home-friends/profile.mjs",
    "music_app/static/js/home-friends/resource-target.mjs",
    "music_app/static/js/home-friends/shared-header.mjs"
  ],
  "homeNativeWrappersEntry.mjs": [
    "music_app/static/js/home-friends/native-controls.mjs",
    "music_app/static/js/home-friends/presentation.mjs",
    "music_app/static/js/home-friends/recent-view-icons.mjs",
    "music_app/static/js/home-friends/view-control.mjs"
  ],
  "queueTrackMetadataFixture.jsx": [
    "music_app/static/js/home-friends/native-controls.mjs",
    "music_app/static/js/home-friends/queue-playlist-source.mjs",
    "music_app/static/js/home-friends/queue-selection.mjs",
    "music_app/static/js/home-friends/queue.mjs",
    "music_app/static/js/home-friends/track-preference-ui.mjs",
    "music_app/static/js/home-friends/track-preference.mjs",
    "music_app/static/js/playlists/filters.mjs",
    "music_app/static/js/playlists/queue-provenance.mjs",
    "music_app/static/js/playlists/track-metrics.mjs",
    "music_app/static/js/playtables/native-selection.mjs",
    "music_app/static/js/playtables/native-track-table-presentation.mjs",
    "music_app/static/js/playtables/selection.mjs",
    "music_app/static/js/playtables/track-table-presentation.mjs"
  ]
};
const entryURL = name => '/__home_queue_fixture__/' + name.replace(/\.jsx$/, '.mjs');
async function request(route, pathname, {method = 'GET', resourceType = 'script', raw} = {}) {
  let result, calls = 0;
  await route({request: () => ({url: () => raw ?? 'https://albumhaven.test' + pathname, method: () => method, resourceType: () => resourceType}),
    fulfill: options => {calls++; result = options; return Promise.resolve();}});
  assert.equal(calls, 1, 'each request resolves exactly once');
  return result;
}
async function rejected(route, pathname, options) {
  assert.deepEqual(await request(route, pathname, options), {status:404, contentType:'text/plain', body:'Unknown fixture resource'});
}
for (const [entry, modules] of Object.entries(graphs)) {
  test(`native Home/Queue delivery serves exact reachable graph for ${entry}`, async () => {
    const route = nativeDelivery(root, html, [entry]);
    assert.deepEqual(await request(route, entryURL(entry)), {contentType:mime, body:fs.readFileSync(path.join(componentRoot, entry), 'utf8')});
    for (const relative of modules) {
      assert.deepEqual(await request(route, '/' + relative), {contentType:mime, body:fs.readFileSync(path.join(root, relative), 'utf8')}, relative);
    }
    for (const other of Object.keys(graphs).filter(name => name !== entry)) await rejected(route, entryURL(other));
    for (const other of new Set(Object.values(graphs).flat())) if (!modules.includes(other)) await rejected(route, '/' + other);
    assert.deepEqual(await request(route, '/', {resourceType:'document'}), {contentType:'text/html', body:html});
    assert.deepEqual(await request(route, '/ordinary/page?view=one', {resourceType:'document'}), {contentType:'text/html', body:html});
    await rejected(route, '/ordinary/page');
  });
  test(`native Home/Queue delivery rejects invalid requests for ${entry}`, async () => {
    const route = nativeDelivery(root, html, [entry]), resource = '/' + modules[0];
    for (const pathname of [entryURL(entry)+'?v=1', resource+'?v=1', '/missing.mjs', '/music_app/static/js/missing.mjs',
      '/__home_queue_fixture__/unknown.mjs', '/%65ncoded', '/music_app/static/js/%2e%2e/secret.mjs']) {
      await rejected(route, pathname); await rejected(route, pathname, {resourceType:'document'});
    }
    for (const pathname of ['/unknown.js', '/unknown.jsx', '/unknown.cjs', '/unknown.mjs', '/unknown.mjs/child', '/music_app/no-extension', '/__home_queue_fixture__/no-extension']) await rejected(route, pathname, {resourceType:'document'});
    for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
      await rejected(route, resource, {method}); await rejected(route, entryURL(entry), {method});
      await rejected(route, '/', {method, resourceType:'document'});
    }
    await rejected(route, '/', {raw:'not a valid URL'});
    await rejected(route, '/', {raw:'https://albumhaven.test\\music_app/static/js/unknown.mjs', resourceType:'document'});
  });
}

// Every malformed-graph probe runs in a fresh isolated temporary copy.
// Only this copied pure collector is required; no entry/owner module executes.
function copiedTree(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'albumhaven-native-delivery-'));
  const repository = path.join(base, 'repository'), components = path.join(repository, 'tests/components');
  fs.mkdirSync(components, {recursive:true});
  const collector = path.join(components, 'homeQueueNativeDelivery.cjs');
  fs.copyFileSync(path.join(componentRoot, 'homeQueueNativeDelivery.cjs'), collector);
  for (const entry of Object.keys(graphs)) fs.copyFileSync(path.join(componentRoot, entry), path.join(components, entry));
  for (const relative of new Set(Object.values(graphs).flat())) {
    const target = path.join(repository, relative); fs.mkdirSync(path.dirname(target), {recursive:true}); fs.copyFileSync(path.join(root, relative), target);
  }
  const {nativeDelivery: copiedDelivery} = require(collector);
  t.after(() => {delete require.cache[require.resolve(collector)]; fs.rmSync(base, {recursive:true, force:true});});
  return {base, repository, components, collect: names => copiedDelivery(repository, html, names),
    write(relative, body) {const file = path.join(repository, relative); fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file, body); return file;}};
}
test('native delivery never serves an existing unreachable module', async t => {
  const tree = copiedTree(t), relative = 'music_app/static/js/unit-unreachable.mjs';
  tree.write(relative, 'throw new Error("This module must never execute or be served");\n');
  assert.equal(fs.existsSync(path.join(tree.repository, relative)), true);
  const route = tree.collect(Object.keys(graphs));
  await rejected(route, '/' + relative); await rejected(route, '/' + relative, {resourceType:'document'});
});
const invalidModules = [
  ['malformed static declaration', 'import {anything} from "./model.mjs"\n', /Unsupported module declaration/],
  ['bare dependency', 'import anything from "unapproved-package";\n', /Only relative native/],
  ['dynamic dependency', 'const pending = import("./model.mjs");\n', /Dynamic module imports/],
  ['relative root escape', 'import "../../../../../outside.mjs";\n', /Non-native module/],
  ['non-module dependency', 'import "./plain.js";\n', /Only relative native/],
];
for (const [label, body, pattern] of invalidModules) test(`native delivery fails closed for ${label}`, t => {
  const tree = copiedTree(t);
  tree.write('music_app/static/js/home-friends/queue.mjs', body);
  assert.throws(() => tree.collect(['queueTrackMetadataFixture.jsx']), pattern);
});
test('native delivery fails closed for a dependency symlink outside the repository', t => {
  const tree = copiedTree(t), outside = path.join(tree.base, 'outside.mjs'), link = path.join(tree.repository, 'music_app/static/js/home-friends/unit-symlink.mjs');
  fs.writeFileSync(outside, 'export const value = 1;\n'); fs.symlinkSync(outside, link);
  tree.write('music_app/static/js/home-friends/queue.mjs', 'import "./unit-symlink.mjs";\n');
  assert.throws(() => tree.collect(['queueTrackMetadataFixture.jsx']), /Native fixture path escaped repository/);
});
for (const [label, body] of [
  ['bare', 'import owner from "unapproved-package";\n'],
  ['dynamic', 'const owner = import("/music_app/static/js/home-friends/queue.mjs");\n'],
  ['malformed', 'import {mountQueuePanel} from "/music_app/static/js/home-friends/queue.mjs"\n'],
  ['relative escape', 'import owner from "../../../outside.mjs";\n'],
]) test(`native delivery rejects ${label} fixture entry imports`, t => {
  const tree = copiedTree(t); tree.write('tests/components/queueTrackMetadataFixture.jsx', body);
  assert.throws(() => tree.collect(['queueTrackMetadataFixture.jsx']), /Unsupported fixture import/);
});
test('native delivery rejects unlisted entry names and entry symlink escapes', t => {
  const tree = copiedTree(t);
  assert.throws(() => tree.collect(['other.mjs']), /Unknown fixture entry/);
  assert.throws(() => tree.collect(['../../../outside.mjs']), /Unknown fixture entry/);
  const entry = path.join(tree.components, 'queueTrackMetadataFixture.jsx'), outside = path.join(tree.base, 'entry.mjs');
  fs.writeFileSync(outside, '// isolated outside entry\n'); fs.unlinkSync(entry); fs.symlinkSync(outside, entry);
  assert.throws(() => tree.collect(['queueTrackMetadataFixture.jsx']), /Native fixture path escaped repository/);
});
