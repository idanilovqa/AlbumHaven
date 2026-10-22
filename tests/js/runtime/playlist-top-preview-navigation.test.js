'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = process.env.ALBUM_TOP_TEST_ROOT || path.resolve(__dirname, '../../..');
const load = (context, name) => vm.runInContext(fs.readFileSync(path.join(ROOT, 'music_app/static/js/runtime', name), 'utf8'), context);
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};

function fixture({gate, retention = 'normal'} = {}) {
  let live = true, retaining = false, opened, delayed;
  const calls = [];
  const target = {kind: 'album', ref: 'canonical', allowed_actions: {can_view_details: true},
    native_actions: {album_ref: 'native', allowed_actions: {can_open_album: true, can_play_album: false}}};
  const context = vm.createContext({window: {}, document: {}, AbortController, state: {ui: {pendingTrackModalLoadToken: 0}},
    deferAppFormPageReplacement: () => {calls.push(['leave', retaining]); return false;},
    fetchTrackModalAlbumDetails: async () => {calls.push(['hydrate', retaining]); if (gate) await gate.promise; return {key: 'native'};},
    releaseTrackModalSelection() {},
    openTrackModal: (_album, options) => {calls.push(['open', retaining]); opened = options; return true;}});
  load(context, 'resource-selection.js');
  const retainNavigation = callback => {
    if (retention === 'delayed') {delayed = callback; return;}
    if (retention === 'cancelled') return false;
    const previous = retaining; retaining = true;
    try {const result = callback(); if (retention === 'reentrant') assert.equal(callback(), false); return result;}
    finally {retaining = previous;}
  };
  const owner = context.window.AlbumHavenResourceSelection.create({
    sourceResource: () => live ? target : null,
    retainResource: () => ({target, isCurrent: () => live}),
    revalidateResource: async () => live ? {target, isCurrent: () => live} : null,
    authorizeResource: async () => {if (!live) throw Error('revoked');}, retainNavigation,
  });
  return {owner, target, context, calls, scope: {scopeKey: 'session:library:draft'},
    retire: () => {live = false;}, get opened() {return opened;}, get retaining() {return retaining;},
    delayed: () => delayed?.()};
}

test('only synchronous admission and post-hydration handoff retain the draft', async () => {
  const gate = deferred(), h = fixture({gate});
  const opening = h.owner.resourceIntent('open', h.target, h.scope);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.retaining, false);
  gate.resolve(); await opening;
  assert.deepEqual(h.calls, [['leave', true], ['hydrate', false], ['open', true]]);
  assert.equal(h.retaining, false);
  let nested = 0;
  h.opened.sourcePageOwner.retainNavigation(() => {assert.equal(h.retaining, true); nested++;});
  assert.equal(nested, 1);
  assert.equal(h.retaining, false);
});

test('session or draft retirement during hydration cannot reach history handoff', async () => {
  const gate = deferred(), h = fixture({gate});
  const opening = h.owner.resourceIntent('open', h.target, h.scope);
  await Promise.resolve(); await Promise.resolve();
  h.retire(); gate.resolve();
  await assert.rejects(opening);
  assert.equal(h.opened, undefined);
  assert.equal(h.retaining, false);
});

test('a newer native opening supersedes the pending hydration owner', async () => {
  const gate = deferred(), h = fixture({gate});
  const old = h.owner.resourceIntent('open', h.target, h.scope).then(() => null, error => error);
  const next = h.owner.resourceIntent('open', h.target, h.scope);
  gate.resolve(); await next;
  assert.ok(await old);
  assert.equal(h.calls.filter(([kind]) => kind === 'open').length, 1);
});

for (const retention of ['cancelled', 'delayed']) test(`${retention} retention never grants deferred navigation`, async () => {
  const h = fixture({retention});
  await assert.rejects(h.owner.resourceIntent('open', h.target, h.scope), {name: 'AbortError'});
  assert.equal(h.delayed(), retention === 'delayed' ? false : undefined);
  assert.equal(h.opened, undefined);
});

test('reentrant retention cannot invoke a native presentation twice', async () => {
  const h = fixture({retention: 'reentrant'});
  await h.owner.resourceIntent('open', h.target, h.scope);
  assert.equal(h.calls.filter(([kind]) => kind === 'open').length, 1);
});

test('retired Back/Cancel owner cannot be resurrected by its retained Forward callback', async () => {
  const h = fixture(); await h.owner.resourceIntent('open', h.target, h.scope);
  const owner = h.opened.sourcePageOwner;
  h.retire(); let called = false;
  assert.throws(() => owner.retainNavigation(() => {called = true;}), {name: 'AbortError'});
  await assert.rejects(owner.revalidate({albumKey: 'native', signal: new AbortController().signal}));
  assert.equal(called, false);
});

test('modal owner normalization preserves the callback without making it authority', () => {
  const c = vm.createContext({}); load(c, 'track-modal-lightbox-helpers.js');
  const candidate = {isCurrent: () => false, retainNavigation: callback => callback()};
  const owner = c.resolveTrackModalSourcePageOwner(candidate, 'native', {});
  assert.equal(owner.retainNavigation, candidate.retainNavigation);
  assert.equal(owner.isCurrent(), false);
  assert.equal(c.resolveTrackModalSourcePageOwner({retainNavigation: candidate.retainNavigation}, 'native', {}), null);
});

test('only the current modal Artist link inherits draft retention', () => {
  let retained = false, current = true, owner;
  const calls = [];
  const c = vm.createContext({state: {view: {}},
    getTrackModalSourcePageOwner: () => owner,
    invalidateAdvancedSearchIntent() {},
    // Stop at the real Artist handler's existing navigation boundary. Full
    // Artist hydration/history behavior remains native integration coverage.
    deferAppFormPageReplacement: () => {calls.push(retained); return true;},
  });
  load(c, 'bootstrap-gallery-event-handlers.js');
  owner = {isCurrent: () => current, retainNavigation(callback) {retained = true; try {return callback();} finally {retained = false;}}};
  const event = modal => {const link = {closest: selector => selector === '#track-modal' && modal ? {} : null};
    return {target: {closest: () => link}, preventDefault() {}};};
  assert.equal(c.handleSidebarArtistSelectionClick(event(true)), true);
  assert.equal(c.handleSidebarArtistSelectionClick(event(false)), true);
  assert.deepEqual(calls, [true, false]);
  current = false;
  assert.equal(c.handleSidebarArtistSelectionClick(event(true)), true);
  assert.deepEqual(calls, [true, false]);
});

test('history replay reauthorizes outside retention and retains only its fresh presentation', async () => {
  let live = true, retaining = false, opens = 0;
  const gate = deferred();
  const c = vm.createContext({state: {ui: {pendingTrackModalLoadToken: 0}},
    getAlbumRequestKey: album => album.key});
  load(c, 'track-modal-lightbox-helpers.js');
  c.releaseTrackModalSelection = () => {};
  c.openTrackModal = () => {assert.equal(retaining, true); opens++; return true;};
  const owner = c.resolveTrackModalSourcePageOwner({isCurrent: () => live,
    async revalidate() {assert.equal(retaining, false); await gate.promise;
      return {album: {key: 'native'}, isCurrent: () => live, presentationRestrictions: {can_open_album_page: true}};},
    retainNavigation(callback) {retaining = true; try {return live ? callback() : false;} finally {retaining = false;}}},
  'native', {can_open_album_page: true, can_view_artwork: true, can_play_album: false});
  c.retainTrackModalSourcePageOwner(owner);
  const descriptor = {sourcePageToken: owner.token, albumKey: 'native'};
  const pending = c.restoreTrackModalSourcePage(descriptor, {isCurrent: () => live});
  assert.equal(retaining, false); gate.resolve();
  assert.equal(await pending, true); assert.equal(opens, 1); assert.equal(retaining, false);
  live = false;
  assert.equal(await c.restoreTrackModalSourcePage(descriptor, {isCurrent: () => live}), false);
  assert.equal(opens, 1);
});

for (const mode of ['skipped', 'cancelled', 'delayed', 'reentrant', 'retired']) {
  test(`history replay ${mode} hook cannot fabricate or repeat a handoff`, async () => {
    let live = true, opens = 0, delayed;
    const c = vm.createContext({state: {ui: {pendingTrackModalLoadToken: 0}}, getAlbumRequestKey: album => album.key});
    load(c, 'track-modal-lightbox-helpers.js');
    c.releaseTrackModalSelection = () => {};
    c.openTrackModal = () => {opens++; return true;};
    const owner = c.resolveTrackModalSourcePageOwner({isCurrent: () => live,
      revalidate: async () => ({album: {key: 'native'}, isCurrent: () => live, presentationRestrictions: {can_open_album_page: true}}),
      retainNavigation(callback) {
        if (mode === 'skipped') return;
        if (mode === 'cancelled') return false;
        if (mode === 'delayed') {delayed = callback; return;}
        if (mode === 'retired') live = false;
        const result = callback();
        if (mode === 'reentrant') assert.equal(callback(), false);
        return result;
      }}, 'native', {can_open_album_page: true});
    c.retainTrackModalSourcePageOwner(owner);
    const result = await c.restoreTrackModalSourcePage({sourcePageToken: owner.token, albumKey: 'native'}, {isCurrent: () => live});
    assert.equal(result, mode === 'reentrant');
    assert.equal(opens, mode === 'reentrant' ? 1 : 0);
    if (delayed) {assert.equal(delayed(), false); assert.equal(opens, 0);}
  });

  test(`modal Artist ${mode} hook cannot leave outside its synchronous handoff`, () => {
    let live = true, calls = 0, delayed;
    const owner = {isCurrent: () => live, retainNavigation(callback) {
      if (mode === 'skipped') return;
      if (mode === 'cancelled') return false;
      if (mode === 'delayed') {delayed = callback; return;}
      if (mode === 'retired') live = false;
      const result = callback();
      if (mode === 'reentrant') assert.equal(callback(), false);
      return result;
    }};
    const c = vm.createContext({state: {view: {}}, getTrackModalSourcePageOwner: () => owner,
      invalidateAdvancedSearchIntent() {}, deferAppFormPageReplacement: () => {calls++; return true;}});
    load(c, 'bootstrap-gallery-event-handlers.js');
    const link = {closest: selector => selector === '#track-modal' ? {} : null};
    assert.equal(c.handleSidebarArtistSelectionClick({target: {closest: () => link}, preventDefault() {}}), true);
    assert.equal(calls, mode === 'reentrant' ? 1 : 0);
    if (delayed) {assert.equal(delayed(), false); assert.equal(calls, 0);}
  });
}

for (const wrapperResult of [undefined, true]) test(`replay rejects a false native opener swallowed by a ${wrapperResult} wrapper`, async () => {
  let opens = 0;
  const c = vm.createContext({state: {ui: {pendingTrackModalLoadToken: 0}}, getAlbumRequestKey: album => album.key});
  load(c, 'track-modal-lightbox-helpers.js');
  c.releaseTrackModalSelection = () => {};
  c.openTrackModal = () => {opens++; return false;};
  const owner = c.resolveTrackModalSourcePageOwner({isCurrent: () => true,
    revalidate: async () => ({album: {key: 'native'}, isCurrent: () => true, presentationRestrictions: {can_open_album_page: true}}),
    retainNavigation(callback) {callback(); return wrapperResult;}}, 'native', {can_open_album_page: true});
  c.retainTrackModalSourcePageOwner(owner);
  assert.equal(await c.restoreTrackModalSourcePage({sourcePageToken: owner.token, albumKey: 'native'}, {isCurrent: () => true}), false);
  assert.equal(opens, 1);
});

for (const replacement of ['load-token', 'replay-owner']) test(`replay hook cannot open after ${replacement} supersession`, async () => {
  let opens = 0, successor;
  const gate = deferred();
  const c = vm.createContext({state: {ui: {pendingTrackModalLoadToken: 0}}, getAlbumRequestKey: album => album.key});
  load(c, 'track-modal-lightbox-helpers.js');
  c.releaseTrackModalSelection = () => {};
  c.openTrackModal = () => {opens++; return true;};
  const nextOwner = c.resolveTrackModalSourcePageOwner({isCurrent: () => true,
    revalidate: async () => {await gate.promise; return {album: {key: 'next'}, isCurrent: () => false};}}, 'next', {can_open_album_page: true});
  c.retainTrackModalSourcePageOwner(nextOwner);
  const owner = c.resolveTrackModalSourcePageOwner({isCurrent: () => true,
    revalidate: async () => ({album: {key: 'native'}, isCurrent: () => true, presentationRestrictions: {can_open_album_page: true}}),
    retainNavigation(callback) {
      if (replacement === 'load-token') c.state.ui.pendingTrackModalLoadToken++;
      else successor = c.restoreTrackModalSourcePage({sourcePageToken: nextOwner.token, albumKey: 'next'}, {isCurrent: () => true});
      assert.equal(callback(), false); return true;
    }}, 'native', {can_open_album_page: true});
  c.retainTrackModalSourcePageOwner(owner);
  assert.equal(await c.restoreTrackModalSourcePage({sourcePageToken: owner.token, albumKey: 'native'}, {isCurrent: () => true}), false);
  gate.resolve(); if (successor) assert.equal(await successor, false);
  assert.equal(opens, 0);
});
