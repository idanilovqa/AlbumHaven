const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const filename = path.resolve(__dirname, '../../../music_app/static/js/runtime/modal-and-overlay-helpers.js');

function setup() {
  const menus = [], actions = [], state = {view: {manual_version_links: {}}};
  const album = {key: 'album-one', album_ref: 'album-one', source_readable: true,
    allowed_actions: {can_play_album: true}, track_rows: [{path: 'one', playback_state: {can_start_here: true}}]};
  const anchor = {isConnected: true, focus() {actions.push(['focus']);}, getBoundingClientRect: () => ({left: 12, top: 24, bottom: 48})};
  const context = vm.createContext({state, AbortController, Object, Promise,
    window: {AlbumHavenPlaytableUI: {actions: (target, options) => {
      const record = {target, options, destroyed: false, closed: false}; menus.push(record);
      return {destroy() {record.destroyed = true;}, close() {record.closed = true;}};
    }}, AlbumHavenExplicitQueue: {timingOptions: () => [
      {value: 'next', label: 'Play next', enabled: true}, {value: 'end', label: 'At end of queue', enabled: true},
      {value: 'album', label: 'After current album', enabled: false}, {value: 'playlist', label: 'After current playlist', enabled: false},
    ]}},
    document: {activeElement: anchor, querySelector: () => anchor, getElementById: () => null},
    isMobileClient: () => false, usesMobilePageLayout: () => false,
    getAlbumIdentity: value => value?.key, getAlbumPlaybackQueueRef: value => value?.album_ref,
    TrackActionsRuntime: {scope: () => ({token: 'session', actor: 'actor', library: 'library'})},
    getAvailableAlbumMoveActions: () => [{action: 'move_to_hoard', label: 'Move to Hoard'}, {action: 'move_to_library', label: 'Move to Main Library'}],
    getAlbumMoveActionLabel: item => item.label,
    openAlbumInExplorer: value => actions.push(['explorer', value]),
    performAlbumMove: (value, action) => actions.push([action, value]),
    openVersionPickerModal: value => actions.push(['mark-version', value]),
    unmarkAlbumVersion: key => actions.push(['unmark-version', key]),
    showToast: () => {},
  });
  const source = fs.readFileSync(filename, 'utf8');
  vm.runInContext(source.slice(0, source.indexOf('function ensureVersionPickerModal()')), context);
  return {context, state, album, anchor, menus, actions};
}

test('React Album menu descriptors preserve Explorer, both moves and exact version action', () => {
  const h = setup(), items = h.context.albumCardContextActions(h.album);
  const byValue = new Map(Array.from(items, item => [item.value, item]));
  assert.equal(byValue.get('open-explorer').label, 'Open in File Explorer');
  assert.equal(byValue.get('move_to_hoard').label, 'Move to Hoard');
  assert.equal(byValue.get('move_to_library').label, 'Move to Main Library');
  assert.equal(byValue.get('mark-version').label, 'Mark as a version');
  assert.equal(byValue.has('unmark-version'), false);
  h.state.view.manual_version_links['album-one'] = 'original';
  const marked = new Map(Array.from(h.context.albumCardContextActions(h.album), item => [item.value, item]));
  assert.equal(marked.get('unmark-version').label, 'Unmark as a version');
  assert.equal(marked.has('mark-version'), false);
});

test('Album Queue timings expose disabled gates through shared descriptors', () => {
  const h = setup(), items = new Map(Array.from(h.context.albumCardContextActions(h.album), item => [item.value, item]));
  assert.equal(items.get('queue:next').disabled, false);
  assert.equal(items.get('queue:end').disabled, false);
  assert.equal(items.get('queue:album').disabled, true);
  assert.equal(items.get('queue:playlist').disabled, true);
  const denied = h.context.albumCardContextActions(h.album, {canQueue: false});
  assert.ok(Array.from(denied).filter(item => item.value.startsWith('queue:')).every(item => item.disabled));
});

for (const [value, expected] of [['open-explorer', 'explorer'], ['move_to_hoard', 'move_to_hoard'],
  ['move_to_library', 'move_to_library'], ['mark-version', 'mark-version']]) {
  test(`shared Album action dispatch preserves ${value}`, async () => {
    const h = setup(); h.context.showAlbumCardContextMenu(12, 24, h.album, h.anchor);
    assert.equal(h.menus.length, 1); assert.equal(h.menus[0].target, h.anchor);
    assert.equal(h.menus[0].options.label, 'Album actions');
    assert.ok(h.menus[0].options.formats.some(item => item.value === value));
    await h.menus[0].options.onSelect(value);
    assert.ok(h.actions.some(action => action[0] === expected && action[1] === h.album));
  });
}

test('opening another Album menu closes the previous shared owner and explicit hide closes the new owner', () => {
  const h = setup();
  h.context.showAlbumCardContextMenu(12, 24, h.album, h.anchor);
  h.context.showAlbumCardContextMenu(20, 30, {...h.album, key: 'album-two'}, h.anchor);
  assert.equal(h.menus[0].closed, true);
  h.context.hideAlbumCardContextMenu(); assert.equal(h.menus[1].closed, true);
});

test('stale view and disabled Queue actions never dispatch from a captured Album menu', async () => {
  const h = setup(); let queued = 0;
  h.context.window.AlbumHavenExplicitQueue.enqueue = async () => {queued++;};
  h.context.showAlbumCardContextMenu(12, 24, h.album, h.anchor);
  await h.menus[0].options.onSelect('queue:album'); assert.equal(queued, 0);
  h.state.view = {manual_version_links: {}};
  await h.menus[0].options.onSelect('open-explorer'); assert.equal(h.actions.length, 0);
});

test('Album context menu stays unavailable on narrow layouts and wide mobile clients', () => {
  for (const [mobile, narrow] of [[true, false], [false, true]]) {
    const h = setup(); h.context.isMobileClient = () => mobile; h.context.usesMobilePageLayout = () => narrow;
    h.context.showAlbumCardContextMenu(12, 24, h.album, h.anchor);
    assert.equal(h.menus.length, 0);
  }
});

test('Album action descriptors and programmatic dispatch fail closed after capability revocation', async () => {
  const h = setup(); let allowed = true;
  h.context.window.AlbumHavenCapabilities = {allows: () => allowed};
  h.context.showAlbumCardContextMenu(12, 24, h.album, h.anchor);
  allowed = false;
  const denied = h.context.albumCardContextActions(h.album, {canQueue: false});
  assert.equal(denied.some(item => ['open-explorer', 'move_to_hoard', 'move_to_library', 'mark-version'].includes(item.value)), false);
  assert.ok(denied.filter(item => item.value.startsWith('queue:')).every(item => item.disabled));
  await h.menus[0].options.onSelect('open-explorer');
  await h.menus[0].options.onSelect('move_to_hoard');
  await h.menus[0].options.onSelect('mark-version');
  assert.equal(h.actions.length, 0);
});

test('whole Album Queue action captures fresh playable rows in grouped source order and rejects duplicate dispatch', async () => {
  const h = setup(), rows = [
    {path: 'a', playback_state: {can_start_here: true}},
    {path: 'b', playback_state: {can_start_here: true}},
    {path: 'missing', playback_state: {can_start_here: false}, availability: 'missing'},
  ], queued = [];
  h.context.fetchTrackModalAlbumDetails = async () => ({...h.album, tracks: [{path: 'b'}, {path: 'missing'}, {path: 'a'}], track_rows: rows});
  h.context.groupAlbumTracks = tracks => ({groups: [{tracks}]});
  h.context.captureNativeAlbumQueueSources = (_album, selected) => selected;
  h.context.window.AlbumHavenExplicitQueue.enqueue = async (sources, timing, options) => {queued.push({sources, timing, options});};
  h.context.showAlbumCardContextMenu(12, 24, h.album, h.anchor);
  assert.equal(await h.menus[0].options.onSelect('queue:next'), true);
  assert.equal(await h.menus[0].options.onSelect('queue:next'), false);
  assert.deepEqual(Array.from(queued[0].sources, row => row.path), ['b', 'a']);
  assert.equal(queued[0].timing, 'next'); assert.equal(queued[0].options.isCurrent(), true);
});
