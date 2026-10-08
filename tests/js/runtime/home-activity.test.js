const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const {pathToFileURL} = require('node:url');
const React = require('react');
const {renderToStaticMarkup} = require('react-dom/server');
const {buildSync} = require('esbuild');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');

const repo = path.resolve(__dirname, '../../..');
// Source-level presentation contracts against published native components.
// This fixture supplies DTOs only; it is not transport or browser acceptance.
const built = buildSync({entryPoints: [path.join(repo, 'music_app/static/js/home-friends/activity.jsx')],
  bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react', 'react-dom']});
const loaded = new Module(`${__filename}.fixture.cjs`, module);
loaded.filename = `${__filename}.fixture.cjs`; loaded.paths = module.paths;
loaded._compile(built.outputFiles[0].text, loaded.filename);
const {ActivityPanel, activityTimestamp, projectActivityRows} = loaded.exports;
const native = createNativeHomeRuntime();
for (const file of ['compact-data-table.js', 'album-track-table.js', 'trigger-anchor.js', 'library-settings.js']) {
  vm.runInContext(fs.readFileSync(path.join(repo, 'music_app/static/js/runtime', file), 'utf8'), native.context);
}
const artistTemplate = native.document.createElement('script');
artistTemplate.id = 'navigation-tree-item-template';
artistTemplate.textContent = fs.readFileSync(path.join(repo, 'music_app/templates/components/navigation-tree-item.html'), 'utf8');
native.document.body.appendChild(artistTemplate);
vm.runInContext(fs.readFileSync(path.join(repo, 'music_app/static/js/navigation-tree.js'), 'utf8'), native.context);
const runtime = {
  openChoice: native.context.openUtilityChoiceDropdown,
  buttonHtml: config => native.context.ButtonComponent.renderButton(config),
  actionHtml: config => native.context.ButtonComponent.renderActionButton(config),
  alertHtml: config => native.context.buildOnPageAlertHtml(config),
  tableHtml: config => native.context.buildCompactDataTable(config),
  galleryCardHtml: config => native.context.buildGalleryCardHtml(config),
  artboxHtml: config => native.context.buildAlbumArtboxHtml(config),
  navigationItemHtml: config => native.context.NavigationTree.renderItem(config),
  albumTrackRow: (track, index) => native.context.buildAlbumTrackTableRow(track, index, {readOnly: true}),
  escapeHtml: native.context.escapeHtml,
  preferredTimeZone: () => 'UTC',
};
const row = (id, extra = {}) => ({id, kind: 'track', title: `Title ${id}`, artist: 'Artist', album_title: 'Album',
  listen_count: null, rating: null, duration_seconds: null, last_listened_at: null, artwork_url: null, ...extra});
const ids = rows => Array.from(rows, item => item.id);
const render = props => renderToStaticMarkup(React.createElement(ActivityPanel, {runtime, ...props}));
const documentOf = html => {const host = native.document.createElement('div'); host.innerHTML = html; return host;};
const ready = rows => ({status: 'ready', data: {rows, total_listens: null, next_cursor: null}});
const headerLabel = node => (node.querySelector('.compact-data-table__sort-label') || node).textContent;
const elements = node => React.isValidElement(node) ? [node, ...React.Children.toArray(node.props.children).flatMap(elements)] : [];
const activityTable = tree => elements(tree).find(element => element.type?.name === 'NativeHtml' && element.props.onClick);
const activityChoice = tree => elements(tree).find(element => element.type?.name === 'NativeChoice');
const activityArtists = tree => elements(tree).find(element => element.type?.name === 'ArtistSelectionRows');

// A bounded hook/DOM probe drives the real callbacks and layout effects. It does
// not claim React reconciliation, native Choice ownership or browser acceptance.
function activityLifecycle(overrides = {}) {
  const env = createNativeHomeRuntime(), host = env.document.createElement('section');
  env.document.body.appendChild(host);
  host.constructor.prototype.focus = function () {if (this.isConnected && !this.disabled) env.document.activeElement = this;};
  const slots = []; let cursor = 0, pending = [], tree;
  const currentRuntime = {...runtime, ...overrides};
  const changed = (old, deps) => !old || !deps || deps.some((value, index) => !Object.is(value, old.deps[index]));
  const hooks = {...React,
    useRef(value) {const index = cursor++; return slots[index] ||= {current: value};},
    useMemo(factory, deps) {const index = cursor++; if (changed(slots[index], deps)) slots[index] = {deps, value: factory()}; return slots[index].value;},
    useState(value) {const index = cursor++; slots[index] ||= {value: typeof value === 'function' ? value() : value};
      return [slots[index].value, next => {slots[index].value = typeof next === 'function' ? next(slots[index].value) : next;}];},
    useLayoutEffect(effect, deps) {const index = cursor++, old = slots[index];
      if (changed(old, deps)) pending.push(() => {old?.cleanup?.(); slots[index] = {deps, cleanup: effect()};});},
  };
  const fixture = {exports: {}};
  vm.runInNewContext(built.outputFiles[0].text, {module: fixture, exports: fixture.exports,
    require: name => name === 'react' ? hooks : require(name), console, AbortController});
  let previousHtml;
  return {env, host, runtime: currentRuntime,
    render(props) {
      cursor = 0; pending = [];
      tree = fixture.exports.ActivityPanel({runtime: currentRuntime, kind: 'tracks', scopeKey: 'activity:actor', ...props});
      tree.props.ref.current = host;
      const trackHost = elements(tree).find(element => element.type === 'div' && element.props.className === 'album-track-table' && element.props.ref);
      if (trackHost) trackHost.props.ref.current = host;
      const table = activityTable(tree);
      const html = table ? table.props.html : elements(tree).filter(element => element.type?.name === 'NativeHtml').map(element => element.props.html).join('');
      if (html !== previousHtml) {host.innerHTML = html; previousHtml = html;}
      for (const effect of pending) effect();
      return tree;
    },
    emit(name, target, patch = {}) {
      const type = {onClick: 'click', onDoubleClick: 'dblclick', onKeyDown: 'keydown', onContextMenu: 'contextmenu'}[name];
      const event = Object.assign(env.event(type, target), {detail: 1}, patch);
      if (name === 'onKeyDown') tree.props.onKeyDownCapture?.(event);
      if (!event.stopped) target.dispatchEvent(event);
      if (!event.stopped) (name === 'onClick' ? activityTable(tree).props : tree.props)[name]?.(event);
      return event;
    },
    dispose() {for (const slot of slots) slot?.cleanup?.(); host.remove();},
  };
}

test('server order is preserved verbatim in a new array, including ties and unknown values', () => {
  const rows = Object.freeze([row('third'), row('first', {listen_count: 7}), row('second', {listen_count: 7})].map(Object.freeze));
  const projected = projectActivityRows(rows);
  assert.notEqual(projected, rows);
  assert.deepEqual(ids(projected), ['third', 'first', 'second']);
  assert.equal(projected[0], rows[0]);
  assert.deepEqual(ids(rows), ['third', 'first', 'second']);
});

test('listen sorting keeps unknown values last, preserves explicit zero, and leaves tie order stable', () => {
  const rows = Object.freeze([row('unknown'), row('zero', {listen_count: 0}), row('b', {listen_count: 3}),
    row('a', {listen_count: 3}), row('high', {listen_count: 9})].map(Object.freeze));
  assert.deepEqual(ids(projectActivityRows(rows, 'listen_count')), ['high', 'b', 'a', 'zero', 'unknown']);
  assert.deepEqual(ids(projectActivityRows(rows, 'listen_count', true)), ['zero', 'b', 'a', 'high', 'unknown']);
  assert.deepEqual(ids(rows), ['unknown', 'zero', 'b', 'a', 'high']);
});

test('length sorting uses only numeric seconds, preserves zero and ties, and restores exact server order', () => {
  const rows = Object.freeze([row('display-only', {duration_display: '0:01'}), row('high', {duration_seconds: 600}),
    row('tie-first', {duration_seconds: 125.9}), row('zero', {duration_seconds: 0}),
    row('tie-second', {duration_seconds: 125.9}), row('numeric-string', {duration_seconds: '1'}),
    row('non-finite', {duration_seconds: Infinity})].map(Object.freeze));
  assert.deepEqual(ids(projectActivityRows(rows, 'duration_seconds', true)),
    ['zero', 'tie-first', 'tie-second', 'high', 'display-only', 'numeric-string', 'non-finite']);
  assert.deepEqual(ids(projectActivityRows(rows, 'duration_seconds')),
    ['high', 'tie-first', 'tie-second', 'zero', 'display-only', 'numeric-string', 'non-finite']);
  assert.deepEqual(ids(projectActivityRows(rows)), ids(rows));
});

test('native metric headers cycle with the Activity order Choice and preserve selection and source rows', t => {
  const rows = Object.freeze([row('unknown'), row('high', {listen_count: 9, duration_seconds: 600}),
    row('zero', {listen_count: 0, duration_seconds: 0}), row('middle', {listen_count: 3, duration_seconds: 120})].map(Object.freeze));
  const value = ready(rows), fixture = activityLifecycle(); t.after(() => fixture.dispose());
  let tree = fixture.render({value});
  fixture.emit('onClick', fixture.host.querySelector('[data-home-activity-row="high"]'));
  tree = fixture.render({value});
  for (const [key, choiceValue] of [['listens', 'listen_count'], ['duration', 'duration_seconds']]) {
    for (const [direction, expected, order] of [
      ['ascending', ['zero', 'middle', 'high', 'unknown'], choiceValue],
      ['descending', ['high', 'middle', 'zero', 'unknown'], choiceValue],
      ['none', ['unknown', 'high', 'zero', 'middle'], 'server'],
    ]) {
      const heading = fixture.host.querySelector(`[data-cdt-sort="${key}"]`); heading.focus();
      const event = fixture.env.event('click', heading.querySelector('.compact-data-table__sort-label'));
      activityTable(tree).props.onClick(event); assert.equal(event.defaultPrevented, true);
      tree = fixture.render({value});
      assert.equal(activityChoice(tree).props.value, order);
      assert.equal(fixture.host.querySelector(`[role="columnheader"][data-cdt-column="${key}"]`).getAttribute('aria-sort'), direction);
      assert.deepEqual(fixture.host.querySelectorAll('[data-home-activity-select]').map(node => node.dataset.homeActivitySelect), expected);
      assert.equal(fixture.host.querySelector('[data-cdt-row-key="high"]').getAttribute('aria-selected'), 'true');
      assert.equal(fixture.env.document.activeElement, fixture.host.querySelector(`[data-cdt-sort="${key}"]`));
    }
  }
  activityChoice(tree).props.onChange('duration_seconds'); tree = fixture.render({value});
  assert.equal(fixture.host.querySelector('[data-cdt-column="duration"]').getAttribute('aria-sort'), 'descending');
  const direction = elements(tree).find(element => element.type?.name === 'Button' && String(element.props.children).startsWith('Sort '));
  direction.props.onClick(); tree = fixture.render({value});
  assert.equal(fixture.host.querySelector('[data-cdt-column="duration"]').getAttribute('aria-sort'), 'ascending');
  activityChoice(tree).props.onChange('server'); tree = fixture.render({value});
  assert.deepEqual(fixture.host.querySelectorAll('[data-home-activity-select]').map(node => node.dataset.homeActivitySelect), ids(rows));
  assert.deepEqual(ids(rows), ['unknown', 'high', 'zero', 'middle']);
  for (const [metadata, scope] of [[{next_cursor: 'opaque:next'}, 'Sorted within loaded history'],
    [{pagination: {mode: 'numbered', page: 2, page_size: 100, total_rows: 104}}, 'Sorted within this page']]) {
    const paged = {...value, data: {...value.data, ...metadata}};
    tree = fixture.render({value: paged});
    assert.equal(elements(tree).some(element => String(element.props.children).startsWith('Sorted within ')), false);
    activityChoice(tree).props.onChange('listen_count'); tree = fixture.render({value: paged});
    assert.equal(elements(tree).filter(element => element.type === 'span').some(element => element.props.children === scope), true);
    assert.deepEqual(ids(paged.data.rows), ids(rows), 'scoped sorting preserves provider-owned row order');
    activityChoice(tree).props.onChange('server'); tree = fixture.render({value: paged});
  }
});

test('pending activity sort focus never revives a replaced scope or steals another connected control', t => {
  for (const change of ['scope', 'resource', 'friend', 'period', 'focus']) {
    const fixture = activityLifecycle(); t.after(() => fixture.dispose());
    const value = ready([row('a', {listen_count: 2}), row('b', {listen_count: 1})]);
    const tree = fixture.render({value}), heading = fixture.host.querySelector('[data-cdt-sort="listens"]');
    heading.focus(); activityTable(tree).props.onClick(fixture.env.event('click', heading));
    const outside = fixture.env.document.createElement('button'); fixture.env.document.body.appendChild(outside);
    if (change === 'focus') outside.focus();
    fixture.render({value: change === 'resource' ? ready([row('new')]) : value,
      scopeKey: change === 'scope' ? 'activity:replacement' : 'activity:actor',
      account_ref: change === 'friend' ? 'friend:replacement' : null, period: change === 'period' ? 'all' : 'week'});
    assert.notEqual(fixture.env.document.activeElement, fixture.host.querySelector('[data-cdt-sort="listens"]'));
    if (change === 'focus') assert.equal(fixture.env.document.activeElement, outside);
  }
});

test('last-listened sorting compares instants across time zones and leaves missing dates last', () => {
  const rows = [row('unknown'), row('old', {last_listened_at: '2026-10-07T23:00:00Z'}),
    row('latest', {last_listened_at: '2026-10-08T03:00:00Z'}),
    row('offset', {last_listened_at: '2026-10-08T01:30:00+02:00'}),
    row('invalid', {last_listened_at: 'unknown'})];
  assert.deepEqual(ids(projectActivityRows(rows, 'last_listened_at')), ['latest', 'offset', 'old', 'unknown', 'invalid']);
  assert.deepEqual(ids(projectActivityRows(rows, 'last_listened_at', true)), ['old', 'offset', 'latest', 'unknown', 'invalid']);
});

test('name order ignores case and uses original row order to resolve equal names', () => {
  const rows = [row('z', {title: 'Zulu'}), row('a', {title: 'alpha'}), row('A', {title: 'ALPHA'}), row('b', {title: 'Beta'})];
  assert.deepEqual(ids(projectActivityRows(rows, 'title', true)), ['a', 'A', 'b', 'z']);
  assert.deepEqual(ids(projectActivityRows(rows, 'title')), ['z', 'b', 'a', 'A']);
});

test('activity timestamps use the preferred time zone and preserve a valid value if the zone is unsupported', () => {
  const timestamp = '2026-10-08T01:20:00Z';
  for (const zone of ['UTC', 'America/Los_Angeles']) {
    const expected = new Intl.DateTimeFormat(undefined, {dateStyle: 'medium', timeStyle: 'short', timeZone: zone}).format(new Date(timestamp));
    assert.equal(activityTimestamp(timestamp, zone), expected);
  }
  assert.equal(activityTimestamp(timestamp, 'Unsupported/Zone'), timestamp);
  for (const value of [null, '', false, 0, 'invalid']) assert.equal(activityTimestamp(value, 'UTC'), '–');
});

test('track activity renders real compact-table columns with explicit zero and unknown facts', () => {
  const html = render({kind: 'tracks', value: ready([row('known', {listen_count: 0, rating: 5, duration_seconds: 125.9}), row('unknown')])});
  const host = documentOf(html);
  assert.equal(host.querySelectorAll('.compact-data-table').length, 1);
  const columns = host.querySelectorAll('[role="columnheader"]').map(headerLabel);
  assert.deepEqual(columns, ['#', 'Track', 'Artist', 'Album', 'Availability', 'Love', 'Listens', 'Rating', 'Length', 'Last listened']);
  assert.deepEqual(host.querySelectorAll('[data-home-activity-select]').map(node => node.dataset.homeActivitySelect), ['known', 'unknown']);
  assert.match(html, /2:05/);
  assert.match(html, />0</);
  assert.match(html, />–</);
  const order = host.querySelector('button[aria-label="Activity order: Server order"]');
  assert.equal(order.getAttribute('aria-haspopup'), 'menu'); assert.equal(order.disabled, false);
  assert.equal(host.querySelector('select'), null);
  const direction = host.querySelector('button[aria-label="Sort ascending by the selected activity order"]');
  assert.equal(direction.disabled, true, 'server order has no client direction');
  assert.equal(direction.getAttribute('aria-disabled'), 'true');
  assert.ok(direction.classList.contains('action-button--bare')); assert.ok(direction.querySelector('svg'));
  assert.doesNotMatch(html, /data-track-path|data-play-track|data-open-tracklist/);
});

test('artists use native identity rows while individual listens keep their listening-event columns', () => {
  const artist = documentOf(render({kind: 'artists', value: ready([row('artist', {kind: 'artist', listen_count: 0})])}));
  assert.equal(artist.querySelectorAll('[data-navigation-tree-item="wide"]').length, 1);
  assert.equal(artist.querySelector('[data-home-artist-select]').dataset.homeArtistSelect, 'artist');
  assert.equal(artist.querySelector('.navigation-tree-count').textContent, '0');
  const listens = documentOf(render({kind: 'listens', value: ready([row('listen', {kind: 'listen'})])}));
  assert.equal(listens.querySelectorAll('[role="columnheader"]').at(-1).textContent, 'Listened at');
});

test('album views reuse inert GalleryCard and AlbumArtbox owners', () => {
  for (const [kind, view, display] of [['albums', 'covers', 'covers'], ['albums', 'cards', 'cards']]) {
    const html = render({kind, view, value: ready([row('opaque', {kind: kind.slice(0, -1), artwork_url: '/artwork/opaque'})])});
    const host = documentOf(html);
    assert.equal(host.querySelectorAll('.album-card').length, 1);
    assert.equal(host.querySelectorAll('.album-artbox').length, 1);
    assert.equal(host.querySelectorAll('[data-home-activity-select]').length, 1);
    assert.match(html, new RegExp(`data-gallery-display="${display}"`));
    assert.match(html, /data-gallery-card-interaction="none"/);
    assert.match(html, /src="\/artwork\/opaque"/);
    assert.doesNotMatch(html, /data-gallery-card-intent|data-album-key|data-track-path|data-open-tracklist|0 tracks/);
  }
  assert.deepEqual(native.forbiddenCalls, []);
});

test('every Artist view uses native rows or circles and keeps unknown and denied identities honest', () => {
  for (const view of ['rows', 'list', 'cards', 'covers', 'circles']) {
    const html = render({kind: 'artists', view, value: ready([
      row('known', {kind: 'artist', title: 'Known artist', artwork_url: '/artwork/artist', listen_count: 0}),
      row('unknown', {kind: 'artist', title: '', artwork_url: null}),
      row('denied', {kind: 'artist', source_readable: false, title: 'Private artist', artwork_url: '/artwork/private', listen_count: 987}),
    ])}), host = documentOf(html);
    assert.equal(host.querySelectorAll('[data-home-artist-select]').length, 3);
    assert.equal(host.querySelectorAll('.album-card').length, 0);
    assert.match(html, new RegExp(`home-artists--${['rows', 'list'].includes(view) ? 'rows' : 'circles'}`));
    for (const label of ['Known artist', 'Unknown artist', 'Unavailable artist']) assert.ok(host.textContent.includes(label));
    assert.match(html, /src="\/artwork\/artist"/);
    assert.doesNotMatch(html, /Private artist|artwork\/private|987|data-album-key|data-track-path/);
    const denied = host.querySelector('[data-home-artist-select="denied"]');
    assert.equal(denied.disabled, true); assert.equal(denied.getAttribute('aria-disabled'), 'true');
  }
});

test('unsafe provider text is escaped and unsafe artwork stays in the native empty state', () => {
  const malicious = row('id" onclick="bad', {kind: 'album', title: '<script>bad</script>',
    artist: '<img src=x onerror=bad>', artwork_url: 'javascript:bad'});
  for (const view of ['rows', 'covers']) {
    const html = render({kind: 'albums', view, value: ready([malicious])});
    assert.match(html, /&lt;script&gt;bad&lt;\/script&gt;/);
    if (view === 'rows') assert.match(html, /&lt;img src=x onerror=bad&gt;/);
    assert.doesNotMatch(html, /<script>|<img src=x|src="javascript:| onclick="bad/);
    if (view === 'covers') assert.match(html, /album-artbox--empty/);
  }
});

test('unreadable activity never renders stale rows or details in any view', () => {
  for (const status of ['loading', 'denied', 'unavailable', 'error', 'empty']) {
    for (const view of ['rows', 'covers']) {
      const html = render({kind: 'albums', view, value: {status, data: {rows: [row('private-id', {title: 'Private stale title'})]}}});
      assert.doesNotMatch(html, /private-id|Private stale title|data-home-activity-select=|Selected listening item/);
    }
  }
});

test('controlled resource selection reports the exact current row without creating another detail pane or playback', t => {
  for (const kind of ['album', 'artist']) for (const view of ['rows', 'cards', 'covers']) {
    const selected = row('resource', {kind, detail_ref: `${kind}:canonical`, allowed_actions: {can_view_details: true}});
    const value = ready([selected]), selections = [], plays = [], fixture = activityLifecycle({trackIntent: (...args) => plays.push(args)});
    t.after(() => fixture.dispose());
    const props = {value, kind: `${kind}s`, view, selectedResourceId: null, onResourceSelect: (...args) => selections.push(args)};
    let tree = fixture.render(props);
    assert.equal(elements(tree).some(element => element.type?.name === 'ResourceDetail'), false);
    if (kind === 'artist') activityArtists(tree).props.onSelect(selected);
    else if (view === 'rows') fixture.emit('onClick', fixture.host.querySelector('[data-home-activity-select="resource"]'));
    else elements(tree).find(element => element.props.attributes?.['data-home-activity-select'] === 'resource').props.onClick();
    assert.equal(selections.length, 1); assert.equal(selections[0][0], selected); assert.equal(selections[0][1], kind);
    tree = fixture.render({...props, selectedResourceId: selected.id});
    assert.equal(elements(tree).some(element => element.type?.name === 'ResourceDetail' || element.props['aria-label'] === 'Selected listening item'), false);
    if (kind === 'artist') assert.equal(activityArtists(tree).props.selectedId, selected.id);
    else if (view === 'rows') assert.equal(fixture.host.querySelector('[data-cdt-row-key="resource"]').getAttribute('aria-selected'), 'true');
    else assert.equal(elements(tree).find(element => element.props.attributes?.['data-home-activity-select'] === 'resource').props.selected, true);
    assert.deepEqual(plays, []);
  }
});

test('controlled resources retire on source, query or access changes and require deliberate reselection after restoration', t => {
  for (const change of ['source', 'scope', 'friend', 'period', 'kind', 'denied', 'removed', 'grant']) {
    const selected = row('resource', {kind: 'artist', detail_ref: 'artist:canonical', allowed_actions: {can_view_details: true}});
    const value = ready([selected]), selections = [], fixture = activityLifecycle(); t.after(() => fixture.dispose());
    const onResourceSelect = (...args) => selections.push(args);
    const props = {value, kind: 'artists', selectedResourceId: selected.id, onResourceSelect};
    assert.equal(activityArtists(fixture.render(props)).props.selectedId, selected.id);
    const replacement = {...props, ...{
      source: {value: ready([selected])}, scope: {scopeKey: 'activity:other'}, friend: {account_ref: 'friend:other'},
      period: {period: 'all'}, kind: {kind: 'albums'},
      denied: {value: ready([{...selected, source_readable: false}])}, removed: {value: ready([])},
      grant: {value: ready([{...selected, allowed_actions: {can_view_details: false}}])},
    }[change]};
    const retired = fixture.render(replacement);
    if (change !== 'kind') assert.equal(activityArtists(retired).props.selectedId, null, change);
    assert.equal(selections.length, 1, change); assert.equal(selections[0][0], null, change);
    fixture.render(replacement); assert.equal(selections.length, 1, `${change} clears once`);
    const restored = fixture.render(props);
    assert.equal(activityArtists(restored).props.selectedId, null, `${change} cannot revive an old id`);
    activityArtists(restored).props.onSelect(selected);
    assert.equal(selections.length, 2); assert.equal(selections[1][0], selected); assert.equal(selections[1][1], 'artist');
    assert.equal(activityArtists(fixture.render(props)).props.selectedId, selected.id);
  }
});

test('Artist consumer sorts exact rows, owns only its outlet, and rejects retired or forged child callbacks', t => {
  const a = row('a', {kind: 'artist', listen_count: 1}), b = row('b', {kind: 'artist', listen_count: 9});
  const value = ready([a, b]), selections = [], fixture = activityLifecycle(); t.after(() => fixture.dispose());
  const onResourceSelect = (...args) => selections.push(args), listenedAlbumsRef = () => {};
  const props = {value, kind: 'artists', onResourceSelect, listenedAlbumsRef, selectedResourceId: null};
  let tree = fixture.render(props), retired = activityArtists(tree).props.onSelect;
  assert.deepEqual(ids(activityArtists(tree).props.rows), ['a', 'b']);
  assert.equal(elements(tree).filter(element => element.props.ref === listenedAlbumsRef).length, 1);
  assert.equal(elements(fixture.render({...props, kind: 'tracks'})).some(element => element.props.ref === listenedAlbumsRef), false);
  retired(a); assert.deepEqual(selections, []);
  tree = fixture.render(props); activityChoice(tree).props.onChange('listen_count'); tree = fixture.render(props);
  assert.deepEqual(ids(activityArtists(tree).props.rows), ['b', 'a']); assert.deepEqual(ids(value.data.rows), ['a', 'b']);
  for (const candidate of [null, {...a}]) activityArtists(tree).props.onSelect(candidate);
  assert.deepEqual(selections, [], 'missing or cloned display rows are not current source authority');
  retired = activityArtists(tree).props.onSelect;
  fixture.render({...props, value: ready([a, b])}); retired(a); assert.deepEqual(selections, []);
  tree = fixture.render(props); retired = activityArtists(tree).props.onSelect;
  fixture.dispose(); retired(a); assert.deepEqual(selections, []);
});

test('Track details expose only granted canonical resource actions and ordinary selection remains local', t => {
  const target = kind => ({kind, ref: `${kind}:canonical`, allowed_actions: {can_view_details: true}});
  const selected = row('track', {album_target: target('album'), artist_target: target('artist')});
  const value = ready([selected]), selections = [], plays = [], fixture = activityLifecycle({trackIntent: (...args) => plays.push(args)});
  t.after(() => fixture.dispose()); const onResourceSelect = (...args) => selections.push(args);
  const props = {value, selectedResourceId: 'external-resource', onResourceSelect};
  fixture.render(props); fixture.emit('onClick', fixture.host.querySelector('[data-home-activity-select="track"]'));
  let tree = fixture.render(props);
  assert.ok(elements(tree).some(element => element.props['aria-label'] === 'Selected listening item'));
  assert.deepEqual(selections, []); assert.deepEqual(plays, []);
  const actions = elements(tree).filter(element => ['View Album', 'View Artist'].includes(element.props.children));
  assert.equal(actions.length, 2);
  for (const action of actions) action.props.onClick();
  assert.equal(selections.length, 2);
  for (const [index, kind] of ['album', 'artist'].entries()) {assert.equal(selections[index][0], selected); assert.equal(selections[index][1], kind);}
  const retired = actions[0].props.onClick;
  tree = fixture.render({...props, value: ready([{...selected, source_readable: false}])});
  retired(); assert.equal(selections.length, 2); assert.deepEqual(plays, []);
  for (const extra of [{}, {artist_target: {...target('artist'), ref: ''}},
    {album_target: {...target('album'), allowed_actions: {can_view_details: false}}}]) {
    const next = ready([row('next', extra)]); fixture.render({value: next, onResourceSelect});
    fixture.emit('onClick', fixture.host.querySelector('[data-home-activity-select="next"]'));
    tree = fixture.render({value: next, onResourceSelect});
    assert.equal(elements(tree).some(element => ['View Album', 'View Artist'].includes(element.props.children)), false);
  }
});

test('track selection and plain Enter preserve native rows; only explicit playback gestures send an intent', async t => {
  const plays = [], track = row('playable', {source_readable: true, availability: 'local', artwork_url: '/artwork/track'});
  const value = ready([track]), fixture = activityLifecycle({canTrackIntent: () => true,
    trackIntent: (...args) => {plays.push(args);}}); t.after(() => fixture.dispose());
  fixture.render({value, period: 'month'});
  const node = fixture.host.querySelector('[data-home-activity-row="playable"]');
  const title = node.querySelector('.album-track-table__title');
  fixture.emit('onClick', title); fixture.render({value, period: 'month'});
  fixture.emit('onKeyDown', node, {key: 'Enter'}); fixture.render({value, period: 'month'});
  assert.equal(fixture.host.querySelector('[data-home-activity-row="playable"]'), node);
  assert.equal(node.getAttribute('aria-selected'), 'true'); assert.deepEqual(plays, []);
  for (const [name, target, event] of [
    ['onDoubleClick', title, {button: 0}], ['onKeyDown', node, {key: 'Enter', ctrlKey: true}],
    ['onKeyDown', node, {key: 'Enter', metaKey: true}], ['onClick', node.querySelector('[data-home-activity-play]'), {}],
  ]) {fixture.emit(name, target, event); await Promise.resolve();}
  assert.equal(plays.length, 4);
  for (const [intent, source, context] of plays) {
    assert.equal(intent, 'play'); assert.equal(source, track);
    assert.equal(context.scopeKey, 'activity:actor'); assert.equal(context.account_ref, null);
    assert.equal(context.kind, 'tracks'); assert.equal(context.period, 'month');
  }
  for (const [name, target, event] of [
    ['onDoubleClick', node.querySelector('[data-home-activity-play]'), {button: 0}],
    ['onClick', node.querySelector('[data-home-activity-play]'), {detail: 2}],
    ['onKeyDown', node, {key: 'Enter', ctrlKey: true, repeat: true}],
    ['onKeyDown', node, {key: 'Enter', metaKey: true, isComposing: true}],
    ['onKeyDown', node, {key: 'Enter', ctrlKey: true, shiftKey: true}],
    ['onDoubleClick', title, {button: 2}],
  ]) fixture.emit(name, target, event);
  await Promise.resolve(); assert.equal(plays.length, 4);
});

test('Activity uses the common multi-selection action, preserves sorting, and retires source replacement', t => {
  const created = [], calls = [];
  const fixture = activityLifecycle({createPlaytableSource: require('./playtable-source-fixture.cjs').createSourceFactory(created),
    openPlaylistAction: (packet, lifetime, source, anchor) => calls.push({packet, lifetime, source, anchor})});
  t.after(() => fixture.dispose());
  const value = ready([row('b', {duration_seconds: 20}), row('a', {duration_seconds: 0})]);
  fixture.render({value});
  const rowFor = id => fixture.host.querySelector(`[data-home-activity-row="${id}"]`);
  fixture.emit('onClick', rowFor('b')); fixture.emit('onClick', rowFor('a'), {ctrlKey: true});
  fixture.emit('onContextMenu', rowFor('b'));
  assert.deepEqual(Array.from(calls[0].packet.row_keys), ['b', 'a']);
  assert.equal(calls[0].source.snapshot().instance, created[0].snapshot().instance);
  assert.equal(calls[0].packet.origin.tableKey, 'home-activity-tracks');
  fixture.emit('onClick', rowFor('a').querySelector('[data-home-activity-select]')); fixture.render({value});
  assert.equal(rowFor('b').getAttribute('aria-selected'), 'true'); assert.equal(rowFor('a').getAttribute('aria-selected'), 'true');
  fixture.emit('onClick', fixture.host.querySelector('[data-cdt-sort="duration"]')); fixture.render({value});
  assert.equal(created.length, 1); assert.equal(calls[0].lifetime.isCurrent(), false);
  fixture.emit('onContextMenu', rowFor('b'));
  assert.deepEqual(Array.from(calls[1].packet.row_keys), ['a', 'b']);
  assert.doesNotMatch(JSON.stringify(calls[1].packet) + fixture.host.innerHTML, /fixture-private/);
  assert.equal(calls[1].source.resolveRows(calls[1].packet.row_keys).rows.length, 2);
  fixture.render({value: ready(value.data.rows)});
  assert.equal(created.length, 2); assert.equal(calls[1].lifetime.isCurrent(), false);
  assert.equal(rowFor('a').hasAttribute('aria-selected'), false);
});

test('denied and missing track rows remain visible without granting playback or exposing denied metadata', t => {
  const calls = [], fixture = activityLifecycle({canTrackIntent: () => true, trackIntent: (...args) => calls.push(args)});
  t.after(() => fixture.dispose());
  fixture.render({value: ready([
    row('missing', {availability: 'missing', source_readable: true}),
    row('denied', {source_readable: false, title: 'Denied title', artist: 'Denied artist', album_title: 'Denied album',
      artwork_url: '/artwork/denied', path: '/private/music.flac', love_tier: 'obsessed'}),
  ])});
  const missing = fixture.host.querySelector('[data-home-activity-row="missing"]');
  const denied = fixture.host.querySelector('[data-home-activity-row="denied"]');
  assert.ok(missing.classList.contains('album-track-table__row--missing'));
  for (const node of [missing, denied]) {
    assert.equal(node.querySelector('[data-home-activity-play]').disabled, true);
    fixture.emit('onDoubleClick', node, {button: 0}); fixture.emit('onKeyDown', node, {key: 'Enter', ctrlKey: true});
  }
  assert.equal(denied.getAttribute('tabindex'), '-1'); assert.equal(denied.getAttribute('aria-disabled'), 'true');
  assert.ok(denied.querySelector('[data-album-artbox-state="empty"]'));
  assert.doesNotMatch(fixture.host.innerHTML, /Denied title|Denied artist|Denied album|artwork\/denied|private\/music|Obsessed/);
  fixture.emit('onClick', missing); fixture.render({value: ready([row('missing', {availability: 'missing', source_readable: true})])});
  const replacement = fixture.host.querySelector('[data-home-activity-row="missing"]');
  assert.equal(replacement.hasAttribute('aria-selected'), false);
  fixture.emit('onClick', replacement); assert.equal(replacement.getAttribute('aria-selected'), 'true');
  assert.deepEqual(calls, []);
});

test('overlap revocation removes selected track details and does not restore the old selection after reauthorization', async t => {
  const {createHomeFriendsController} = await import(pathToFileURL(path.join(repo, 'music_app/static/js/home-friends/model.mjs')));
  for (const failure of ['append', 'no-progress', 'malformed-pagination', 'invalid-cursor']) {
    let calls = 0; const original = row('a', {kind: 'listen', source_readable: true, title: 'Revoked title', artist: 'Revoked artist',
      album_title: 'Revoked album', artwork_url: '/artwork/revoked', love_tier: 'obsessed', detail_ref: 'detail:revoked',
      allowed_actions: {can_view_details: true}});
    const controller = createHomeFriendsController({providers: {readActivity: () => calls++ === 0
      ? {rows: [original], next_cursor: 'cursor:one'}
      : {rows: [{...original, source_readable: false}, ...(failure === 'no-progress' ? [] : [row('b', {kind: 'listen'})])],
        next_cursor: failure === 'invalid-cursor' ? 7 : 'cursor:two',
        ...(failure === 'malformed-pagination' ? {pagination: {mode: 'numbered', page: 'invalid'}} : {})}}});
    t.after(() => controller.dispose()); await controller.loadActivity({kind: 'listens'});
    const fixture = activityLifecycle(); t.after(() => fixture.dispose());
    fixture.render({value: controller.getSnapshot().activity, kind: 'listens'});
    fixture.emit('onClick', fixture.host.querySelector('[data-home-activity-select="a"]'));
    let tree = fixture.render({value: controller.getSnapshot().activity, kind: 'listens'});
    assert.ok(elements(tree).some(element => element.props['aria-label'] === 'Selected listening item'));
    await controller.loadMoreActivity(); tree = fixture.render({value: controller.getSnapshot().activity, kind: 'listens'});
    assert.equal(elements(tree).some(element => element.props['aria-label'] === 'Selected listening item'), false);
    assert.equal(fixture.host.querySelector('[data-home-activity-row="a"]').hasAttribute('aria-selected'), false);
    assert.doesNotMatch(fixture.host.innerHTML, /Revoked|artwork\/revoked|detail:revoked|Obsessed/);
    tree = fixture.render({value: ready([original]), kind: 'listens'});
    assert.equal(elements(tree).some(element => element.props['aria-label'] === 'Selected listening item'), false);
  }
});

test('album and artist revocations retire selected details and disable native Select controls in tables and cards', async t => {
  const {createHomeFriendsController} = await import(pathToFileURL(path.join(repo, 'music_app/static/js/home-friends/model.mjs')));
  for (const kind of ['album', 'artist']) for (const view of ['rows', 'cards', 'covers']) {
    let calls = 0; const original = row('a', {kind, title: 'Revoked title', artist: 'Revoked artist',
      artwork_url: '/artwork/revoked', detail_ref: 'detail:revoked', allowed_actions: {can_view_details: true}});
    const controller = createHomeFriendsController({providers: {readActivity: () => calls++ === 0
      ? {rows: [original], next_cursor: 'cursor:one'}
      : {rows: [{...original, source_readable: false}, row('b', {kind})], next_cursor: 'cursor:two', pagination: {mode: 'bad'}}}});
    t.after(() => controller.dispose()); await controller.loadActivity({kind: `${kind}s`});
    const fixture = activityLifecycle(); t.after(() => fixture.dispose());
    const props = () => ({value: controller.getSnapshot().activity, kind: `${kind}s`, view});
    let tree = fixture.render(props());
    if (kind === 'artist') activityArtists(tree).props.onSelect(controller.getSnapshot().activity.data.rows[0]);
    else if (view === 'rows') fixture.emit('onClick', fixture.host.querySelector('[data-home-activity-select="a"]'));
    else elements(tree).find(element => element.type?.name === 'Button' && element.props.attributes?.['data-home-activity-select'] === 'a').props.onClick();
    tree = fixture.render(props());
    assert.ok(elements(tree).some(element => element.props['aria-label'] === 'Selected listening item'));
    assert.ok(elements(tree).some(element => element.type?.name === 'ResourceDetail' && element.props.selection?.ref === 'detail:revoked'));
    await controller.loadMoreActivity(); tree = fixture.render(props());
    assert.equal(controller.getSnapshot().activityNavigation.status, 'error'); assert.equal(controller.getSnapshot().activity.data.rows.length, 1);
    assert.equal(elements(tree).some(element => element.props['aria-label'] === 'Selected listening item' || element.type?.name === 'ResourceDetail'), false);
    const html = render(props()), host = documentOf(html), button = host.querySelector(`[data-home-${kind === 'artist' ? 'artist' : 'activity'}-select="a"]`);
    assert.equal(button.disabled, true); assert.equal(button.getAttribute('aria-disabled'), 'true');
    assert.match(html, new RegExp(`Unavailable ${kind}`)); assert.doesNotMatch(html, /Revoked|artwork\/revoked|detail:revoked/);
    if (kind === 'artist') activityArtists(tree).props.onSelect(controller.getSnapshot().activity.data.rows[0]);
    else if (view === 'rows') fixture.emit('onClick', fixture.host.querySelector('[data-home-activity-select="a"]'));
    else {
      const control = elements(tree).find(element => element.type?.name === 'Button' && element.props.attributes?.['data-home-activity-select'] === 'a');
      assert.equal(control.props.disabled, true); control.props.onClick();
    }
    tree = fixture.render(props()); assert.equal(elements(tree).some(element => element.props['aria-label'] === 'Selected listening item'), false);
  }
});

test('retired playback callbacks recheck current resource, scope, query and native action owners', async t => {
  for (const change of ['resource', 'scope', 'friend', 'period', 'kind', 'grant', 'action', 'dispose']) {
    const plays = [], track = row('same', {source_readable: true, availability: 'local'}), value = ready([track]);
    const fixture = activityLifecycle({canTrackIntent: () => true, trackIntent: (...args) => plays.push(args)});
    t.after(() => fixture.dispose()); const original = fixture.render({value});
    const button = fixture.host.querySelector('[data-home-activity-play]');
    if (change === 'grant') fixture.runtime.canTrackIntent = () => false;
    else if (change === 'action') fixture.runtime.trackIntent = (...args) => plays.push(args);
    else if (change === 'dispose') fixture.dispose();
    else fixture.render({value, ...{
      resource: {value: ready([track])}, scope: {scopeKey: 'other:actor'}, friend: {account_ref: 'friend:one'},
      period: {period: 'all'}, kind: {kind: 'listens'},
    }[change]});
    activityTable(original).props.onClick(fixture.env.event('click', button));
    await Promise.resolve(); assert.deepEqual(plays, [], change);
  }
});

test('an earlier Home Play never replaces a newer native selection after the event turn', async t => {
  let nativeSelection = null; const calls = [], track = row('home:earlier'), value = ready([track]);
  const fixture = activityLifecycle({canTrackIntent: () => true, trackIntent: (intent, source) => {
    calls.push([intent, source]); nativeSelection = source.id; return Promise.resolve();
  }}); t.after(() => fixture.dispose()); fixture.render({value});
  fixture.emit('onClick', fixture.host.querySelector('[data-home-activity-play]'));
  assert.equal(nativeSelection, 'home:earlier', 'the native boundary receives the intent in the original interaction');
  nativeSelection = 'native:newer';
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(nativeSelection, 'native:newer'); assert.equal(calls.length, 1); assert.equal(calls[0][1], track);
});

test('playback errors expose a generic message and ignore cancellation and retired activity', async t => {
  for (const mode of ['failure', 'synchronous', 'cancelled', 'replaced']) {
    let reject; const track = row('play'), value = ready([track]);
    const fixture = activityLifecycle({canTrackIntent: () => true, trackIntent: () => {
      if (mode === 'synchronous') throw new Error('/private/media/path');
      return new Promise((resolve, fail) => {reject = fail;});
    }}); t.after(() => fixture.dispose());
    fixture.render({value}); fixture.emit('onClick', fixture.host.querySelector('[data-home-activity-play]'));
    await Promise.resolve();
    const next = mode === 'replaced' ? ready([row('next')]) : value;
    if (mode === 'replaced') fixture.render({value: next});
    reject?.(Object.assign(new Error('/private/media/path'), mode === 'cancelled' ? {name: 'AbortError'} : {}));
    await new Promise(resolve => setImmediate(resolve));
    const tree = fixture.render({value: next}), html = elements(tree).filter(element => element.type?.name === 'NativeHtml').map(element => element.props.html).join('');
    assert.doesNotMatch(html, /private\/media/);
    if (mode === 'failure' || mode === 'synchronous') assert.match(html, /This track could not be played/);
    else assert.doesNotMatch(html, /This track could not be played/);
  }
});

test('native player notifications paint exact current rows without replacing controls or selection', t => {
  let current = null, playing = false, canPlay = true; const subscriptions = new Set();
  const rows = [row('first'), row('second')], value = ready(rows);
  const fixture = activityLifecycle({trackPlayback: track => ({isCurrent: track.id === current, isPlaying: playing}),
    canTrackIntent: () => canPlay, trackIntent() {},
    subscribeTrackPlayback: listener => {subscriptions.add(listener); return () => subscriptions.delete(listener);}});
  t.after(() => fixture.dispose()); fixture.render({value});
  const first = fixture.host.querySelector('[data-home-activity-row="first"]'), second = fixture.host.querySelector('[data-home-activity-row="second"]');
  const button = first.querySelector('[data-home-activity-select]'); button.focus();
  fixture.emit('onClick', first);
  fixture.emit('onClick', button); fixture.render({value});
  current = 'second'; playing = true; for (const listener of subscriptions) listener();
  assert.equal(second.getAttribute('aria-current'), 'true'); assert.ok(second.classList.contains('album-track-table__row--playing'));
  assert.equal(first.getAttribute('aria-selected'), 'true'); assert.equal(fixture.env.document.activeElement, button);
  playing = false; for (const listener of subscriptions) listener();
  assert.equal(second.getAttribute('aria-current'), 'true'); assert.equal(second.classList.contains('album-track-table__row--playing'), false);
  assert.equal(fixture.host.querySelector('[data-home-activity-row="first"]'), first);
  assert.equal(fixture.host.querySelector('[data-home-activity-row="second"]'), second);
  canPlay = false; for (const listener of subscriptions) listener();
  assert.equal(second.querySelector('[data-home-activity-play]').disabled, true);
  assert.equal(second.querySelector('[data-home-activity-play]').getAttribute('aria-disabled'), 'true');
  fixture.dispose(); assert.equal(subscriptions.size, 0);
});

test('Love uses the own activity context, keeps its native control during acknowledgement, and leaves friends read-only', async t => {
  let preference = {identity: 'track:opaque', love_tier: 'off', rating: null, allowed_actions: {can_set_love_tier: true}};
  let acknowledge; const writes = [], track = row('love', {love_tier: 'off'}), value = ready([track]);
  const fixture = activityLifecycle({trackPreference: (row, context) => ({...preference,
    allowed_actions: {can_set_love_tier: context.account_ref === null}}),
    setTrackLove: args => {writes.push(args); return new Promise(resolve => {acknowledge = () => {
      preference = {...preference, love_tier: args.love_tier}; resolve(preference);
    };});}}); t.after(() => fixture.dispose()); fixture.render({value});
  const node = fixture.host.querySelector('[data-home-activity-row="love"]'), button = node.querySelector('[data-track-love]');
  assert.ok(button); button.focus(); fixture.emit('onClick', button); fixture.render({value});
  assert.equal(node.querySelector('[data-track-love]'), button); assert.equal(button.disabled, true);
  await Promise.resolve(); assert.equal(writes.length, 1); assert.equal(writes[0].row, track);
  assert.equal(writes[0].context.account_ref, null); assert.equal(writes[0].love_tier, 'loved');
  acknowledge(); await new Promise(resolve => setImmediate(resolve)); fixture.render({value});
  assert.equal(node.querySelector('[data-track-love]'), button); assert.equal(button.disabled, false);
  assert.equal(button.getAttribute('data-love-tier'), 'loved'); assert.equal(fixture.env.document.activeElement, button);
  fixture.render({value, account_ref: 'friend:one'});
  assert.equal(fixture.host.querySelector('[data-track-love]'), null);
  assert.equal(fixture.host.querySelector('[data-track-love-cell]').textContent, 'Loved');
});
