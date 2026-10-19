'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {fixture, artistView, album, group, vector, ARTIST, drain} = require('./artist-host-fixtures/actual-artist-runtime.cjs');
async function mounted(t, groups = vector(1000), options = {}) {
  const h = fixture(t, options); await h.entry();
  await h.admit(artistView({primary_artist_groups: groups.slice(0, 1), family_artist_groups: groups.slice(1),
    artist_groups: groups, related_artists: groups.slice(1).map(row => row.artist),
    album_count: groups.reduce((n, row) => n + row.albums.length, 0), artist_count: groups.length}));
  h.context.ensureGalleryMainState().albumTypes = Array.from(h.owner('GALLERY_RELEASE_TYPES'));
  h.context.renderArtistGroups({preserveScroll: true});
  h.geometry({contentOrigin: 180, top: 180}); h.grid.recalculate(); h.grid.render(true); return h;
}
function selectedRecords(h) {
  const lease = h.grid._artistPageLease; assert.ok(lease);
  return [...lease.mounted.values()];
}
function materialized(h) {return {rows: h.nodes.container.querySelectorAll('.album-row').length,
  cards: h.nodes.container.querySelectorAll('.album-card').length, sections: selectedRecords(h).length};}
function assertBounded(h) {
  const {grid} = h, render = grid.diagnostics.latestRender, actual = materialized(h);
  assert.equal(grid.overscanPx, 320);
  assert.equal(render.start, Math.max(0, h.scroll.scrollTop - grid.getArtistPageOrigin() - 320));
  assert.equal(render.end, h.scroll.scrollTop + h.scroll.clientHeight - grid.getArtistPageOrigin() + 320);
  let rows = 0, cards = 0;
  // Use the real owner's selected sections and block ranges as evidence. This
  // never copies its selection, partition or rendering algorithm into a mock.
  for (const record of selectedRecords(h)) {
    const section = grid.sections.find(row => grid.getRenderedSectionKey(row) === record.key); assert.ok(section);
    const range = grid.getVisibleBlockRange(section, render.start, render.end);
    for (const block of section.blocksData.slice(range.firstIndex, range.lastIndex + 1)) {
      if (block.kind === 'subheading') continue;
      rows++; cards += block.albums.length;
    }
  }
  assert.equal(actual.rows, rows, 'only actual selected row blocks materialize');
  assert.equal(actual.cards, cards, 'no hidden whole-library album materialization');
  assert.ok(actual.cards <= rows * grid.columns);
  const intersecting = grid.sections.filter(section => section.bottom >= render.start && section.top <= render.end).length;
  const buffer = Math.max(3, Number.isInteger(grid.bufferSectionsOverride) ? grid.bufferSectionsOverride : grid.bufferSections);
  assert.ok(actual.sections <= intersecting + 2 * buffer, 'only intersecting and existing adjacent sections');
  assert.ok(grid.albumCardNodeCache.size <= 48, 'shared retained-card cap stays 48');
  return actual;
}

for (const total of [1000, 10000]) test(`actual ${total}-album grid is bounded at top, middle, end and below Discography`, async t => {
  const h = await mounted(t, vector(total)); const initial = assertBounded(h), listeners = h.listeners().filter(row => row.target.isConnected).length;
  assert.ok(initial.cards < 100, 'fixed viewport materializes a bounded subset');
  for (const position of [h.grid.totalHeight / 2, h.grid.totalHeight - 400]) {
    h.scrollTo(180 + position); h.grid.render(true); assertBounded(h);
    assert.ok(h.listeners().filter(row => row.target.isConnected).length <= listeners + 30,
      'listeners follow bounded native subsection owners, never payload rows');
  }
  h.scrollTo(180 + h.grid.totalHeight + 1000); h.grid.render(true);
  assert.equal(materialized(h).rows, 0); assert.equal(materialized(h).cards, 0);
  assert.equal(selectedRecords(h).length, 0);
  assert.equal(parseFloat(h.nodes.top.style.height || '0') + parseFloat(h.nodes.bottom.style.height || '0'), h.grid.totalHeight);
  assert.ok(h.grid.albumCardNodeCache.size <= 48);
});

test('1,000 and 10,000 albums at identical viewport geometry have equal materialization and persistent listener count', async t => {
  const h = await mounted(t, vector(1000)), first = assertBounded(h), id = h.identities();
  const firstListeners = h.listeners().filter(row => row.target.isConnected).length;
  const large = vector(10000);
  await h.admit(artistView({primary_artist_groups: large.slice(0, 1), family_artist_groups: large.slice(1),
    artist_groups: large, related_artists: large.slice(1).map(row => row.artist), album_count: 10000}), {push: false});
  h.geometry({contentOrigin: 180, top: 180}); h.grid.recalculate(); h.grid.render(true);
  assert.deepEqual(assertBounded(h), first);
  assert.equal(h.listeners().filter(row => row.target.isConnected).length, firstListeners);
  assert.equal(h.grid, id.grid); assert.equal(h.grid.albumCardNodeCache, id.cache); assert.equal(h.identities().scheduler, id.scheduler);
});

test('actual parent collapse moves focus first, drops all rows and preserves independently collapsed subsection choice', async t => {
  const h = await mounted(t), lease = h.grid._artistPageLease, record = selectedRecords(h)[0];
  const key = h.grid.sections.find(section => h.grid.getRenderedSectionKey(section) === record.key).sectionKey;
  const trigger = record.element.querySelector('[data-album-key]'); assert.ok(trigger); trigger.focus();
  h.click(record.toggle);
  assert.equal(h.document.activeElement, record.toggle); assert.equal(record.owner.slots.panel.hidden, true);
  assert.equal(lease.choices.get(key), true); assert.equal(record.element.querySelectorAll('.album-row').length, 0);
  const parent = h.section('discography');
  record.toggle.focus(); assert.equal(h.document.activeElement, record.toggle);
  const proto = h.context.Element.prototype, setAttribute = proto.setAttribute;
  let hiddenWrites = 0, focusBeforeHide = false;
  proto.setAttribute = function(name, value) {
    if (this === parent.panel && name === 'hidden' && !this.hidden) {
      hiddenWrites++; focusBeforeHide = h.document.activeElement === parent.toggle;
      assert.equal(this.hidden, false, 'observation precedes the hiding write');
    }
    return setAttribute.call(this, name, value);
  };
  t.after(() => {proto.setAttribute = setAttribute;});
  h.click(parent.toggle);
  assert.equal(hiddenWrites, 1, 'the actual parent panel was hidden once');
  assert.equal(focusBeforeHide, true, 'intrinsic owner moved focus before hiding parent');
  assert.equal(h.document.activeElement, parent.toggle);
  assert.equal(parent.panel.hidden, true); assert.equal(materialized(h).rows, 0); assert.equal(lease.mounted.size, 0);
  assert.ok(h.grid.albumCardNodeCache.size <= 48);
  h.click(parent.toggle); assert.equal(parent.panel.hidden, false); assert.equal(lease.choices.get(key), true);
  const reopened = selectedRecords(h).find(row => row.key === record.key); assert.ok(reopened);
  assert.equal(reopened.owner.slots.panel.hidden, true); assert.equal(reopened.element.querySelectorAll('.album-row').length, 0);
  assertBounded(h);
});

test('Info, Family and Discography disclosures remain independent and same-key native headers survive row patches', async t => {
  const h = await mounted(t), discography = h.section('discography'), record = selectedRecords(h)[0];
  const header = record.header, toggle = record.toggle, panel = record.owner.slots.panel;
  h.click(h.section('info').toggle); h.click(h.section('family').toggle);
  assert.equal(discography.panel.hidden, false); assert.ok(materialized(h).cards > 0);
  h.scrollTo(500); h.grid.render(true);
  const retained = selectedRecords(h).find(row => row.key === record.key); assert.ok(retained);
  assert.equal(retained.header, header); assert.equal(retained.toggle, toggle); assert.equal(retained.owner.slots.panel, panel);
  assertBounded(h);
});

test('subsection semantic choice survives temporary filter removal and uses the actual classifier only', async t => {
  const albums = [album(1, {release_type: 'studio'}), album(2, {release_type: 'compilation'}),
    album(3, {name: 'Live EP Single', release_type: 'live'}), album(4, {is_compilation: true})];
  const h = await mounted(t, [group(ARTIST, albums)]), lease = h.grid._artistPageLease;
  const compilation = h.grid.sections.find(section => section.releaseType === 'compilation'); assert.ok(compilation);
  const record = lease.mounted.get(h.grid.getRenderedSectionKey(compilation)); assert.ok(record); h.click(record.toggle);
  const studio = h.grid.sections.find(section => section.releaseType === 'studio');
  assert.deepEqual(Array.from(studio.group.albums, a => a.key), ['artist-album-1', 'artist-album-3']);
  assert.equal(h.grid.sections.every(section => ['studio', 'compilation'].includes(section.releaseType)), true);
  const filtered = group(ARTIST, albums.filter(item => h.context.classifyGalleryReleaseType(item) === 'studio'));
  await h.admit(artistView({primary_artist_groups: [filtered], artist_groups: [filtered]}), {push: false});
  assert.equal(h.grid.sections.some(section => section.sectionKey === compilation.sectionKey), false);
  assert.equal(lease.choices.get(compilation.sectionKey), true);
  const restored = group(ARTIST, albums); await h.admit(artistView({primary_artist_groups: [restored], artist_groups: [restored]}), {push: false});
  assert.equal(h.grid._artistPageLease, lease);
  const back = h.grid.sections.find(section => section.sectionKey === compilation.sectionKey); assert.ok(back);
  assert.equal(back.blocksData.length, 0); assert.equal(h.context.getIndexedAlbum('artist-album-2').key, 'artist-album-2',
    'collapsed membership stays indexed');
});

test('partition ordering is a stable filter of the real display model, with duplicate occurrences and version keys intact', async t => {
  const h = await mounted(t, [group(ARTIST, [album(1), album(2, {release_type: 'compilation'})]),
    group('Duplicate', [album(3)]), group('Duplicate', [album(4, {edition: 'Remaster'})])]);
  const lease = h.grid._artistPageLease, keys = h.grid.sections.map(section => section.sectionKey);
  assert.equal(new Set(keys).size, keys.length);
  for (const ordinary of lease.ordinarySections.filter(section => section.kind === 'artist')) {
    for (const partition of h.grid.sections.filter(section => section.sectionKey.startsWith(ordinary.sectionKey + ':release:'))) {
      assert.deepEqual(Array.from(partition.group.albums), Array.from(ordinary.group.albums).filter(album =>
        h.context.classifyGalleryReleaseType(album) === partition.releaseType));
      for (const item of partition.group.albums) assert.equal(h.context.getIndexedAlbum(h.context.getAlbumRequestKey(item)), item);
    }
  }
  assert.equal(h.nodes.container.querySelector('.gallery-divider'), null, 'no second decorative Family surface');
});

for (const mode of ['cards', 'list', 'covers']) test(`actual ${mode} geometry uses transferred width and nonzero origin`, async t => {
  const h = await mounted(t, vector(1000), {mobile: mode === 'list'});
  h.context.transitionGalleryMain({type: 'set-view', view: mode});
  h.geometry({width: 740, height: 600, contentOrigin: 360, top: 800}); h.grid.recalculate(); h.grid.render(true);
  assert.equal(h.grid.getArtistPageOrigin(), 360); assertBounded(h);
  assert.ok(h.grid.columns >= 1); assert.ok(h.grid.cardTrackWidth * h.grid.columns <= 740);
  const section = h.grid.sections.find(section => section.blocksData.length);
  assert.equal(section.height, h.grid.getSectionHeaderHeight(section) + section.blocksHeight + h.grid.sectionMarginBottom);
  h.geometry({width: 740, contentOrigin: 0, top: 800}); h.grid.render(true); assert.equal(h.grid.getArtistPageOrigin(), 0);
  assertBounded(h);
});

test('one lease observer measures wrapped headers, Info reflow and coalesces work without overriding later user scroll', async t => {
  const h = await mounted(t), lease = h.grid._artistPageLease, record = selectedRecords(h)[0];
  const key = h.grid.sections.find(section => h.grid.getRenderedSectionKey(section) === record.key).sectionKey;
  assert.ok(lease.observer.nodes.has(h.host)); assert.ok(lease.observer.nodes.has(record.header));
  h.setRect(record.header, {width: 700, height: 96});
  h.geometry({contentOrigin: 310, top: 180});
  lease.observer.callback([{target: record.header}, {target: h.host}]); const frame = h.grid._measureRaf;
  lease.observer.callback([{target: record.header}]); assert.equal(h.grid._measureRaf, frame);
  h.frame(); assert.equal(h.grid.getArtistPageOrigin(), 310);
  assert.equal(h.grid.sections.find(section => section.sectionKey === key).headerHeight, 96);
  lease.observer.callback([{target: h.host}]); const late = [...h.frames.values()];
  h.dispatch(h.scroll, 'wheel'); h.scrollTo(900);
  for (const callback of late) callback(0);
  assert.equal(h.scroll.scrollTop, 900, 'user scroll cancels stale geometry restoration');
});

test('recycling focused card moves to a current toggle without expanding the materialization window; explicit return rematerializes it', async t => {
  const h = await mounted(t), lease = h.grid._artistPageLease, record = selectedRecords(h)[0];
  const trigger = record.element.querySelector('[data-open-tracklist="1"][data-album-key]') || record.element.querySelector('[data-album-key]');
  assert.ok(trigger); trigger.focus(); const token = lease.focusToken; assert.ok(token);
  h.scrollTo(180 + h.grid.totalHeight / 2); h.grid.render(true); assertBounded(h);
  assert.equal(h.document.activeElement.closest('[hidden],[inert]'), null);
  assert.equal(h.document.activeElement.isConnected, true);
  assert.equal(lease.api.restoreFocus(token), true);
  assert.equal(h.document.activeElement.getAttribute('data-album-key'), token.albumKey);
  assertBounded(h);
  const restored = lease.mounted.get(h.grid.getRenderedSectionKey(h.grid.sections.find(s => s.sectionKey === token.sectionKey)));
  h.click(restored.toggle); assert.equal(lease.api.restoreFocus(token), true);
  assert.equal(h.document.activeElement, restored.toggle); assert.equal(lease.choices.get(token.sectionKey), true);
});

test('hidden child preserves geometry and cache; release restores dock and stale lease cannot move successor', async t => {
  const h = await mounted(t, vector(1000), {mobile: true}), id = h.identities(), lease = h.grid._artistPageLease;
  const origin = h.grid.getArtistPageOrigin(), rows = materialized(h).rows;
  const form = h.openForm(); assert.equal(lease.suspended, true);
  h.geometry({width: 0, height: 0}); h.resize();
  assert.equal(h.grid.getArtistPageOrigin(), origin); assert.equal(materialized(h).rows, rows);
  assert.equal(h.grid.albumCardNodeCache, id.cache);
  h.geometry({width: 374, height: 600, contentOrigin: 180}); h.holdHistory(); const close = form.dismiss('back'); await drain();
  h.settleHistory(); await close; await drain(); assert.equal(h.grid._artistPageLease, lease); assertBounded(h);
  h.runtime().dispose(); assert.equal(h.nodes.viewport.parentElement, h.scroll); assert.equal(lease.observer.retired, true);
  assert.equal(h.grid._destroyed, false); assert.equal(h.grid.albumCardNodeCache, id.cache);
  const marker = h.scroll.childNodes.find(node => node.nodeType === 8 && node.data === 'Artist viewport origin'); assert.equal(marker, undefined);
  const nextPanel = h.document.createElement('div'); h.scroll.append(nextPanel);
  const {mountIntrinsicDisclosure} = await import('../../../music_app/static/js/home-friends/native-controls.mjs');
  const runtime = {buttonHtml: options => h.context.ButtonComponent.renderButton(options),
    createIntrinsicDisclosure: options => h.context.createIntrinsicDisclosure(options)};
  const next = h.grid.acquireArtistPagePresentation({sessionId: 'successor', panel: nextPanel, isCurrent: () => true,
    mountReleaseDisclosure: (element, props) => mountIntrinsicDisclosure(element, runtime, props)});
  assert.ok(next); lease.api.release(); assert.equal(h.nodes.viewport.parentElement, nextPanel);
  next.release(); assert.equal(h.nodes.viewport.parentElement, h.scroll);
});

test('acquisition rejects mismatched original bindings and leaves ordinary Gallery usable without fallback', async t => {
  const h = fixture(t), spacer = h.nodes.top; spacer.remove(); await h.entry(); await h.admit();
  assert.equal(h.runtime().snapshot().status, 'unavailable'); assert.equal(h.grid._artistPageLease, null);
  assert.equal(h.nodes.viewport.parentElement, h.scroll); assert.match(h.host.textContent, /unavailable/i);
  assert.equal(h.host.querySelectorAll('.album-card').length, 0);
  assert.equal(h.grid._destroyed, false);
});

test('failed DOM transfer rolls back before native disclosure teardown and does not create a second grid', async t => {
  const h = fixture(t), proto = h.context.Element.prototype, append = proto.appendChild, grid = h.grid;
  let fail = true;
  proto.appendChild = function(node) {
    const result = append.call(this, node);
    if (fail && node === h.nodes.viewport && this !== h.scroll) {fail = false; throw new Error('fixture DOM transfer failure');}
    return result;
  };
  t.after(() => {proto.appendChild = append;});
  await h.entry(); await h.admit();
  assert.equal(fail, false); assert.equal(h.runtime().snapshot().status, 'unavailable');
  assert.equal(h.nodes.viewport.parentElement, h.scroll); assert.equal(h.grid, grid); assert.equal(grid._artistPageLease, null);
  assert.equal(h.document.querySelectorAll('#albums-viewport').length, 1);
  assert.equal(h.scroll.childNodes.some(node => node.nodeType === 8 && node.data === 'Artist viewport origin'), false);
});

test('chronological display retains admitted uncombined scope while release partitions keep owner order', async t => {
  const primary = group(ARTIST, [album(1, {year: 2010}), album(2, {year: 1990, release_type: 'compilation'})]);
  const family = group('Family', [album(3, {year: 2000}), album(4, {year: 1980, release_type: 'compilation'})]);
  const chronological = group('Chronological', [family.albums[1], primary.albums[1], family.albums[0], primary.albums[0]]);
  const h = await mounted(t, [primary, family]);
  await h.admit(artistView({selected_artist_family_display_mode: 'chronological',
    artist_page: {artist_ref: ARTIST, active_page_mode: 'info', family_display_mode: 'chronological'},
    primary_artist_groups: [primary], family_artist_groups: [family], artist_groups: [chronological], related_artists: ['Family']}), {push: false});
  const snapshot = h.runtime().snapshot();
  assert.deepEqual(Array.from(snapshot.scopeGroups, row => row.artist), [ARTIST, 'Family']);
  assert.equal(snapshot.familyMembers.some(row => row.artistRef === 'Chronological'), false);
  assert.deepEqual(Array.from(h.grid.sections.find(section => section.releaseType === 'studio').group.albums, row => row.key),
    ['artist-album-3', 'artist-album-1']);
  assert.deepEqual(Array.from(h.grid.sections.find(section => section.releaseType === 'compilation').group.albums, row => row.key),
    ['artist-album-4', 'artist-album-2']);
});

for (const kind of ['cover', 'tracklist']) test(`same-album replacement rejects stale ${kind} version token and resolves exact current trigger`, async t => {
  const h = await mounted(t, [group(ARTIST, [album(1, {edition: 'Original'})])]);
  const before = h.focusOpener(kind), lease = h.grid._artistPageLease;
  const replacement = group(ARTIST, [album(1, {edition: 'Remaster'})]);
  await h.admit(artistView({primary_artist_groups: [replacement], artist_groups: [replacement]}), {push: false});
  assert.equal(h.grid._artistPageLease, lease);
  const currentAlbum = h.context.getIndexedAlbum(before.token.albumKey);
  assert.equal(h.context.getAlbumRequestKey(currentAlbum), before.token.albumKey, 'same canonical request identity is reused');
  assert.notEqual(h.context.getAlbumCardVersionKey(currentAlbum), before.token.versionKey, 'version really changed');
  const checkpoint = h.focusLog.length;
  lease.api.restoreFocus(before.token);
  assert.ok(h.focusLog.length > checkpoint, 'stale token takes the current semantic fallback');
  assert.equal(h.document.activeElement.hasAttribute('aria-controls'), true, 'fallback is a disclosure toggle');
  assert.equal(h.focusLog.slice(checkpoint).some(row => row.albumKeyAtCall === before.token.albumKey), false,
    'an old version token cannot focus a new same-key album trigger');
  const current = h.focusOpener(kind);
  assert.notEqual(current.token.versionKey, before.token.versionKey);
  h.section('discography').toggle.focus();
  assert.equal(lease.api.restoreFocus(current.token), true);
  assert.equal(h.document.activeElement, current.trigger, 'exact current trigger is restored');
  assert.equal(h.document.activeElement.getAttribute('data-album-version-key'), current.token.versionKey);
  assert.equal(h.focusLog.at(-1).triggerAtCall, kind);
});
