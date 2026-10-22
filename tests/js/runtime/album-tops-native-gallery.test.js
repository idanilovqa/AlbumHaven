'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {TOP, OTHER, A, B, IA, IB, row, detail, state, progress, freeze, environment, mounted, intent} = require('./album-tops-native-gallery-fixture.cjs');

const keys = f => f.cards().map(card => card.getAttribute('data-gallery-card-key'));
const patchDetail = (f, patch) => f.setState({...f.getState(), detail: {...f.getState().detail, data: {...f.getState().detail.data, ...patch}}});
const complete = f => intent(f.cards()[0], 'complete');

test('native Top renders and updates without ResizeObserver or a metadata owner', async t => {
  const f = await mounted(t, {resizeObserver: false}), cards = f.cards();
  assert.equal(cards.length, 2);
  assert.equal(f.owners.filter(owner => owner.kind === 'metadata').length, 0, 'Actual shared metadata factory returns null');
  patchDetail(f, {items: [...f.getState().detail.data.items].reverse()});
  assert.deepEqual(f.cards(), [...cards].reverse());
  f.click(complete(f));
  assert.deepEqual(f.calls, [{action: 'set_manual_completion', payload: {album_ref: B, completed: false}}]);
  f.owner.dispose(); f.flush();
  assert.equal(f.galleryRoot(), null);
  assert.equal(f.frames.size, 0);
});

for (const action of ['open', 'complete']) test(`native Top retains outer card and focused ${action} node through update plus reorder`, async t => {
  const data = freeze(detail()), original = JSON.stringify(data);
  const f = await mounted(t, {data});
  const root = f.galleryRoot(), [first, second] = f.cards(), focused = intent(first, action);
  focused.focus();
  const items = freeze([{...data.items[1], position: 1}, {...data.items[0], position: 2, title: 'Renamed album'}]);
  patchDetail(f, {revision: '8', items, top_viewer_overlay: {...data.top_viewer_overlay,
    item_progress: {...data.top_viewer_overlay.item_progress, [A]: progress(true)}}});
  assert.equal(f.galleryRoot(), root);
  assert.deepEqual(f.cards(), [second, first], 'stable item identity survives canonical reorder');
  assert.equal(intent(first, action), focused, 'the surviving focused control is retained');
  assert.equal(f.document.activeElement, focused);
  assert.equal(focused.isConnected, true);
  assert.equal(JSON.stringify(data), original, 'render does not mutate prior canonical detail');
  assert.equal(f.getState().detail.data.items, items, 'canonical ordered array is not replaced by presentation');
  assert.deepEqual(keys(f), [IB, IA]);
  assert.equal(f.owners.filter(owner => owner.kind === 'gallery').length, 1);
});

test('unchanged snapshot, scale, and view updates retain keyed card nodes and canonical members', async t => {
  const data = freeze(detail()), before = JSON.stringify(data);
  const f = await mounted(t, {data, shell: {galleryDisplayMode: 'covers', galleryScalePercent: 80}});
  const [first, second] = f.cards(), root = f.galleryRoot();
  assert.equal(root.getAttribute('data-gallery-display'), 'covers');
  const minimum = root.style.gridTemplateColumns;
  f.update();
  assert.deepEqual(f.cards(), [first, second]);
  f.setShell({galleryScalePercent: 140}); f.update();
  assert.notEqual(root.style.gridTemplateColumns, minimum);
  f.choose('list'); f.update();
  assert.deepEqual(f.writes, ['list']);
  assert.equal(root.getAttribute('data-gallery-display'), 'list');
  assert.ok(f.cards().every(card => card.getAttribute('data-gallery-display') === 'list'));
  assert.deepEqual(f.cards(), [first, second]);
  assert.equal(f.getState().detail.data.items, data.items);
  assert.equal(JSON.stringify(data), before);
});

test('saved mobile columns and Rows use the real shared device geometry', async t => {
  const f = await mounted(t, {shell: {galleryDisplayMode: 'covers', mobileGalleryColumns: 2}});
  f.context.innerWidth = 390; f.update();
  assert.equal(f.galleryRoot().style.gridTemplateColumns, 'repeat(2, minmax(0, 481px))');
  f.setShell({mobileGalleryColumns: 3}); f.update();
  assert.equal(f.galleryRoot().style.gridTemplateColumns, 'repeat(3, minmax(0, 316px))');
  f.setShell({galleryDisplayMode: 'list'}); f.update();
  assert.equal(f.galleryRoot().style.gridTemplateColumns, 'repeat(1, minmax(0, 976px))');
});

test('manual completion dispatches current actor progress and never edits canonical membership', async t => {
  const data = freeze(detail()), before = JSON.stringify(data), f = await mounted(t, {data});
  f.click(complete(f));
  f.click(intent(f.cards()[1], 'complete'));
  assert.deepEqual(f.calls, [{action: 'set_manual_completion', payload: {album_ref: A, completed: true}},
    {action: 'set_manual_completion', payload: {album_ref: B, completed: false}}]);
  assert.equal(JSON.stringify(data), before);
  assert.deepEqual(keys(f), [IA, IB]);
});

for (const mutation of [{status: 'loading'}, {status: 'uncertain'}, {status: 'idle', refreshing: true}]) {
  test(`manual completion is visibly and behaviorally disabled during ${JSON.stringify(mutation)}`, async t => {
    const f = await mounted(t);
    f.setState({...f.getState(), mutation});
    const button = complete(f);
    assert.equal(button.disabled, true);
    assert.equal(button.getAttribute('aria-disabled'), 'true');
    const open = intent(f.cards()[0], 'open');
    assert.equal(open.disabled, true);
    assert.equal(open.getAttribute('aria-disabled'), 'true');
    // Synthetic dispatch bypasses browser disabled suppression to test the owner.
    button.dispatchEvent(new f.context.Event('click'));
    open.dispatchEvent(new f.context.Event('click'));
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.selections[0].intents, []);
  });
}

test('paused progress stays visible and disabled; loss of permission and malformed progress remove completion', async t => {
  const f = await mounted(t), original = f.getState().detail.data;
  patchDetail(f, {top_viewer_overlay: {...original.top_viewer_overlay, activity: {active: false, activity_revision: '1'}}});
  assert.equal(complete(f).disabled, true);
  assert.equal(intent(f.cards()[1], 'complete').getAttribute('aria-pressed'), 'true');
  complete(f).dispatchEvent(new f.context.Event('click')); assert.deepEqual(f.calls, []);
  patchDetail(f, {top_viewer_overlay: original.top_viewer_overlay, allowed_actions: {'library.browse.read': true, can_manage_own_progress: false}});
  assert.equal(complete(f), null);
  patchDetail(f, {allowed_actions: original.allowed_actions, top_viewer_overlay: {...original.top_viewer_overlay,
    item_progress: {[A]: {manual_completed_at: null}, [B]: progress(true)}}});
  assert.equal(complete(f), null);
  assert.ok(intent(f.cards()[1], 'complete'));
});

test('retained completion callback rechecks live mutation and permission before a consumer update', async t => {
  const f = await mounted(t), stale = complete(f), initial = f.getState();
  f.setState({...initial, mutation: {status: 'loading'}}, {render: false});
  stale.dispatchEvent(new f.context.Event('click')); assert.deepEqual(f.calls, []);
  f.setState({...initial, detail: {...initial.detail, data: {...initial.detail.data,
    allowed_actions: {'library.browse.read': true, can_manage_own_progress: false}}}}, {render: false});
  stale.dispatchEvent(new f.context.Event('click')); assert.deepEqual(f.calls, []);
});

test('remote, denied and missing-artwork rows retain canonical order without unsafe native actions', async t => {
  const remote = row(13, {source_kind: 'remote_summary', native_album: {artwork_url: 'https://invalid.example/remote.png', allowed_actions: {can_view_details: true}}});
  const denied = row(14, {native_album: null});
  const noArtwork = row(15, {native_album: {inventory_album_ref: 'native-15', artwork_url: null, allowed_actions: {can_view_details: true}}});
  const data = freeze(detail({items: [remote, denied, noArtwork], top_viewer_overlay: {activity: {active: true, activity_revision: '0'},
    item_progress: Object.fromEntries([remote, denied, noArtwork].map(item => [item.album_ref, progress()]))}}));
  const f = await mounted(t, {data}), [remoteCard, deniedCard, missingCard] = f.cards();
  assert.deepEqual(keys(f), data.items.map(item => item.item_ref));
  assert.match(remoteCard.textContent, /Remote album summary · tracks unavailable/);
  assert.equal(intent(remoteCard, 'open'), null);
  assert.equal(intent(deniedCard, 'open'), null);
  assert.ok(intent(missingCard, 'open'));
  assert.equal(f.host.querySelectorAll('img').length, 0);
  assert.equal(f.host.querySelectorAll('[data-open-tracklist]').length, 0);
  assert.equal(f.host.querySelectorAll('[data-album-key]').length, 0);
  f.cards().forEach(card => assert.ok(intent(card, 'complete'), 'manual progress remains independent of local track availability'));
  assert.equal(f.getState().detail.data, data);
});

test('eligible native artwork uses the scoped URL and never exposes raw album paths', async t => {
  const f = await mounted(t);
  assert.deepEqual(f.host.querySelectorAll('img').map(image => image.getAttribute('src')), ['/library/album-artwork/native-11', '/library/album-artwork/native-12']);
  assert.equal(f.host.querySelectorAll('[data-album]').length, 0);
  assert.equal(f.host.querySelectorAll('[data-cover-path]').length, 0);
  assert.equal(f.host.querySelectorAll('[data-open-tracklist]').length, 0);
});

for (const patch of [{viewVersion: 2}, {viewRequestId: 11}, {scopeKey: 'other-account'}, {visible: false}, {authenticated: false}, {topRef: OTHER}]) {
  test(`stale source rejects View and completion callbacks after ${JSON.stringify(patch)}`, async t => {
    const f = await mounted(t), button = complete(f), choose = f.chosen[0].onSelect;
    f.setShell(patch);
    choose('covers'); button.dispatchEvent(new f.context.Event('click')); f.flush();
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.calls, []);
    f.owner.dispose();
    assert.ok(f.observers.every(observer => observer.disconnected));
  });
}

test('disposal retires native owners once, cancels scheduled work, and fences detached controls', async t => {
  const f = await mounted(t), button = complete(f), choose = f.chosen[0].onSelect;
  button.focus(); f.emitWindow('resize');
  const callbacks = [...f.frames.values(), ...f.timers.values(), ...f.observers.map(observer => observer.callback)];
  f.owner.dispose(); f.owner.dispose();
  assert.ok(f.owners.every(owner => owner.disposals === 1));
  assert.ok(f.observers.every(observer => observer.disconnected));
  assert.equal(f.frames.size, 0); assert.equal(f.timers.size, 0);
  assert.equal(f.windowEvents.listeners.length, f.baseline.windowListeners);
  assert.equal(f.listeners().length, f.baseline.listeners);
  callbacks.forEach(callback => callback([]));
  choose('covers'); button.dispatchEvent(new f.context.Event('click'));
  f.owner.update({controller: f.controller, state: f.getState(), providers: {}}); f.flush();
  assert.deepEqual(f.calls, []); assert.deepEqual(f.writes, []);
  assert.equal(f.host.children.length, 0);
  assert.equal(f.context.state.gallery, f.artistGallery);
  assert.equal(f.context.state.view, f.artistView);
});

test('empty Top destroys the open View chooser and can restore it on a later canonical update', async t => {
  const f = await mounted(t), active = f.host.querySelector('.unfolding-action-button button.is-active');
  f.click(active);
  assert.equal(active.getAttribute('aria-expanded'), 'true');
  const staleSelect = f.chosen[0].onSelect;
  patchDetail(f, {items: [], completion_summary: {completed: 0, total: 0}});
  assert.equal(f.host.querySelector('.unfolding-action-button'), null);
  assert.equal(f.cards().length, 0);
  staleSelect('covers'); assert.deepEqual(f.writes, []);
  patchDetail(f, {items: [row()], completion_summary: {completed: 0, total: 1}});
  assert.equal(f.cards().length, 1);
  assert.ok(f.host.querySelector('.unfolding-action-button'));
});

test('app places View in shared header and remounts an exact new source, then retires it for directory', async t => {
  const f = await mounted(t, {app: true}), first = f.galleryRoot();
  const viewControl = f.host.querySelector('.unfolding-action-button');
  assert.ok(viewControl.closest('[data-shared-header]'), 'View is owned by existing shared header actions');
  f.setShell({viewVersion: 2}); f.update();
  assert.notEqual(f.galleryRoot(), first);
  assert.equal(first.isConnected, false);
  assert.equal(f.owners.filter(owner => owner.kind === 'gallery').length, 2);
  f.setShell({topRef: null});
  f.setState({...f.getState(), selectedTopRef: null, detail: {status: 'unavailable', data: null}});
  assert.equal(f.galleryRoot(), null);
  assert.equal(f.host.querySelector('.unfolding-action-button'), null);
  assert.equal(f.cards().length, 1, 'directory uses its original Top summary cards');
  f.click(intent(f.cards()[0], 'open'));
  assert.deepEqual(f.calls, [{action: 'navigate', ref: TOP}]);
});

test('app retires a saved gallery while detail loads or is denied and mounts fresh on recovery', async t => {
  const f = await mounted(t, {app: true}), data = f.getState().detail.data;
  for (const status of ['loading', 'denied']) {
    const old = f.galleryRoot();
    f.setState({...f.getState(), detail: {status, data: status === 'denied' ? null : data}});
    assert.equal(f.galleryRoot(), null); assert.equal(old.isConnected, false);
    f.setState({...f.getState(), detail: {status: 'ready', data}});
    assert.ok(f.galleryRoot()); assert.notEqual(f.galleryRoot(), old);
  }
});

test('removal retires the removed focused member and does not restore stale controls', async t => {
  const f = await mounted(t), removed = f.cards()[0], stale = intent(removed, 'complete'), surviving = f.cards()[1];
  stale.focus();
  patchDetail(f, {items: [f.getState().detail.data.items[1]]});
  assert.deepEqual(f.cards(), [surviving]);
  assert.equal(removed.isConnected, false);
  assert.equal(f.document.activeElement, f.document.body);
  stale.dispatchEvent(new f.context.Event('click')); assert.deepEqual(f.calls, []);
});

test('provider replacement retires pending details without remounting unchanged cards', async t => {
  const f = await mounted(t), cards = f.cards(), selection = f.selections[0], before = selection.invalidations;
  f.replaceProviders({resolveNativeAlbum() {assert.fail('no details intent was requested');}});
  assert.ok(selection.invalidations > before);
  assert.deepEqual(f.cards(), cards);
  assert.equal(f.owners.filter(owner => owner.kind === 'gallery').length, 1);
});

test('gallery disposes its chooser while preserving caller-owned shared-header slot', async t => {
  const f = await mounted(t, {toolsHost: true});
  assert.ok(f.externalTools.querySelector('.unfolding-action-button'));
  assert.equal(f.host.querySelector('.unfolding-action-button'), null);
  f.owner.dispose();
  assert.equal(f.externalTools.isConnected, true);
  assert.equal(f.externalTools.hidden, true);
  assert.equal(f.externalTools.children.length, 0);
});

test('detail refresh disables native Open and restores the unchanged enabled default after settlement', async t => {
  const f = await mounted(t), card = f.cards()[0];
  assert.equal(intent(card, 'open').disabled, false);
  f.setState({...f.getState(), detail: {...f.getState().detail, refreshing: true}});
  assert.equal(f.cards()[0], card);
  assert.equal(intent(card, 'open').disabled, true);
  assert.equal(intent(card, 'open').getAttribute('aria-disabled'), 'true');
  intent(card, 'open').dispatchEvent(new f.context.Event('click'));
  assert.deepEqual(f.selections[0].intents, []);
  f.setState({...f.getState(), detail: {...f.getState().detail, refreshing: false}});
  assert.equal(intent(card, 'open').disabled, false);
  assert.equal(intent(card, 'open').getAttribute('aria-disabled'), null);
});

test('shared controlled GalleryCard Open disables only on explicit boolean and preserves the default', () => {
  const f = environment(), holder = f.document.createElement('div');
  const config = {identity: IA, title: 'Album', interaction: 'controlled', actionRef: A, actions: {open: true}};
  for (const openDisabled of [undefined, false, 'true']) {
    holder.innerHTML = f.runtime.galleryCardHtml({...config, openDisabled});
    assert.equal(intent(holder, 'open').disabled, false);
    assert.equal(intent(holder, 'open').getAttribute('aria-disabled'), null);
  }
  holder.innerHTML = f.runtime.galleryCardHtml({...config, openDisabled: true});
  assert.equal(intent(holder, 'open').disabled, true);
  assert.equal(intent(holder, 'open').getAttribute('aria-disabled'), 'true');
});

test('first and repeated no-op Gallery updates retain every unfocused action node', async t => {
  const f = await mounted(t), cards = f.cards();
  const actions = cards.map(card => ['open', 'complete'].map(kind => intent(card, kind)));
  for (const pair of actions) for (const button of pair) {assert.ok(button); assert.notEqual(f.document.activeElement, button);}
  for (let index = 0; index < 3; index++) {
    f.update();
    assert.deepEqual(f.cards(), cards);
    cards.forEach((card, rowIndex) => ['open', 'complete'].forEach((kind, actionIndex) => {
      assert.equal(intent(card, kind), actions[rowIndex][actionIndex], `unchanged ${kind} identity, update ${index}`);
    }));
  }
  f.setState({...f.getState(), mutation: {status: 'loading'}});
  assert.equal(intent(cards[0], 'complete').disabled, true, 'actual changed markup still reconciles');
  f.setState({...f.getState(), mutation: {status: 'idle'}});
  const ready = intent(cards[0], 'complete'); assert.equal(ready.disabled, false);
  f.update(); assert.equal(intent(cards[0], 'complete'), ready, 'updated raw markup becomes the next stable cache');
  f.click(ready);
  assert.deepEqual(f.calls, [{action: 'set_manual_completion', payload: {album_ref: A, completed: true}}]);
});
