'use strict';
// AUTHORED ONLY. No Node/browser run has been performed for this source packet.
// Load complete production files, including the genuine private transport and
// native modal owner. Only loadLocalAlbumListeningPresenter is a declared
// static-asset loader seam: host native import loads the genuine complete ES
// module, without a custom VM loader or flags. The browser asset URL/version
// loader itself is not runtime-covered. No ESM implementation is extracted.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {pathToFileURL} = require('node:url');
const ROOT = path.resolve(__dirname, '../../../');
const runtime = name => path.join(ROOT, 'music_app/static/js/runtime', name);
const presenterURL = pathToFileURL(path.join(ROOT, 'music_app/static/js/album-tops/listening-presentation.mjs')).href;
const flush = async () => {for (let i = 0; i < 8; i++) await new Promise(setImmediate);};
const MARKER = 'a'.repeat(64);

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}

// Minimal platform tree, events, observation delivery and timers. There is no
// HTML/layout engine here; no real browser mutation timing claim is made.
class Element {
  constructor(name = 'div', connected = false) {
    this.tagName = name; this.parentNode = null; this.children = []; this.dataset = {};
    this.rootConnected = connected; this.hidden = false; this.title = '';
    this.attributes = new Map(); this.listeners = new Map(); this.html = ''; this.text = '';
    const classes = new Set();
    this.classList = {add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)), contains: name => classes.has(name),
      toggle: (name, value) => value ? classes.add(name) : classes.delete(name)};
  }
  get isConnected() {return this.parentNode ? this.parentNode.isConnected : this.rootConnected;}
  appendChild(node) {node.remove(); this.children.push(node); node.parentNode = this; return node;}
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this);
    this.parentNode = null; this.rootConnected = false;
  }
  replaceChildren(...nodes) {for (const child of [...this.children]) child.remove(); nodes.forEach(node => this.appendChild(node));}
  set innerHTML(value) {this.replaceChildren(); this.html = String(value); this.text = '';}
  get innerHTML() {return this.html;}
  set textContent(value) {this.replaceChildren(); this.text = String(value); this.html = '';}
  get textContent() {return this.text + this.children.map(node => node.textContent).join('');}
  contains(node) {return node === this || this.children.some(child => child.contains(node));}
  querySelector() {return null;}
  querySelectorAll() {return [];}
  setAttribute(name, value) {this.attributes.set(name, String(value));}
  getAttribute(name) {return this.attributes.get(name) ?? null;}
  removeAttribute(name) {this.attributes.delete(name);}
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }
  removeEventListener(type, callback) {this.listeners.get(type)?.delete(callback);}
}

function album(key = 'album / one', extra = {}) {
  return {key, name: 'Album', album_artist: 'Artist', tracks: [], source_readable: true,
    allowed_actions: {can_read: true}, album_preference: {taste_state: 'available',
      album_ref: 'inventory-album:3:41', context_ref: MARKER, rating: 8, is_favorite: true,
      can_edit: true, allowed_actions: {can_manage_album_preferences: true}}, ...extra};
}
function payload(key = 'album / one') {
  return {ok: true, version: 'local-album-recorded-metrics-v1', album_key: key,
    account_id: '7', library_id: '3', context_ref: MARKER, membership_revision: 'b'.repeat(64),
    history_complete: false, window_truncated: false, compatibility_policy: 'healthy-local-inventory-version-v1',
    metrics: {status: 'partial', basis: 'local-edition-recorded-v1', history_status: 'partial',
      full: null, listened: 'unknown', recorded_frames: 48000, tracks_with_supported_coverage: 0,
      unsupported_run_count: 1, tracks: [{track_id: '11', recorded_frames: 48000,
        coverage_status: 'unknown', covered_frames: null, extent_frames48: null}]}};
}

function fixture({enabled = true, context = MARKER, observer = true, csrf = false} = {}) {
  const requests = [], observers = [], timers = new Map(), imports = [], moduleLoads = [], playback = [];
  let serial = 0, importFailure = false;
  const shell = new Element('shell', true);
  shell.dataset = {positionCaptureEnabled: String(enabled), privateUiContext: context,
    nativeAccountId: '7', nativeLibraryId: '3', listeningSelectionsEnabled: 'false'};
  const overlay = new Element('overlay', true); overlay.hidden = true;
  const header = overlay.appendChild(new Element('header'));
  const list = overlay.appendChild(new Element('list'));
  const cover = overlay.appendChild(new Element('cover'));
  const body = new Element('body', true), documentElement = new Element('html', true);
  const nodes = {'app-shell': shell, 'track-modal': overlay};
  const documentListeners=new Map();
  const document = {hidden:false,body, documentElement, activeElement: body, getElementById: id => nodes[id] || null,
    createElement: name => new Element(name), querySelectorAll: () => [],
    addEventListener(type,callback){if(!documentListeners.has(type))documentListeners.set(type,new Set());documentListeners.get(type).add(callback);},
    removeEventListener(type,callback){documentListeners.get(type)?.delete(callback);}};
  class Observer {
    constructor(callback) {this.callback = callback; this.observed = []; this.disconnected = false; observers.push(this);}
    observe(target, options) {this.observed.push({target, options});}
    disconnect() {this.disconnected = true;}
    deliver() {if (!this.disconnected) this.callback([]);}
  }
  const c = vm.createContext({AbortController, URL, URLSearchParams, TextEncoder, TextDecoder, console,
    document, window: {__ALBUM_HAVEN_RUNTIME_ASSET_VERSION__: 'test-local-metrics'},
    ...(observer ? {MutationObserver: Observer} : {}),
    setTimeout: (callback, delay) => {timers.set(++serial, {callback, delay}); return serial;},
    clearTimeout: id => timers.delete(id),
    fetch: (url, options) => {
      const pending = deferred(); requests.push({url, options, ...pending}); return pending.promise;
    },
    state: {player: {}, view: {}, ui: {pendingTrackModalLoadToken: 0}, modalReleases: [], modalReleaseIndex: 0},
    getTrackModalElements: () => ({overlay, header, list, cover}),
    getAlbumRequestKey: value => value?.key || '',
    escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    ButtonComponent: {renderActionButton: () => '<button>Action</button>', renderButton: value => `<button>${value.label}</button>`, renderIconSvg: () => ''},
    buildAlbumDetailsHeaderHtml: value => `<h2>${value.album}</h2>`,
    buildAlbumDetailsHeaderActionsHtml: () => '',
    buildGalleryRatingHtml: value => `rating(${value.value})`,
    albumHasDisplayCover: () => false, formatAlbumDuration: () => '', formatTrackDuration: () => '',
    getPlayerPlaybackSnapshot: () => ({paused: true, currentTime: 0, duration: 0}),
    attachSharedPlayer: () => playback.push('attached'),
    // Existing independent preference-receipt adapter is an explicit fixture
    // seam. The actual preference DOM/lease/disposal code is NOT replaced.
    captureRuntimeAlbumPreferenceScope: () => ({actor: shell.dataset.nativeAccountId,
      library: shell.dataset.nativeLibraryId, context: shell.dataset.privateUiContext,
      transport: c.window.AlbumHavenPrivateUITransport}),
    runtimeAlbumPreferenceForAlbum: value => value?.album_preference || null,
    runtimeAlbumPreferenceGeneration: value => value?.album_preference?.album_ref,
    runtimeAlbumPreferenceScopeIsCurrent: scope => scope.actor === shell.dataset.nativeAccountId
      && scope.library === shell.dataset.nativeLibraryId && scope.context === shell.dataset.privateUiContext
      && c.window.AlbumHavenPrivateUITransport.peekGeneration() !== null,
  });
  if(csrf){
    c.Headers=Headers;c.window.fetch=c.fetch;c.window.location={href:'https://music.test/',origin:'https://music.test'};
    c.document.cookie='__Host-album_haven_csrf=synthetic-session-token';
    const filename=runtime('session-csrf-fetch.js');vm.runInContext(fs.readFileSync(filename,'utf8'),c,{filename});
    c.fetch=c.window.fetch; // Browser window/global fetch alias, not product replacement.
  }
  for (const name of ['private-ui-transport.js', 'tag-editor-and-optimistic-updates.js', 'track-modal-lightbox-helpers.js']) {
    const filename = runtime(name);
    vm.runInContext(fs.readFileSync(filename, 'utf8'), c, {filename});
  }
  // Explicit platform asset-loader seam, installed after unmodified full-source
  // loading. All call sites, read owners, admission, actual transport, modal
  // lifecycle and presenter implementation remain product code. Browser asset
  // URL/version construction is not exercised by this Node harness.
  assert.equal(typeof c.loadLocalAlbumListeningPresenter, 'function');
  c.loadLocalAlbumListeningPresenter = () => {
    imports.push(presenterURL);
    const pending = importFailure ? Promise.reject(Error('Synthetic asset load failure')) : import(presenterURL);
    moduleLoads.push(pending);
    return pending;
  };
  const readOwner = () => vm.runInContext('trackModalListeningRead', c);
  const open = value => c.openTrackModal(value, {releaseSet: {releases: [value], selectedIndex: 0}});
  return {c, shell, overlay, header, list, cover, requests, observers, timers, imports, playback, readOwner, open,
    visibility(hidden){document.hidden=hidden;for(const callback of [...(documentListeners.get('visibilitychange')||[])])callback();},
    async flush() {await flush(); await Promise.allSettled(moduleLoads); await flush();},
    failImport() {importFailure = true;},
    mutate(target) {for (const item of observers) if (item.observed.some(row => row.target === target)) item.deliver();},
    reply(index, value, status = 200) {requests[index].resolve({status, ok: status >= 200 && status < 300, json: async () => value});},
  };
}

async function settle(f) {
  f.c.disposeTrackModalLocalListening();
  f.c.disposeTrackModalAlbumPreferences();
  for (const request of f.requests) request.reject(Object.assign(Error('Fixture cleanup'), {name: 'AbortError'}));
  await f.flush();
}

test('initial load and ordinary queue construction do not issue album metrics reads', async () => {
  const f = fixture();
  assert.equal(f.requests.length, 0); assert.equal(f.imports.length, 0);
  const queue = f.c.buildAlbumPlaybackQueueState(album('queue-only', {tracks: [{path: '/synthetic/1.flac', title: 'Track', disc_number: 1}]}));
  assert.ok(queue); assert.equal(f.requests.length, 0); assert.equal(f.imports.length, 0);
  assert.equal(f.readOwner(), null); await settle(f);
});

test('actual first-open owner unhides before the one genuine guarded on-demand GET', async () => {
  const f = fixture(), a = album();
  assert.equal(f.overlay.hidden, true);
  assert.equal(f.open(a), undefined); // Opening is synchronous, not a metrics promise.
  assert.equal(f.overlay.hidden, false);
  assert.equal(f.requests.length, 0); // No read inside the render-before-unhide turn.
  assert.ok(f.playback.length > 0); // Existing player composition already ran.
  await f.flush();
  assert.equal(f.requests.length, 1); assert.equal(f.imports.length, 1);
  const request = f.requests[0];
  assert.equal(request.url, '/playback/capture/position/album-metrics?album_key=album%20%2F%20one');
  assert.equal(request.options.method, 'GET'); assert.equal(request.options.credentials, 'same-origin');
  assert.equal(request.options.cache, 'no-store'); assert.equal(Object.hasOwn(request.options, 'body'), false);
  assert.equal(request.options.headers['X-AlbumHaven-Context'], MARKER);
  const owner = f.readOwner(), preference = f.c.getTrackModalAlbumPreferenceLease();
  assert.equal(owner.root.textContent, 'Recorded listening: loading…');
  assert.ok(preference); assert.equal(f.header.children.length, 2);
  const tasteBefore = preference.root.innerHTML, leaseBefore = preference;
  f.reply(0, payload()); await f.flush();
  assert.equal(owner.root.textContent, 'Recorded: at least 1 sec · Coverage known: 0/1 tracks');
  assert.match(owner.root.title, /Full listens are not yet qualified/);
  assert.equal(f.c.getTrackModalAlbumPreferenceLease(), leaseBefore);
  assert.equal(preference.root.innerHTML, tasteBefore);
  assert.equal(f.c.getCurrentTrackModalAlbum().album_preference.rating, 8);
  assert.equal(f.c.getCurrentTrackModalAlbum().album_preference.is_favorite, true);
  assert.equal(f.timers.size, 0); await settle(f);
});

for (const context of ['', 'invalid', 'f'.repeat(63)]) test(`actual context admission failure (${context.length}) leaves taste and native owner intact`, async () => {
  const f = fixture({context});
  assert.doesNotThrow(() => f.open(album()));
  await f.flush();
  assert.equal(f.requests.length, 0); assert.equal(f.imports.length, 0); assert.equal(f.readOwner(), null);
  assert.equal(f.overlay.hidden, false); assert.ok(f.playback.length > 0);
  assert.ok(f.header.children.some(node => node === f.c.getTrackModalAlbumPreferenceLease()?.root));
  await settle(f);
});

test('transport invalidation makes genuine context() fail before any metrics read', async () => {
  const f = fixture(); f.c.window.AlbumHavenPrivateUITransport.invalidate();
  assert.doesNotThrow(() => f.open(album())); await f.flush();
  assert.equal(f.requests.length, 0); assert.equal(f.readOwner(), null); await settle(f);
});

for (const [name, options, change] of [
  ['feature disabled', {enabled: false}, a => a],
  ['observer unavailable', {observer: false}, a => a],
  ['subject taste', {}, a => ({...a, read_only_subject: true, taste_state: 'available', album_rating: 6, favorite: true})],
  ['unreadable source', {}, a => ({...a, source_readable: false})],
  ['read action denied', {}, a => ({...a, allowed_actions: {can_read: false}})],
]) test(`no metrics request for ${name}`, async () => {
  const f = fixture(options); f.open(change(album())); await f.flush();
  assert.equal(f.requests.length, 0); assert.equal(f.imports.length, 0); assert.equal(f.readOwner(), null);
  if (name === 'subject taste') {
    assert.equal(f.c.getTrackModalAlbumPreferenceLease(), null);
    assert.match(f.header.children[0].innerHTML, /Rating: rating\(6\) · Favorite: Yes/);
  }
  await settle(f);
});

test('modal retired in its opening turn does not start a read or presenter import', async () => {
  const f = fixture(); f.open(album()); f.overlay.hidden = true;
  await f.flush(); assert.equal(f.requests.length, 0); assert.equal(f.imports.length, 0);
  assert.equal(f.readOwner(), null); await settle(f);
});

for (const [name, mutate] of [
  ['account', f => {f.shell.dataset.nativeAccountId = '8'; f.mutate(f.shell);}],
  ['library', f => {f.shell.dataset.nativeLibraryId = '4'; f.mutate(f.shell);}],
  ['context', f => {f.shell.dataset.privateUiContext = 'c'.repeat(64); f.mutate(f.shell);}],
  ['gate', f => {f.shell.dataset.positionCaptureEnabled = 'false'; f.mutate(f.shell);}],
  ['transport generation', f => {f.c.window.AlbumHavenPrivateUITransport.invalidate();}],
  ['modal close', f => {f.overlay.hidden = true; f.mutate(f.overlay);}],
  ['album identity', f => {f.c.state.modalReleases[0] = album('different'); f.mutate(f.header);}],
  ['header detached result', f => {f.header.replaceChildren(); f.mutate(f.header);}],
]) test(`pending ${name} change aborts the owned read and rejects late data`, async () => {
  const f = fixture(); f.open(album()); await f.flush();
  const old = f.readOwner(); assert.equal(f.requests.length, 1);
  mutate(f);
  assert.equal(old.controller.signal.aborted, true); assert.equal(old.root.isConnected, false);
  assert.equal(f.readOwner(), null); assert.equal(old.observer.disconnected, true);
  f.reply(0, payload()); await f.flush();
  assert.equal(f.readOwner(), null); assert.doesNotMatch(f.header.textContent, /Recorded: at least/);
  await settle(f);
});

test('old completion and old observer cannot dispose a newer album read or its taste lease', async () => {
  const f = fixture(); f.open(album('old')); await f.flush();
  const old = f.readOwner(), oldPreference = f.c.getTrackModalAlbumPreferenceLease();
  f.open(album('new')); await f.flush();
  const fresh = f.readOwner(), freshPreference = f.c.getTrackModalAlbumPreferenceLease();
  assert.notEqual(fresh, old); assert.notEqual(freshPreference, oldPreference);
  assert.equal(old.controller.signal.aborted, true); assert.equal(fresh.controller.signal.aborted, false);
  assert.equal(oldPreference.root.isConnected, false);
  old.observer.callback([]); // Deliberately invoke a retained stale callback.
  f.reply(0, payload('old')); await f.flush();
  assert.equal(f.readOwner(), fresh); assert.equal(f.c.getTrackModalAlbumPreferenceLease(), freshPreference);
  assert.equal(fresh.controller.signal.aborted, false); assert.equal(fresh.root.isConnected, true);
  f.reply(1, payload('new')); await f.flush();
  assert.equal(fresh.root.textContent, 'Recorded: at least 1 sec · Coverage known: 0/1 tracks');
  await settle(f);
});

test('same-album native rerender creates a distinct generation rather than reusing a stale result', async () => {
  const f = fixture(); f.open(album()); await f.flush();
  const previous = f.readOwner(); f.c.renderTrackModalRelease(f.c.getCurrentTrackModalAlbum()); await f.flush();
  const next = f.readOwner(); assert.notEqual(next, previous);
  assert.equal(previous.controller.signal.aborted, true); assert.equal(f.requests.length, 2);
  f.reply(0, payload()); await f.flush(); assert.equal(next.root.textContent, 'Recorded listening: loading…');
  f.reply(1, payload()); await f.flush(); assert.match(next.root.textContent, /^Recorded: at least/);
  await settle(f);
});

test('deadline aborts only metrics and never waits for or mutates playback/taste', async () => {
  const f = fixture(); f.open(album()); await f.flush();
  const owner = f.readOwner(), taste = f.c.getTrackModalAlbumPreferenceLease();
  const before = JSON.stringify(f.c.state.player), count = f.playback.length;
  const timer = f.timers.get(owner.timer); assert.equal(timer.delay, 2000); timer.callback();
  assert.equal(f.requests[0].options.signal.aborted, true);
  assert.equal(f.c.getTrackModalAlbumPreferenceLease(), taste); assert.equal(taste.root.isConnected, true);
  assert.equal(JSON.stringify(f.c.state.player), before); assert.equal(f.playback.length, count);
  f.requests[0].reject(Object.assign(Error('Aborted'), {name: 'AbortError'})); await f.flush();
  assert.equal(owner.root.textContent, 'Recorded listening unavailable.'); await settle(f);
});

for (const mode of ['response identity', 'dto validation', 'http denial', 'asset failure']) test(`${mode} cannot promote private metrics into taste or full-listen authority`, async () => {
  const f = fixture(); if (mode === 'asset failure') f.failImport();
  f.open(album()); await f.flush();
  const owner = f.readOwner(), taste = f.c.getTrackModalAlbumPreferenceLease();
  if (mode === 'response identity') f.reply(0, {...payload(), context_ref: 'd'.repeat(64)});
  else if (mode === 'dto validation') {const value = payload(); value.metrics.listened = true; f.reply(0, value);}
  else if (mode === 'http denial') f.reply(0, {ok: false, error: 'capture_forbidden'}, 403);
  else f.reply(0, payload());
  await f.flush();
  assert.doesNotMatch(f.header.textContent, /Recorded: at least/);
  if (mode === 'response identity') {
    assert.equal(owner.controller.signal.aborted, true); assert.equal(owner.root.isConnected, false);
  } else {
    assert.equal(owner.root.textContent, 'Recorded listening unavailable.');
    assert.equal(f.c.getTrackModalAlbumPreferenceLease(), taste);
  }
  assert.equal(f.c.getCurrentTrackModalAlbum().album_preference.rating, 8);
  assert.equal(Object.hasOwn(f.c.getCurrentTrackModalAlbum(), 'listened'), false);
  await settle(f);
});

function initialFull(){return {...payload(),full_progress:{available:true,state_revision:'0',status:'not_started',continuation:true}};}
function finishedFull(revision='1'){
  return {ok:true,version:'local-album-full-progress-v1',album_key:'album / one',account_id:'7',library_id:'3',
    context_ref:MARKER,membership_revision:'b'.repeat(64),full_progress:{available:true,state_revision:revision,
      policy_version:'local-edition-overlap-total-margin-v1',basis:'healthy-local-inventory-version-v1',
      full:5,uninterrupted_full:2,listened:true,partial:null,history_complete:false,derived_pruned:false,
      status:'complete_at_cutoff',continuation:false,cutoff_checkpoint_id:'99',completed_cutoff_checkpoint_id:'99'}};
}
function fireContinuation(f){
  const found=[...f.timers.entries()].find(([,timer])=>timer.delay===1500);
  assert.ok(found,'one paced continuation expected');f.timers.delete(found[0]);found[1].callback();return found[1];
}

test('actual local modal advances one paced private page and renders supported Full lower bound',async()=>{
  const f=fixture();try{
    f.open(album());await f.flush();f.reply(0,initialFull());await f.flush();
    const playbackCount=f.playback.length;assert.ok(playbackCount>0);
    assert.equal(f.requests.length,1);assert.match(f.header.textContent,/calculating/);
    fireContinuation(f);await f.flush();assert.equal(f.requests.length,2);
    assert.equal(f.requests[1].url,'/playback/capture/position/album-metrics/advance');
    assert.equal(f.requests[1].options.method,'POST');
    assert.deepEqual(JSON.parse(f.requests[1].options.body),{album_key:'album / one',state_revision:'0'});
    assert.equal(f.requests[1].options.headers['X-AlbumHaven-Context'],MARKER);
    f.reply(1,finishedFull());await f.flush();
    assert.match(f.header.textContent,/Full: at least 5 \(2 uninterrupted\)/);
    assert.equal([...f.timers.values()].filter(t=>t.delay===1500).length,0);
    assert.equal(f.playback.length,playbackCount);
    assert.equal(Object.hasOwn(f.c.getCurrentTrackModalAlbum(),'listened'),false);
  }finally{await settle(f);}
});

test('local Full continuation never issues overlapping requests for one modal owner',async()=>{
  const f=fixture();try{
    f.open(album());await f.flush();f.reply(0,initialFull());await f.flush();
    const callback=fireContinuation(f);callback.callback();await f.flush();
    assert.equal(f.requests.length,2);assert.equal(f.readOwner().inFlight,true);
    f.reply(1,finishedFull());await f.flush();assert.equal(f.readOwner().inFlight,false);
  }finally{await settle(f);}
});

for(const change of ['closed','disconnected','account','library','context'])test(`local Full pending continuation retires on ${change}`,async()=>{
  const f=fixture();try{
    f.open(album());await f.flush();f.reply(0,initialFull());await f.flush();
    const owner=f.readOwner();
    if(change==='closed')f.overlay.hidden=true;
    else if(change==='disconnected')owner.root.remove();
    else if(change==='account')f.shell.dataset.nativeAccountId='8';
    else if(change==='library')f.shell.dataset.nativeLibraryId='4';
    else f.shell.dataset.privateUiContext='c'.repeat(64);
    fireContinuation(f);await f.flush();assert.equal(f.requests.length,1);
  }finally{await settle(f);}
});

test('hidden document pauses Full work and visible current owner resumes once',async()=>{
  const f=fixture();try{
    f.open(album());await f.flush();f.reply(0,initialFull());await f.flush();
    f.visibility(true);fireContinuation(f);await f.flush();assert.equal(f.requests.length,1);
    f.visibility(false);fireContinuation(f);await f.flush();assert.equal(f.requests.length,2);
    f.reply(1,finishedFull());await f.flush();
  }finally{await settle(f);}
});

for(const status of [403,409,429,503])test(`Full continuation stops after ${status} without a retry spin`,async()=>{
  const f=fixture();try{
    f.open(album());await f.flush();f.reply(0,initialFull());await f.flush();fireContinuation(f);await f.flush();
    f.reply(1,{ok:false,error:'capture_unavailable'},status);await f.flush();
    assert.equal([...f.timers.values()].filter(t=>t.delay===1500).length,0);
    assert.match(f.readOwner().root.title,/Reopen this album to resume/);
  }finally{await settle(f);}
});

test('retired Full reply cannot restart a replacement album continuation',async()=>{
  const f=fixture();try{
    f.open(album());await f.flush();f.reply(0,initialFull());await f.flush();fireContinuation(f);await f.flush();
    f.open(album('replacement'));await f.flush();f.reply(1,finishedFull());await f.flush();
    assert.doesNotMatch(f.header.textContent,/Full: at least/);
    assert.equal([...f.timers.values()].filter(t=>t.delay===1500).length,0);
  }finally{await settle(f);}
});


test('genuine session CSRF wrapper accompanies actual private Full advance POST',async()=>{
  const f=fixture({csrf:true});try{
    f.open(album());await f.flush();f.reply(0,initialFull());await f.flush();fireContinuation(f);await f.flush();
    assert.equal(f.requests[1].options.headers.get('X-Album-Haven-CSRF'),'synthetic-session-token');
    assert.equal(f.requests[1].options.headers.get('X-AlbumHaven-Context'),MARKER);
    assert.equal(f.requests[1].options.credentials,'same-origin');
    f.reply(1,finishedFull());await f.flush();assert.match(f.header.textContent,/Full: at least 5/);
  }finally{await settle(f);}
});

test('unchanged Full revision stops pacing instead of spinning on throttled work',async()=>{
  const f=fixture();try{
    f.open(album());await f.flush();f.reply(0,initialFull());await f.flush();fireContinuation(f);await f.flush();
    f.reply(1,{...finishedFull('0'),full_progress:{available:true,state_revision:'0',status:'not_started',continuation:true}});
    await f.flush();assert.equal([...f.timers.values()].filter(t=>t.delay===1500).length,0);
    assert.match(f.readOwner().root.title,/progress is unchanged/);
  }finally{await settle(f);}
});
