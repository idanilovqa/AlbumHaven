'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {createNativeHomeRuntime, readRepo} = require('./native-home-harness.cjs');
const SHARE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PUBLICATION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PATH = '/public/album-tops/' + SHARE, WORKING = '/album-tops/public-link/' + SHARE;
const builders = ['markup-format-helpers.js', 'album-artbox.js', 'gallery-main-components.js',
  'gallery-card-component.js', 'album-details-components.js', 'compact-data-table.js', 'album-track-table.js'];
function fixture({absentBody = false} = {}) {
  const platform = createNativeHomeRuntime(), {document} = platform;
  const body = document.body; body.replaceChildren();
  if (absentBody) {body.remove(); document.body = null;}
  document.readyState = 'loading';
  const events = new Map(), forbidden = [], reloads = [];
  const context = vm.createContext({document, URLSearchParams,
    location: {pathname: PATH, search: '', reload() {reloads.push(true);}},
    addEventListener(type, handler) {assert.ok(!events.has(type)); events.set(type, handler);},
  }); context.window = context;
  for (const name of ['fetch', 'Audio', 'localStorage', 'sessionStorage', 'navigator', 'state', 'ButtonComponent',
    'playAlbum', 'openTrackModal', 'setTimeout', 'setInterval', 'requestAnimationFrame']) {
    Object.defineProperty(context, name, {get() {forbidden.push(name); throw new Error('Forbidden guest access: ' + name);}});
  }
  // Only actual inert builders are installed in the new guest realm.
  for (const file of builders) vm.runInContext(readRepo('music_app/static/js/runtime/' + file), context, {filename: file});
  vm.runInContext(readRepo('music_app/static/js/public-album-tops/page.js'), context, {filename: 'public-album-tops/page.js'});
  function insertPage() {
    if (!document.body) {document.body = body; document.documentElement.append(body);}
    const page = document.createElement('main'); page.id = 'public-album-top-page'; page.hidden = true;
    const heading = document.createElement('h1'); heading.textContent = 'Published metadata title';
    const action = document.createElement('a'); action.setAttribute('href', WORKING); action.textContent = 'Open in AlbumHaven';
    const content = document.createElement('div'); content.id = 'public-album-top-content';
    const payload = document.createElement('script'); payload.id = 'public-album-top-data'; payload.type = 'application/json';
    payload.textContent = JSON.stringify({kind: 'top', share_ref: SHARE, item_ref: null, limit: 50,
      data: {share_ref: SHARE, publication_ref: PUBLICATION, publication_revision: '2', title: 'Published metadata title',
        description: 'Approved description', items: [], next_cursor: null, allowed_actions: {can_read: true, can_open_item: true}}});
    page.append(heading, action, content, payload); body.append(page);
    return {page, action, content, payload};
  }
  return {document, context, forbidden, reloads, platform, insertPage,
    dispatch(type, patch = {}) {events.get(type)?.({type, persisted: false, ...patch});},
    ready() {document.readyState = 'complete'; document.dispatchEvent(new platform.context.Event('DOMContentLoaded'));}};
}
function retired(env, nodes) {
  assert.equal(nodes.page.hidden, false);
  assert.equal(nodes.page.textContent, 'Loading published metadata…');
  assert.equal(nodes.page.querySelector('a'), null);
  assert.equal(nodes.action.isConnected, false, 'quiet working action retires with the metadata region');
  assert.equal(nodes.content.textContent, ''); assert.equal(nodes.payload.textContent, '');
  assert.equal(env.document.getElementById('public-album-top-data'), null);
  assert.deepEqual(env.forbidden, []); assert.deepEqual(env.platform.forbiddenCalls, []);
}

test('new working navigation anchor is retired with the actual guest main and cannot return from BFCache', () => {
  const env = fixture(), nodes = env.insertPage(); env.ready();
  assert.equal(nodes.page.hidden, false); assert.equal(nodes.action.isConnected, true);
  assert.equal(nodes.action.getAttribute('href'), WORKING);
  assert.match(nodes.content.textContent, /has no albums/);
  env.dispatch('pagehide'); retired(env, nodes);
  env.dispatch('pageshow'); retired(env, nodes); assert.equal(env.reloads.length, 0);
  env.dispatch('pageshow', {persisted: true}); retired(env, nodes); assert.equal(env.reloads.length, 1);
});

test('head pagehide with genuinely absent body and main retires markup inserted later before DOM ready', () => {
  const env = fixture({absentBody: true});
  assert.equal(env.document.body, null); assert.equal(env.document.querySelector('body'), null);
  assert.equal(env.document.getElementById('public-album-top-page'), null);
  env.dispatch('pagehide');
  const nodes = env.insertPage();
  assert.equal(nodes.page.hidden, true); assert.equal(nodes.action.isConnected, true);
  env.ready(); retired(env, nodes);
  env.dispatch('pageshow', {persisted: true}); retired(env, nodes); assert.equal(env.reloads.length, 1);
});

test('persisted pageshow before body insertion also prevents later action or metadata exposure', () => {
  const env = fixture({absentBody: true}); env.dispatch('pageshow', {persisted: true});
  assert.equal(env.reloads.length, 1);
  const nodes = env.insertPage(); env.ready(); retired(env, nodes);
});
