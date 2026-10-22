'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {createNativeHomeRuntime, readRepo} = require('./native-home-harness.cjs');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SHARE = id(1), PUBLICATION = id(2), PATH = `/public/album-tops/${SHARE}`;
const files = ['markup-format-helpers.js', 'album-artbox.js', 'gallery-main-components.js',
  'gallery-card-component.js', 'album-details-components.js', 'compact-data-table.js', 'album-track-table.js'];
const clone = value => JSON.parse(JSON.stringify(value));
function item(position = 1) {
  return {item_ref: id(100 + position), original_position: String(position + 5), curator_position: position,
    album_ref: id(200 + position), presentation_ref: id(300 + position), title: `Album ${position}`,
    artist: 'Published artist', year: 2001, artwork_ref: null, details_path: `${PATH}/items/${id(100 + position)}`};
}
function top() {
  return {kind: 'top', share_ref: SHARE, item_ref: null, limit: 50,
    data: {share_ref: SHARE, publication_ref: PUBLICATION, publication_revision: '7', next_cursor: null,
      allowed_actions: {can_read: true, can_open_item: true}, title: 'Published Top', description: 'Approved description',
      items: [item(1), item(2)]}};
}
function detail() {
  return {kind: 'item', share_ref: SHARE, item_ref: id(101), limit: 100,
    data: {share_ref: SHARE, publication_ref: PUBLICATION, publication_revision: '7', next_cursor: null,
      allowed_actions: {can_read: true, can_open_item: true}, item: item(), track_count: 2,
      tracks: [1, 2].map(position => ({track_ref: id(400 + position), position, title: `Track ${position}`,
        artist: 'Track artist', duration_ms: position === 1 ? null : 3723000}))}};
}
function environment(payload = top(), options = {}) {
  // Reuse only the established platform's DOM objects. The guest runs in a NEW
  // VM with only its seven real builders: no ButtonComponent or private globals.
  const platform = createNativeHomeRuntime(), document = platform.document;
  const page = document.createElement('main'); page.id = 'public-album-top-page'; page.hidden = true;
  const heading = document.createElement('h1'); heading.textContent = payload.kind === 'top' ? payload.data.title : 'Shared album';
  const content = document.createElement('div'); content.id = 'public-album-top-content';
  const script = document.createElement('script'); script.id = 'public-album-top-data'; script.type = 'application/json';
  script.textContent = options.raw ?? JSON.stringify(payload);
  page.append(heading, content, script); document.body.append(page); document.title = 'Shared Album Top · AlbumHaven';
  document.readyState = options.readyState || 'complete';
  const listeners = new Map(), forbidden = [], reloads = [];
  const context = vm.createContext({document, URLSearchParams,
    location: {pathname: options.path ?? `${PATH}${payload.kind === 'item' ? `/items/${payload.item_ref}` : ''}`,
      search: options.query ?? '', reload() {reloads.push(true); if (options.reloadError) throw new Error('blocked reload');}},
    addEventListener(type, callback) {assert.ok(!listeners.has(type), 'one lifetime owner'); listeners.set(type, callback);},
  });
  context.window = context;
  for (const name of ['fetch', 'localStorage', 'sessionStorage', 'Audio', 'state', 'ButtonComponent',
    'playAlbum', 'openTrackModal', 'navigator', 'setTimeout', 'setInterval', 'requestAnimationFrame']) {
    Object.defineProperty(context, name, {configurable: true, get() {forbidden.push(name); throw new Error(`Guest used ${name}`);}});
  }
  for (const file of files) vm.runInContext(readRepo(`music_app/static/js/runtime/${file}`), context, {filename: file});
  const dispatch = (type, patch = {}) => listeners.get(type)?.({type, persisted: false, ...patch});
  options.beforeBoot?.({context, document, page, content, script, dispatch});
  vm.runInContext(readRepo('music_app/static/js/public-album-tops/page.js'), context, {filename: 'public-album-tops/page.js'});
  return {context, document, page, content, script, dispatch, reloads, forbidden, listeners, platform,
    ready() {document.dispatchEvent(new platform.context.Event('DOMContentLoaded'));}};
}
function safe(env) {
  assert.deepEqual(env.forbidden, [], 'guest never accesses private/network/storage globals');
  assert.deepEqual(env.platform.forbiddenCalls, []);
  assert.equal(env.document.getElementById('public-album-top-data'), null, 'embedded DTO is discarded after rendering');
  assert.equal(env.script.textContent, '');
  assert.equal(env.page.querySelectorAll('button').length, 0);
  assert.equal(env.page.querySelectorAll('audio').length, 0);
  assert.equal(env.page.querySelectorAll('img').length, 0, 'no artwork fallback request is invented');
  assert.doesNotMatch(env.page.innerHTML, /data-(?:src|track-path|track-row-path|open-tracklist|album-key|inventory-track-ref|gallery-card-intent|track-love-cell|playtable-section|track-duration-path)=/);
}
function unavailable(env) {
  assert.equal(env.page.textContent, 'This shared Album Top is unavailable.'); safe(env);
}

test('real shared gallery builders yield inert native cards with exact public anchors', () => {
  const env = environment(); safe(env);
  assert.equal(env.page.hidden, false);
  const cards = env.content.querySelectorAll('.album-card'), anchors = env.content.querySelectorAll('a');
  assert.equal(cards.length, 2); assert.equal(anchors.length, 2);
  for (const [index, anchor] of anchors.entries()) {
    assert.equal(anchor.getAttribute('href'), item(index + 1).details_path);
    assert.equal(anchor.querySelector('.album-card').getAttribute('data-gallery-card-interaction'), 'none');
    assert.match(anchor.getAttribute('aria-label'), new RegExp(`album ${index + 1}$`));
  }
  assert.equal(env.content.querySelectorAll('.track-count').length, 0, 'unknown totals do not become zero tracks');
  assert.equal(env.content.querySelectorAll('.rating-row').length, 0);
  assert.equal(env.content.querySelectorAll('.album-artbox--empty').length, 2);
});

test('actual AlbumDetails and AlbumTrackTable render only approved metadata', () => {
  const env = environment(detail()); safe(env);
  assert.equal(env.content.querySelector('.album-details-header').getAttribute('data-album-details-variant'), 'copy');
  assert.equal(env.content.querySelector('.compact-data-table').getAttribute('data-cdt-selection'), 'none');
  assert.equal(env.content.querySelector('.album-track-table').getAttribute('data-playing-animation'), 'disabled');
  assert.equal(env.content.querySelectorAll('[data-cdt-column="path"]').length, 0);
  assert.equal(env.content.querySelectorAll('[data-cdt-column="love"]').length, 0);
  assert.equal(env.content.querySelectorAll('[data-cdt-column="rating"]').length, 0);
  assert.equal(env.content.querySelectorAll('[data-cdt-column="problem"]').length, 0);
  assert.deepEqual(env.content.querySelectorAll('.track-duration').map(node => node.textContent), ['—', '1:02:03']);
  assert.equal(env.content.querySelectorAll('.album-track-table__secondary')[0].textContent, 'Track artist');
  assert.equal(env.content.querySelector('.public-album-top__track-count').textContent, '2 published tracks · 2 on this page');
  assert.doesNotMatch(env.content.textContent, /Total Length|CD 1|ALBUM/);
});

test('hostile text is escaped by actual shared builders, never used as markup or links', () => {
  for (const payload of [top(), detail()]) {
    const row = payload.kind === 'top' ? payload.data.items[0] : payload.data.item;
    row.title = '<img src=x onerror="stolen()"> & </script>'; row.artist = '<script>bad()</script>';
    if (payload.kind === 'item') payload.data.tracks[0].title = '<audio autoplay src=x>';
    const env = environment(payload); safe(env);
    assert.match(env.content.textContent, /<img src=x onerror="stolen\(\)">/);
    assert.equal(env.content.querySelectorAll('script').length, 0);
  }
});

test('legitimate empty Top and zero-track DTO retain clear metadata-only empty states', () => {
  const empty = top(); empty.data.items = [];
  const env = environment(empty); safe(env); assert.match(env.content.textContent, /has no albums/);
  const zero = detail(); zero.data.tracks = []; zero.data.track_count = 0;
  const tracks = environment(zero); safe(tracks);
  assert.match(tracks.content.textContent, /0 published tracks · 0 on this page/);
  assert.match(tracks.content.textContent, /No tracks on this published page/);
});

test('maximum gallery and item page sizes remain bounded without automatic continuation', () => {
  const gallery = top(); gallery.limit = 100; gallery.data.items = Array.from({length: 100}, (_, index) => item(index + 1));
  gallery.data.next_cursor = 'opaque-next';
  const env = environment(gallery, {query: '?limit=100'}); safe(env); assert.equal(env.content.querySelectorAll('a').length, 100);
  const tracks = detail(); tracks.limit = 250; tracks.data.track_count = 5000; tracks.data.next_cursor = 'opaque-next';
  tracks.data.tracks = Array.from({length: 250}, (_, index) => ({track_ref: id(1000 + index), position: index + 251,
    title: `Track ${index + 251}`, artist: 'Artist', duration_ms: 0}));
  const next = environment(tracks, {query: '?limit=250&cursor=opaque-current'}); safe(next);
  assert.equal(next.content.querySelectorAll('.album-track-table__row').length, 250);
  assert.equal(next.content.querySelector('.album-track-table__number').textContent, '251');
  assert.equal(next.content.querySelector('.track-duration').textContent, '0:00');
  assert.equal(next.content.querySelector('.public-album-top__track-count').textContent, '5000 published tracks · 250 on this page');
});

const invalid = {
  'wrong share': value => {value.data.share_ref = id(9);},
  'wrong publication identity': value => {value.data.publication_ref = 'private-id';},
  'unsafe revision': value => {value.data.publication_revision = '9223372036854775808';},
  'false read action': value => {value.data.allowed_actions.can_read = false;},
  'numeric action': value => {value.data.allowed_actions.can_open_item = 1;},
  'extra private data': value => {value.data.context_ref = 'private';},
  'extra item grant': value => {value.data.items[0].can_play = true;},
  'external item link': value => {value.data.items[0].details_path = 'https://foreign.example/';},
  'encoded item path': value => {value.data.items[0].details_path += '%2f';},
  'invented artwork': value => {value.data.items[0].artwork_ref = id(5);},
  'duplicate row': value => {value.data.items[1] = clone(value.data.items[0]);},
  'position gap': value => {value.data.items[1].curator_position = 4;},
  'missing first row': value => {value.data.items = [item(2)];},
  'empty next cursor': value => {value.data.next_cursor = '';},
  'short continuation page': value => {value.data.next_cursor = 'next';},
  'over-limit rows': value => {value.data.items = Array.from({length: 51}, (_, index) => item(index + 1));},
  'control text': value => {value.data.items[0].title = 'bad\ntext';},
  'unpaired surrogate': value => {value.data.items[0].title = '\ud800';},
  'overlong title': value => {value.data.items[0].title = 'x'.repeat(1001);},
};
for (const [name, change] of Object.entries(invalid)) test(`invalid published payload fails closed: ${name}`, () => {
  const value = top(); change(value); unavailable(environment(value));
});
for (const [name, change] of Object.entries({
  'item identity mismatch': value => {value.data.item.item_ref = id(999);},
  'negative duration': value => {value.data.tracks[0].duration_ms = -1;},
  'private track path': value => {value.data.tracks[0].path = '/private';},
  'noncontiguous tracks': value => {value.data.tracks[1].position = 4;},
  'count below rows': value => {value.data.track_count = 1;},
  'count above bound': value => {value.data.track_count = 5001;},
})) test(`invalid item payload fails closed: ${name}`, () => {const value = detail(); change(value); unavailable(environment(value));});

for (const options of [{path: `/public/album-tops/${id(99)}`}, {query: '?q=private'}, {query: '?limit=50&limit=50'},
  {query: '?limit=050'}, {query: '?limit=100'}, {query: '?cursor='}, {query: '?cursor=' + 'x'.repeat(4097)},
  {raw: '{broken'}, {raw: ' '.repeat(8000001)}]) {
  test(`invalid route or JSON retires metadata: ${JSON.stringify(options).slice(0, 70)}`, () => unavailable(environment(top(), options)));
}

test('maximum Unicode metadata counts code points rather than rejecting valid surrogate pairs', () => {
  const value = top(); value.data.items[0].title = '🎵'.repeat(1000);
  const env = environment(value); safe(env); assert.equal(env.content.querySelector('.album-title').textContent, value.data.items[0].title);
});

test('pagehide removes all metadata, heading and payload; ordinary pageshow cannot resurrect it', () => {
  const env = environment(); safe(env); env.dispatch('pagehide');
  assert.equal(env.page.textContent, 'Loading published metadata…');
  assert.equal(env.document.title, 'Shared Album Top · AlbumHaven');
  env.dispatch('pageshow'); assert.equal(env.page.textContent, 'Loading published metadata…');
  assert.equal(env.reloads.length, 0); safe(env);
  assert.equal(env.content.textContent, '', 'retired detached content does not retain approved rows');
});

test('head entry registers retirement before deferred rendering and exposes metadata only after ready', () => {
  const env = environment(top(), {readyState: 'loading'});
  assert.equal(env.page.hidden, true); assert.equal(env.content.textContent, '');
  assert.equal(env.listeners.size, 2);
  env.ready(); safe(env); assert.equal(env.page.hidden, false);
  assert.equal(env.content.querySelectorAll('.album-card').length, 2);
});

test('retirement before DOM ready prevents deferred metadata exposure', () => {
  const env = environment(top(), {readyState: 'loading'});
  env.dispatch('pagehide'); env.ready();
  assert.equal(env.page.textContent, 'Loading published metadata…'); safe(env);
  env.dispatch('pageshow', {persisted: true}); assert.equal(env.reloads.length, 1);
});

test('persisted pageshow clears first and requires a fresh document response', () => {
  const env = environment(detail()); env.dispatch('pageshow', {persisted: true});
  assert.equal(env.page.textContent, 'Loading published metadata…'); assert.equal(env.reloads.length, 1); safe(env);
  env.dispatch('pageshow'); assert.equal(env.reloads.length, 1);
});

test('reload failure does not restore metadata or the retired DTO', () => {
  const env = environment(top(), {reloadError: true}); env.dispatch('pagehide'); env.dispatch('pageshow', {persisted: true});
  assert.equal(env.reloads.length, 1); assert.equal(env.page.textContent, 'Loading published metadata…'); safe(env);
});

test('actual builder failure clears the server heading and entire metadata region', () => {
  const env = environment(top(), {beforeBoot({context}) {
    context.buildGalleryCardHtml = () => {throw new Error('private failure detail');};
  }}); unavailable(env); assert.doesNotMatch(env.page.textContent, /private failure detail|Published Top/);
});

test('pagehide during a shared builder cannot commit stale markup after retirement', () => {
  const env = environment(top(), {beforeBoot({context, dispatch}) {
    const actual = context.buildGalleryCardHtml;
    context.buildGalleryCardHtml = options => {dispatch('pagehide'); return actual(options);};
  }});
  assert.equal(env.page.textContent, 'Loading published metadata…'); safe(env);
});

test('template delivers only direct existing native assets and the guest entry', () => {
  const template = readRepo('music_app/templates/public-album-top.html');
  for (const file of files) assert.ok(template.includes(`'${file}'`));
  for (const stylesheet of ['button-component.css', 'runtime/non-album-and-player.css', 'public-album-tops.css']) assert.ok(template.includes(`'${stylesheet}'`));
  assert.match(template, /payload \| tojson/);
  assert.match(template, /from "partials\/button.html" import ui_link/);
  assert.doesNotMatch(template, /appearance-bootstrap|capability-bootstrap|index-native|runtime-bundle|app\.js|private_ui_context|csrf|current_actor/);
  const css = readRepo('music_app/static/css/public-album-tops.css');
  assert.match(css, /body\.public-album-top-page \{[^}]*overflow: auto/);
  assert.match(css, /public-album-top__navigation \{[^}]*flex-wrap: wrap/);
  assert.match(css, /public-album-top__card-link:focus-visible/);
  assert.doesNotMatch(css, /@import|url\(/);
});
