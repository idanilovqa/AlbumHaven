'use strict';
// Source-authored D tests. Real guest entry and seven existing core builders;
// only the established deterministic DOM fixture is adapted, never production.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {createNativeHomeRuntime, readRepo} = require('./native-home-harness.cjs');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SHARE = id(1), PUBLICATION = id(2), PATH = `/public/album-tops/${SHARE}`;
const files = ['markup-format-helpers.js', 'album-artbox.js', 'gallery-main-components.js',
  'gallery-card-component.js', 'album-details-components.js', 'compact-data-table.js', 'album-track-table.js'];
const imagePath = (row, generation = PUBLICATION) =>
  `${PATH}/publications/${generation}/items/${row.item_ref}/artwork/${row.artwork_ref}.png`;
function item(position = 1, included = true) {
  return {item_ref: id(100 + position), original_position: String(position + 5), curator_position: position,
    album_ref: id(200 + position), presentation_ref: id(300 + position), title: `Album ${position}`,
    artist: 'Published artist', year: 2001, artwork_ref: included ? id(500 + position) : null,
    details_path: `${PATH}/items/${id(100 + position)}`};
}
function top() {
  return {kind: 'top', share_ref: SHARE, item_ref: null, limit: 50,
    data: {share_ref: SHARE, publication_ref: PUBLICATION, publication_revision: '7',
      publication_contract_version: 2, next_cursor: null,
      allowed_actions: {can_read: true, can_open_item: true}, title: 'Published Top', description: 'Approved description',
      items: [item(1), item(2, false)]}};
}
function detail() {
  return {kind: 'item', share_ref: SHARE, item_ref: id(101), limit: 100,
    data: {share_ref: SHARE, publication_ref: PUBLICATION, publication_revision: '7',
      publication_contract_version: 2, next_cursor: null,
      allowed_actions: {can_read: true, can_open_item: true}, item: item(), track_count: 1,
      tracks: [{track_ref: id(401), position: 1, title: 'Track', artist: 'Artist', duration_ms: null}]}};
}
function environment(payload = top(), options = {}) {
  const platform = createNativeHomeRuntime(), document = platform.document;
  // The existing fixture has an outerHTML getter. Add only native replacement
  // semantics locally, using its real parser and tree operations. No shared
  // harness or guest behavior is replaced by this test-only adaptation.
  const prototype = Object.getPrototypeOf(document.createElement('div'));
  const outer = Object.getOwnPropertyDescriptor(prototype, 'outerHTML');
  if (!outer.set) Object.defineProperty(prototype, 'outerHTML', {...outer, set(value) {
    if (!this.parentNode) return;
    const parent = this.parentNode, template = document.createElement('template');
    template.innerHTML = String(value);
    for (const child of [...template.content.childNodes]) parent.insertBefore(child, this);
    parent.removeChild(this);
  }});
  const page = document.createElement('main'); page.id = 'public-album-top-page'; page.hidden = true;
  const heading = document.createElement('h1'); heading.textContent = 'Published Top';
  const content = document.createElement('div'); content.id = 'public-album-top-content';
  const script = document.createElement('script'); script.id = 'public-album-top-data'; script.type = 'application/json';
  script.textContent = options.raw ?? JSON.stringify(payload);
  page.append(heading, content, script); document.body.append(page); document.title = 'Shared Album Top · AlbumHaven';
  document.readyState = options.readyState || 'complete';
  const listeners = new Map(), forbidden = [], reloads = [], insertions = [];
  const inner = Object.getOwnPropertyDescriptor(prototype, 'innerHTML');
  Object.defineProperty(content, 'innerHTML', {get() {return inner.get.call(this);}, set(markup) {
    insertions.push(String(markup));
    if (/<img\b/i.test(String(markup))) assert.equal(
      this.listeners.filter(entry => entry.type === 'error' && entry.capture).length, 1,
      'native image error owner is attached before image insertion');
    inner.set.call(this, markup);
  }});
  const context = vm.createContext({document, URLSearchParams,
    location: {pathname: options.path ?? `${PATH}${payload.kind === 'item' ? `/items/${payload.item_ref}` : ''}`,
      search: options.query ?? '', reload() {reloads.push(page.querySelectorAll('img').length);
        if (options.reloadError) throw new Error('blocked reload');}},
    addEventListener(type, callback) {assert.ok(!listeners.has(type), 'one lifetime owner'); listeners.set(type, callback);},
  });
  context.window = context;
  for (const name of ['fetch', 'XMLHttpRequest', 'Image', 'localStorage', 'sessionStorage', 'Audio', 'state',
    'ButtonComponent', 'buildAlbumArtbox', 'getAlbumCoverUrl', 'playAlbum', 'openTrackModal', 'navigator',
    'setTimeout', 'setInterval', 'requestAnimationFrame', 'Worker']) {
    Object.defineProperty(context, name, {configurable: true, get() {forbidden.push(name); throw new Error(`Guest used ${name}`);}});
  }
  for (const file of files) vm.runInContext(readRepo(`music_app/static/js/runtime/${file}`), context, {filename: file});
  context.buildUtilityAlbumArtbox = () => {forbidden.push('buildUtilityAlbumArtbox');
    throw new Error('Guest used private fallback/lightbox artbox');};
  const dispatch = (type, patch = {}) => listeners.get(type)?.({type, persisted: false, ...patch});
  options.beforeBoot?.({context, document, page, content, script, dispatch});
  vm.runInContext(readRepo('music_app/static/js/public-album-tops/page.js'), context, {filename: 'public-album-tops/page.js'});
  return {context, document, page, content, script, dispatch, reloads, forbidden, listeners, platform, insertions,
    ready() {document.dispatchEvent(new platform.context.Event('DOMContentLoaded'));},
    error(image) {image.dispatchEvent(new platform.context.Event('error', {bubbles: false}));}};
}
function safe(env, count) {
  assert.deepEqual(env.forbidden, []);
  assert.deepEqual(env.platform.forbiddenCalls, []);
  assert.equal(env.document.getElementById('public-album-top-data'), null);
  assert.equal(env.script.textContent, '');
  assert.equal(env.page.querySelectorAll('img').length, count);
  for (const tag of ['button', 'audio', 'video', 'iframe']) assert.equal(env.page.querySelectorAll(tag).length, 0);
  for (const image of env.page.querySelectorAll('img')) {
    assert.equal(image.hasAttribute('onerror'), false);
    assert.equal(image.hasAttribute('onclick'), false);
  }
  assert.doesNotMatch(env.page.innerHTML,
    /data-(?:src|track-path|open-tracklist|album-key|gallery-card-intent|track-love-cell)=/);
}
function unavailable(env) {
  assert.equal(env.page.textContent, 'This shared Album Top is unavailable.');
  assert.ok(env.insertions.every(markup => !/<img\b/i.test(markup)), 'invalid whole DTO never inserts an image');
  safe(env, 0);
}

for (const kind of ['top', 'item']) test(`v2 ${kind} uses actual core artboxes with exact generation-scoped PNG`, () => {
  const value = kind === 'top' ? top() : detail(), env = environment(value);
  safe(env, 1);
  const row = kind === 'top' ? value.data.items[0] : value.data.item;
  const image = env.page.querySelector('img');
  assert.equal(image.getAttribute('src'), imagePath(row));
  assert.equal(image.getAttribute('alt'), `Published artwork: ${row.title}`);
  assert.equal(image.getAttribute('referrerpolicy'), 'no-referrer');
  assert.equal(image.getAttribute('loading'), 'lazy');
  assert.equal(image.getAttribute('decoding'), 'async');
  assert.equal(image.getAttribute('data-public-album-artwork'), '1');
  assert.equal(image.closest('.album-artbox').classList.contains('album-artbox--ready'), true);
  assert.equal(env.content.listeners.filter(event => event.type === 'error' && event.capture).length, 1);
  assert.equal(env.content.querySelectorAll('.album-artbox--empty').length, kind === 'top' ? 1 : 0);
  if (kind === 'top') assert.equal(image.closest('a').getAttribute('href'), row.details_path);
});

test('same asset UUID changes image URL when publication generation changes', () => {
  const value = top(); value.data.publication_ref = id(999);
  const env = environment(value); safe(env, 1);
  assert.equal(env.page.querySelector('img').getAttribute('src'), imagePath(value.data.items[0], id(999)));
});

test('hostile labels stay text and attributes, never arbitrary image or media markup', () => {
  const value = top(); value.data.items[0].title = '<img src="https://foreign.example" onerror="bad()"> & </script>';
  value.data.items[0].artist = '<audio src="private">';
  const env = environment(value); safe(env, 1);
  assert.equal(env.page.querySelector('img').getAttribute('src'), imagePath(value.data.items[0]));
  assert.equal(env.page.querySelector('img').getAttribute('alt'), `Published artwork: ${value.data.items[0].title}`);
  assert.equal(env.content.querySelectorAll('script').length, 0);
});

const invalid = {
  'missing discriminator with image': value => {delete value.data.publication_contract_version;},
  'explicit v1 discriminator': value => {value.data.publication_contract_version = 1;},
  'boolean discriminator': value => {value.data.publication_contract_version = true;},
  'string discriminator': value => {value.data.publication_contract_version = '2';},
  'unknown discriminator': value => {value.data.publication_contract_version = 3;},
  'outer discriminator': value => {value.publication_contract_version = 2;},
  'item discriminator': value => {value.data.items[0].publication_contract_version = 2;},
  'remote artwork': value => {value.data.items[0].artwork_ref = 'https://foreign.example/cover.png';},
  'data artwork': value => {value.data.items[0].artwork_ref = 'data:image/png;base64,AAAA';},
  'blob artwork': value => {value.data.items[0].artwork_ref = 'blob:https://public.example/id';},
  'noncanonical artwork': value => {value.data.items[0].artwork_ref = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';},
  'query artwork': value => {value.data.items[0].artwork_ref += '?token=private';},
  'private field': value => {value.data.items[0].source_stamp = {};},
  'arbitrary image URL': value => {value.data.items[0].artwork_url = '/private/cover';},
  'malformed final row': value => {value.data.items[1].artwork_ref = false;},
  'invalid action': value => {value.data.allowed_actions.can_play = true;},
};
for (const [name, change] of Object.entries(invalid)) test(`entire v2 payload rejects before first image: ${name}`, () => {
  const value = top(); change(value); unavailable(environment(value));
});

test('v1 remains implicit metadata-only and excluded/empty v2 creates no image', () => {
  const excluded = top(); excluded.data.items.forEach(row => {row.artwork_ref = null;});
  safe(environment(excluded), 0);
  const legacy = top(); delete legacy.data.publication_contract_version;
  legacy.data.items.forEach(row => {row.artwork_ref = null;}); safe(environment(legacy), 0);
  const empty = top(); empty.data.items = []; safe(environment(empty), 0);
});

test('real non-bubbling error becomes inert missing art without retry or replacement request', () => {
  const env = environment(), image = env.page.querySelector('img');
  const before = image.getAttribute('src'); env.error(image); safe(env, 0);
  assert.equal(env.content.querySelectorAll('.album-artbox--missing').length, 1);
  assert.equal(image.getAttribute('src'), before);
  const markup = env.content.innerHTML; env.error(image);
  assert.equal(env.content.innerHTML, markup, 'repeated detached-image error has no effect');
});

for (const target of ['page', 'content', 'image']) test(`detached ${target} rejects late image errors`, () => {
  const env = environment(), image = env.page.querySelector('img');
  const callback = env.content.listeners.find(entry => entry.type === 'error').callback;
  (target === 'image' ? image : env[target]).remove(); const old = env.content.innerHTML;
  callback({target: image}); assert.equal(env.content.innerHTML, old); assert.deepEqual(env.forbidden, []);
});

test('error builder retirement cannot restore stale artwork after pagehide', () => {
  const env = environment(), image = env.page.querySelector('img');
  const original = env.context.buildAlbumArtboxHtml;
  env.context.buildAlbumArtboxHtml = options => {env.dispatch('pagehide'); return original(options);};
  env.error(image); safe(env, 0);
  assert.equal(env.page.textContent, 'Loading published metadata and approved artwork…');
  assert.equal(env.content.textContent, '');
});

for (const kind of ['top', 'item']) test(`${kind} pagehide retires images and listener before BFCache reload`, () => {
  const env = environment(kind === 'top' ? top() : detail()), image = env.page.querySelector('img');
  const callback = env.content.listeners.find(entry => entry.type === 'error').callback;
  env.dispatch('pagehide'); safe(env, 0);
  assert.equal(env.content.listeners.filter(entry => entry.type === 'error').length, 0);
  assert.equal(env.content.textContent, '');
  assert.equal(env.page.textContent, 'Loading published metadata and approved artwork…');
  callback({target: image}); env.dispatch('pageshow'); safe(env, 0);
  assert.deepEqual(env.reloads, []);
  env.dispatch('pageshow', {persisted: true}); assert.deepEqual(env.reloads, [0]); safe(env, 0);
});

test('pagehide before DOM ready never exposes an unvalidated image or trusts its version', () => {
  const env = environment(top(), {readyState: 'loading'});
  assert.equal(env.content.innerHTML, ''); env.dispatch('pagehide'); env.ready(); safe(env, 0);
  assert.equal(env.page.textContent, 'Loading published metadata…');
  assert.ok(env.insertions.every(markup => !/<img\b/i.test(markup)));
});

test('reload failure keeps imagery retired', () => {
  const env = environment(top(), {reloadError: true}); env.dispatch('pageshow', {persisted: true}); safe(env, 0);
  assert.deepEqual(env.reloads, [0]); assert.equal(env.content.textContent, '');
});

test('retirement during card generation cannot insert already-built image markup', () => {
  const env = environment(top(), {beforeBoot({context, dispatch}) {
    const original = context.buildGalleryCardHtml;
    context.buildGalleryCardHtml = options => {dispatch('pagehide'); return original(options);};
  }}); safe(env, 0); assert.ok(env.insertions.every(markup => !/<img\b/i.test(markup)));
});

test('bounded continuation uses stable details links and only this generation artwork', () => {
  const value = top(); value.limit = 100;
  value.data.items = Array.from({length: 100}, (_, index) => item(index + 101, index % 2 === 0));
  value.data.next_cursor = 'opaque-next';
  const env = environment(value, {query: '?limit=100&cursor=opaque-current'}); safe(env, 50);
  assert.equal(env.content.querySelectorAll('.album-card').length, 100);
  for (const [index, anchor] of env.content.querySelectorAll('a').entries()) {
    assert.equal(anchor.getAttribute('href'), value.data.items[index].details_path);
  }
  assert.equal(env.content.querySelectorAll('img')[0].getAttribute('src'), imagePath(value.data.items[0]));
});

test('v2 template notice is explicit and existing guest assets remain isolated', () => {
  const template = readRepo('music_app/templates/public-album-top.html');
  assert.match(template, /approved artwork/);
  assert.match(template, /publication_contract_version/);
  assert.doesNotMatch(template, /utility\/album-artbox|runtime-bundle|index-native|private_ui_context/);
});
