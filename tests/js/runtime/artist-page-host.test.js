'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {fixture, artistView, album, group, ARTIST, plain, drain} = require('./artist-host-fixtures/actual-artist-runtime.cjs');

async function mounted(t, payload = artistView(), options) {
  const h = fixture(t, options); await h.entry(); await h.admit(payload); h.frame(); return h;
}
const refs = snapshot => Array.from(snapshot.familyMembers, row => row.artistRef);

test('normalized admitted info response mounts actual native sections and transfers exactly the original grid', async t => {
  const h = await mounted(t), snapshot = h.runtime().snapshot(), id = h.identities();
  assert.equal(snapshot.status, 'ready'); assert.equal(snapshot.artistRef, ARTIST); assert.equal(snapshot.actionable, true);
  assert.equal(snapshot.viewRevision, h.state.ui.viewStateRevision);
  assert.equal(h.section('discography').panel.contains(id.viewport), true);
  for (const name of ['info', 'discography', 'family']) assert.ok(h.section(name).toggle);
  assert.equal(h.document.querySelectorAll('#albums-scroll').length, 1);
  assert.equal(h.document.querySelectorAll('#albums-viewport').length, 1);
  assert.equal(h.grid.scrollEl, h.scroll); assert.equal(h.owner('virtualGrid'), id.grid);
  assert.equal(id.viewport.contains(id.container), true); assert.equal(id.viewport.contains(id.top), true);
  assert.equal(id.viewport.contains(id.bottom), true);
});

test('URL and selected name alone cannot admit, while delayed native readiness consumes the last admitted view', async t => {
  const h = fixture(t, {url: `https://albumhaven.test/?artist=${encodeURIComponent(ARTIST)}&page_mode=info`});
  assert.equal(h.runtime().snapshot().status, 'inactive');
  const payload = artistView(); delete payload.artist_page;
  await h.admit(payload); assert.equal(h.runtime().snapshot().status, 'inactive');
  await h.admit(artistView()); assert.equal(h.runtime().snapshot().mounted, false);
  const count = h.requests.length; await h.entry(); await drain();
  assert.equal(h.runtime().snapshot().mounted, true); assert.equal(h.requests.length, count, 'native readiness performs no read');
});

for (const retained of [false, true]) test(`descriptor changes reconcile ${retained ? 'retained' : 'full'} render without trusting equal albums`, async t => {
  const h = await mounted(t), first = h.runtime().snapshot(), original = h.identities();
  const payload = artistView(); delete payload.artist_page;
  // Invoke the actual normalized apply owner, followed by the actual render
  // owner using its documented retained-branch inputs. No state double exists.
  h.context.applyViewPayload(payload);
  h.refresh(retained ? {preserveMountedGalleryChildren: true, retainMountedSelectedViewState: {}} : {});
  assert.equal(h.runtime().snapshot().status, 'inactive');
  assert.equal(original.viewport.parentElement, h.scroll);
  assert.equal(h.host.querySelector('.artist-page__sections'), null);
  await h.admit(artistView()); assert.notEqual(h.runtime().snapshot().sessionId, first.sessionId);
});

for (const patch of [
  {artist_page: null}, {artist_page: {artist_ref: 'Other Artist', active_page_mode: 'info'}},
  {artist_page: {artist_ref: ARTIST, active_page_mode: 'gallery'}}, {surface: {active: 'home'}},
]) test(`retirement follows normalized replacement ${JSON.stringify(patch)}`, async t => {
  const h = await mounted(t), viewport = h.nodes.viewport;
  h.context.applyViewPayload(artistView(patch)); h.refresh({preserveMountedGallery: true});
  assert.equal(h.runtime().snapshot().status, 'inactive'); assert.equal(viewport.parentElement, h.scroll);
  assert.equal(h.grid._artistPageLease, null);
});

test('private Search normalized admission retires the Artist host', async t => {
  const {ready, mainUrl} = require('./search-native-fixtures/actual-runtime.cjs');
  const h = await mounted(t), payload = ready(), index = h.requests.length;
  const work = h.read(mainUrl(payload), {}, true); h.reply(index, payload); const result = await work;
  assert.equal(result.error, undefined); assert.equal(h.state.view.private_search, true);
  assert.equal(h.runtime().snapshot().status, 'inactive'); assert.equal(h.nodes.viewport.parentElement, h.scroll);
});

test('same parent refresh replaces facts but preserves disclosure choices, slots and canonical Family rows', async t => {
  const primary = group(ARTIST, [album(1)], {artist_summary: 'First supplied fact'});
  const h = await mounted(t, artistView({primary_artist_groups: [primary], artist_groups: [primary]}));
  const before = h.runtime().snapshot(), discography = h.section('discography'), family = h.section('family');
  const row = h.host.querySelector(`[data-artist-page-family="${ARTIST}"]`), slot = h.identities().slot;
  h.click(family.toggle); assert.equal(family.panel.hidden, true);
  const updated = group(ARTIST, [album(1)], {artist_summary: 'Second supplied fact'});
  await h.admit(artistView({primary_artist_groups: [updated], artist_groups: [updated]}), {push: false});
  assert.equal(h.runtime().snapshot().sessionId, before.sessionId);
  assert.equal(h.section('discography').panel, discography.panel); assert.equal(h.section('family').panel, family.panel);
  assert.equal(family.panel.hidden, true); assert.equal(h.host.querySelector(`[data-artist-page-family="${ARTIST}"]`), row);
  assert.equal(h.identities().slot, slot); assert.match(h.host.textContent, /Second supplied fact/);
});

test('Info is supplied canonical data only, with truthful emptiness and URL policy', async t => {
  const primary = group(ARTIST, [album(1, {cover_url: 'https://covers.test/album.jpg'})],
    {artist_summary: '  Canonical summary  ', artist_image_url: '//unsafe.test/portrait', summary: 'Lower priority'});
  const h = await mounted(t, artistView({primary_artist_groups: [primary], artist_groups: [group('Composite label', [], {summary: 'Wrong info'})]}));
  assert.deepEqual(plain(h.runtime().snapshot().info), {artist: ARTIST, summary: 'Canonical summary', imageUrl: '', metadata: '', sourceLabel: ''});
  assert.equal(h.section('info').panel.querySelector('img'), null);
  await h.admit(artistView({primary_artist_groups: [group()], artist_groups: []}), {push: false});
  assert.match(h.section('info').panel.textContent, /No information was supplied/);
  assert.doesNotMatch(h.section('info').panel.textContent, /Wrong info|Source:/);
});

test('real Family helper synthetic placeholder never fabricates zero, but genuine empty and panel-backed groups do', async t => {
  const empty = group('Empty Artist', []), loaded = group('Loaded Artist', [album(2), album(3)]);
  const h = await mounted(t, artistView({related_artists: ['Missing Artist', 'Empty Artist', 'Loaded Artist'],
    family_artist_groups: [empty, loaded], artist_groups: [group('Chronological', [album(1)])]}));
  const panel = h.context.getGalleryFamilyPanelGroups();
  const placeholder = panel.find(row => row.artist === 'Missing Artist');
  assert.ok(placeholder, 'real helper supplied its synthetic placeholder'); assert.equal(placeholder.albums.length, 0);
  const snapshot = h.runtime().snapshot(), missing = snapshot.familyMembers.find(row => row.artistRef === 'Missing Artist');
  assert.equal(Object.hasOwn(missing, 'albumCount'), false);
  assert.equal(snapshot.familyMembers.find(row => row.artistRef === 'Empty Artist').albumCount, 0);
  assert.equal(snapshot.familyMembers.find(row => row.artistRef === 'Loaded Artist').albumCount, 2);
  assert.ok(panel.some(row => row.artist === 'Loaded Artist' && row.albums.length === 2));
  assert.deepEqual(refs(snapshot), [ARTIST, 'Missing Artist', 'Empty Artist', 'Loaded Artist']);
  assert.equal(refs(snapshot).includes('Chronological'), false);
});

test('Family ref stays separate from display label and explicit navigation deletes old descriptor precedence', async t => {
  const ref = 'A & B / Ω', h = await mounted(t, artistView({related_artists: [ref], family_artist_groups: [group(ref, [], {artist_display: 'Friendly label'})]}));
  const row = h.host.querySelector(`[data-artist-page-family="${ref}"]`); assert.ok(row); assert.match(row.textContent, /Friendly label/);
  const first = h.runtime().snapshot(), count = h.requests.length; h.click(row);
  assert.equal(h.requests.length, count + 1);
  const query = new URL(h.requests[count].url, h.location).searchParams;
  assert.equal(query.get('artist'), ref); assert.equal(query.get('page_mode'), 'info');
  assert.equal(query.has('related_artist'), false); assert.equal(query.has('primary_only'), false);
  assert.equal(h.runtime().snapshot().artistRef, first.artistRef, 'intent does not manufacture admission');
  assert.equal(h.runtime().snapshot().actionable, false, 'pending unrelated navigation is inert');
});

test('stable outer Artist header and one empty Loved slot survive virtual scroll and chrome refresh', async t => {
  const h = await mounted(t), slot = h.identities().slot;
  assert.ok(slot); assert.equal(slot.hidden, true); assert.equal(slot.childNodes.length, 0);
  assert.equal(h.document.querySelectorAll('[data-artist-page-action-slot="loved"]').length, 1);
  h.scrollTo(5000); h.context.updateGalleryMainChrome();
  assert.equal(h.header.querySelector('[data-gallery-context-name]').textContent, ARTIST);
  assert.equal(h.identities().slot, slot); assert.equal(h.runtime().snapshot().lovedDescriptor, undefined);
  assert.equal(h.scroll.contains(h.header), false);
});

test('subscriber reentry cannot publish an older view or retire the newer native host', async t => {
  const h = await mounted(t); let reentered = false;
  const unsubscribe = h.runtime().subscribe(() => {
    if (reentered || h.runtime().snapshot().info?.summary !== 'Trigger') return;
    reentered = true;
    h.context.applyViewPayload(artistView({primary_artist_groups: [group(ARTIST, [album(2)], {summary: 'Successor'})]}));
    h.refresh({preserveMountedGalleryChildren: true, retainMountedSelectedViewState: {}});
  });
  t.after(unsubscribe);
  h.context.applyViewPayload(artistView({primary_artist_groups: [group(ARTIST, [album(1)], {summary: 'Trigger'})]})); h.refresh();
  assert.equal(reentered, true); assert.equal(h.runtime().snapshot().info.summary, 'Successor');
  assert.match(h.section('info').panel.textContent, /Successor/); assert.doesNotMatch(h.section('info').panel.textContent, /Trigger/);
});

test('scope A to B to A invalidates old snapshot context and callbacks synchronously', async t => {
  const h = await mounted(t), opener = h.nodes.container.querySelector('[data-album-key]'); assert.ok(opener);
  const context = h.runtime().currentContextFor(opener), old = h.runtime().snapshot(); assert.ok(context);
  h.change('actor', '8'); assert.equal(context.isCurrent(), false); assert.equal(h.runtime().snapshot().status, 'inactive');
  h.change('actor', '7'); assert.equal(context.isCurrent(), false);
  const count = h.requests.length; assert.equal(h.runtime().navigateFamily(ARTIST), false); assert.equal(h.requests.length, count);
  await h.admit(artistView()); assert.notEqual(h.runtime().snapshot().sessionId, old.sessionId);
  assert.equal(context.isCurrent(), false);
});

test('existing indexed album resolution wins over stale embedded data and native page restriction remains authoritative', async t => {
  const h = await mounted(t, artistView(), {mobile: true});
  const button = h.nodes.container.querySelector('[data-album-key]'); assert.ok(button);
  const key = button.getAttribute('data-album-key'), indexed = h.context.getIndexedAlbum(key); assert.ok(indexed);
  button.setAttribute('data-album', JSON.stringify({key, name: 'Stale embedded impostor'}));
  assert.equal(h.context.resolveTrackModalActionAlbum(button), indexed);
  const before = h.mobileState().pages.length;
  assert.equal(h.context.openTrackModal(indexed, {presentationRestrictions: {can_open_album_page: false}}), false);
  assert.equal(h.mobileState().pages.length, before); assert.equal(h.runtime().snapshot().actionable, true);
});

test('stale direct grid dispatch cannot fall through after a reentrant admitted successor', async t => {
  const h = await mounted(t), previousView = h.state.view; let once = true;
  const unsubscribe = h.runtime().subscribe(() => {
    if (!once) return; once = false;
    h.context.applyViewPayload(artistView({primary_artist_groups: [group(ARTIST, [album(99)], {summary: 'Current successor'})]}));
    h.refresh();
  }); t.after(unsubscribe);
  h.context.renderArtistGroups({preserveScroll: true, isCurrentResponse: () => h.state.view === previousView});
  assert.equal(once, false); assert.equal(h.runtime().snapshot().info.summary, 'Current successor');
  assert.equal(h.nodes.viewport.parentElement, h.section('discography').panel);
  assert.equal(h.context.getIndexedAlbum('artist-album-99').key, 'artist-album-99');
  assert.equal(h.header.querySelector('[data-gallery-context-name]').textContent, ARTIST);
});

for (const requestKind of ['Family navigation', 'refresh']) for (const failure of ['network', 'cancel', 'http'])
  test(`terminal ${failure} restores unchanged admitted Artist after actual ${requestKind}`, async t => {
  const h = await mounted(t, artistView({related_artists: ['Next Artist']}));
  const before = h.runtime().snapshot(), identity = h.identities(), admitted = h.state.view;
  h.click(h.section('family').toggle); h.scrollTo(220); const scroll = h.scroll.scrollTop;
  const location = h.location.href, entry = h.history.state.albumHavenNavigationPosition;
  const count = h.requests.length, work = requestKind === 'Family navigation'
    ? Promise.resolve(h.runtime().navigateFamily('Next Artist')).catch(error => error)
    : h.read(h.context.buildApiUrl(h.state.view), {}, false);
  assert.equal(h.requests.length, count + 1); assert.equal(h.runtime().snapshot().actionable, false);
  const requestId = h.state.ui.activeViewRequestId;
  if (failure === 'cancel') {
    h.state.ui.activeViewRequestController.abort();
    h.requests[count].reject(Object.assign(new Error('cancelled at browser transport'), {name: 'AbortError'}));
  } else if (failure === 'http') h.reply(count, {error: 'fixture service unavailable'}, 503);
  else h.requests[count].reject(new Error('fixture network failure'));
  await work; await drain();
  assert.equal(h.state.view, admitted); assert.equal(h.location.href, location); assert.equal(h.history.state.albumHavenNavigationPosition, entry);
  assert.equal(h.state.ui.activeViewRequestId, requestId, 'recovery does not rewind request identity');
  assert.equal(h.state.busy, false); assert.equal(h.runtime().snapshot().sessionId, before.sessionId);
  assert.equal(h.runtime().snapshot().actionable, true, 'only terminal same-parent failure releases the held presentation');
  assert.equal(h.host.inert, false); assert.equal(h.grid._artistPageLease, identity.lease);
  assert.equal(h.grid._artistPageLease.suspended, false); assert.equal(h.scroll.scrollTop, scroll);
  assert.equal(h.section('family').panel.hidden, true);
});

for (const boundary of ['pending successor', 'accepted successor', 'scope loss', 'committed entry'])
  test(`older failed refresh cannot reopen after ${boundary}`, async t => {
    const h = await mounted(t), original = h.runtime().snapshot();
    const oldIndex = h.requests.length, oldWork = h.read(h.context.buildApiUrl(h.state.view), {restartIfSameUrl: true}, false);
    assert.equal(h.requests.length, oldIndex + 1); assert.equal(h.runtime().snapshot().actionable, false);
    let successor = null;
    if (boundary.includes('successor')) {
      const payload = artistView({selected_artist: 'Successor', artist_page: {artist_ref: 'Successor', active_page_mode: 'info'}});
      const index = h.requests.length, work = h.read(h.context.buildApiUrl(payload), {}, true);
      assert.equal(h.requests.length, index + 1);
      successor = {index, work, payload};
      if (boundary === 'accepted successor') {h.reply(index, payload); await work; await drain();}
    } else if (boundary === 'scope loss') h.change('actor', '8');
    else h.history.pushState({albumHavenNavigationPosition: 900, mobilePages: []}, '', '/?artist=Elsewhere');
    const currentRequest = h.state.ui.activeViewRequestId;
    h.requests[oldIndex].reject(new Error('late old network failure')); await oldWork; await drain();
    assert.equal(h.state.ui.activeViewRequestId, currentRequest);
    const snapshot = h.runtime().snapshot();
    if (boundary === 'pending successor') {
      assert.equal(snapshot.actionable, false); assert.equal(h.state.busy, true);
      h.reply(successor.index, successor.payload); await successor.work;
    } else if (boundary === 'accepted successor') {
      assert.equal(snapshot.artistRef, 'Successor'); assert.notEqual(snapshot.sessionId, original.sessionId);
      assert.equal(snapshot.actionable, true);
    } else assert.equal(snapshot.status, 'inactive');
  });

for (const query of ['artist=Canonical+Artist&page_mode=info', 'page_mode=info&artist=Canonical%20Artist',
  'category=main_library&artist=Canonical+Artist&gallery_scope=all&page_mode=info&surface=albums']) {
  test(`actual normalized initial bootstrap retains admitted Artist at supplied route ${query}`, async t => {
    const url = 'https://albumhaven.test/?' + query;
    const h = fixture(t, {url, initial: artistView()}); await h.entry();
    h.boot(); await drain();
    assert.equal(h.location.href, url, 'initial server entry is not rewritten merely to prove identity');
    assert.equal(h.state.view.artist_page.artist_ref, ARTIST);
    assert.equal(h.runtime().snapshot().status, 'ready'); assert.equal(h.runtime().snapshot().actionable, true);
    const expectedEntry = new URL(url);
    expectedEntry.search = new URLSearchParams(query).toString();
    assert.equal(h.runtime().snapshot().entryUrl, expectedEntry.href, 'actual committed URL key is captured separately');
    assert.equal(h.runtime().snapshot().parentViewUrl, new URL(h.context.buildUrl(h.state.view), h.location.href).href,
      'canonical descriptor route remains owned by the existing builder');
    const session = h.runtime().snapshot().sessionId, lease = h.grid._artistPageLease;
    await h.admit(artistView(), {push: false});
    assert.equal(h.location.href, url); assert.equal(h.runtime().snapshot().sessionId, session);
    assert.equal(h.grid._artistPageLease, lease); assert.equal(h.runtime().snapshot().actionable, true);
  });
}

for (const mode of ['list', 'covers']) for (const next of ['refresh', 'album', 'form', 'album-form'])
  test(`local Cards to ${mode} preserves actual parent through ${next}`, async t => {
    const h = await mounted(t, artistView(), {mobile: true}), before = h.runtime().snapshot(), lease = h.grid._artistPageLease;
    const url = h.location.href, position = h.history.state.albumHavenNavigationPosition;
    h.context.transitionGalleryMain({type: 'set-view', view: mode});
    assert.equal(h.state.view.gallery_display_mode, mode); assert.equal(h.location.href, url);
    assert.equal(h.history.state.albumHavenNavigationPosition, position);
    if (next === 'refresh') await h.admit(artistView({gallery_display_mode: mode}), {push: false});
    else {
      if (next.includes('album')) {
        const key = h.nodes.container.querySelector('[data-album-key]').getAttribute('data-album-key');
        const indexed = h.context.getIndexedAlbum(key); assert.ok(indexed);
        assert.equal(h.context.presentMobileAlbumPage(indexed), true);
      }
      if (next.includes('form')) h.openForm();
    }
    assert.equal(h.runtime().snapshot().sessionId, before.sessionId); assert.equal(h.grid._artistPageLease, lease);
    assert.equal(h.runtime().snapshot().actionable, next === 'refresh');
    assert.equal(h.runtime().snapshot().retained, true);
  });

test('actual no-push source hydration preserves parent entry and admitted host identity', async t => {
  const h = await mounted(t), before = h.runtime().snapshot(), url = h.location.href, lease = h.grid._artistPageLease;
  const index = h.requests.length;
  h.context.transitionGalleryMain({type: 'toggle-source', source: 'new_arrivals'});
  assert.equal(h.requests.length, index + 1, 'real preference command dispatched hydration');
  h.reply(index, artistView({visible_library_categories: ['main_library', 'new_arrivals']}));
  await h.invocations.at(-1).outcome; await drain();
  assert.equal(h.location.href, url); assert.equal(h.runtime().snapshot().sessionId, before.sessionId);
  assert.equal(h.grid._artistPageLease, lease); assert.equal(h.runtime().snapshot().actionable, true);
});

test('same Artist at an unrelated committed entry cannot borrow previous parent authority', async t => {
  const h = await mounted(t), before = h.runtime().snapshot();
  h.history.pushState({albumHavenNavigationPosition: 901, mobilePages: []}, '', h.location.href);
  h.runtime().syncPresentation(); assert.equal(h.runtime().snapshot().status, 'inactive');
  assert.equal(h.grid._artistPageLease, null);
  assert.equal(h.nodes.viewport.parentElement, h.scroll);
  assert.equal(before.artistRef, ARTIST);
});

test('successful same-URL push creates a new parent and permanently invalidates old action context', async t => {
  const h = await mounted(t), opener = h.focusOpener('tracklist');
  const oldContext = h.runtime().currentContextFor(opener.trigger), before = h.runtime().snapshot();
  const oldLease = h.grid._artistPageLease, url = h.location.href, position = h.history.state.albumHavenNavigationPosition;
  assert.ok(oldContext); assert.equal(oldContext.isCurrent(), true);
  // Same-entry refresh is the positive retention control.
  await h.admit(artistView(), {push: false});
  assert.equal(h.runtime().snapshot().sessionId, before.sessionId); assert.equal(h.grid._artistPageLease, oldLease);
  assert.equal(oldContext.isCurrent(), true); assert.equal(h.location.href, url);
  await h.admit(artistView(), {push: true});
  assert.equal(h.location.href, url, 'URL equality does not imply browser entry equality');
  assert.equal(h.history.state.albumHavenNavigationPosition, position + 1);
  assert.notEqual(h.runtime().snapshot().sessionId, before.sessionId); assert.notEqual(h.grid._artistPageLease, oldLease);
  assert.equal(oldContext.isCurrent(), false);
  const current = h.focusOpener('tracklist'), currentContext = h.runtime().currentContextFor(current.trigger);
  assert.ok(currentContext); assert.equal(currentContext.isCurrent(), true);
  const checkpoint = h.focusLog.length; oldContext.restoreFocus(opener.token);
  assert.equal(h.focusLog.length, checkpoint, 'retired context cannot focus even after successor is actionable');
  await h.admit(artistView(), {push: false});
  assert.equal(currentContext.isCurrent(), true); assert.equal(oldContext.isCurrent(), false);
});
