'use strict';
// Additive platform composition. The connected fixture loads whole production
// scripts in the checked-in manifest order, including the real request,
// normalizer, renderView, grid, transport and mobile-navigation owners. Native
// tests import the real delivered entry and its static module closure.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {fixture: connected, ordinary, read, plain, drain, deferred, ROOT} = require('../search-native-fixtures/actual-runtime.cjs');
const ARTIST = 'Canonical Artist';
const album = (id, patch = {}) => ({key: `artist-album-${id}`, name: `Release ${id}`, artist: ARTIST,
  year: 2000 + id % 20, edition: 'Original', path: `/library/${id}`, category: 'main_library',
  root_provenance: {categories: ['main_library']}, tracks: [], ...patch});
const group = (artist = ARTIST, albums = [album(1)], patch = {}) => ({artist, artist_display: artist, albums, ...patch});
function artistView(patch = {}) {
  const groups = [group()];
  return {...ordinary(), selected_artist: ARTIST, gallery_display_mode: 'cards', gallery_scale_percent: 100,
    related_filter_artists: [], primary_filter_active: false, related_artists: [],
    artist_groups: groups, primary_artist_groups: groups, family_artist_groups: [],
    album_count: 1, artist_count: 1, initial_view_partial: false,
    artist_page: {artist_ref: ARTIST, active_page_mode: 'info', page_modes: ['gallery', 'info'], default_page_mode: 'gallery'}, ...patch};
}
function vector(total, groupCount = 20) {
  assert.equal(total % groupCount, 0);
  return Array.from({length: groupCount}, (_, g) => group(g ? `Family ${g}` : ARTIST,
    Array.from({length: total / groupCount}, (_, i) => album(g * total / groupCount + i + 1,
      {artist: g ? `Family ${g}` : ARTIST, release_type: i % 3 === 0 ? 'compilation' : 'studio'}))));
}
function fixture(t, {mobile = false, ...options} = {}) {
  const h = connected(t, options), c = h.context, doc = h.document, proto = c.Element.prototype;
  // The appearance partial loads these whole component owners synchronously
  // before deferred runtime/bootstrap and native entry use them. The shared
  // connected fixture already supplies the actual ButtonComponent prerequisite.
  assert.equal(typeof c.ButtonComponent?.renderButton, 'function');
  for (const relative of ['music_app/static/js/editor-page.js', 'music_app/static/js/unfolding-action-button.js']) {
    vm.runInContext(read(relative), c, {filename: relative});
    h.loaded.push(relative);
  }
  assert.equal(typeof c.EditorPage?.mountFooter, 'function');
  assert.equal(typeof c.UnfoldingActionButton?.mount, 'function');
  // Add missing browser DOM APIs without changing a product function. Comments
  // must be real non-element nodes: docking assertions inspect their identity.
  const childBefore = proto.before;
  class Comment extends c.Node {
    constructor(data) {super(8); this.data = String(data);}
    get textContent() {return this.data;}
    set textContent(value) {this.data = String(value);}
    get outerHTML() {return `<!--${this.data}-->`;}
    before(...nodes) {return childBefore.apply(this, nodes);}
    replaceWith(...nodes) {if (!this.parentNode) return; for (const node of nodes) this.parentNode.insertBefore(node, this); this.remove();}
  }
  if (!doc.createComment) doc.createComment = data => new Comment(data);
  const insertAdjacentHTML = proto.insertAdjacentHTML;
  proto.insertAdjacentHTML = function(position, html) {
    const where = String(position).toLowerCase();
    if (where !== 'beforebegin' && where !== 'afterend') return insertAdjacentHTML.call(this, where, html);
    const parent = this.parentNode;
    if (!parent || parent.nodeType === 9) {
      const error = new Error('Adjacent sibling insertion requires a non-Document parent');
      error.name = 'NoModificationAllowedError'; throw error;
    }
    // Reuse the existing parser and node insertion/mutation observers intact.
    const holder = doc.createElement(parent.tagName?.toLowerCase() || 'div');
    insertAdjacentHTML.call(holder, 'beforeend', String(html));
    const reference = where === 'beforebegin' ? this : this.nextSibling;
    for (const node of [...holder.childNodes]) parent.insertBefore(node, reference);
  };
  if (!proto.isEqualNode) proto.isEqualNode = function(other) {
    if (!other || this.nodeType !== other.nodeType || this.tagName !== other.tagName) return false;
    const attrs = node => [...node.attributes].map(({name, value}) => [name, value]).sort(([a], [b]) => a.localeCompare(b));
    if (JSON.stringify(attrs(this)) !== JSON.stringify(attrs(other)) || this.childNodes.length !== other.childNodes.length) return false;
    return this.childNodes.every((node, i) => node.nodeType === 1 ? node.isEqualNode(other.childNodes[i])
      : node.nodeType === other.childNodes[i].nodeType && node.textContent === other.childNodes[i].textContent);
  };
  proto.scrollTo = function(arg, y) {this.scrollTop = typeof arg === 'object' ? Number(arg.top || 0) : Number(y || 0);};
  const focusLog = [], focus = proto.focus;
  proto.focus = function(options) {
    const trigger = this.closest?.('[data-album-key]');
    const indexed = trigger && c.getIndexedAlbum?.(trigger.getAttribute('data-album-key'));
    focusLog.push({node: this, options, connectedAtCall: this.isConnected,
      artistHostAtCall: this.closest?.('#artist-page-root'),
      albumKeyAtCall: trigger?.getAttribute('data-album-key') || null,
      versionKeyAtCall: trigger?.getAttribute('data-album-version-key') || (indexed ? c.getAlbumCardVersionKey(indexed) : null),
      triggerAtCall: trigger ? (trigger.classList.contains('cover') ? 'cover' : 'tracklist') : null});
    return focus.call(this, options);
  };
  const add = (tag, id, parent = h.main) => {const existing = id && doc.getElementById(id); if (existing) return existing;
    const node = doc.createElement(tag); if (id) node.id = id; parent.append(node); return node;};
  const viewport = doc.getElementById('albums-viewport');
  const rootTag = read('music_app/templates/index.html').match(/<([a-z]+)\b[^>]*\bid="artist-page-root"[^>]*>/);
  assert.ok(rootTag, 'served Artist host root is declared');
  const host = doc.createElement(rootTag[1]);
  // Initial served root has no content. No startup Artist rows are fabricated.
  host.id = 'artist-page-root'; host.hidden = true; h.scroll.insertBefore(host, viewport);
  const header = add('div', 'gallery-bar'); header.setAttribute('data-gallery-bar-instance', 'gallery');
  header.innerHTML = c.buildGalleryBarHtml({contextKind: 'gallery', albumCount: 0, artistCount: 0});
  h.main.insertBefore(header, h.scroll);
  // Platform shell slots consumed by the real mobile owner, with no replacement
  // navigation, form controller, album renderer, history serializer or router.
  const mobileHeader = add('header', 'mobile-page-header'); mobileHeader.hidden = true;
  for (const id of ['mobile-page-title', 'mobile-page-summary', 'mobile-back-button', 'mobile-library-button',
    'mobile-settings-actions', 'mobile-settings-button']) add(id.includes('button') ? 'button' : 'div', id, mobileHeader);
  const outlet = add('div', 'mobile-page-outlet'); outlet.hidden = true;
  const trackModal = add('div', 'track-modal', doc.body); trackModal.hidden = true;
  c.innerWidth = mobile ? 390 : 1200;
  doc.documentElement.clientWidth = c.innerWidth;
  const grid = h.owner('virtualGrid'), nodes = {viewport, container: grid.containerEl, top: grid.topSpacerEl, bottom: grid.bottomSpacerEl};
  let origin = 180, scrollY = 0;
  const geometry = ({width = mobile ? 374 : 1000, height = 600, contentOrigin = origin, top = scrollY} = {}) => {
    origin = contentOrigin; scrollY = top;
    Object.assign(h.scroll, {clientWidth: width, clientHeight: height, clientTop: 0, scrollTop: top, scrollHeight: 10000000});
    viewport.clientWidth = width; host.clientWidth = width;
    h.setRect(h.scroll, {x: 0, y: 80, width, height});
    h.setRect(viewport, {x: 0, y: 80 + origin - top, width, height: grid.totalHeight || 1});
    h.setRect(host, {x: 0, y: 80 - top, width, height: 1000});
  };
  geometry();
  // Browser coordinates follow scroll even when the production focus/anchor
  // owner writes scrollTop itself. Content origin is a controlled layout fact.
  viewport.getBoundingClientRect = () => ({x: 0, y: 80 + origin - h.scroll.scrollTop,
    left: 0, top: 80 + origin - h.scroll.scrollTop, width: viewport.clientWidth,
    height: grid.totalHeight || 1, right: viewport.clientWidth,
    bottom: 80 + origin - h.scroll.scrollTop + (grid.totalHeight || 1)});
  const scroll = top => {geometry({top}); h.dispatch(h.scroll, 'scroll'); h.flushFrames();};
  const frame = () => h.flushFrames();
  const resize = () => {for (const observer of h.resizers) if (!observer.retired)
    observer.callback([...observer.nodes].map(target => ({target, contentRect: target.getBoundingClientRect()}))); frame();};
  const runtime = () => c.AlbumHavenArtistPageRuntime;
  const section = name => {const toggle = [...host.querySelectorAll('button[aria-controls]')].find(node =>
    node.getAttribute('aria-controls')?.endsWith(`-${name}-panel`)
    || node.getAttribute('aria-controls')?.includes(`-${name}`));
    assert.ok(toggle, `actual ${name} disclosure exists`); return {toggle, panel: doc.getElementById(toggle.getAttribute('aria-controls'))};};
  const click = node => {assert.ok(node); return h.dispatch(node, 'click');};
  const refresh = (renderOptions = {}) => c.renderView(renderOptions);
  const admit = async (payload = artistView(), {push = true, renderOptions = {}} = {}) => {
    const request = h.requests.length;
    const url = c.buildApiUrl(payload);
    const work = h.read(url, renderOptions, push);
    assert.equal(h.requests.length, request + 1, 'real foreground request started'); h.reply(request, payload);
    const result = await work; assert.equal(result.error, undefined, result.error?.stack);
    assert.equal(result.value, true, 'real normalized response applied'); await drain(); return runtime().snapshot();
  };
  const identities = () => ({grid, ...nodes, host, header, slot: header.querySelector('[data-artist-page-action-slot="loved"]'),
    lease: grid._artistPageLease, scheduler: h.owner('galleryCoverLoadScheduler'), cache: grid.albumCardNodeCache});
  // History is the controllable browser boundary. Delaying go models the real
  // asynchronous traversal after shell reconciliation without replacing owners.
  const historyGo = h.history.go.bind(h.history), historyReplace = h.history.replaceState.bind(h.history);
  let held = false, pending = [], beforeHistory = null;
  h.history.go = delta => {beforeHistory?.('go', delta); if (held) pending.push(delta); else historyGo(delta);};
  h.history.replaceState = (...args) => {beforeHistory?.('replace', args); return historyReplace(...args);};
  const holdHistory = listener => {held = true; beforeHistory = listener || null;};
  const settleHistory = () => {assert.equal(pending.length, 1, 'one browser traversal is pending'); const delta = pending.shift(); held = false;
    beforeHistory = null; historyGo(delta);};
  const observeHistory = listener => {beforeHistory = listener;};
  const mobileState = () => h.owner('mobilePageState');
  const focusOpener = (kind = 'tracklist') => {
    const candidates = [...nodes.container.querySelectorAll('[data-album-key]')];
    const trigger = candidates.find(node => kind === 'cover' ? node.classList.contains('cover')
      : node.getAttribute('data-open-tracklist') === '1' && !node.classList.contains('cover'));
    assert.ok(trigger, `real ${kind} Discography opener exists`);
    h.setRect(trigger, {x: 20, y: 200, width: 120, height: 40});
    assert.ok(trigger.getClientRects().length, 'actual opener is eligible in visible geometry');
    assert.equal(trigger.closest('[hidden],[inert]'), null);
    trigger.focus(); assert.equal(doc.activeElement, trigger);
    const token = grid._artistPageLease.focusToken;
    assert.ok(token, 'actual delegated grid focus owner captured its token');
    const indexed = c.getIndexedAlbum(token.albumKey); assert.ok(indexed);
    assert.equal(token.versionKey, c.getAlbumCardVersionKey(indexed));
    assert.equal(token.trigger, kind);
    return {trigger, token, indexed, retiredNodes: new Set([host, ...host.querySelectorAll('*')])};
  };
  const openForm = options => c.openReactFormDialog({title: 'Artist action', pageId: 'artist-test-action', ...options});
  t.after(() => runtime()?.dispose());
  return {...h, host, header, grid, nodes, focusLog, geometry, scrollTo: scroll, frame, resize, runtime, section, click,
    refresh, admit, identities, holdHistory, settleHistory, observeHistory, mobileState, openForm,
    pendingHistory: () => [...pending], rawHistoryGo: historyGo, focusOpener};
}
module.exports = {fixture, artistView, album, group, vector, ARTIST, plain, drain, deferred, ROOT};
