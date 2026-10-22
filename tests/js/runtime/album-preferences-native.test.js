'use strict';
// Authored assertions, NOT executed. See COVERAGE.md for explicit exclusions.
const test = require('node:test');
const assert = require('node:assert/strict');
const {fixture, preference, album, envelope, detail, plain, drain, deferred, ordinary, A, B} = require('./album-preferences-native-fixture.cjs');
const postBody = request => JSON.parse(request.options.body);
const response = payload => ({ok: true, status: 200, json: async () => payload});
const available = (patch = {}) => preference(patch);
const favored = (patch = {}) => available({is_favorite: true, favorite_override: true, favorite_source: 'personal', preference_revision: 1, ...patch});
const disabled = h => ['favorite', 'rating', 'clear'].forEach(name => assert.equal(h.control(name)?.disabled, true, name));
const noProgress = value => ['to_listen', 'is_relisten', 'can_toggle_to_listen'].forEach(key => assert.equal(Object.hasOwn(value || {}, key), false, key));
async function settleGallery(h) {
  const request = h.pending(r => r.url.startsWith('/view-data')).at(-1);
  assert.ok(request, 'actual actor-scoped gallery refresh follows successful mutation');
  const current = h.c.getCurrentTrackModalAlbum();
  request.resolve({...ordinary(), context_ref: A, artist_groups: [{artist: 'Local artist', albums: [plain(current)]}], album_count: 1});
  await drain();
  for (const read of h.pending(r => r.url.startsWith('/album-details?'))) {read.resolve(detail(plain(current))); await drain();}
}
async function failSaveAndRead(h, action = 'favorite') {
  const request = await h.activate(action, action === 'rating' ? 10 : undefined);
  request.resolve({error: 'revision_conflict'}, 409); await drain();
  const read = h.pending(r => r.url.startsWith('/album-details?')).at(-1);
  assert.ok(read, 'uncertain command uses actual uncached detail owner');
  read.resolve({error: 'unavailable'}, 503); await drain();
  return request;
}

test('whole classic closure supplies the actual native transport, receipt owners and disabled-focus semantics', t => {
  const h = fixture(t), scope = h.c.captureRuntimeAlbumPreferenceScope();
  assert.ok(scope); assert.equal(Object.isFrozen(scope), true);
  assert.equal(scope.transport, h.c.AlbumHavenPrivateUITransport);
  const button = h.document.createElement('button'); h.document.body.append(button); button.disabled = true;
  button.focus(); assert.notEqual(h.document.activeElement, button);
  button.disabled = false; button.focus(); assert.equal(h.document.activeElement, button);
  button.remove(); assert.equal(h.document.activeElement, h.document.body);
});

test('own modal shows empty existing stars and every native rating from 1 through 10', async t => {
  for (const rating of [null, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) await t.test(String(rating), async t => {
    const h = fixture(t); await h.open(album({album_preference: available({rating})}));
    const root = h.c.getTrackModalAlbumPreferenceLease().root;
    assert.ok(root.innerHTML.includes(rating === null ? 'Your album is unrated' : `Your album rating ${rating}/10`));
    const stars = root.querySelectorAll('.stars .star');
    assert.equal(stars.length, 10);
    assert.equal([...stars].filter(star => star.classList.contains('filled')).length, rating ?? 0);
    assert.equal([...stars].filter(star => !star.classList.contains('filled')).length, 10 - (rating ?? 0));
    assert.equal(h.control('rating').querySelectorAll('option').length, 11);
    assert.equal(h.control('favorite').getAttribute('aria-pressed'), 'false');
    assert.ok(h.c.runtimeAlbumPreferenceForAlbum(h.c.getCurrentTrackModalAlbum()), 'actual read minted authority');
  });
});

test('favorite desired booleans, rating endpoints and Clear send strict independent CAS patches with real CSRF/context', async t => {
  for (const [action, value, initial, expectedPatch, next] of [
    ['favorite', null, available({rating: 7}), {favorite: true}, favored({rating: 7})],
    ['favorite', null, favored({rating: 7}), {favorite: false}, available({rating: 7, favorite_override: false, favorite_source: 'personal', preference_revision: 2})],
    ['rating', 1, favored(), {rating: 1}, favored({rating: 1, preference_revision: 2})],
    ['rating', 10, favored(), {rating: 10}, favored({rating: 10, preference_revision: 2})],
    ['clear', null, favored({rating: 9}), {rating: null}, favored({rating: null, preference_revision: 2})],
  ]) await t.test(`${action}:${JSON.stringify(expectedPatch)}`, async t => {
    const h = fixture(t); await h.open(album({album_preference: initial}));
    const request = await h.activate(action, value);
    assert.deepEqual(postBody(request), {album_ref: 'inventory-album:9:11', expected_revision: initial.preference_revision, patch: expectedPatch});
    const headers = new Headers(request.options.headers);
    assert.equal(headers.get('X-Album-Haven-CSRF'), 'csrf-native');
    assert.equal(headers.get('X-AlbumHaven-Context'), A);
    assert.notEqual(headers.get('X-Album-Haven-CSRF'), A);
    assert.equal(request.options.credentials, 'same-origin'); assert.equal(request.options.cache, 'no-store');
    disabled(h); const pendingRoot = h.c.getTrackModalAlbumPreferenceLease().root;
    assert.equal(pendingRoot.getAttribute('aria-busy'), 'true');
    const desiredRating = Object.hasOwn(expectedPatch, 'rating') ? expectedPatch.rating : initial.rating;
    const desiredFavorite = Object.hasOwn(expectedPatch, 'favorite') ? expectedPatch.favorite : initial.is_favorite;
    assert.equal(h.control('favorite').getAttribute('aria-pressed'), String(desiredFavorite));
    assert.equal(pendingRoot.querySelector('.rating-row').getAttribute('data-rating-value'), String(desiredRating ?? 0));
    assert.equal(h.control('rating').querySelector('option[selected]').getAttribute('value'), String(desiredRating ?? ''));
    const duplicate = h.control(action); h.dispatch(duplicate, action === 'rating' ? 'change' : 'click');
    assert.equal(h.posts().length, 1, 'even synthetic duplicate activation is ignored while pending');
    duplicate.focus(); assert.notEqual(h.document.activeElement, duplicate, 'disabled replacement cannot fake focus');
    request.resolve(envelope(next)); await drain(); await settleGallery(h);
    assert.deepEqual(plain(h.c.getCurrentTrackModalAlbum().album_preference), next);
    assert.equal(h.document.activeElement, h.control(action), 'focus survives exact automatic foreground owner');
    assert.equal(h.posts().length, 1); noProgress(h.c.getCurrentTrackModalAlbum().album_preference);
  });
});

test('same-state Clear accepts unchanged revision; next command uses last authorized revision', async t => {
  const h = fixture(t); await h.open(); const request = await h.activate('clear');
  request.resolve(envelope(available())); await drain(); await settleGallery(h);
  const next = await h.activate('rating', 10); assert.equal(postBody(next).expected_revision, 0);
});

test('missing CSRF never dispatches a mutation', async t => {
  const h = fixture(t); await h.open(); h.document.cookie = '';
  await h.activate('favorite'); assert.equal(h.posts().length, 0);
  assert.match(h.c.getTrackModalAlbumPreferenceLease().root.textContent, /Reload to restore/);
});

test('malformed, mismatched, unavailable and unsafe own state never gets editable receipt', t => {
  const h = fixture(t), c = h.c, scope = c.captureRuntimeAlbumPreferenceScope();
  for (const patch of [{rating: 0}, {rating: 11}, {rating: true}, {preference_revision: 9007199254740992},
    {context_ref: B}, {album_ref: 'inventory-album:10:11'}, {can_edit: false},
    {allowed_actions: {can_manage_album_preferences: true, can_read: true}}, {is_favorite: true},
    {favorite_source: 'tag'}, {extra: true}, {taste_state: 'unavailable'}]) {
    const input = album({album_preference: available(patch)});
    assert.equal(c.runtimeAlbumPreferenceForAlbum(input, scope, false), null, JSON.stringify(patch));
  }
  for (const patch of [{album_id: 9007199254740992}, {album_id: 12}, {library_id: 10}, {read_only_subject: 'peer'}])
    assert.equal(c.runtimeAlbumPreferenceForAlbum(album(patch), scope, false), null);
});

test('embedded and cached DTOs cannot mint a read receipt or admit optional progress', async t => {
  const h = fixture(t), input = album({album_preference: available({to_listen: true, is_relisten: true, can_toggle_to_listen: true})});
  const compact = h.c.compactRuntimeAlbumPayload(input);
  assert.deepEqual(plain(compact.album_preference), available(), 'current fully bound DTO preserves all valid core preference facts');
  assert.equal(h.c.runtimeAlbumPreferenceForAlbum(compact), null); noProgress(compact.album_preference);
  h.c.openTrackModal(input); await drain(); disabled(h); assert.equal(h.posts().length, 0);
  const request = h.pending(r => r.url.startsWith('/album-details?')).at(-1); assert.ok(request);
  request.resolve(detail(album())); await drain(); assert.equal(h.control('favorite').disabled, false);
});

test('409, post-commit denial, network failure and invalid success reconcile by GET with no command replay', async t => {
  for (const mode of ['conflict', 'denial', 'network', 'json', 'extra-envelope', 'nested-context', 'backward', 'wrong-intent'])
    await t.test(mode, async t => {
      const h = fixture(t); await h.open(album({album_preference: available({preference_revision: 5})}));
      const request = await h.activate('favorite');
      if (mode === 'network') request.reject(new Error('response lost after commit'));
      else if (mode === 'json') request.holdJson().reject(new SyntaxError('invalid JSON'));
      else if (mode === 'conflict' || mode === 'denial') request.resolve({error: mode}, mode === 'conflict' ? 409 : 403);
      else request.resolve(mode === 'extra-envelope' ? {...envelope(favored({preference_revision: 6})), extra: true}
        : envelope(favored({preference_revision: mode === 'backward' ? 4 : 6,
          ...(mode === 'nested-context' ? {context_ref: B} : {}),
          ...(mode === 'wrong-intent' ? {is_favorite: false, favorite_override: false} : {})})));
      await drain(); const read = h.pending(r => r.url.startsWith('/album-details?')).at(-1); assert.ok(read);
      assert.equal(h.posts().length, 1); disabled(h);
      read.resolve(detail(album({album_preference: favored({preference_revision: 6})}))); await drain();
      assert.equal(h.control('favorite').disabled, false); assert.equal(h.posts().length, 1);
      assert.equal(h.document.activeElement, h.control('favorite'));
      const next = await h.activate('clear'); assert.equal(postBody(next).expected_revision, 6);
    });
});

test('legacy one-key mutation wrapper cannot be accepted by actual private transport', async t => {
  const h = fixture(t); await h.open(); const request = await h.activate('favorite');
  const current = h.c.getCurrentTrackModalAlbum(), before = plain(current.album_preference);
  request.resolve({album_preference: favored()}); await drain();
  assert.deepEqual(plain(current.album_preference), before); assert.equal(h.posts().length, 1);
  assert.throws(() => h.c.AlbumHavenPrivateUITransport.context(), /Reload/);
});

test('failed automatic reconciliation focuses enabled recovery; keyboard Refresh success focuses an enabled own control', async t => {
  const h = fixture(t); await h.open(); await failSaveAndRead(h);
  disabled(h); assert.equal(h.control('refresh').disabled, false);
  assert.equal(h.document.activeElement, h.control('refresh'));
  const count = h.posts().length; await h.activate('refresh');
  assert.equal(h.control('refresh').disabled, true);
  assert.notEqual(h.document.activeElement, h.control('refresh'));
  h.pending(r => r.url.startsWith('/album-details?')).at(-1).resolve(detail(album({album_preference: favored()})));
  await drain(); assert.equal(h.control('refresh'), null);
  assert.equal(h.document.activeElement, h.control('favorite')); assert.equal(h.posts().length, count);
});

test('successful reconciliation removing edit permission clears uncertainty and focuses stable status', async t => {
  const h = fixture(t); await h.open(); await failSaveAndRead(h); await h.activate('refresh');
  h.pending(r => r.url.startsWith('/album-details?')).at(-1).resolve(detail(album({album_preference: available({
    can_edit: false, allowed_actions: {can_manage_album_preferences: false}})})));
  await drain(); disabled(h); assert.equal(h.control('refresh'), null);
  const lease = h.c.getTrackModalAlbumPreferenceLease(); assert.equal(lease.needsRead, false);
  assert.equal(h.document.activeElement, lease.root.querySelector('[data-album-preference-status]'));
  assert.equal(h.document.activeElement.getAttribute('tabindex'), '-1');
});

test('outside focus or pointer movement cancels both automatic failure and manual Refresh focus restoration', async t => {
  for (const manual of [false, true]) for (const pointer of [false, true]) await t.test(`${manual}:${pointer}`, async t => {
    const h = fixture(t); await h.open();
    if (manual) {await failSaveAndRead(h); await h.activate('refresh');}
    else {const request = await h.activate('favorite'); request.resolve({error: 'conflict'}, 409); await drain();}
    const outside = h.outside(pointer);
    const read = h.pending(r => r.url.startsWith('/album-details?')).at(-1); assert.ok(read);
    read.resolve(manual ? detail(album()) : {error: 'offline'}, manual ? 200 : 503); await drain();
    assert.equal(h.document.activeElement, outside);
    assert.equal(h.c.getTrackModalAlbumPreferenceLease().focusIntent.eligible, false);
  });
});

test('close during POST retires response; reopening exact binding reads before another command', async t => {
  const h = fixture(t); await h.open(); const request = await h.activate('favorite');
  const original = h.c.getCurrentTrackModalAlbum(), snapshot = plain(original.album_preference);
  h.c.closeTrackModal(); assert.equal(request.options.signal.aborted, true);
  request.resolve(envelope(favored())); await drain(); assert.deepEqual(plain(original.album_preference), snapshot);
  h.c.openTrackModal(original); await drain(); disabled(h);
  const read = h.pending(r => r.url.startsWith('/album-details?')).at(-1); assert.ok(read);
  assert.equal(h.posts().length, 1); read.resolve(detail(album({album_preference: favored()}))); await drain();
  assert.equal(h.control('favorite').disabled, false);
});

test('old captured subscription cannot dispose replacement installed earlier in transport listener snapshot', async t => {
  const h = fixture(t); let successor = null, replaced = false;
  const unsubscribe = h.c.AlbumHavenPrivateUITransport.subscribe(() => {
    if (replaced) return; replaced = true;
    h.c.openTrackModal(album({album_preference: available({context_ref: B})}));
    successor = h.c.getTrackModalAlbumPreferenceLease();
  });
  await h.open(); const old = h.c.getTrackModalAlbumPreferenceLease();
  const request = await h.activate('favorite'); h.change('context', B); await drain(); unsubscribe();
  assert.ok(successor); assert.notEqual(successor, old); assert.equal(h.c.getTrackModalAlbumPreferenceLease(), successor);
  assert.equal(request.options.signal.aborted, true); assert.equal(successor.root.isConnected, true);
  h.c.disposeTrackModalAlbumPreferences(old); assert.equal(h.c.getTrackModalAlbumPreferenceLease(), successor);
  const before = successor.root.innerHTML; request.resolve(envelope(favored())); await drain();
  assert.equal(h.c.getTrackModalAlbumPreferenceLease(), successor); assert.equal(successor.root.innerHTML, before);
});

test('A to B to A retires a dispatched detail scope even with unchanged final identity strings', async t => {
  const h = fixture(t), scope = h.c.captureRuntimeAlbumPreferenceScope();
  const work = h.c.fetchTrackModalAlbumDetails('local-album-11');
  const request = h.reads().at(-1); h.change('context', B); h.change('context', A);
  const payload = album(); request.resolve(detail(payload));
  await assert.rejects(work, {name: 'AbortError'});
  assert.equal(h.c.runtimeAlbumPreferenceScopeIsCurrent(scope), false);
  assert.equal(h.c.runtimeAlbumPreferenceForAlbum(payload), null);
});

test('actual root page dispatch retains original scope across A to B to A, including cursor restart', async t => {
  for (const restart of [false, true]) await t.test(String(restart), async t => {
    const h = fixture(t); h.state.view = {...ordinary(), context_ref: A,
      gallery_page: {has_more: true, next_cursor: 'cursor-1', revision: 'root-1'}};
    const work = h.c.loadNextRootGalleryPage(); const first = h.requests.at(-1); assert.ok(first);
    if (restart) {first.resolve({restart_required: true}, 409); await drain(); assert.notEqual(h.requests.at(-1), first);}
    const request = h.requests.at(-1), payload = album();
    h.change('context', B); h.change('context', A);
    request.resolve({...ordinary(), context_ref: A, artist_groups: [{artist: 'Local artist', albums: [payload]}],
      gallery_page: {has_more: false, next_cursor: null, revision: 'root-1'}});
    assert.equal(await work, false); assert.equal(h.c.runtimeAlbumPreferenceForAlbum(payload), null);
    noProgress(payload.album_preference);
  });
});

test('unscoped status-style reader cannot grant taste authority, while explicitly captured current read can', async t => {
  const h = fixture(t), unscoped = album(), scoped = album();
  await h.c.readGalleryResponse(response({ok: true, album: unscoped}), () => true);
  assert.equal(h.c.runtimeAlbumPreferenceForAlbum(unscoped), null);
  await h.c.readGalleryResponse(response({ok: true, album: scoped}), () => true, null, null, h.c.captureRuntimeAlbumPreferenceScope());
  assert.ok(h.c.runtimeAlbumPreferenceForAlbum(scoped));
});

test('nested preview and ordinary compact paths remove private containers without mutating input', t => {
  const h = fixture(t);
  for (const preview_only of [false, true]) for (const scope of ['missing', 'foreign', 'retired']) {
    const nested = album({album_preference: favored({to_listen: true, is_relisten: true, can_toggle_to_listen: true})});
    const value = album({preview_only, album_preference: available({context_ref: B}), duplicate_sources: [nested], tracks: [nested], track_rows: [nested],
      gallery_list_block: {summary: nested}, album_display_metadata: nested, tag_album_rating: 8, tag_album_rating_source: 'file_tag'});
    if (scope === 'missing') h.shell.dataset.privateUiContext = '';
    else if (scope === 'foreign') h.change('context', B);
    else {h.change('context', A); const original = h.c.captureRuntimeAlbumPreferenceScope(); h.change('context', B); h.change('context', A); assert.equal(h.c.runtimeAlbumPreferenceScopeIsCurrent(original), false);}
    // Always make the supplied DTO foreign to the final current scope.
    value.album_preference.context_ref = h.shell.dataset.privateUiContext === A ? B : A;
    const before = plain(value), compact = h.c.compactRuntimeAlbumPayload(value);
    assert.deepEqual(plain(value), before);
    for (const key of ['duplicate_sources', 'tracks', 'track_rows']) assert.deepEqual(plain(compact[key]), []);
    for (const key of ['album_preference', 'gallery_list_block', 'album_display_metadata', 'context_ref', 'preference_revision'])
      assert.equal(Object.hasOwn(compact, key), false, key);
    assert.equal(compact.tag_album_rating, 8); assert.equal(compact.tag_album_rating_source, 'file_tag');
  }
});

test('read-only peer compaction and actual modal retain peer facts but expose no own controls or preference data', async t => {
  for (const taste_state of ['available', 'unavailable']) for (const album_rating of [null, 10]) await t.test(`${taste_state}:${album_rating}`, async t => {
    const h = fixture(t), original = album({read_only_subject: 'peer-ref', taste_state, album_rating, favorite: false,
      album_preference: favored(), tracks: [{album_preference: favored()}], allowed_actions: {can_read: true, can_manage_album_preferences: true}});
    const before = plain(original), compact = h.c.compactRuntimeAlbumPayload(original);
    assert.deepEqual(plain(original), before); assert.equal(compact.read_only_subject, 'peer-ref');
    assert.equal(Object.hasOwn(compact, 'album_preference'), false); noProgress(compact);
    assert.equal(Object.hasOwn(compact.allowed_actions, 'can_manage_album_preferences'), false);
    assert.equal(compact.favorite, taste_state === 'available' ? false : null);
    assert.equal(compact.album_rating, taste_state === 'available' ? album_rating : null);
    await h.open({...compact, preview_only: false});
    assert.equal(h.c.getTrackModalAlbumPreferenceLease(), null);
    assert.equal(h.document.querySelectorAll('[data-album-preference-action]').length, 0); assert.equal(h.posts().length, 0);
    const text = h.c.getTrackModalElements().header.textContent;
    if (taste_state === 'unavailable') assert.doesNotMatch(text, /Favorite:\s*No/);
  });
});

test('collector continuation and bounded restart cannot recapture scope after observed away/back', async t => {
  for (const restart of [false, true]) await t.test(String(restart), async t => {
    const h = fixture(t), scope = h.c.captureRuntimeAlbumPreferenceScope();
    const first = {...ordinary(), gallery_page: {has_more: true, next_cursor: 'c1', revision: 'r1'}};
    const work = h.c.collectRootGalleryRefresh(first, '/view-data?surface=albums&gallery_page_size=50', 1,
      new AbortController(), () => true, null, scope);
    const initial = h.requests.at(-1); assert.ok(initial);
    if (restart) {initial.resolve({restart_required: true}, 409); await drain(); assert.notEqual(initial, h.requests.at(-1));}
    const value = album(); h.change('context', B); h.change('context', A);
    h.requests.at(-1).resolve({...ordinary(), artist_groups: [{artist: 'Local artist', albums: [value]}],
      gallery_page: {has_more: false, next_cursor: null, revision: 'r1'}});
    await assert.rejects(work, {name: 'AbortError'});
    assert.equal(h.c.runtimeAlbumPreferenceForAlbum(value), null);
  });
});

test('foreground dispatch scope cannot admit a late A response after A to B to A', async t => {
  const h = fixture(t), value = album();
  const start = h.requests.length, work = h.read('/view-data?surface=albums');
  assert.equal(h.requests.length, start + 1, 'actual foreground request dispatched');
  const request = h.requests[start];
  assert.equal(new URL(request.url, h.location.href).pathname, '/view-data');
  assert.equal(new URL(request.url, h.location.href).searchParams.get('surface'), 'albums');
  assert.equal(request.options.method || 'GET', 'GET');
  h.change('context', B); h.change('context', A);
  request.resolve({...ordinary(), context_ref: A, artist_groups: [{artist: 'Local artist', albums: [value]}]});
  const result = await work;
  assert.equal(result.error, undefined, result.error?.stack || 'unexpected foreground rejection');
  assert.equal(result.value, false, 'real fetchAndRender resolves obsolete foreground work as false');
  assert.equal(h.c.runtimeAlbumPreferenceForAlbum(value), null);
});

test('modal load, local navigation, actor, library and edition replacement retire a pending write', async t => {
  for (const mode of ['load', 'navigation', 'actor', 'library', 'edition']) await t.test(mode, async t => {
    const h = fixture(t); await h.open(); const priorListeners = new Set(h.document.listeners);
    const request = await h.activate('favorite');
    const original = h.c.getCurrentTrackModalAlbum(), before = plain(original.album_preference);
    const old = h.c.getTrackModalAlbumPreferenceLease();
    const oldFocusListeners = h.document.listeners.filter(row => !priorListeners.has(row) && ['focusin', 'pointerdown'].includes(row.type));
    assert.equal(oldFocusListeners.length, 2);
    if (mode === 'load') h.c.invalidatePendingTrackModalLoad();
    if (mode === 'navigation') {
      h.c.claimLocalViewStateNavigation();
      assert.equal(request.options.signal.aborted, true, 'navigation immediately aborts captured preference request');
      assert.equal(h.c.getTrackModalAlbumPreferenceLease(), null, 'navigation immediately detaches old global owner');
      assert.equal(old.root.childNodes.length, 0);
      assert.equal(old.root.listeners.some(row => row.callback === old.click || row.callback === old.change), false);
      for (const listener of oldFocusListeners) assert.equal(h.document.listeners.includes(listener), false);
    }
    if (mode === 'actor' || mode === 'library') {h.change(mode); await drain();}
    if (mode === 'edition') h.c.openTrackModal(album({key: 'local-album-12', album_id: 12,
      album_preference: available({album_ref: 'inventory-album:9:12'})}));
    await drain(); request.resolve(envelope(favored())); await drain();
    assert.deepEqual(plain(original.album_preference), before);
    assert.equal(h.posts().length, 1); assert.equal(request.options.signal.aborted, true);
  });
});

test('outside keyboard focus during owning automatic gallery refresh is not stolen at final repaint', async t => {
  const h = fixture(t); await h.open(); const request = await h.activate('favorite');
  request.resolve(envelope(favored())); await drain();
  assert.ok(h.pending(r => r.url.startsWith('/view-data')).length);
  const outside = h.outside(); await settleGallery(h); assert.equal(h.document.activeElement, outside);
});

test('metadata path overlap never ranks by taste and never transfers private summaries', t => {
  const h = fixture(t), first = album({name: 'First metadata', tracks: [{path: '/same.flac'}]}),
    second = album({key: 'local-album-12', album_id: 12, name: 'Rated metadata', tracks: [{path: '/same.flac'}],
      album_preference: favored({rating: 10}), album_rating: 10});
  first.gallery_list_block = {summary: {album_preference: favored()}};
  first.duplicate_sources = [second];
  h.state.view.artist_groups = [{artist: 'Local artist', albums: [first, second]}];
  const before = plain(h.state.view.artist_groups), result = h.c.findVisibleAlbumByTrackPaths(new Set(['/same.flac']));
  assert.equal(result.name, first.name); assert.notEqual(result, first);
  for (const key of ['album_preference', 'album_rating', 'gallery_list_block', 'duplicate_sources'])
    assert.equal(Object.hasOwn(result, key), false, key);
  assert.deepEqual(plain(h.state.view.artist_groups), before);
});

test('mutation optional progress values cannot become a read receipt or overwrite absent progress', async t => {
  const h = fixture(t); await h.open(); const request = await h.activate('favorite');
  request.resolve(envelope(favored({to_listen: true, is_relisten: true, can_toggle_to_listen: true})));
  await drain(); await settleGallery(h); noProgress(h.c.getCurrentTrackModalAlbum().album_preference);
});

test('actual Home bridge activity-to-native projection clones and recursively removes viewer taste', async t => {
  for (const taste_state of ['available', 'unavailable']) await t.test(taste_state, async t => {
    const h = fixture(t), c = h.c, runtime = c.AlbumHavenHomeRuntime;
    const host = h.document.createElement('section'); host.id = 'mobile-home'; h.main.append(host);
    h.location.href = 'https://albumhaven.test/?surface=home&home_section=friends&home_friend=peer-ref';
    const snapshot = runtime.snapshot(); assert.equal(snapshot.visible, true);
    // The supported provider boundary receives fixed server wire examples. All
    // source grants, origin matching, subject projection and native leases use
    // the actual Home bridge and resource-selection implementations unchanged.
    const wireTarget = {kind: 'album', ref: 'album-resource-11', allowed_actions: {can_view_details: true},
      native_actions: {album_ref: 'local-album-11', allowed_actions: {can_open_album: true, can_play_album: false}}};
    const read = runtime.configureActivityProvider({
      readActivity: async () => ({rows: [{id: 'row-11', kind: 'album', source_readable: true,
        allowed_actions: {can_read: true, can_view_details: true}, album_target: wireTarget}], next_cursor: null}),
      resolveActivityNativeTarget: async () => ({album_ref: 'local-album-11', allowed_actions: {can_view_details: true, can_play_album: false},
        subject_taste: {subject_ref: 'peer-ref', read_only: true, rating: 4, favorite: false, taste_state, tracks: []}}),
    });
    const result = await read({scopeKey: snapshot.scopeKey, account_ref: 'peer-ref', kind: 'albums', period: 'week'});
    const target = result.rows[0].album_target; assert.ok(target);
    const work = runtime.resourceIntent('open', target, {scopeKey: snapshot.scopeKey}); await drain();
    const request = h.pending(r => r.url.startsWith('/album-details?')).at(-1); assert.ok(request);
    const nested = {album_preference: favored(), preference_revision: 7, context_ref: A, to_listen: true, is_relisten: true,
      allowed_actions: {can_manage_album_preferences: true, can_toggle_to_listen: true}};
    const original = album({album_preference: favored({rating: 10}), gallery_list_block: {summary: nested},
      album_display_metadata: nested, duplicate_sources: [], tracks: []});
    const before = plain(original); request.resolve(detail(original)); await work; await drain();
    assert.deepEqual(plain(original), before, 'fetched own native data is never overwritten by peer projection');
    assert.equal(c.runtimeAlbumPreferenceForAlbum(original), null, 'read-only-subject detail cannot mint own authority');
    const projected = c.getCurrentTrackModalAlbum(); assert.equal(projected.read_only_subject, 'peer-ref');
    assert.equal(projected.album_rating, taste_state === 'available' ? 4 : null);
    assert.equal(projected.favorite, taste_state === 'available' ? false : null);
    const visit = value => {if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        assert.equal(['album_preference', 'preference_revision', 'context_ref', 'can_edit', 'can_manage_album_preferences',
          'to_listen', 'is_relisten', 'can_toggle_to_listen'].includes(key), false, key); visit(child);
      }};
    visit(projected); assert.equal(c.getTrackModalAlbumPreferenceLease(), null); assert.equal(h.posts().length, 0);
  });
});

test('closing pending controls removes their document focus listeners and cannot refocus a replacement', async t => {
  const h = fixture(t); await h.open(); const prior = new Set(h.document.listeners);
  const request = await h.activate('favorite');
  const installed = h.document.listeners.filter(row => !prior.has(row) && ['focusin', 'pointerdown'].includes(row.type));
  assert.equal(installed.length, 2, 'one preference focus tracker owns two document listeners');
  h.c.closeTrackModal();
  for (const listener of installed) assert.equal(h.document.listeners.includes(listener), false);
  const outside = h.outside(); request.resolve(envelope(favored())); await drain();
  assert.equal(h.document.activeElement, outside); assert.equal(h.c.getTrackModalAlbumPreferenceLease(), null);
});

test('local navigation abort reentry cannot dispose a successor created by the old request abort observer', async t => {
  const h = fixture(t); await h.open(); const request = await h.activate('favorite');
  const old = h.c.getTrackModalAlbumPreferenceLease(), original = h.c.getCurrentTrackModalAlbum();
  const before = plain(original.album_preference); let successor = null, slotDuringAbort = undefined;
  request.options.signal.addEventListener('abort', () => {
    slotDuringAbort = h.c.getTrackModalAlbumPreferenceLease();
    h.c.openTrackModal(album({key: 'local-album-12', album_id: 12,
      album_preference: available({album_ref: 'inventory-album:9:12'})}));
    successor = h.c.getTrackModalAlbumPreferenceLease();
  }, {once: true});
  h.c.claimLocalViewStateNavigation();
  assert.equal(request.options.signal.aborted, true);
  assert.equal(slotDuringAbort, null, 'old global slot detaches before abort observers run');
  assert.ok(successor); assert.notEqual(successor, old);
  assert.equal(h.c.getTrackModalAlbumPreferenceLease(), successor);
  assert.equal(successor.isCurrent(), true, 'abort-created successor captures the new navigation revision');
  assert.equal(old.root.childNodes.length, 0); assert.equal(successor.root.isConnected, true);
  await drain();
  const read = h.pending(r => r.url.startsWith('/album-details?')).at(-1); assert.ok(read);
  assert.equal(read.options.signal.aborted, false, 'old cleanup cannot abort successor detail authority');
  read.resolve(detail(album({key: 'local-album-12', album_id: 12,
    album_preference: available({album_ref: 'inventory-album:9:12'})}))); await drain();
  const successorMarkup = successor.root.innerHTML;
  request.resolve(envelope(favored())); await drain();
  assert.deepEqual(plain(original.album_preference), before);
  assert.equal(h.c.getTrackModalAlbumPreferenceLease(), successor);
  assert.equal(successor.root.innerHTML, successorMarkup); assert.equal(h.control('favorite').disabled, false);
});

const pagedView = () => ({...ordinary(), context_ref: A,
  gallery_page: {has_more: true, next_cursor: 'native-root-cursor', revision: 'native-root-revision'}});
const finalRootPage = () => ({...ordinary(), context_ref: A,
  gallery_page: {has_more: false, next_cursor: null, revision: 'native-root-revision'}});
function assertRootRequest(request, location) {
  assert.ok(request, 'real root-page request dispatched');
  const url = new URL(request.url, location.href);
  assert.equal(url.pathname, '/view-data');
  assert.equal(url.searchParams.get('gallery_cursor'), 'native-root-cursor');
  assert.equal(request.options.credentials, 'same-origin');
  assert.equal(request.options.cache, 'no-store');
}

test('preference abort can install a real foreground successor without old navigation canceling it', async t => {
  for (const hasEntryOwner of [false, true]) await t.test(String(hasEntryOwner), async t => {
    const h = fixture(t); let priorWork = null, priorRequest = null;
    if (hasEntryOwner) {
      const index = h.requests.length;
      priorWork = h.read('/view-data?surface=albums'); priorRequest = h.requests[index];
      assert.ok(priorRequest); assert.equal(h.state.ui.activeViewRequestController.signal, priorRequest.options.signal);
    } else assert.equal(h.state.ui.activeViewRequestController == null, true);
    await h.open(); const post = await h.activate('favorite');
    const entryController = h.state.ui.activeViewRequestController;
    let nextWork = null, nextRequest = null, nextController = null, nextId = null;
    post.options.signal.addEventListener('abort', () => {
      const index = h.requests.length;
      nextWork = h.read('/view-data?surface=albums&gallery_page_size=50', {interruptCurrent: true, restartIfSameUrl: true});
      nextRequest = h.requests[index]; nextController = h.state.ui.activeViewRequestController; nextId = h.state.ui.activeViewRequestId;
    }, {once: true});
    h.c.claimLocalViewStateNavigation();
    assert.equal(post.options.signal.aborted, true); assert.ok(nextWork); assert.ok(nextRequest);
    assert.equal(new URL(nextRequest.url, h.location.href).pathname, '/view-data');
    assert.equal(new URL(nextRequest.url, h.location.href).searchParams.get('gallery_page_size'), '50');
    assert.notEqual(nextController, entryController); assert.equal(nextRequest.options.signal, nextController.signal);
    assert.equal(nextController.signal.aborted, false);
    assert.equal(h.state.ui.activeViewRequestController, nextController); assert.equal(h.state.ui.activeViewRequestId, nextId);
    if (priorRequest) {
      assert.equal(priorRequest.options.signal.aborted, true);
      priorRequest.resolve({...ordinary(), context_ref: A});
      const oldResult = await priorWork;
      assert.equal(oldResult.error, undefined, oldResult.error?.stack); assert.equal(oldResult.value, false);
      assert.equal(h.state.ui.activeViewRequestController, nextController, 'old foreground finally cannot clear successor controller');
      assert.equal(h.state.ui.activeViewRequestId, nextId);
    }
    post.resolve(envelope(favored())); await drain();
    assert.equal(nextController.signal.aborted, false); assert.equal(h.state.ui.activeViewRequestController, nextController);
    nextRequest.resolve({...ordinary(), context_ref: A});
    const result = await nextWork;
    assert.equal(result.error, undefined, result.error?.stack); assert.equal(result.value, true);
  });
});

test('preference abort can install a real root-page successor with present or absent captured root owner', async t => {
  for (const hasEntryOwner of [false, true]) await t.test(String(hasEntryOwner), async t => {
    const h = fixture(t); h.state.view = pagedView();
    let priorWork = null, priorRequest = null, entryRoot = null;
    if (hasEntryOwner) {
      const index = h.requests.length; priorWork = h.c.loadNextRootGalleryPage(); priorRequest = h.requests[index];
      assertRootRequest(priorRequest, h.location); entryRoot = h.owner('rootGalleryPageRequest'); assert.ok(entryRoot);
    } else assert.equal(h.owner('rootGalleryPageRequest'), null);
    await h.open(); const post = await h.activate('favorite');
    let nextWork = null, nextRequest = null, nextRoot = null;
    post.options.signal.addEventListener('abort', () => {
      // A real root navigation replaces its prior root owner through the actual
      // cancellation helper, rather than assigning a synthetic ownership slot.
      if (entryRoot) h.c.cancelRootGalleryPageRequest(entryRoot);
      const index = h.requests.length; nextWork = h.c.loadNextRootGalleryPage();
      nextRequest = h.requests[index]; nextRoot = h.owner('rootGalleryPageRequest');
    }, {once: true});
    h.c.claimLocalViewStateNavigation();
    assert.equal(post.options.signal.aborted, true); assert.ok(nextWork); assertRootRequest(nextRequest, h.location);
    assert.ok(nextRoot); assert.notEqual(nextRoot, entryRoot);
    assert.equal(h.owner('rootGalleryPageRequest'), nextRoot); assert.equal(nextRoot.controller.signal, nextRequest.options.signal);
    assert.equal(nextRequest.options.signal.aborted, false, 'captured null/old owner cannot select new root request');
    if (priorRequest) {
      assert.equal(priorRequest.options.signal.aborted, true); priorRequest.resolve(finalRootPage());
      assert.equal(await priorWork, false);
      assert.equal(h.owner('rootGalleryPageRequest'), nextRoot, 'old root finally retains exact successor slot');
    }
    post.resolve(envelope(favored())); await drain();
    assert.equal(h.owner('rootGalleryPageRequest'), nextRoot); assert.equal(nextRequest.options.signal.aborted, false);
    nextRequest.resolve(finalRootPage()); assert.equal(await nextWork, true);
    assert.equal(h.owner('rootGalleryPageRequest'), null, 'successful successor releases only its own slot');
  });
});

test('root abort observer installs real root successor before stale-owner cancellation and old finally', async t => {
  const h = fixture(t); h.state.view = pagedView();
  const index = h.requests.length, oldWork = h.c.loadNextRootGalleryPage(), oldRequest = h.requests[index];
  assertRootRequest(oldRequest, h.location); const oldRoot = h.owner('rootGalleryPageRequest');
  let slotDuringAbort = undefined, nextWork = null, nextRequest = null, nextRoot = null;
  oldRequest.options.signal.addEventListener('abort', () => {
    slotDuringAbort = h.owner('rootGalleryPageRequest');
    const index = h.requests.length; nextWork = h.c.loadNextRootGalleryPage();
    nextRequest = h.requests[index]; nextRoot = h.owner('rootGalleryPageRequest');
  }, {once: true});
  h.c.cancelRootGalleryPageRequest();
  assert.equal(oldRequest.options.signal.aborted, true); assert.equal(slotDuringAbort, null);
  assertRootRequest(nextRequest, h.location); assert.ok(nextRoot); assert.notEqual(nextRoot, oldRoot);
  assert.equal(h.owner('rootGalleryPageRequest'), nextRoot); assert.equal(nextRequest.options.signal.aborted, false);
  h.c.cancelRootGalleryPageRequest(oldRoot);
  assert.equal(h.owner('rootGalleryPageRequest'), nextRoot, 'explicit stale cancellation never detaches successor');
  assert.equal(nextRequest.options.signal.aborted, false);
  oldRequest.resolve(finalRootPage()); assert.equal(await oldWork, false);
  assert.equal(h.owner('rootGalleryPageRequest'), nextRoot, 'old request finally cannot erase replacement');
  nextRequest.resolve(finalRootPage()); assert.equal(await nextWork, true);
  assert.equal(h.owner('rootGalleryPageRequest'), null);
});

test('no-argument root cancellation still retires the current request without a successor', async t => {
  const h = fixture(t); h.state.view = pagedView();
  const index = h.requests.length, work = h.c.loadNextRootGalleryPage(), request = h.requests[index];
  assertRootRequest(request, h.location); assert.ok(h.owner('rootGalleryPageRequest'));
  h.c.cancelRootGalleryPageRequest();
  assert.equal(request.options.signal.aborted, true); assert.equal(h.owner('rootGalleryPageRequest'), null);
  request.resolve(finalRootPage()); assert.equal(await work, false);
});

test('actual foreground and payload-application no-argument callers cancel their entry-current root request', async t => {
  for (const caller of ['foreground', 'apply']) await t.test(caller, async t => {
    const h = fixture(t); h.state.view = pagedView();
    const index = h.requests.length, oldWork = h.c.loadNextRootGalleryPage(), oldRequest = h.requests[index];
    assertRootRequest(oldRequest, h.location);
    let nextWork = null, nextRequest = null;
    if (caller === 'foreground') {
      const index = h.requests.length; nextWork = h.read('/view-data?surface=albums'); nextRequest = h.requests[index];
      assert.ok(nextRequest); assert.equal(new URL(nextRequest.url, h.location.href).pathname, '/view-data');
      assert.equal(new URL(nextRequest.url, h.location.href).searchParams.has('gallery_cursor'), false);
    } else h.c.applyViewPayload({...ordinary(), context_ref: A}, {trackSidebarReveal: false});
    assert.equal(oldRequest.options.signal.aborted, true); assert.equal(h.owner('rootGalleryPageRequest'), null);
    oldRequest.resolve(finalRootPage()); assert.equal(await oldWork, false);
    if (nextWork) {
      assert.equal(nextRequest.options.signal.aborted, false);
      nextRequest.resolve({...ordinary(), context_ref: A});
      const result = await nextWork; assert.equal(result.error, undefined, result.error?.stack); assert.equal(result.value, true);
    }
  });
});
