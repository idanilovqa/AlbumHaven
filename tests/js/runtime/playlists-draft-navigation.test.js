const {installPrivateContext, STAMP} = require('./private-context-harness.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');

const root = path.resolve(__dirname, '../../../music_app/static/js');
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
const settle = async () => {for (let i = 0; i < 12; i++) await Promise.resolve();};

function harness() {
  const native = createNativeHomeRuntime(), {context, document} = native;
  const add = (id, attribute) => {
    const node = document.createElement('div'); if (id) node.id = id;
    if (attribute) node.setAttribute(attribute, ''); document.body.appendChild(node); return node;
  };
  const shell = add('app-shell'); shell.dataset.privateUiContext = 'a'.repeat(64); shell.dataset.nativeAccountId = 'account:one'; shell.dataset.nativeLibraryId = 'library:one';
  add('playlists-root'); add('shell-main-surface'); add('mobile-home');
  const settings = add(null, 'data-settings-host'); settings.hidden = true;
  add(null, 'data-settings-outlet'); add(null, 'data-settings-nav');
  const location = new URL('https://albumhaven.test/?surface=playlists&playlist_id=source');
  const entries = [{url: location.href, state: {albumHavenNavigationPosition: 0}}], listeners = [];
  let index = 0;
  const calls = {fetch: [], gallery: 0, discard: 0, confirm: 0};
  const dispatch = () => {
    const event = {state: entries[index].state, stopped: false, stopImmediatePropagation() {this.stopped = true;}};
    for (const capture of [true, false]) for (const listener of listeners.filter(value => value.name === 'popstate' && value.capture === capture)) {
      if (!event.stopped) listener.callback(event);
    }
    if (!event.stopped) context.handleGalleryBootstrapPopState();
  };
  const history = {
    get state() {return entries[index].state;},
    pushState(value, title, url) {location.href = new URL(url, location).href; entries.splice(++index, Infinity, {url: location.href, state: structuredClone(value)});},
    replaceState(value, title, url) {location.href = new URL(url || location.href, location).href; entries[index] = {url: location.href, state: structuredClone(value)};},
    go(delta) {queueMicrotask(() => {if (index + delta < 0 || index + delta >= entries.length) return; index += delta; location.href = entries[index].url; dispatch();});},
  };
  const view = {context_ref: 'a'.repeat(64), surface: {active: 'playlists'}, playlist_sidebar: {active_playlist_id: 'source', items: []},
    playlist_detail: {playlist_id: 'source', title: 'Real source', track_rows: []}};
  Object.assign(context, {URL, URLSearchParams, AbortController, location, history, innerWidth: 1200,
    state: {view, ui: {}}, AlbumHavenHomeRuntime: {}, DOMParser: class {},
    addEventListener: (name, callback, capture = false) => listeners.push({name, callback, capture: capture === true}),
    removeEventListener() {}, dispatchEvent() {},
    fetch: (...args) => {calls.fetch.push(args); return Promise.reject(new Error('No transport expected'));},
    buildUrl: value => value.url || '/?artist=Retained',
    NavigationTree: {setSelection() {}},
  });
  installPrivateContext(context);
  for (const file of ['runtime/mobile-home.js', 'settings-navigation.js', 'runtime/mobile-navigation.js', 'runtime/browser-navigation-helpers.js',
    'runtime/gallery-refresh-and-status.js', 'runtime/bootstrap-gallery-event-handlers.js', 'runtime/track-actions.js', 'runtime/playlists-react-bridge.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, {filename: file});
  }
  const nativePop = context.handleGalleryBootstrapPopState;
  context.handleMobilePagePopState = () => false;
  context.handleGalleryBootstrapPopState = () => {
    calls.gallery++;
    if (context.AlbumHavenPlaylistRuntime.restoreDraftFromHistory()) return;
    context.syncMobileHome();
  };
  const runtime = context.AlbumHavenPlaylistRuntime, navigation = context.AlbumHavenSettingsNavigation.instance;
  let current = true, decision = true;
  const open = () => runtime.openDraft({token: 'draft:one', scopeKey: runtime.snapshot().scopeKey,
    isCurrent: () => current, confirmLeave: () => {calls.confirm++; return decision;}, onDiscard: () => {calls.discard++; current = false;}});
  return {...native, runtime, navigation, shell, settings, location, history, entries, view, calls, open, nativePop,
    decision(value) {decision = value;}, invalidate() {current = false;}, index: () => index};
}

test('draft entry is native opaque UI ownership only and never writes or alters the source DTO', () => {
  const h = harness(), original = h.context.state.view;
  assert.equal(h.open(), true);
  assert.deepEqual(Object.keys(h.history.state).sort(), ['albumHavenNavigationPosition', 'playlistDraft']);
  assert.deepEqual(plain(h.history.state.playlistDraft), {token: 'draft:one', scopeKey: h.runtime.snapshot().scopeKey});
  assert.equal(h.location.search, '?surface=playlists');
  assert.equal(h.runtime.snapshot().draftToken, 'draft:one');
  assert.equal(h.runtime.snapshot().playlistId, null);
  assert.strictEqual(h.context.state.view, original);
  assert.doesNotMatch(JSON.stringify(h.history.state), /playlist_id|entries|source|title|description/);
  assert.equal(h.open(), false);
  assert.equal(h.calls.fetch.length, 0);
});

test('native modal and direct gallery requests ask Discard before touching their destination', async () => {
  const h = harness(); h.open(); h.decision(false);
  let opened = 0;
  assert.equal(await h.context.deferAppFormPageReplacement(() => {opened++;}), false);
  assert.equal(await h.context.fetchAndRender('/view-data?surface=home', true), false);
  assert.equal(opened, 0); assert.equal(h.calls.fetch.length, 0); assert.equal(h.calls.discard, 0);
  assert.equal(h.runtime.snapshot().draftToken, 'draft:one');
  h.decision(true);
  await h.context.deferAppFormPageReplacement(() => {opened++;});
  assert.equal(opened, 1); assert.equal(h.calls.discard, 1);
});

test('Settings navigation asks Discard and does not start its fetch when declined', async () => {
  const h = harness(); h.open(); h.decision(false);
  assert.equal(await h.navigation.navigate('/account'), false);
  assert.equal(h.calls.fetch.length, 0); assert.equal(h.calls.discard, 0);
  assert.equal(h.settings.hidden, true); assert.equal(h.runtime.snapshot().draftToken, 'draft:one');
});

test('Back cancellation restores the exact native draft entry, then Discard prevents Forward resurrection', async () => {
  const h = harness(); h.open(); h.decision(false);
  h.history.go(-1); await settle();
  assert.equal(h.index(), 1); assert.equal(h.runtime.snapshot().draftToken, 'draft:one');
  assert.equal(h.calls.discard, 0);
  h.decision(true); h.history.go(-1); await settle();
  assert.equal(h.index(), 0); assert.equal(h.calls.discard, 1);
  h.history.go(1); await settle();
  assert.equal(h.history.state.playlistDraft, undefined);
  assert.equal(h.runtime.snapshot().draftToken, null); assert.equal(h.calls.discard, 1);
});

test('retained native Album/Artist/Top navigation preserves the owner through Back and Forward', async () => {
  const h = harness(); h.open();
  const draftEntry = plain(h.history.state);
  h.runtime.retainDraft('draft:one', () => {
    assert.equal(h.context.deferAppFormPageReplacement(() => {throw new Error('Retained child was replayed');}), false);
    assert.equal(h.context.pushBrowserViewState({url: '/?artist=Retained', privateSource: 'must not enter history'}), undefined,
      'retained navigation preserves the native successful void return');
  });
  h.context.state.view = {surface: {active: 'albums'}};
  assert.equal(h.runtime.sync().visible, false);
  assert.deepEqual(plain(h.history.state.playlistDraft), draftEntry.playlistDraft);
  assert.doesNotMatch(JSON.stringify(h.history.state), /privateSource/);
  h.history.go(-1); await settle();
  assert.equal(h.runtime.snapshot().draftToken, 'draft:one'); assert.equal(h.runtime.snapshot().visible, true);
  h.nativePop(); // The actual gallery pop owner must not fetch over the live page.
  h.history.go(1); await settle();
  assert.equal(h.runtime.snapshot().retainedDraftToken, 'draft:one');
  assert.equal(h.calls.confirm, 0); assert.equal(h.calls.discard, 0); assert.equal(h.calls.fetch.length, 0);
});

test('a delayed leave confirmation cannot replay over a later native destination', async () => {
  const h = harness(), answer = deferred(); h.open(); h.decision(answer.promise);
  let destination = 0;
  const leaving = h.navigation.deferPlaylistDraftNavigation(() => {destination++;});
  await settle();
  h.navigation.pushLibraryHistory('/?artist=Newer', {});
  answer.resolve(true); await leaving;
  assert.equal(destination, 0); assert.equal(h.calls.discard, 0);
});

test('actor, library and provider invalidation erase ownership without waiting for Discard', async () => {
  for (const invalidate of [h => {h.shell.dataset.nativeAccountId = 'account:two';},
    h => {h.shell.dataset.nativeLibraryId = 'library:two';}, h => h.invalidate()]) {
    const h = harness(), answer = deferred(); h.open(); h.decision(answer.promise);
    let destination = 0;
    const leaving = h.navigation.deferPlaylistDraftNavigation(() => {destination++;});
    await settle(); invalidate(h); h.runtime.sync();
    assert.equal(h.calls.discard, 1); assert.equal(h.runtime.snapshot().retainedDraftToken, null);
    answer.resolve(true); await leaving;
    assert.equal(destination, 0);
    h.history.go(-1); await settle(); h.history.go(1); await settle();
    assert.equal(h.runtime.snapshot().draftToken, null);
  }
});

test('Close uses the retained native parent and clears the draft once', async () => {
  const h = harness(); h.open();
  assert.equal(await h.runtime.closeDraft('draft:one'), true); await settle();
  assert.equal(h.index(), 0); assert.equal(h.calls.discard, 1);
  assert.equal(await h.runtime.closeDraft('draft:one'), false);
});

test('persisted navigation acquires its request ownership after the draft dismissal settles', async () => {
  const h = harness(); h.open();
  const target = {context_ref: STAMP, surface: {active: 'playlists'}, playlist_sidebar: {active_playlist_id: 'saved:one',
    items: [{playlist_id: 'saved:one', allowed_actions: {can_open: true}}]},
    playlist_detail: {playlist_id: 'saved:one', title: 'Saved', track_rows: []}};
  h.context.fetchAndRender = async (url, push, options) => {
    assert.equal(h.calls.discard, 1, 'no native request starts until departure is confirmed');
    h.context.state.ui.activeViewRequestId = 17;
    await Promise.resolve();
    assert.equal(options.shouldApplyResponse(target), true);
    h.context.state.view = target;
    h.navigation.pushLibraryHistory('/?surface=playlists&playlist_id=saved%3Aone', {});
    return true;
  };
  await h.runtime.navigate({playlist_id: 'saved:one'});
  assert.equal(h.runtime.snapshot().playlistId, 'saved:one');
  assert.equal(h.runtime.snapshot().draftToken, null);
});

test('opening and restoring a draft invalidate older native view responses', () => {
  const h = harness(); let aborted = 0;
  h.context.state.ui.activeViewRequestController = {abort() {aborted++;}};
  h.context.state.ui.viewStateRevision = 4;
  h.open();
  assert.equal(aborted, 1); assert.equal(h.context.state.ui.viewStateRevision, 5);
  h.nativePop();
  assert.equal(aborted, 2); assert.equal(h.calls.fetch.length, 0);
});

// Native entry owns controller, view, draft, subscriptions and teardown.
// The runtime boundary below supplies shell navigation acknowledgements only.
async function mountHarness(t, readPlaylists, providers, payload) {
  const {sessionDom, settle: nativeSettle} = require('./playlist-native-session-migration-fixture.cjs');
  const {mountPlaylists} = await import('../../../music_app/static/js/playlists/native.mjs');
  const h = sessionDom(), subscribers = new Set(), calls = {navigate: 0, released: 0}, downloads = [];
  let owner = null;
  let shell = {visible: true, authenticated: true, scopeKey: 'mount:actor', payload, playlistId: 'source:mount', entryKey: 1,
    draftToken: null, retainedDraftToken: null};
  const emit = () => {for (const listener of [...subscribers]) listener();};
  Object.assign(h.runtime, {snapshot: () => shell, subscribe: callback => {subscribers.add(callback); return () => subscribers.delete(callback);}, readPlaylists,
    openDraft(value) {owner = value; shell = {...shell, visible: true, playlistId: null, draftToken: value.token, retainedDraftToken: value.token}; emit(); return true;},
    releaseDraft(token) {
      if (!owner || owner.token !== token) return false;
      const current = owner; owner = null; calls.released++;
      shell = {...shell, payload: null, draftToken: null, retainedDraftToken: null}; current.onDiscard(); emit(); return true;
    },
    retainDraft(token, callback) {return owner?.token === token && owner.isCurrent() ? callback() : false;},
    navigate() {calls.navigate++; return false;}, downloadText: value => downloads.push(value),
  });
  let mount;
  t.after(async () => {
    try {mount?.dispose();}
    finally {h.closing.resolve(false); await nativeSettle();}
  });
  mount = mountPlaylists({host: h.host, runtime: h.runtime, providers});
  return {...h, mount, calls, downloads, render: nativeSettle,
    async openMissing(title, description = '') {
      h.click(h.host.querySelector('[data-playlists-action="missing"]')); await nativeSettle();
      h.edit(title, description);
      const all = h.field('Select visible tracks'); all.checked = true; h.event(all, 'change');
      h.submit(); await h.closeEntered.promise; await h.finishClose(); await nativeSettle();
      assert.ok(h.host.querySelector('.playlists-draft__tracks'), 'the actual native entry mounted its Missing draft');
    },
    draftAction: name => h.host.querySelector(`[data-playlists-draft-action="${name}"]`),
    setShell(patch) {shell = {...shell, ...patch}; emit();},
  };
}

test('Save acknowledgement still revalidates refreshed source grants, identity and revision before preserving private draft facts', async t => {
  const creation = await import('../../../music_app/static/js/playlists/creation.mjs');
  const subject = {scopeKey: 'mount:actor', mode: 'missing', canCreate: true, canCreateAlbumTop: true,
    source: {kind: 'playlist', ref: 'source:mount', revision: 'revision:one', allowed_actions: {can_read: true, can_use_for_playlist: true}}};
  const sourcePayload = source => ({playlist_actions: {can_create: true},
    playlist_sidebar: {items: [{playlist_id: 'source:mount', title: 'Source', allowed_actions: {can_open: true}}]},
    playlist_detail: {playlist_id: 'source:mount', title: 'Source', revision: source.revision, track_rows: [], items_complete: true,
      allowed_actions: {can_open: true, can_create_album_top: true}, missing_playlist_creation_source: source}});
  for (const change of ['revoked', 'identity', 'revision']) {
    let writes = 0;
    const changed = {...subject.source, ...(change === 'identity' ? {ref: 'source:other'} : {}),
      ...(change === 'revision' ? {revision: 'revision:two'} : {}),
      ...(change === 'revoked' ? {allowed_actions: {can_read: false, can_use_for_playlist: false}} : {})};
    const providers = {
      readPlaylistCreationSource: request => ({status: 'ready', data: {...request, allowed_actions: {can_read: true, can_use_for_playlist: true},
        entries_complete: true, entries: [{entry_ref: 'occurrence:private', title: 'Private original', artist: 'Private artist',
          availability: 'missing', allowed_actions: {can_read: true, can_select: true}}], retained_parent_albums: []}}),
      createPlaylistFromSelection: request => {writes++; return {status: 'ready', data: {scopeKey: request.scopeKey,
        request_key: request.request_key, playlist_id: 'saved:missing-from-directory', revision: 'saved:one'}};},
    };
    const form = creation.createPlaylistCreationController({providers});
    t.after(() => form.dispose());
    form.setContext(subject); await form.load(); form.edit({title: 'Typed title', description: 'Typed description'});
    const packet = form.prepareDraft(); assert.ok(packet);
    const h = await mountHarness(t, async () => sourcePayload(changed), providers, sourcePayload(subject.source));
    await h.openMissing(packet.title, packet.description);
    const save = h.draftAction('save'); assert.ok(save); h.click(save); await h.render();
    assert.equal(writes, 1); assert.equal(h.calls.navigate, 0);
    assert.equal(h.host.querySelectorAll('[data-playlist-row-key]').length, 0);
    assert.doesNotMatch(h.host.textContent, /Private original|Private artist/);
    const exportButton = h.draftAction('export');
    if (exportButton) {h.click(exportButton); await h.render();}
    assert.equal(h.downloads.length, 0, `${change} source facts must no longer be exportable`);
    if (change === 'revision') {
      assert.match(h.host.textContent, /source changed/i);
      assert.equal(h.host.querySelector('[aria-label="Playlist name"]').value, 'Typed title');
    } else {
      assert.equal(h.calls.released, 1);
      assert.doesNotMatch(h.host.innerHTML, /Typed title|Typed description/);
      assert.equal(h.host.querySelector('[aria-label="Playlist name"]')?.value || '', '');
      assert.equal(h.host.querySelector('[aria-label="Playlist description"]')?.value || '', '');
    }
    h.click(save); await h.render(); assert.equal(writes, 1);
    form.dispose(); h.mount.dispose();
  }
});

test('async Top UI ownership aborts on retained-row and source changes even when the deduplicated albums are unchanged', async t => {
  const creation = await import('../../../music_app/static/js/playlists/creation.mjs');
  const subject = {scopeKey: 'mount:actor', mode: 'missing', canCreate: true, canCreateAlbumTop: true,
    source: {kind: 'playlist', ref: 'source:mount', revision: 'revision:one', allowed_actions: {can_read: true, can_use_for_playlist: true}}};
  const sourcePayload = {playlist_actions: {can_create: true},
    playlist_sidebar: {items: [{playlist_id: 'source:mount', title: 'Source', allowed_actions: {can_open: true}}]},
    playlist_detail: {playlist_id: 'source:mount', title: 'Source', revision: 'revision:one', track_rows: [], items_complete: true,
      allowed_actions: {can_open: true, can_create_album_top: true}, missing_playlist_creation_source: subject.source}};
  for (const change of ['remove', 'source', 'provider']) {
    const pending = deferred(); let options, received, topCalls = 0;
    const providers = {
      readPlaylistCreationSource: request => ({status: 'ready', data: {...request, allowed_actions: {can_read: true, can_use_for_playlist: true},
        entries_complete: true, retained_parent_albums: [], entries: ['one', 'two'].map(entry_ref => ({entry_ref, title: entry_ref,
          availability: 'missing', allowed_actions: {can_read: true, can_select: true},
          parent_album: {state: 'known', album_ref: 'album:same-parent', allowed_actions: {can_read: true, can_create_album_top: true}}}))}}),
      openAlbumTopDraft(intent, ui) {topCalls++; received = intent; options = ui; return pending.promise;},
    };
    const form = creation.createPlaylistCreationController({providers});
    t.after(() => form.dispose()); form.setContext(subject); await form.load(); form.edit({title: 'Draft'});
    const changedSource = {...sourcePayload, playlist_detail: {...sourcePayload.playlist_detail,
      allowed_actions: {can_open: true, can_create_album_top: false}, missing_playlist_creation_source: {...subject.source, revision: 'revision:two'}}};
    const h = await mountHarness(t, async () => changedSource, providers, sourcePayload);
    await h.openMissing('Draft'); h.click(h.draftAction('top'));
    assert.equal(options.isCurrent(), true); assert.equal(options.signal.aborted, false);
    assert.doesNotMatch(JSON.stringify(received), /draftToken|playlist_id/);
    assert.deepEqual(plain(received.album_refs), ['album:same-parent']);
    const originalAlbums = plain(received.album_refs);
    if (change === 'remove') {
      // The actual page disables removal while its Top UI handoff is pending.
      // The former private-controller mutation is not a public UI action.
      // Preserve the blocked action and then test retirement after completion.
      const remove = h.host.querySelector('[data-draft-remove="entry:one"]');
      assert.ok(remove); assert.equal(remove.disabled, true);
      h.click(remove); assert.ok(h.host.querySelector('[data-playlist-row-key="entry:one"]'));
      assert.ok(h.host.querySelector('[data-playlist-row-key="entry:two"]'));
      assert.equal(topCalls, 1); assert.equal(options.signal.aborted, false); assert.equal(options.isCurrent(), true);
      pending.resolve(false); await h.render(); h.click(h.host.querySelector('[data-draft-remove="entry:one"]')); await h.render();
      assert.equal(h.host.querySelector('[data-playlist-row-key="entry:one"]'), null);
      assert.ok(h.host.querySelector('[data-playlist-row-key="entry:two"]'));
      // The existing child lifetime must still retire when its retained row set changes.
    } else if (change === 'source') await h.mount.refresh();
    else h.mount.configureProviders({...providers, openAlbumTopDraft() {assert.fail('A replacement provider was invoked by the old child');}});
    assert.equal(options.signal.aborted, true); assert.equal(options.isCurrent(), false);
    let navigated = 0; assert.equal(options.retainNavigation(() => {navigated++;}), false); assert.equal(navigated, 0);
    pending.resolve(true); await h.render();
    if (change === 'remove') {
      h.click(h.draftAction('top')); await h.render();
      assert.equal(topCalls, 2); assert.deepEqual(plain(received.album_refs), originalAlbums, 'retained occurrence changed while album refs did not');
    }
    form.dispose(); h.mount.dispose();
  }
});

test('Activity can open the existing Missing draft page with a verified Home scope and return to its source', async () => {
  const f=harness();
  f.context.state.view={surface:{active:'home'}};
  f.location.href='https://albumhaven.test/?home_kind=tracks';
  f.history.replaceState({albumHavenNavigationPosition:0},'',f.location.href);
  f.context.AlbumHavenHomeRuntime={snapshot:()=>({visible:f.context.shouldShowMobileHome(),authenticated:true,scopeKey:'home:current'})};
  f.context.syncMobileHome();
  assert.equal(f.document.getElementById('mobile-home').hidden,false);
  assert.equal(f.runtime.snapshot().visible,false);
  let alive=true;
  const opened=f.runtime.openDraft({token:'activity:draft',scopeKey:f.runtime.snapshot().scopeKey,externalScopeKey:'home:current',
    isCurrent:()=>alive,confirmLeave:()=>true,onDiscard:()=>{alive=false;}});
  assert.equal(opened,true);assert.equal(f.runtime.snapshot().draftToken,'activity:draft');
  assert.equal(f.runtime.snapshot().visible,true);
  assert.equal(f.document.getElementById('mobile-home').hidden,true);
  assert.equal(f.document.getElementById('shell-main-surface').classList.contains('has-mobile-home'),false);
  assert.equal(f.context.AlbumHavenHomeRuntime.snapshot().visible,false);
  await f.runtime.closeDraft('activity:draft');await settle();
  assert.equal(f.location.search,'?home_kind=tracks');assert.equal(f.runtime.snapshot().draftToken,null);
  assert.equal(f.document.getElementById('mobile-home').hidden,false);
  assert.equal(f.context.AlbumHavenHomeRuntime.snapshot().visible,true);
});

test('external Missing draft rejects a stale or unauthenticated Home source',()=>{
  for(const home of [{visible:true,authenticated:true,scopeKey:'home:new'},{visible:true,authenticated:false,scopeKey:'home:current'}]){
    const f=harness();f.context.state.view={surface:{active:'home'}};f.location.href='https://albumhaven.test/';
    f.context.AlbumHavenHomeRuntime={snapshot:()=>home};
    assert.equal(f.runtime.openDraft({token:'activity:draft',scopeKey:f.runtime.snapshot().scopeKey,externalScopeKey:'home:current',
      isCurrent:()=>true,confirmLeave:()=>true,onDiscard:()=>{}}),false);
    assert.equal(f.history.state.playlistDraft,undefined);
  }
});

test('external Activity packet mounts the existing draft controller while hidden Playlist directory is loading',async t=>{
  const creation=await import('../../../music_app/static/js/playlists/creation.mjs');
  const subject={scopeKey:'mount:actor',mode:'missing',canCreate:true,source:{kind:'activity',ref:'activity:capture',revision:'activity:revision',
    source_protocol:'missing_activity_selection_v1',allowed_actions:{can_read:true,can_use_for_playlist:true}}};
  const sourceResource=creation.normalizeCreationResult({status:'ready',data:{...subject,source_protocol:'missing_activity_selection_v1',
    allowed_actions:subject.source.allowed_actions,entries_complete:true,entries:[{entry_ref:'occurrence:one',title:'Missing original',
      availability:'missing',allowed_actions:{can_read:true,can_select:true}}]}},subject);
  const packet=creation.prepareMissingDraft({...subject,sourceResource,mutation:{status:'idle'},title:'Missing activity',description:'',
    selectedKeys:sourceResource.data.entries.map(row=>row.row_key)});
  assert.ok(packet);
  let writes=0;const directory=deferred();
  const h=await mountHarness(t, ()=>directory.promise,{createPlaylistFromSelection:()=>{writes++;}},{playlist_sidebar:{items:[]},playlist_index:{playlists:[]}});
  h.setShell({visible:false,playlistId:null,payload:null});await h.render();
  assert.equal(h.mount.prepareActivityDraft(packet,'home:current'),true);await h.render();
  assert.match(h.host.textContent,/Missing original/);assert.equal(h.host.querySelectorAll('[data-playlist-row-key]').length,1);assert.equal(writes,0);
  directory.resolve({playlist_sidebar:{items:[]},playlist_index:{playlists:[]},playlist_actions:{can_create:true}});await h.render();
  assert.equal(h.host.querySelectorAll('[data-playlist-row-key]').length,1);
  h.mount.configureProviders({});assert.equal(h.calls.released,1);assert.equal(h.host.querySelectorAll('[data-playlist-row-key]').length,0);
  assert.doesNotMatch(h.host.textContent,/Missing original/);h.mount.dispose();
});
