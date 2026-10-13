const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const React = require('react');
const {buildSync} = require('esbuild');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');

const repo = path.resolve(__dirname, '../../..');
const built = buildSync({entryPoints: [path.join(repo, 'music_app/static/js/playlists/track-table.jsx')], bundle: true,
  platform: 'node', format: 'cjs', write: false, external: ['react', 'react-dom']}).outputFiles[0].text;
const row = (id, patch = {}) => ({row_key: `item:${id}`, playlist_item_id: id, title: id, source_readable: true,
  availability: 'local', duration_seconds: null, ...patch});
const children = node => React.isValidElement(node) ? [node, ...React.Children.toArray(node.props.children).flatMap(children)] : [];

// A bounded hook/DOM driver exercises the actual table component and handlers
// with the native HTML renderer. Commits and provider changes are explicit;
// browser event synthesis, layout and real React reconciliation remain E2E work.
function fixture(t, {rows, grants = {}, canPlay = true} = {}) {
  const native = createNativeHomeRuntime(), doc = native.document;
  for (const file of ['compact-data-table.js', 'album-track-table.js']) {
    vm.runInContext(fs.readFileSync(path.join(repo, 'music_app/static/js/runtime', file), 'utf8'), native.context);
  }
  const host = doc.createElement('div'); doc.body.appendChild(host);
  // Native harness event ownership, plus the minimal non-layout DOM APIs used
  // by the current column presenter. These cases never resize or start gestures.
  const win = doc.createElement('window'); doc.defaultView = win;
  Object.assign(win, {NodeFilter: {SHOW_TEXT: 4}, cancelAnimationFrame() {},
    MutationObserver: class {observe() {} disconnect() {}},
  });
  doc.createTreeWalker = root => {
    const texts = [], collect = node => {for (const child of node.childNodes) {
      if (child.nodeType === 3) texts.push(child); else collect(child);
    }};
    collect(root); let index = -1;
    return {currentNode: null, nextNode() {this.currentNode = texts[++index] || null; return Boolean(this.currentNode);}};
  };
  // No text/layout measurements are available in this bounded DOM seam.
  doc.createRange = () => ({selectNodeContents() {}, getBoundingClientRect: () => ({width: 0})});
  host.clientWidth = 832;
  const Element = host.constructor;
  Element.prototype.replaceWith = function (...nodes) {
    const parent = this.parentNode;
    if (parent) {for (const node of nodes) parent.insertBefore(node, this); this.remove();}
  };
  Element.prototype.focus = function () {if (this.isConnected && !this.disabled) doc.activeElement = this;};
  let detail = {playlist_id: 'table:owned', title: 'Owned playlist', track_rows: rows, items_complete: true, author_order: true,
    allowed_actions: {can_play: true, can_edit: true, can_reorder: true, ...grants}};
  let state = {scopeKey: 'scope:owned', selectedPlaylistId: detail.playlist_id, resource: {status: 'ready', data: {detail}},
    drafts: {}, filters: {}, mutation: {status: 'idle'}};
  const plays = [], selects = [], errors = [], moves = [];
  const controller = {getSnapshot: () => state, reorder: ids => {moves.push([...ids]); return true;}};
  const runtime = {escapeHtml: native.context.escapeHtml,
    buttonHtml: value => native.context.ButtonComponent.renderButton(value),
    actionHtml: value => native.context.ButtonComponent.renderActionButton(value), tableHtml: value => native.context.buildCompactDataTable(value),
    artboxHtml: value => native.context.buildAlbumArtboxHtml(value),
    albumTrackRow: (track, index) => native.context.buildAlbumTrackTableRow({...track, duration: track.duration_display}, index, {readOnly: true}),
    canTrackIntent: () => canPlay, trackIntent: (...args) => {plays.push(args);}};
  const slots = []; let cursor = 0, pending = [], tree, props, disposed = false;
  const changed = (old, deps) => !old || !deps || deps.length !== old.deps.length || deps.some((value, index) => !Object.is(value, old.deps[index]));
  const hooks = {...React,
    useRef(initial) {return slots[cursor++] ||= {current: initial};},
    useState(initial) {const slot = slots[cursor++] ||= {value: initial}; return [slot.value, value => {slot.value = typeof value === 'function' ? value(slot.value) : value;}];},
    useMemo(factory, deps) {const index = cursor++; if (changed(slots[index], deps)) slots[index] = {deps, value: factory()}; return slots[index].value;},
    useLayoutEffect(callback, deps) {const index = cursor++, old = slots[index]; if (changed(old, deps)) pending.push(() => {old?.cleanup?.(); slots[index] = {deps, cleanup: callback()};});},
  };
  const loaded = {exports: {}};
  vm.runInNewContext(built, {module: loaded, exports: loaded.exports, document: doc, console, AbortController,
    require(name) {
      if (name === 'react') return hooks;
      if (name === 'react-dom/client') return {createRoot() {assert.fail('This consumer uses the shared hook; native root mounting is tested separately.');}};
      assert.fail(`Unexpected dependency: ${name}`);
    }});
  function render(patch = {}) {
    assert.equal(disposed, false);
    props = {...{runtime, controller, rows, detail, state, selected: null, currentItemId: null,
      onSelect: value => selects.push(value), onError: value => errors.push(value)}, ...props, state, detail, rows, ...patch};
    cursor = 0; pending = []; tree = loaded.exports.PlaylistTracks(props);
    const table = children(tree).find(node => node.props.className?.split(' ').includes('playlists__tracks'));
    table.props.ref.current = host; host.className = table.props.className;
    for (const effect of pending) effect();
    return table.props;
  }
  function emit(name, target, values = {}, handlers = children(tree).find(node => node.props.className?.split(' ').includes('playlists__tracks')).props) {
    const type = {onClick: 'click', onDoubleClick: 'dblclick', onKeyDown: 'keydown', onContextMenu: 'contextmenu'}[name];
    const event = Object.assign(new native.context.Event(type), {button: 0, detail: 1}, values);
    event.target = target;
    if (name === 'onKeyDown') handlers.onKeyDownCapture?.(event);
    if (!event.stopped) target.dispatchEvent(event);
    if (!event.stopped) handlers[name]?.(event);
    return event;
  }
  function close() {if (disposed) return; disposed = true; for (const slot of slots) slot?.cleanup?.(); host.remove();}
  t.after(close); render();
  return {host, doc, runtime, plays, selects, render, emit,
    row: id => host.querySelector(`[data-playlist-row-key="item:${id}"]`),
  };
}

// Missing/unresolved inventory has no confirmed local source. Capability denial
// and a busy player are different states: their local controls remain disabled.
for (const availability of ['missing', 'unresolved']) {
  test(`saved ${availability} row hides Play without losing native selection or Review`, t => {
    const value = fixture(t, {rows: [row('subject', {availability})], canPlay: false});
    const element = value.row('subject');
    assert.equal(element.querySelector('[data-playlists-play]').hidden, true);
    assert.equal(element.getAttribute('tabindex'), '0');
    value.emit('onClick', element); value.render();
    assert.equal(value.row('subject').getAttribute('aria-selected'), 'true');
    const review = value.row('subject').querySelector('[data-playlists-select="review"]');
    assert.equal(review.disabled, false);
    value.emit('onClick', review);
    assert.equal(value.selects[0].row_key, 'item:subject');
    assert.deepEqual(value.plays, []);
  });
}
for (const [name, grants, canPlay, disabled] of [
  ['allowed', {}, true, false], ['permission denied', {can_play: false}, true, true], ['player busy', {}, false, true],
]) {
  test(`saved local ${name} retains its ${disabled ? 'disabled' : 'enabled'} Play control`, t => {
    const value = fixture(t, {rows: [row('local')], grants, canPlay});
    const play = value.row('local').querySelector('[data-playlists-play]');
    assert.equal(play.hidden, false); assert.equal(play.disabled, disabled);
    value.emit('onClick', play);
    assert.equal(value.plays.length, disabled ? 0 : 1);
    if (!disabled) assert.equal(value.plays[0][1].playlist_item_id, 'local');
  });
}

const draftBuilt = buildSync({entryPoints: [path.join(repo, 'music_app/static/js/playlists/draft.jsx')], bundle: true,
  platform: 'node', format: 'cjs', write: false, external: ['react', 'react-dom']}).outputFiles[0].text;
const draftModule = {exports: {}};
vm.runInNewContext(draftBuilt, {module: draftModule, exports: draftModule.exports, require, console, AbortController});
function draftTable(t, availability) {
  const value = fixture(t, {rows: [row('native-runtime')]});
  const entry = {row_key: 'entry:subject', entry_ref: 'subject', title: 'Original', artist: 'Artist', album_title: 'Album',
    availability, match_state: availability === 'local' ? 'accepted' : null, source_readable: true,
    metadata_state: 'unknown', duration_seconds: null, allowed_actions: {can_read: true, can_select: true}};
  const state = {title: 'Draft', selectedKeys: ['entry:subject']};
  const html = draftModule.exports.missingPlaylistDraftTableHtml(value.runtime, {id: 'unconfirmed-draft', state,
    projection: {entries: [entry], authoredEntries: [entry], canReorder: false}});
  const host = value.doc.createElement('div'); host.className = 'album-track-table'; host.innerHTML = html;
  return {host, state};
}
for (const [availability, hidden] of [['missing', true], ['unresolved', true], ['local', false]]) {
  test(`unsaved ${availability} row preserves checked selection and ${hidden ? 'hides' : 'disables'} Play`, t => {
    const {host, state} = draftTable(t, availability);
    const element = host.querySelector('[data-playlist-row-key="entry:subject"]');
    const play = element.querySelector('.album-track-table__play');
    assert.equal(play.hidden, hidden); assert.equal(play.disabled, true);
    assert.equal(element.getAttribute('tabindex'), '0');
    assert.equal(element.querySelector('[data-draft-pick]').hasAttribute('checked'), true);
    assert.equal(element.querySelector('[data-draft-review]').disabled, false);
    assert.deepEqual(state.selectedKeys, ['entry:subject']);
  });
}

// Bounded proof of the shared stylesheet's display/visibility cascade only.
// Not a browser or computed-style simulator. Only selectors targeting these two
// native classes are admitted; unsupported selector syntax fails loudly.
const css = fs.readFileSync(path.join(repo, 'music_app/static/css/runtime/album-track-table.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
function splitSelectors(text) {
  const result = []; let depth = 0, start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++;
    if (text[i] === ')') depth--;
    if (text[i] === ',' && depth === 0) {result.push(text.slice(start, i).trim()); start = i + 1;}
  }
  result.push(text.slice(start).trim()); return result;
}
// Resolve a relative selector as a sequence of descendant/child relations.
// Each compound selector is still checked by the native DOM harness; other
// combinators remain unsupported and fail rather than silently matching.
function relativeMatches(root, selector) {
  const tokens = selector.trim().split(/\s*(>)\s*|\s+(?![^\[]*\])/).filter(Boolean);
  let candidates = [root], direct = false;
  for (const token of tokens) {
    if (token === '>') {
      assert.equal(direct, false, 'Repeated child combinator');
      direct = true; continue;
    }
    candidates = candidates.flatMap(node => direct
      ? node.children.filter(child => child.matches(token)) : node.querySelectorAll(token));
    direct = false;
  }
  assert.equal(direct, false, 'Trailing child combinator');
  return candidates.length > 0;
}
function selectorMatches(element, selector, interaction) {
  // Resolve :is() alternatives and descendant :has() against actual native DOM.
  const functional = /:(is|has)\(([^()]*)\)/.exec(selector);
  if (functional) {
    const [whole, kind, argumentsText] = functional;
    const before = selector.slice(0, functional.index), after = selector.slice(functional.index + whole.length);
    if (kind === 'is') return splitSelectors(argumentsText).some(branch => selectorMatches(element, before + branch + after, interaction));
    const marker = 'data-test-has-hidden';
    const root = element.closest('.album-track-table');
    const nodes = [root, ...root.querySelectorAll('*')];
    for (const node of nodes) {
      node.removeAttribute(marker);
      if (splitSelectors(argumentsText).some(branch => relativeMatches(node, branch))) node.setAttribute(marker, 'true');
    }
    return selectorMatches(element, `${before}[${marker}]${after}`, interaction);
  }
  selector = selector.replace(/:hover|:focus-within/g, pseudo => pseudo === `:${interaction}` ? '[data-test-interaction]' : '[data-test-inactive]');
  return element.matches(selector);
}
function specificity(selector) {
  selector = selector.replace(/:(?:is|has)\(([^()]*)\)/g, (_, inside) => '.specificity'.repeat(Math.max(...splitSelectors(inside).map(specificity))));
  assert.doesNotMatch(selector, /#|:where\(/, 'Extend bounded cascade proof before adding a new specificity category');
  return (selector.match(/\.[\w-]+|\[[^\]]+\]|:[\w-]+/g) || []).length;
}
function declaredValue(element, property, interaction) {
  let winner = {value: property === 'visibility' ? 'visible' : 'inline', score: -1, important: false};
  for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const declaration = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`).exec(body);
    if (!declaration) continue;
    for (const selector of splitSelectors(selectors)) {
      const target = property === 'visibility' ? 'number' : 'play';
      if (!new RegExp(`\\.album-track-table__${target}(?:\\[[^\\]]+\\])?$`).test(selector)) continue;
      if (!selectorMatches(element, selector, interaction)) continue;
      const important = /!important/.test(declaration[1]), score = specificity(selector);
      if (important > winner.important || important === winner.important && score >= winner.score) {
        winner = {value: declaration[1].replace(/!important/, '').trim(), score, important};
      }
    }
  }
  return winner.value;
}
for (const surface of ['saved', 'draft']) for (const availability of ['missing', 'unresolved', 'local']) {
  test(`${surface} ${availability} native ordinal follows the shared hover/focus selector cascade`, t => {
    const host = surface === 'saved' ? fixture(t, {rows: [row('subject', {availability})], canPlay: false}).host : draftTable(t, availability).host;
    const element = host.querySelector('[data-playlist-row-key]');
    element.setAttribute('data-test-interaction', 'true');
    const number = element.querySelector('.album-track-table__number'), play = element.querySelector('.album-track-table__play');
    assert.equal(number.textContent, '1');
    for (const interaction of ['hover', 'focus-within']) {
      assert.equal(declaredValue(number, 'visibility', interaction), availability === 'local' ? 'hidden' : 'visible', interaction);
      assert.equal(declaredValue(play, 'display', interaction), availability === 'local' ? 'inline-grid' : 'none', interaction);
    }
  });
}
