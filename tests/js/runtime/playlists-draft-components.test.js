const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {nativeDialogFixture} = require('./playlist-native-dialog-fixture.cjs');
const {installNativeSearch} = require('./native-search-harness.cjs');
const repo = path.resolve(__dirname, '../../..');
let creation, draft, nativeDraft, creationReviewRow;
let missingPlaylistDraftTableHtml, missingPlaylistDraftReorderSnapshot;
test.before(async () => {
  creation = await import('../../../music_app/static/js/playlists/creation.mjs');
  draft = await import('../../../music_app/static/js/playlists/draft.mjs');
  nativeDraft = await import('../../../music_app/static/js/playlists/native-draft.mjs');
  ({missingPlaylistDraftTableHtml, missingPlaylistDraftReorderSnapshot} = nativeDraft);
  ({creationReviewRow} = await import('../../../music_app/static/js/playlists/native-creation-form.mjs'));
});

// This adapter changes only the DOM/platform delivery. Product rendering, menu,
// filtering, selection, drag, information panels and page commands stay real.
function nativeEnvironment({gestures = false, search = true} = {}) {
  const env = nativeDialogFixture(), {document, context} = env;
  const winEvents = document.createElement('window'), frames = new Map(), scrollCalls = []; let frameId = 0;
  context.addEventListener = (...args) => winEvents.addEventListener(...args);
  context.removeEventListener = (...args) => winEvents.removeEventListener(...args);
  context.dispatchEvent = event => winEvents.dispatchEvent(event);
  context.requestAnimationFrame = callback => {frames.set(++frameId, callback); return frameId;};
  context.cancelAnimationFrame = id => frames.delete(id);
  context.getComputedStyle = () => ({display: 'block', columnGap: '8px', overflowY: 'visible', direction: 'ltr'});
  // Bounded platform scrolling for the actual choice/reorder owners. This is
  // geometry bookkeeping, not a menu or gesture implementation.
  context.Element.prototype.scrollIntoView = function (options = {}) {
    scrollCalls.push({target: this, options});
    if (!this.isConnected) return;
    if (options.block !== 'nearest' || options.inline && options.inline !== 'nearest') {
      throw new Error('Draft fixture supports nearest scrolling only');
    }
    const box = this.getBoundingClientRect();
    for (let parent = this.parentElement; parent; parent = parent.parentElement) {
      if (!(parent.scrollHeight > parent.clientHeight)) continue;
      const viewport = parent.getBoundingClientRect();
      const delta = box.top < viewport.top ? box.top - viewport.top
        : box.bottom > viewport.bottom ? box.bottom - viewport.bottom : 0;
      parent.scrollTop = Math.max(0, Math.min(parent.scrollHeight - parent.clientHeight, parent.scrollTop + delta));
    }
  };
  document.scrollingElement = document.documentElement;
  Object.assign(document.documentElement, {scrollHeight: 600, clientHeight: 600});
  for (const file of ['trigger-anchor.js', 'library-settings.js']) {
    vm.runInContext(fs.readFileSync(path.join(repo, 'music_app/static/js/runtime', file), 'utf8'), context);
  }
  const nativeSearch = search ? installNativeSearch(env) : null;
  // Replace the review fixture's boundary doubles with their canonical owners.
  Object.assign(env.runtime, {...(nativeSearch ? {searchHtml: nativeSearch.render} : {}),
    detailHeaderHtml: env.owner('buildAlbumDetailsHeaderHtml'),
    galleryBarHtml: env.owner('buildGalleryBarHtml'),
    openChoice: env.owner('openUtilityChoiceDropdown'), downloadText() {}});
  if (gestures) {
    context.Element.prototype.cloneNode = function (deep) {
      const clone = document.createElement(this.tagName);
      for (const {name, value} of this.attributes) clone.setAttribute(name, value);
      if (deep) for (const child of this.childNodes) clone.appendChild(child.nodeType === 3
        ? document.createTextNode(child.textContent) : child.cloneNode(true));
      return clone;
    };
    const bounds = context.Element.prototype.getBoundingClientRect;
    context.Element.prototype.getBoundingClientRect = function () {
      if (!this.matches('[data-playlist-row-key]')) return bounds.call(this);
      const index = env.host.querySelectorAll('[data-playlist-row-key]').indexOf(this), top = 100 + index * 40;
      return {x: 20, y: top, left: 20, right: 720, top, bottom: top + 40, width: 700, height: 40};
    };
  }
  return {...env, frames, winEvents, scrollCalls};
}
const native = nativeEnvironment(), runtime = native.runtime;
const context = () => ({scopeKey: 'draft-components:actor', mode: 'missing', canCreate: true, canCreateAlbumTop: true,
  source: {kind: 'playlist', ref: 'draft-components:source', revision: 'original-revision',
    allowed_actions: {can_read: true, can_use_for_playlist: true}}});
const entry = (entry_ref, patch = {}) => ({entry_ref, canonical_track_ref: null, title: `Original ${entry_ref}`, artist: 'Artist',
  album_title: 'Album', duration_seconds: null, availability: 'unresolved', metadata_state: 'unknown',
  allowed_actions: {can_read: true, can_select: true},
  parent_album: {state: 'known', album_ref: 'exact-parent', title: 'Album',
    allowed_actions: {can_read: true, can_create_album_top: true, can_view_details: true}}, ...patch});
function session({entries = [entry('a'), entry('b', {availability: 'missing'})], writer, reader, token = 'local-page'} = {}) {
  const subject = context();
  const sourceResource = creation.normalizeCreationResult({status: 'ready', data: {...subject,
    allowed_actions: {can_read: true, can_use_for_playlist: true}, entries_complete: true, entries, retained_parent_albums: []}}, subject);
  const prepared = creation.prepareMissingDraft({...subject, sourceResource, title: 'Missing originals', description: 'Typed description',
    selectedKeys: sourceResource.data.entries.filter(row => row.source_readable && row.availability !== 'local').map(row => row.row_key),
    mutation: {status: 'idle'}}, {draftToken: token});
  return draft.createMissingPlaylistDraftController({prepared, providers: {...(writer ? {createPlaylistFromSelection: writer} : {}), ...(reader ? {readPlaylistCreationSource: reader} : {})}});
}
const acknowledged = request => ({status: 'ready', data: {scopeKey: request.scopeKey, request_key: request.request_key,
  playlist_id: 'persisted-playlist', revision: 'persisted-revision'}});
const hostFor = html => {const host = native.document.createElement('div'); host.innerHTML = html; return host;};
const action = (host, name) => host.querySelector(`[data-playlists-draft-action="${name}"]`);
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
const rowKeys = host => host.querySelectorAll('[data-playlist-row-key]').map(row => row.dataset.playlistRowKey);
const filterSurface = host => host.querySelector('[aria-label="Playlist filters"]');
const choiceButton = host => [...host.querySelectorAll('button')].find(button => button.getAttribute('aria-label')?.startsWith('Availability:'));
const selectionStatus = fixture => fixture.root.querySelector('.album-track-table__selection-actions [role="status"]').textContent;
const settle = () => new Promise(resolve => setImmediate(resolve));

function pageLifecycle(name = 'MissingPlaylistDraftPage', options = {}) {
  const isTracks = name === 'MissingPlaylistDraftTracks';
  const env = nativeEnvironment({...options, search: !isTracks}), root = env.host;
  // Canonical trigger-anchor installs lifetime-global listeners before the tested owner.
  // Preserve their exact identities and require zero additional owner listeners after cleanup.
  const baselineDocumentListeners = [...env.document.listeners];
  const baselineWindowListeners = [...env.winEvents.listeners];
  let owner = null, disposed = false, mutationBaseline = 0;
  const emit = (target, type, values = {}) => {
    assert.ok(target, `A real DOM target exists for ${type}`);
    const event = Object.assign(new env.context.Event(type), {pointerId: 7, button: 0, isPrimary: true, clientX: 40, clientY: 120}, values);
    target.dispatchEvent(event); return event;
  };
  return {env, root, frames: env.frames, emit, baselineDocumentListeners, baselineWindowListeners,
    get host() {return isTracks ? root.querySelector('.playlists-draft__tracks') || root : root;},
    render(controller, extra = {}) {
      assert.equal(disposed, false, 'A disposed native owner cannot be reused');
      const state = controller.getSnapshot();
      const props = {controller, state, id: 'draft-adapter', projection: draft.projectMissingPlaylistDraft(state),
        disabled: false, onReview() {}, onClose() {}, ...extra};
      const deliveredRuntime = {...env.runtime, ...(extra.runtime || {})};
      if (owner) owner.update(props);
      else owner = (isTracks ? nativeDraft.mountMissingPlaylistDraftTracks : nativeDraft.mountMissingPlaylistDraftPage)(root, deliveredRuntime, props);
      return root;
    },
    click(target) {emit(target, 'click'); return settle();},
    command(command, host = root) {emit(action(host, command), 'click'); return settle();},
    input(input, value) {input.value = value; emit(input, 'input');},
    openAvailability(host = root) {emit(choiceButton(host), 'click'); return env.document.querySelector('[role="menu"][aria-label="Availability"]');},
    frame() {const callbacks = [...env.frames.values()]; env.frames.clear(); for (const callback of callbacks) callback(16);},
    lateMutations() {return env.mutations.length + env.attributeMutations.length - mutationBaseline;},
    dispose() {
      if (disposed) return; disposed = true;
      const table = root.querySelector('.playlists-draft__tracks'); owner?.dispose();
      if (isTracks) {
        /* D001 */ assert.equal(env.frames.size, 0);
        /* D002 */ assert.equal(table?.listeners.length || 0, 0);
        /* D003 */ assert.deepEqual(env.document.listeners, baselineDocumentListeners);
        /* D004 */ assert.deepEqual(env.winEvents.listeners, baselineWindowListeners);
        /* D005 */ assert.deepEqual(env.forbiddenCalls, []);
      }
      root.remove(); mutationBaseline = env.mutations.length + env.attributeMutations.length;
    },
  };
}
const trackLifecycle = options => pageLifecycle('MissingPlaylistDraftTracks', options);
const render = (controller, extra = {}) => {
  const fixture = pageLifecycle();
  try {return fixture.render(controller, extra).innerHTML;} finally {fixture.dispose();}
};

const metricEntries = () => [entry('unknown'), entry('high', {love_tier: 'obsessed', play_count: 9, popularity_count: 100, duration_seconds: 600, track_rating: 5}),
  entry('tie-first', {love_tier: 'loved', play_count: 3, popularity_count: 20, duration_seconds: 120, track_rating: 2}),
  entry('zero', {love_tier: 'off', play_count: 0, popularity_count: 0, duration_seconds: 0, track_rating: 1}),
  entry('tie-second', {love_tier: 'loved', play_count: 3, popularity_count: 20, duration_seconds: 120, track_rating: 4})];

test('draft metrics render supplied read-only facts and keep unavailable values honest', () => {
  const controller = session({entries: metricEntries()}), state = controller.getSnapshot();
  const html = missingPlaylistDraftTableHtml(runtime, {id: 'draft-metrics', state, projection: draft.projectMissingPlaylistDraft(state)}), host = hostFor(html);
  /* D006 */ assert.deepEqual(host.querySelectorAll('[data-cdt-sort]').map(button => button.dataset.cdtSort),
    ['love_tier', 'play_count', 'popularity_count', 'duration']);
  const table = host.querySelector('.compact-data-table'), style = table.getAttribute('style');
  /* D007 */ assert.equal(table.getAttribute('data-cdt-narrow'), 'true');
  const fullColumns = style.match(/--cdt-columns: ([^;]+)/)[1], narrowColumns = style.match(/--cdt-narrow-columns: ([^;]+)/)[1];
  /* D008 */ assert.match(fullColumns, / 36px 80px 54px 64px 54px 40px$/);
  /* D009 */ assert.equal(narrowColumns, '30px 36px minmax(0,1fr) 36px 54px 54px 40px', 'the responsive grid retains selection, track, Love, plays, duration and remove');
  const ratingCells = host.querySelectorAll('[data-cdt-column="track_rating"]');
  /* D010 */ assert.equal(ratingCells.length, state.entries.length + 1);
  /* D011 */ assert.ok(ratingCells.every(cell => cell.hasAttribute('data-cdt-hide-narrow')));
  for (const key of ['love_tier', 'play_count', 'popularity_count', 'duration']) {
    const cells = host.querySelectorAll(`[data-cdt-column="${key}"]`);
    /* D012 */ assert.equal(cells.length, state.entries.length + 1);
    /* D013 */ assert.ok(cells.every(cell => cell.hasAttribute('data-cdt-hide-narrow') === (key === 'popularity_count')));
  }
  const known = host.querySelector('[data-playlist-row-key="entry:high"]');
  /* D014 */ assert.equal(known.querySelector('[data-love-tier]').getAttribute('aria-label'), 'Obsessed');
  /* D015 */ assert.equal(known.querySelector('[data-cdt-column="track_rating"] [role="img"]').getAttribute('aria-label'), 'Track rating: 5 out of 5');
  /* D016 */ assert.equal(known.querySelector('[data-cdt-column="play_count"]').textContent, '9');
  /* D017 */ assert.equal(known.querySelector('[data-cdt-column="popularity_count"]').textContent, '100');
  /* D018 */ assert.equal(known.querySelector('[data-cdt-column="duration"]').textContent, '10:00');
  const unknown = host.querySelector('[data-playlist-row-key="entry:unknown"]');
  for (const key of ['love_tier', 'track_rating', 'play_count', 'popularity_count', 'duration']) {
    const cell = unknown.querySelector(`[data-cdt-column="${key}"]`);
    /* D019 */ assert.equal(cell.textContent, '–'); /* D020 */ assert.equal(cell.querySelector('button,input,select'), null);
    /* D021 */ assert.equal(known.querySelector(`[data-cdt-column="${key}"]`).querySelector('button,input,select'), null);
  }
  const zero = host.querySelector('[data-playlist-row-key="entry:zero"]');
  /* D022 */ assert.equal(zero.querySelector('[data-cdt-column="play_count"]').textContent, '0');
  /* D023 */ assert.equal(zero.querySelector('[data-cdt-column="duration"]').textContent, '0:00');
  /* D024 */ assert.doesNotMatch(html, /data-track-path=|data-src=|data-play-track=|data-rating-edit=|data-love-edit=/);
  controller.dispose();
});

test('draft metric header cycles preserve row-key selection, authored order, TXT and Save payloads', async t => {
  const requests = [], controller = session({entries: metricEntries(), writer: request => {requests.push(request); return acknowledged(request);}});
  const fixture = trackLifecycle(); t.after(() => {fixture.dispose(); controller.dispose();});
  controller.select('entry:tie-first');
  const authored = controller.getSnapshot(), keys = authored.entries.map(row => row.row_key), exported = controller.exportText();
  let tree = fixture.render(controller);
  for (const key of ['love_tier', 'play_count', 'popularity_count', 'duration']) {
    for (const [direction, expected] of [
      ['ascending', ['entry:zero', 'entry:tie-first', 'entry:tie-second', 'entry:high', 'entry:unknown']],
      ['descending', ['entry:high', 'entry:tie-first', 'entry:tie-second', 'entry:zero', 'entry:unknown']],
      ['none', keys],
    ]) {
      const button = fixture.host.querySelector(`[data-cdt-sort="${key}"]`); button.focus();
      fixture.emit(button.querySelector('.compact-data-table__sort-label'), 'click');
      tree = fixture.render(controller);
      /* D025 */ assert.deepEqual(rowKeys(fixture.host), expected);
      /* D026 */ assert.equal(fixture.host.querySelector(`[role="columnheader"][data-cdt-column="${key}"]`).getAttribute('aria-sort'), direction);
      /* D027 */ assert.equal(fixture.env.document.activeElement, fixture.host.querySelector(`[data-cdt-sort="${key}"]`));
      /* D028 */ assert.equal(fixture.host.querySelector('[data-draft-pick="entry:tie-first"]').hasAttribute('checked'), true);
      /* D029 */ assert.equal(fixture.host.querySelectorAll('[data-draft-pick]').filter(input => input.hasAttribute('checked')).length, 1);
      /* D030 */ assert.equal(controller.getSnapshot(), authored, 'view sorting cannot publish an authored draft mutation');
      /* D031 */ assert.equal(controller.exportText(), exported);
      const handles = fixture.host.querySelectorAll('[data-playlists-drag]');
      /* D032 */ assert.ok(handles.every(button => button.disabled === (direction !== 'none')));
      if (direction !== 'none') /* D033 */ assert.ok(fixture.host.querySelectorAll('[data-draft-move]').every(button => button.disabled));
    }
  }
  fixture.emit(fixture.host.querySelector('[data-cdt-sort="play_count"]'), 'click');
  tree = fixture.render(controller);
  fixture.emit(fixture.host.querySelector('[data-draft-pick="entry:high"]'), 'change');
  /* D034 */ assert.deepEqual(controller.getSnapshot().selectedKeys, ['entry:tie-first', 'entry:high']);
  /* D035 */ assert.deepEqual(controller.getSnapshot().entries.map(row => row.row_key), keys);
  /* D036 */ assert.equal(controller.exportText(), exported);
  const result = await controller.save();
  /* D037 */ assert.equal(result.playlist_id, 'persisted-playlist'); /* D038 */ assert.equal(requests.length, 1);
  /* D039 */ assert.deepEqual(requests[0].entry_refs, ['unknown', 'high', 'tie-first', 'zero', 'tie-second']);
});

test('sorting synchronously cancels native drag and blocks manual and keyboard reorder before owner update', t => {
  const controller = session({entries: metricEntries()}), fixture = trackLifecycle({gestures: true});
  t.after(() => {fixture.dispose(); controller.dispose();});
  let tree = fixture.render(controller);
  const before = controller.getSnapshot(), first = fixture.host.querySelector('[data-playlists-drag]');
  const manual = fixture.host.querySelector('[data-playlist-row-key="entry:unknown"] [data-draft-move="down"]');
  fixture.emit(first, 'pointerdown'); fixture.emit(fixture.env.document, 'pointermove', {clientY: 200}); fixture.frame();
  /* D040 */ assert.equal(fixture.host.classList.contains('is-reordering'), true);
  /* D041 */ assert.notDeepEqual(rowKeys(fixture.host), before.entries.map(row => row.row_key));
  const heading = fixture.host.querySelector('[data-cdt-sort="play_count"]'); heading.focus();
  fixture.emit(heading, 'click');
  /* D042 */ assert.equal(fixture.host.classList.contains('is-reordering'), false);
  /* D043 */ assert.equal(fixture.host.querySelector('.playlists__reorder-ghost'), null);
  /* D044 */ assert.deepEqual(fixture.env.document.listeners, fixture.baselineDocumentListeners); /* D045 */ assert.equal(fixture.frames.size, 0);
  /* D046 */ assert.deepEqual(rowKeys(fixture.host), ['entry:zero', 'entry:tie-first', 'entry:tie-second', 'entry:high', 'entry:unknown']);
  /* D047 */ assert.equal(fixture.host.querySelector('[data-playlist-row-key="entry:unknown"] [data-draft-move="down"]').disabled, true, 'native paint disables current reorder controls synchronously');
  fixture.emit(manual, 'click');
  fixture.emit(first, 'keydown', {key: 'End'});
  fixture.emit(first, 'pointerdown'); fixture.emit(fixture.env.document, 'pointerup', {clientY: 240});
  /* D048 */ assert.deepEqual(fixture.env.document.listeners, fixture.baselineDocumentListeners); /* D049 */ assert.equal(controller.getSnapshot(), before);
  tree = fixture.render(controller);
  /* D050 */ assert.ok(fixture.host.querySelectorAll('[data-draft-move],[data-playlists-drag]').every(button => button.disabled));
  for (let index = 0; index < 2; index++) {
    fixture.emit(fixture.host.querySelector('[data-cdt-sort="play_count"]'), 'click');
    tree = fixture.render(controller);
  }
  /* D051 */ assert.deepEqual(rowKeys(fixture.host), before.entries.map(row => row.row_key));
  const restored = fixture.host.querySelector('[data-playlist-row-key="entry:unknown"] [data-playlists-drag]');
  /* D052 */ assert.equal(restored.disabled, false);
  fixture.emit(restored, 'keydown', {key: 'End'});
  /* D053 */ assert.deepEqual(controller.getSnapshot().entries.map(row => row.row_key),
    ['entry:high', 'entry:tie-first', 'entry:zero', 'entry:tie-second', 'entry:unknown']);
});

test('busy and denied draft headers expose disabled state and reject retained sorting handlers', t => {
  const controller = session({entries: metricEntries()}), fixture = trackLifecycle();
  t.after(() => {fixture.dispose(); controller.dispose();});
  const previous = fixture.render(controller), oldHeading = fixture.host.querySelector('[data-cdt-sort="play_count"]');
  let tree = fixture.render(controller, {disabled: true});
  const before = controller.getSnapshot();
  const busyPage = hostFor(render(controller, {busy: true}));
  /* D054 */ assert.equal(busyPage.querySelectorAll('[data-cdt-sort]').length, 4);
  /* D055 */ assert.ok(busyPage.querySelectorAll('[data-cdt-sort]').every(button => button.disabled && button.getAttribute('aria-disabled') === 'true'));
  for (const button of fixture.host.querySelectorAll('[data-cdt-sort]')) {
    /* D056 */ assert.equal(button.disabled, true); /* D057 */ assert.equal(button.getAttribute('aria-disabled'), 'true');
    /* D058 */ assert.ok(button.classList.contains('ui-button'), 'disabled styling stays owned by the native Button');
    fixture.emit(button, 'click');
  }
  fixture.emit(oldHeading, 'click');
  tree = fixture.render(controller);
  /* D059 */ assert.deepEqual(rowKeys(fixture.host), before.entries.map(row => row.row_key));
  /* D060 */ assert.ok(fixture.host.querySelectorAll('[data-cdt-sort]').every(button => button.dataset.cdtSortDirection === 'default'));
  controller.setContext({...context(), canCreate: false});
  fixture.render(controller, {disabled: true});
  fixture.emit(oldHeading, 'click');
  /* D061 */ assert.equal(fixture.host.querySelectorAll('[data-playlist-row-key]').length, 0);
  /* D062 */ assert.ok(fixture.host.querySelectorAll('[data-cdt-sort]').every(button => button.disabled));
  /* D063 */ assert.doesNotMatch(fixture.host.innerHTML, /Original unknown|Original high|Original tie-first/);
});

test('unsaved page composes the native Playlist owners, editable metadata, compact Review and explicit unknown facts', () => {
  const controller = session({entries: [entry('a', {title: '<Unknown original>', private_path: '/private/music.flac'}),
    entry('b', {duration_seconds: 0, availability: 'missing', metadata_state: 'current'}), entry('local', {availability: 'local'})]});
  const html = render(controller), host = hostFor(html);
  /* D064 */ assert.ok(host.querySelector('.gallery-bar .home-header__actions')); /* D065 */ assert.match(html, /compact-data-table/);
  /* D066 */ assert.match(html, /album-track-table__title/); /* D067 */ assert.match(html, /album-artbox--empty/);
  /* D068 */ assert.match(html, /&lt;Unknown original&gt;/); /* D069 */ assert.match(html, /Metadata freshness unknown/);
  /* D070 */ assert.match(html, /Availability unknown/); /* D071 */ assert.match(html, /Confirmed missing/); /* D072 */ assert.match(html, /0:00/);
  /* D073 */ assert.equal(host.querySelector('[aria-label="Playlist name"]').disabled, false);
  /* D074 */ assert.equal(host.querySelector('[aria-label="Playlist description"]').disabled, false);
  /* D075 */ assert.equal(action(host, 'save').disabled, true); /* D076 */ assert.equal(action(host, 'export').disabled, false);
  /* D077 */ assert.equal(action(host, 'top').disabled, true); /* D078 */ assert.equal(action(host, 'close').disabled, false);
  /* D079 */ assert.equal(host.querySelectorAll('[data-draft-review]').length, 2);
  /* D080 */ assert.equal(host.querySelectorAll('[data-draft-remove]').length, 2);
  /* D081 */ assert.ok([...host.querySelectorAll('.album-track-table__play')].every(button => button.disabled));
  /* D082 */ assert.equal(host.querySelector('[data-playlist-row-key="entry:a"]').classList.contains('album-track-table__row--missing'), false);
  /* D083 */ assert.equal(host.querySelector('[data-playlist-row-key="entry:b"]').classList.contains('album-track-table__row--missing'), true);
  /* D084 */ assert.doesNotMatch(html, /private\/music|Original local|role="dialog"|<form|data-src=|data-track-path=|playlist_item_id|local-page/);
  controller.dispose();
});

test('real saved directory stays outside the local draft and the standard action order is stable', () => {
  const controller = session(), fixture = pageLifecycle(), directory = fixture.env.document.createElement('aside');
  directory.setAttribute('aria-label', 'Saved playlists'); directory.textContent = 'Existing playlist';
  const host = fixture.render(controller, {directory}), html = host.innerHTML;
  /* D085 */ assert.equal(host.querySelector('.playlists').children.length, 2);
  /* D086 */ assert.match(html, /Existing playlist/);
  const order = ['top', 'export', 'filters', 'save', 'close'].map(name => html.indexOf(`data-playlists-draft-action="${name}"`));
  /* D087 */ assert.ok(order.every((value, index) => value >= 0 && (!index || value > order[index - 1])));
  /* D088 */ assert.deepEqual([...host.querySelectorAll('[data-playlists-draft-action]')].map(button => button.getAttribute('aria-label')),
    ['Create Album Top', 'Export TXT', 'Filters', 'Save', 'Close playlist preview']);
  /* D089 */ assert.ok([...host.querySelectorAll('[data-playlists-draft-action]')].every(button => button.classList.contains('action-button--bare') && button.querySelector('svg')));
  fixture.dispose(); controller.dispose();
});

test('draft Availability choice filters retained originals and rejects an old choice handler after a newer edit', async () => {
  const controller = session(), fixture = pageLifecycle();
  await fixture.command('filters', fixture.render(controller));
  const tree = fixture.render(controller), choice = choiceButton(tree), menu = fixture.openAvailability();
  /* D090 */ assert.equal(menu.getAttribute('aria-label'), 'Availability'); /* D091 */ assert.equal(choice.disabled, false);
  /* D092 */ assert.deepEqual([...menu.querySelectorAll('[data-foobar-format]')].map(option => option.dataset.foobarFormat), ['all', 'local', 'missing', 'unresolved']);
  assert.ok(fixture.env.scrollCalls.some(call => menu.contains(call.target)), 'the actual menu owns focus/nearest scrolling');
  const oldUnresolved = menu.querySelector('[data-foobar-format="unresolved"]');
  fixture.emit(menu.querySelector('[data-foobar-format="missing"]'), 'click');
  /* D093 */ assert.equal(controller.getSnapshot().filters.availability, 'missing');
  const host = fixture.render(controller);
  /* D094 */ assert.equal(host.querySelector('button[aria-label="Availability: Confirmed missing"]').disabled, false);
  /* D095 */ assert.equal(host.querySelectorAll('[data-playlist-row-key]').length, 1);
  /* D096 */ assert.ok(host.querySelector('[data-playlist-row-key="entry:b"]'));
  fixture.emit(oldUnresolved, 'click');
  /* D097 */ assert.equal(controller.getSnapshot().filters.availability, 'missing');
  const locked = choiceButton(fixture.render(controller, {busy: true}));
  /* D098 */ assert.equal(locked.disabled, true);
  fixture.emit(locked, 'click'); fixture.emit(menu.querySelector('[data-foobar-format="all"]'), 'click');
  /* D099 */ assert.equal(controller.getSnapshot().filters.availability, 'missing');
  assert.equal(fixture.env.document.querySelector('[role="menu"][aria-label="Availability"]'), null);
  fixture.dispose(); controller.dispose();
});

test('pre-Save TXT uses retained complete draft order even when filters hide unknown originals and no writer exists', async () => {
  const controller = session(), fixture = pageLifecycle(), downloads = [];
  controller.reorder(['entry:b', 'entry:a']); controller.setQuery('Original b');
  const tree = fixture.render(controller, {runtime: {downloadText: value => downloads.push(value)}});
  await fixture.command('export', tree);
  /* D100 */ assert.equal(downloads.length, 1);
  /* D101 */ assert.equal(downloads[0].text, 'Artist - Original b [Album]\nArtist - Original a [Album]');
  /* D102 */ assert.equal(downloads[0].filename, 'playlist-missing.txt');
  /* D103 */ assert.equal(controller.getSnapshot().mutation.status, 'idle');
  const host = hostFor(render(controller));
  /* D104 */ assert.equal(host.querySelectorAll('[data-playlist-row-key]').length, 1);
  /* D105 */ assert.ok([...host.querySelectorAll('[data-draft-move],[data-playlists-drag]')].every(button => button.disabled));
  /* D106 */ assert.equal(action(host, 'save').disabled, true); /* D107 */ assert.equal(action(host, 'export').disabled, false);
  fixture.dispose(); controller.dispose();
});

test('selection and reorder remain local and retained unknown rows have the same Remove controls', () => {
  const controller = session(); controller.select('entry:a');
  let host = hostFor(render(controller));
  /* D108 */ assert.equal(host.querySelector('[aria-label="Select visible tracks"]').getAttribute('aria-checked'), 'mixed');
  /* D109 */ assert.equal(host.querySelector('[data-draft-pick="entry:a"]').hasAttribute('checked'), true);
  const snapshot = missingPlaylistDraftReorderSnapshot(controller);
  /* D110 */ assert.equal(snapshot.draftToken, 'local-page'); /* D111 */ assert.equal(snapshot.playlistId, undefined);
  /* D112 */ assert.ok(snapshot.rows.every(row => row.playlist_item_id === undefined));
  /* D113 */ assert.equal(snapshot.canReorder, true); /* D114 */ assert.equal(snapshot.unfiltered, true);
  controller.remove(); host = hostFor(render(controller));
  /* D115 */ assert.equal(host.querySelector('[data-playlist-row-key="entry:a"]'), null);
  /* D116 */ assert.equal(host.querySelector('[data-playlist-row-key="entry:b"] [data-draft-remove]').disabled, false);
  /* D117 */ assert.equal(controller.getSnapshot().mutation.status, 'idle'); controller.dispose();
});

test('draft highlight gestures preserve retained tracks, checkbox selection and the separate review target', t => {
  const controller = session({entries: [entry('a'), entry('b'), entry('c')]}), fixture = trackLifecycle(), reviews = [];
  t.after(() => {fixture.dispose(); controller.dispose();});
  const extra = {onReview: key => reviews.push(key)};
  const row = key => fixture.host.querySelector(`[data-playlist-row-key="entry:${key}"]`);
  const highlighted = () => fixture.host.querySelectorAll('[data-playlist-row-key][aria-selected="true"]').map(node => node.dataset.playlistRowKey);
  const original = controller.getSnapshot(), text = controller.exportText();
  let tree = fixture.render(controller, extra); const first = row('a');
  fixture.emit(first, 'click'); tree = fixture.render(controller, {...extra, reviewKey: 'entry:a'});
  /* D118 */ assert.equal(row('a'), first); /* D119 */ assert.deepEqual(highlighted(), ['entry:a']); /* D120 */ assert.deepEqual(reviews, ['entry:a']);
  fixture.emit(row('b'), 'click', {ctrlKey: true}); tree = fixture.render(controller, extra);
  /* D121 */ assert.deepEqual(highlighted(), ['entry:a', 'entry:b']); /* D122 */ assert.deepEqual(reviews, ['entry:a']);
  /* D123 */ assert.equal(fixture.emit(row('a'), 'contextmenu').defaultPrevented, true); tree = fixture.render(controller, extra);
  /* D124 */ assert.deepEqual(highlighted(), ['entry:a', 'entry:b']);
  /* D125 */ assert.match([...fixture.root.querySelectorAll('[role="status"]')].find(node => node.textContent.includes('Add to playlist'))?.textContent || '', /unsaved source tracks/);
  fixture.emit(row('a'), 'click', {metaKey: true}); tree = fixture.render(controller, extra);
  /* D126 */ assert.deepEqual(highlighted(), ['entry:b']);
  fixture.emit(row('c'), 'contextmenu'); tree = fixture.render(controller, extra); /* D127 */ assert.deepEqual(highlighted(), ['entry:c']);
  fixture.emit(row('a'), 'keydown', {key: ' ', ctrlKey: true}); tree = fixture.render(controller, extra);
  /* D128 */ assert.deepEqual(highlighted(), ['entry:a', 'entry:c']); /* D129 */ assert.deepEqual(reviews, ['entry:a']);
  fixture.emit(row('a'), 'dblclick'); fixture.emit(row('a'), 'keydown', {key: 'Enter', ctrlKey: true});
  /* D130 */ assert.equal(controller.getSnapshot(), original); /* D131 */ assert.equal(controller.exportText(), text);
  /* D132 */ assert.equal(selectionStatus(fixture), '2 rows selected');
  const checkbox = row('b').querySelector('[data-draft-pick]');
  fixture.emit(checkbox, 'change'); tree = fixture.render(controller, extra);
  /* D133 */ assert.deepEqual(controller.getSnapshot().selectedKeys, ['entry:b']); /* D134 */ assert.deepEqual(highlighted(), ['entry:a', 'entry:c']);
  const review = row('b').querySelector('[data-draft-review]');
  fixture.emit(review, 'click');
  /* D135 */ assert.deepEqual(reviews, ['entry:a', 'entry:b']); /* D136 */ assert.deepEqual(highlighted(), ['entry:a', 'entry:c']);
  /* D137 */ assert.deepEqual(controller.getSnapshot().entries, original.entries); /* D138 */ assert.equal(controller.getSnapshot().dirty, false);
  const html = render(controller), output = hostFor(html);
  /* D139 */ assert.equal([...output.querySelectorAll('button')].find(button => button.textContent === 'Add to playlist').disabled, true);
  /* D140 */ assert.doesNotMatch(html, /data-track-path=|data-src=|data-play-track=/);
});

test('draft highlight follows displayed rows across sort and filter and clears on access retirement', t => {
  const controller = session({entries: [entry('a', {play_count: 9}), entry('b', {play_count: 1})]}), fixture = trackLifecycle();
  t.after(() => {fixture.dispose(); controller.dispose();});
  let tree = fixture.render(controller);
  const row = key => fixture.host.querySelector(`[data-playlist-row-key="entry:${key}"]`);
  fixture.emit(row('a'), 'click'); fixture.render(controller);
  fixture.emit(row('b'), 'click', {metaKey: true}); tree = fixture.render(controller);
  fixture.emit(fixture.host.querySelector('[data-cdt-sort="play_count"]'), 'click');
  tree = fixture.render(controller);
  /* D141 */ assert.deepEqual(rowKeys(fixture.host), ['entry:b', 'entry:a']);
  /* D142 */ assert.equal(fixture.host.querySelectorAll('[data-playlist-row-key][aria-selected="true"]').length, 2);
  controller.setQuery('Original a'); fixture.render(controller); tree = fixture.render(controller);
  const selection = selectionStatus(fixture);
  /* D143 */ assert.match(selection, /^1 row selected/); /* D144 */ assert.match(selection, / · 1 no longer visible or selectable$/);
  controller.setContext({...context(), canCreate: false});
  /* D145 */ assert.equal(fixture.host.querySelectorAll('[data-playlist-row-key][aria-selected="true"]').length, 0);
  /* D146 */ assert.equal(fixture.emit(row('a'), 'contextmenu').defaultPrevented, false);
  /* D147 */ assert.deepEqual(controller.getSnapshot().selectedKeys, []);
});

test('native row handlers remove and reorder local row keys, reject stale renders and detach after native return', () => {
  const controller = session(), fixture = trackLifecycle();
  fixture.render(controller); const host = fixture.host;
  const move = host.querySelector('[data-playlist-row-key="entry:a"] [data-draft-move="down"]');
  const oldRemove = host.querySelector('[data-draft-remove="entry:b"]');
  fixture.emit(move, 'click');
  /* D148 */ assert.deepEqual(controller.getSnapshot().entries.map(row => row.row_key), ['entry:b', 'entry:a']);
  // Withhold update once: the still-mounted DOM may not mutate a newer snapshot.
  fixture.emit(oldRemove, 'click'); assert.equal(controller.getSnapshot().entries.length, 2);
  fixture.render(controller);
  const remove = fixture.host.querySelector('[data-draft-remove="entry:b"]');
  assert.equal(oldRemove.isConnected, false, 'the previous table render is retired');
  fixture.emit(oldRemove, 'click'); /* D149 */ assert.equal(controller.getSnapshot().entries.length, 2);
  fixture.emit(remove, 'click'); /* D150 */ assert.equal(controller.getSnapshot().entries.length, 1);
  fixture.render(controller); const last = fixture.host.querySelector('[data-draft-remove="entry:a"]');
  fixture.dispose(); fixture.emit(last, 'click');
  /* D151 */ assert.equal(controller.getSnapshot().entries.length, 1); /* D152 */ assert.equal(fixture.lateMutations(), 0);
  /* D153 */ assert.equal(host.listeners.length, 0); /* D154 */ assert.equal(controller.getSnapshot().mutation.status, 'idle'); controller.dispose();
});

test('Top opens only with exact current authorized parents and a configured opener, without saving', async () => {
  let writes = 0; const opened = [], controller = session({writer: request => {writes++; return acknowledged(request);}}), fixture = pageLifecycle();
  /* D155 */ assert.equal(action(hostFor(render(controller)), 'top').disabled, true);
  let tree = fixture.render(controller, {onTop: intent => opened.push(intent)});
  /* D156 */ assert.equal(action(tree, 'top').disabled, false);
  await fixture.command('top', tree);
  /* D157 */ assert.deepEqual(opened, [{scopeKey: 'draft-components:actor', source: {kind: 'playlist', ref: 'draft-components:source', revision: 'original-revision'}, album_refs: ['exact-parent']}]);
  /* D158 */ assert.equal(writes, 0); /* D159 */ assert.equal(controller.getSnapshot().mutation.status, 'idle');
  controller.setContext({...context(), canCreateAlbumTop: false});
  tree = fixture.render(controller, {onTop: intent => opened.push(intent)});
  /* D160 */ assert.equal(action(tree, 'top').disabled, true); await fixture.command('top', tree); /* D161 */ assert.equal(opened.length, 1);
  fixture.dispose(); controller.dispose();
});

test('Close delegates native discard ownership with no local disposal, save or selection loss', async () => {
  let writes = 0; const closes = [], controller = session({writer: request => {writes++; return acknowledged(request);}}), fixture = pageLifecycle();
  controller.edit({title: 'Keep typed title'}); controller.reorder(['entry:b', 'entry:a']); controller.select('entry:a');
  const before = controller.getSnapshot(), tree = fixture.render(controller, {onClose: value => closes.push(value)});
  await fixture.command('close', tree);
  /* D162 */ assert.equal(closes.length, 1); /* D163 */ assert.equal(closes[0].reason, 'discard'); /* D164 */ assert.equal(closes[0].restoreFocusRequested, true);
  /* D165 */ assert.equal(controller.getSnapshot(), before); /* D166 */ assert.equal(writes, 0);
  fixture.dispose(); controller.dispose();
});

test('Save rejects duplicate clicks and reports only the exact real acknowledgement to native navigation', async () => {
  const write = deferred(), requests = [], saved = [], controller = session({writer: request => {requests.push(request); return write.promise;}});
  const fixture = pageLifecycle(), tree = fixture.render(controller, {onSaved: value => saved.push(value)});
  const first = fixture.command('save', tree), second = fixture.command('save', tree);
  /* D167 */ assert.equal(requests.length, 1); /* D168 */ assert.equal(saved.length, 0);
  assert.equal(action(tree, 'save').disabled, true);
  assert.equal(action(tree, 'close').disabled, true);
  assert.equal(tree.querySelector('[aria-label="Playlist name"]').disabled, true);
  const host = hostFor(render(controller));
  /* D169 */ assert.equal(action(host, 'save').disabled, true); /* D170 */ assert.equal(action(host, 'close').disabled, true);
  /* D171 */ assert.equal(host.querySelector('[aria-label="Playlist name"]').disabled, true);
  write.resolve(acknowledged(requests[0])); await Promise.all([first, second]);
  /* D172 */ assert.deepEqual(saved, [acknowledged(requests[0]).data]);
  /* D173 */ assert.equal(saved[0].playlist_id, 'persisted-playlist'); /* D174 */ assert.equal(requests[0].playlist_id, null);
  /* D175 */ assert.equal(requests[0].draftToken, undefined); /* D176 */ assert.deepEqual(requests[0].entry_refs, ['a', 'b']);
  const complete = fixture.render(controller); await fixture.command('save', complete); /* D177 */ assert.equal(requests.length, 1);
  fixture.dispose(); controller.dispose();
});

test('saved-but-not-opened completion is explicit and never retries the writer', async () => {
  let writes = 0; const controller = session({writer: request => {writes++; return acknowledged(request);}}), fixture = pageLifecycle();
  const tree = fixture.render(controller, {onSaved: () => false}); await fixture.command('save', tree);
  const complete = fixture.render(controller, {onSaved: () => false});
  const messages = [...complete.querySelectorAll('[role="status"]')].map(node => node.textContent).join('\n');
  /* D178 */ assert.match(messages, /Playlist saved, but it could not be opened/);
  await fixture.command('save', complete); /* D179 */ assert.equal(writes, 1);
  fixture.dispose(); controller.dispose();
});

test('stale rendered commands cannot export, save, close or open Top after a newer edit', async () => {
  const calls = [], controller = session({writer: request => {calls.push('save'); return acknowledged(request);}}), fixture = pageLifecycle();
  const tree = fixture.render(controller, {runtime: {downloadText: () => calls.push('export')},
    onTop: () => calls.push('top'), onClose: () => calls.push('close')});
  controller.edit({description: 'A newer render owns the next action'});
  for (const command of ['save', 'export', 'top', 'close']) await fixture.command(command, tree);
  /* D180 */ assert.deepEqual(calls, []); fixture.dispose(); controller.dispose();
});

test('a new draft controller rejects old page handlers even when the old controller still has its unchanged snapshot', async () => {
  const calls = [], previous = session({writer: request => {calls.push('save'); return acknowledged(request);}});
  const current = session({token: 'new-local-page'}), fixture = pageLifecycle();
  const tree = fixture.render(previous, {runtime: {downloadText: () => calls.push('export')},
    onTop: () => calls.push('top'), onClose: () => calls.push('close')});
  const controls = ['save', 'export', 'top', 'close'].map(command => action(tree, command));
  const name = tree.querySelector('[aria-label="Playlist name"]'), oldSnapshot = previous.getSnapshot();
  // native.mjs keys show('draft', owner, ...) by the draft owner identity and
  // disposes the old page before mounting its replacement. Exercise that actual
  // ownership boundary; a retained live button otherwise belongs to its new UI.
  fixture.dispose(); const replacement = pageLifecycle(); replacement.render(current);
  for (const control of controls) fixture.emit(control, 'click');
  fixture.input(name, 'Stale name'); await settle();
  /* D181 */ assert.deepEqual(calls, []); /* D182 */ assert.equal(previous.getSnapshot().title, 'Missing originals');
  assert.equal(previous.getSnapshot(), oldSnapshot);
  assert.equal(current.getSnapshot().title, 'Missing originals');
  replacement.dispose(); previous.dispose(); current.dispose();
});

test('pending native Close blocks duplicate confirmations and cancellation keeps the full draft', async () => {
  const controller = session(), fixture = pageLifecycle(), confirmation = deferred(); let closes = 0;
  const before = controller.getSnapshot();
  const tree = fixture.render(controller, {onClose: () => {closes++; return confirmation.promise;}});
  const first = fixture.command('close', tree), second = fixture.command('close', tree);
  const name = tree.querySelector('[aria-label="Playlist name"]');
  fixture.input(name, 'Attempt during confirmation');
  /* D183 */ assert.equal(closes, 1); confirmation.resolve(false); await Promise.all([first, second]);
  /* D184 */ assert.equal(controller.getSnapshot(), before);
  const ready = fixture.render(controller); /* D185 */ assert.equal(ready.querySelector('main').getAttribute('aria-busy'), 'false');
  fixture.dispose(); controller.dispose();
});

test('parent busy and replaced Top callbacks invalidate retained handlers without changing the source snapshot', async () => {
  const calls = [], controller = session({writer: request => {calls.push('save'); return acknowledged(request);}}), fixture = pageLifecycle();
  const top = () => calls.push('top'), close = () => calls.push('close');
  const tree = fixture.render(controller, {onTop: top, onClose: close});
  fixture.render(controller, {onTop: top, onClose: close, busy: true});
  await fixture.command('save', tree); await fixture.command('close', tree);
  const name = tree.querySelector('[aria-label="Playlist name"]');
  fixture.input(name, 'Attempt during native navigation');
  /* D186 */ assert.equal(controller.getSnapshot().title, 'Missing originals');
  fixture.render(controller, {onClose: close}); await fixture.command('top', tree);
  /* D187 */ assert.deepEqual(calls, []); fixture.dispose(); controller.dispose();
});

test('revocation clears readable facts and old save continuations cannot navigate the newer page', async () => {
  const write = deferred(), saved = [], controller = session({writer: () => write.promise}), fixture = pageLifecycle();
  const tree = fixture.render(controller, {onSaved: value => saved.push(value)}), pending = fixture.command('save', tree);
  controller.setContext({...context(), canCreate: false});
  fixture.render(controller, {onSaved: value => saved.push(value)});
  const html = render(controller); /* D188 */ assert.doesNotMatch(html, /Original a|Original b|Typed description/); /* D189 */ assert.match(html, /permission/);
  write.resolve({status: 'ready', data: {scopeKey: 'draft-components:actor', request_key: 'old', playlist_id: 'old', revision: 'old'}});
  await pending; /* D190 */ assert.deepEqual(saved, []);
  fixture.dispose(); controller.dispose();
});

test('unmounted page ignores pending Save and TXT failures without late UI updates', async () => {
  for (const kind of ['save', 'export']) {
    const operation = deferred(), saved = [], controller = session({writer: () => operation.promise}), fixture = pageLifecycle();
    const tree = fixture.render(controller, {runtime: {downloadText: () => operation.promise}, onSaved: value => saved.push(value)});
    const pending = fixture.command(kind, tree); fixture.dispose();
    operation.reject(new Error('late response')); await pending;
    /* D191 */ assert.equal(fixture.lateMutations(), 0); /* D192 */ assert.deepEqual(saved, []); controller.dispose();
  }
});

test('Review is the normal read-only information panel; unknown original identity is never a matching or player key', () => {
  const controller = session(), fixture = pageLifecycle();
  let tree = fixture.render(controller);
  fixture.emit(tree.querySelector('[data-draft-review="entry:a"]'), 'click');
  tree = fixture.render(controller);
  const panel = tree.querySelector('[aria-label="Selected playlist item"]');
  assert.ok(panel.querySelector('[aria-label="Track information"]'), 'the actual information-panel owner is mounted');
  // The same production adapter supplies the panel; no child component props or
  // fabricated persistence identity stand in for the delivered native boundary.
  const state = controller.getSnapshot(), row = creationReviewRow(state.entries.find(row => row.row_key === 'entry:a'), state.source);
  /* D193 */ assert.equal(row.album_ref, 'exact-parent'); /* D194 */ assert.equal(row.playlist_item_id, undefined);
  /* D195 */ assert.equal(row.entry_ref, undefined); /* D196 */ assert.equal(row.canonical_track_ref, undefined);
  const markup = tree.innerHTML; /* D197 */ assert.match(markup, /Track information/); /* D198 */ assert.match(markup, /Local matching unavailable/);
  /* D199 */ assert.doesNotMatch(markup, /Accept selected local match|data-src=|data-track-path=/);
  controller.setQuery('Original b'); tree = fixture.render(controller);
  /* D200 */ assert.equal(tree.querySelector('[aria-label="Track information"]'), null);
  assert.equal(panel.childNodes.length, 0, 'the previous information owner is disposed');
  fixture.dispose(); controller.dispose();
});

test('rendering a source row uses only safe display facts and source-free native markup', () => {
  const controller = session(), state = controller.getSnapshot(), passed = [];
  missingPlaylistDraftTableHtml({...runtime, albumTrackRow: (row, index) => {passed.push(row); return runtime.albumTrackRow(row, index);}},
    {id: 'draft-safe', state, projection: draft.projectMissingPlaylistDraft(state)});
  /* D201 */ assert.ok(passed.length > 0);
  /* D202 */ assert.ok(passed.every(row => Object.keys(row).sort().join(',') === 'availability,duration_display,secondary_artist,title'));
  const source = fs.readFileSync(path.join(repo, 'music_app/static/js/playlists/native-draft.mjs'), 'utf8');
  /* D203 */ assert.doesNotMatch(source, /createPlaylistIntegrations|trackIntent\(|acceptMatch\(|createAlbumTop\(|localStorage|sessionStorage|indexedDB|fetch\(/);
  controller.dispose();
});


test('draft filter opening retires across real paused authority and refresh while its values remain', async () => {
  const response = () => ({status: 'ready', data: {...context(), entries_complete: true,
    allowed_actions: {can_read: true, can_use_for_playlist: true}, entries: [entry('a'), entry('b')], retained_parent_albums: []}});
  const controller = session({reader: async () => response()}), fixture = pageLifecycle();
  await fixture.command('filters', fixture.render(controller));
  let tree = fixture.render(controller);
  /* D204 */ assert.ok(filterSurface(tree));
  controller.setQuery('Original'); controller.setFilters({love: 'loved'});
  /* D205 */ assert.ok(filterSurface(fixture.render(controller)));
  const token = controller.getSnapshot().draftToken;
  controller.pauseSource('error');
  /* D206 */ assert.equal(filterSurface(fixture.render(controller)), null);
  controller.setContext(context()); /* D207 */ assert.equal(await controller.refresh(), true);
  /* D208 */ assert.equal(controller.getSnapshot().draftToken, token);
  /* D209 */ assert.equal(controller.getSnapshot().query, 'Original');
  /* D210 */ assert.equal(controller.getSnapshot().filters.love, 'loved');
  /* D211 */ assert.equal(filterSurface(fixture.render(controller)), null);
  await fixture.command('filters', fixture.render(controller));
  tree = fixture.render(controller); /* D212 */ assert.ok(filterSurface(tree));
  const staleChoice = fixture.openAvailability(tree).querySelector('[data-foobar-format="missing"]');
  // Loading and ready both publish before the next explicit native owner update.
  /* D213 */ assert.equal(await controller.refresh(), true);
  /* D214 */ assert.equal(filterSurface(fixture.render(controller)), null);
  fixture.emit(staleChoice, 'click'); /* D215 */ assert.equal(controller.getSnapshot().filters.availability, 'all');
  fixture.dispose(); controller.dispose();
});

test('a retired draft filter close cannot dismiss a new opening and unmount invalidates changes', async () => {
  const controller = session(), fixture = pageLifecycle();
  await fixture.command('filters', fixture.render(controller));
  let tree = fixture.render(controller), oldSurface = filterSurface(tree);
  fixture.emit(oldSurface, 'keydown', {key: 'Escape'}); fixture.render(controller);
  assert.equal(oldSurface.isConnected, false);
  await fixture.command('filters', fixture.render(controller));
  tree = fixture.render(controller); const currentSurface = filterSurface(tree);
  fixture.emit(oldSurface, 'keydown', {key: 'Escape'});
  /* D216 */ assert.equal(filterSurface(fixture.render(controller)), currentSurface);
  const staleChoice = fixture.openAvailability(tree).querySelector('[data-foobar-format="missing"]'); fixture.dispose();
  fixture.emit(staleChoice, 'click'); /* D217 */ assert.equal(controller.getSnapshot().filters.availability, 'all');
  controller.dispose();
});

// Append after the corrected native draft migration, preserving all its tests.
test('builder sort cancellation preserves row-action suppression and repeated metric cycles', t => {
  const controller = session({entries: metricEntries()}), fixture = trackLifecycle({gestures: true});
  t.after(() => {fixture.dispose(); controller.dispose();});
  fixture.render(controller);
  const before = controller.getSnapshot(), first = fixture.host.querySelector('[data-playlists-drag]');
  fixture.emit(first, 'pointerdown'); fixture.emit(fixture.env.document, 'pointermove', {clientY: 200}); fixture.frame();
  const remove = fixture.host.querySelector('[data-draft-remove]');
  assert.equal(fixture.emit(remove, 'click').defaultPrevented, true);
  assert.equal(controller.getSnapshot(), before);
  assert.equal(fixture.host.classList.contains('is-reordering'), true);
  fixture.host.querySelector('[data-cdt-sort="play_count"]').focus();
  fixture.emit(fixture.host.querySelector('[data-cdt-sort="play_count"]'), 'click');
  assert.equal(fixture.host.classList.contains('is-reordering'), false);
  assert.equal(fixture.host.querySelector('.playlists__reorder-ghost'), null);
  assert.equal(fixture.frames.size, 0);
  assert.deepEqual(fixture.env.document.listeners, fixture.baselineDocumentListeners);
  assert.equal(fixture.env.document.activeElement.dataset.cdtSort, 'play_count');
  assert.deepEqual(rowKeys(fixture.host), ['entry:zero', 'entry:tie-first', 'entry:tie-second', 'entry:high', 'entry:unknown']);
  assert.equal(fixture.emit(fixture.host.querySelector('[data-draft-remove]'), 'click').defaultPrevented, true);
  assert.equal(controller.getSnapshot(), before);
  fixture.emit(fixture.host.querySelector('[data-cdt-sort="play_count"]'), 'click');
  fixture.emit(fixture.host.querySelector('[data-cdt-sort="play_count"]'), 'click');
  assert.deepEqual(rowKeys(fixture.host), before.entries.map(row => row.row_key));
  assert.equal(controller.getSnapshot(), before);
});

test('builder canonical draft cache preserves focused highlight and status semantics', t => {
  const controller = session(), fixture = trackLifecycle();
  t.after(() => {fixture.dispose(); controller.dispose();});
  fixture.render(controller);
  const first = fixture.host.querySelector('[data-playlist-row-key]');
  first.focus(); fixture.emit(first, 'click');
  assert.equal(first.getAttribute('aria-selected'), 'true');
  fixture.render(controller); fixture.render(controller);
  assert.equal(fixture.host.querySelector('[data-playlist-row-key]'), first);
  assert.equal(fixture.env.document.activeElement, first);
  assert.equal(first.getAttribute('aria-selected'), 'true');
  assert.ok([...fixture.root.querySelectorAll('[role="status"]')].some(node => /Add to playlist.*unsaved source tracks/.test(node.textContent)));
});

test('builder draft cache rejects a renderer reentry superseded by disabled state', t => {
  const controller = session(), fixture = trackLifecycle();
  t.after(() => {fixture.dispose(); controller.dispose();});
  let reenter = false;
  const guardedRuntime = {tableHtml(options) {
    const html = fixture.env.runtime.tableHtml(options);
    if (reenter) {reenter = false; fixture.render(controller, {disabled: true});}
    return html;
  }};
  fixture.render(controller, {runtime: guardedRuntime});
  reenter = true; fixture.render(controller);
  const first = fixture.host.querySelector('[data-playlist-row-key]');
  assert.equal(first.querySelector('[data-draft-pick]').disabled, true);
  fixture.render(controller, {disabled: true});
  assert.equal(fixture.host.querySelector('[data-playlist-row-key]'), first);
  assert.equal(first.querySelector('[data-draft-pick]').disabled, true);
});
