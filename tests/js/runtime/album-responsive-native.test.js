// Isolated component contract. No app boot, network, database or media access.
// Root may point this proposal at a guarded source tree before admitting it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');
const root = process.env.ALBUM_RESPONSIVE_REPOSITORY_ROOT || path.resolve(__dirname, '../../..');
const read = file => fs.readFileSync(path.join(root, 'music_app/static/js', file), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function renderer() {
  const context = vm.createContext({console});
  context.window = context;
  for (const file of ['button-component.js', 'runtime/markup-format-helpers.js',
    'runtime/compact-data-table.js', 'runtime/album-track-table.js']) vm.runInContext(read(file), context, {filename: file});
  return context;
}

test('Album metadata reserves identity, Number, Love and Length; only supplied extras are offered', () => {
  const context = renderer();
  assert.equal(typeof context.albumTrackTableColumns, 'function');
  const required = columns => columns.filter(column => column.required || column.identity).map(column => column.key).sort();
  const basic = plain(context.albumTrackTableColumns({groups: [{tracks: [{title: 'One'}]}]}));
  assert.deepEqual(required(basic), ['duration', 'love', 'number', 'title']);
  assert.deepEqual(basic.filter(column => !column.required && !column.identity), []);
  assert.equal(basic.find(column => column.key === 'title').identity, true);
  const subject = plain(context.albumTrackTableColumns({subjectTaste: true, showPath: true,
    groups: [{tracks: [{isProblematic: true}]}]}));
  assert.deepEqual(required(subject), ['duration', 'love', 'number', 'title']);
  assert.deepEqual(subject.filter(column => !column.required && !column.identity).map(column => column.key).sort(), ['path', 'problem', 'rating']);
  assert.equal(new Set(subject.map(column => column.key)).size, subject.length);
});

test('real native renderer retains playback, grouped totals, missing state and stable unknown Love cells', () => {
  const context = renderer();
  const html = context.buildAlbumTrackTableHtml({selection: 'multiple', groups: [
    {discNumber: 1, tracks: [{rowKey: 'one', readable: true, path: 'synthetic-one', title: 'First',
      duration: '1:20 / 3:00', isCurrent: true, isPlaying: true}]},
    {discNumber: 2, tracks: [{rowKey: 'two', readable: true, path: 'synthetic-two', title: 'Second',
      duration: '22:30', availability: 'missing', canPlay: false}]},
  ], totalLength: '25m 30s', mainLength: '3:00', bonusLength: '22:30'});
  assert.equal((html.match(/data-track-love-cell(?:[\s=>])/g) || []).length, 2);
  assert.match(html, /album-track-table__row--current/);
  assert.match(html, /album-track-table__row--playing/);
  assert.match(html, /album-track-table__row--missing/);
  assert.match(html, /aria-label="Pause track"/);
  assert.match(html, /aria-label="Play track"[^>]*disabled/);
  for (const text of ['1:20 / 3:00', 'Total Length: 25m 30s', 'Total Main Album Length: 3:00', 'Bonus Disc Length: 22:30']) assert.ok(html.includes(text), text);
  assert.equal((html.match(/role="table"/g) || []).length, 2);
  const ordinary = context.buildAlbumTrackTableRow({title: 'No preference receipt', love_tier: 'off'}, 0, {});
  assert.match(ordinary.cells.love.content, /data-track-love-cell/);
  assert.doesNotMatch(ordinary.cells.love.content, /<button|aria-label="off"|love-off/);
  const subject = context.buildAlbumTrackTableRow({title: 'Subject', subjectLove: 'loved', subjectTasteState: 'available'}, 0, {subjectTaste: true});
  assert.match(subject.cells.love.content, /role="img" aria-label="loved"/);
  assert.doesNotMatch(subject.cells.love.content, /data-track-love-cell|<button/);
});

function nativeBridge() {
  const mounts = [], listeners = new Map();
  let token = 'scope-A';
  const context = vm.createContext({console, state: {view: {}},
    document: {getElementById: () => null},
    TrackActionsRuntime: {scope: () => ({token})},
    window: {
      AlbumHavenPlaylistRuntime: {snapshot: () => ({scopeKey: 'actor-library'})},
      AlbumHavenPlaytableUI: {mount(host, options) {
        const mount = {host, options, updates: [], disposed: 0,
          update(next) {if (next) {this.options = {...this.options, ...next}; this.updates.push(next);}},
          dispose() {this.disposed++;}};
        mounts.push(mount); return mount;
      }},
      addEventListener(name, callback) {listeners.set(name, callback);},
      removeEventListener(name, callback) {if (listeners.get(name) === callback) listeners.delete(name);},
    },
  });
  vm.runInContext(read('runtime/playtable-source.js') + '\n globalThis.native = NativePlaytables;', context);
  const sourceIdentity = {tracks: [{path: 'private-fixture-path', canonical_track_ref: 'private-canonical-fixture'}]}, host = {};
  const columns = [{key: 'title', identity: true, width: 100}, {key: 'love', required: true, width: 36}];
  function prepare(key = 'album-tracks', identity = sourceIdentity, tableOptions = key === 'album-tracks' ? {columns} : undefined) {
    const groups = [{tracks: [{title: 'Synthetic track'}]}];
    const owner = context.native.prepare(key, identity, groups,
      [{inventory_track_ref: 'inventory-track:1:1', source_readable: true}], () => true, undefined, tableOptions);
    return {owner, groups};
  }
  return {context, mounts, host, columns, sourceIdentity, prepare, scope(next) {token = next;}};
}

test('native Album mount passes one public presentation resource and replaces sources without leaking private refs', () => {
  const f = nativeBridge(), first = f.prepare();
  assert.equal(f.context.native.mount('album-tracks', f.host), true);
  const before = f.mounts[0], options = before.options.tablePresentation;
  assert.ok(options, 'Native Album must actually supply presentation to its React owner');
  assert.deepEqual(plain(options.columns), f.columns);
  assert.notEqual(options.resourceKey, f.sourceIdentity, 'React receives an opaque presentation key, not an Album DTO');
  assert.doesNotMatch(JSON.stringify(options), /private-fixture-path|private-canonical-fixture|canonical_track_ref|\"tracks\"/);
  assert.equal(options.isCurrent(), true);
  assert.doesNotMatch(JSON.stringify(before.options.sourceAdapter.snapshot()), /inventory-track|canonical_track_ref/);
  const second = f.prepare();
  assert.equal(options.isCurrent(), false, 'Old source callbacks retire immediately on refresh');
  assert.equal(f.context.native.mount('album-tracks', f.host), true);
  assert.equal(f.mounts.length, 1, 'Same exact Album resource keeps its existing React root');
  assert.equal(before.disposed, 0);
  assert.equal(before.options.tablePresentation.resourceKey, options.resourceKey, 'Same resource refresh retains its opaque key');
  assert.notEqual(before.options.tablePresentation.source, options.source);
  assert.notEqual(second.owner.source, first.owner.source);
  assert.equal(first.owner.source.snapshot(), null);
  assert.equal(before.options.tablePresentation.isCurrent(), true);
  f.context.native.retire('album-tracks');
  assert.equal(before.options.tablePresentation.isCurrent(), false);
  assert.equal(before.disposed, 1);
});

for (const change of ['album', 'scope', 'view', 'host']) test(`native Album ${change} replacement cannot reuse old mounted resource`, () => {
  const f = nativeBridge(); f.prepare(); f.context.native.mount('album-tracks', f.host);
  const before = f.mounts[0], oldPresentation = before.options.tablePresentation;
  assert.ok(oldPresentation);
  if (change === 'scope') f.scope('scope-B');
  if (change === 'view') f.context.state.view = {};
  f.prepare('album-tracks', change === 'album' ? {} : f.sourceIdentity);
  f.context.native.mount('album-tracks', change === 'host' ? {} : f.host);
  assert.equal(before.disposed, 1);
  assert.equal(f.mounts.length, 2);
  if (change !== 'host') assert.notEqual(f.mounts[1].options.tablePresentation.resourceKey, oldPresentation.resourceKey);
  assert.equal(oldPresentation.isCurrent(), false);
});

test('Loose Tracks does not acquire Album presentation implicitly', () => {
  const f = nativeBridge(); f.prepare('loose-tracks', {}, undefined);
  f.context.native.mount('loose-tracks', f.host);
  assert.equal(f.mounts[0].options.tablePresentation, undefined);
});
