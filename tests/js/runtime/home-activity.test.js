const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {fixture: nativeFixture, load} = require('./home-friends-native-app-fixture.cjs');
const repo = path.resolve(__dirname, '../../..');
let mountActivityPanel, activityTimestamp, projectActivityRows;
test.before(async () => {({mountActivityPanel, activityTimestamp, projectActivityRows} = await load('activity.mjs'));});
const row = (id, extra = {}) => ({id, kind: 'track', title: `Title ${id}`, artist: 'Artist', album_title: 'Album',
  listen_count: null, rating: null, duration_seconds: null, last_listened_at: null, artwork_url: null, ...extra});
const ids = rows => Array.from(rows, item => item.id);
const ready = rows => ({status: 'ready', data: {rows, total_listens: null, next_cursor: null}});
const headerLabel = node => (node.querySelector('.compact-data-table__sort-label') || node).textContent;
const visible = node => Boolean(node && !node.closest('[hidden]'));
const hasDetail = host => visible(host.querySelector('[aria-label="Selected listening item"]'));
const artistSelected = host => host.querySelector('[data-home-artist-select][aria-current="true"]')?.dataset.homeArtistSelect ?? null;
const resourceActions = host => host.querySelectorAll('button').filter(node => ['View Album', 'View Artist'].includes(node.textContent));
const choiceLabels = {server: 'Server order', last_listened_at: 'Last listened', listen_count: 'Listens', title: 'Name', duration_seconds: 'Length'};
const choiceValue = host => Object.keys(choiceLabels).find(key => host.querySelector(`[aria-label="Activity order: ${choiceLabels[key]}"]`));
const cleanups = [];
test.afterEach(() => {for (const cleanup of cleanups.splice(0).reverse()) cleanup();});
function activityLifecycle(overrides = {}) {
  const cleanup = [], env = nativeFixture({after: fn => cleanup.push(fn)});
  const {host, runtime} = env; Object.assign(runtime, {preferredTimeZone: () => 'UTC'}, overrides);
  let owner, disposed = false;
  const api = {env, host, runtime,
    render(props) {const next = {kind: 'tracks', scopeKey: 'activity:actor', ...props};
      if (!owner) owner = mountActivityPanel(host, runtime, next); else owner.update(next); return host;},
    emit(name, target, patch = {}) {assert.ok(target, `Native target for ${name} exists`);
      const type = {onClick: 'click', onDoubleClick: 'dblclick', onKeyDown: 'keydown', onContextMenu: 'contextmenu'}[name];
      const event = Object.assign(env.event(type, target), {detail: 1}, patch); target.dispatchEvent(event); return event;},
    choose(value) {api.emit('onClick', host.querySelector('.ui-choice__trigger'));
      const option = env.document.querySelector(`[data-foobar-format="${value}"]`); assert.ok(option, 'Real canonical Choice menu option exists');
      api.emit('onClick', option);},
    dispose() {if (disposed) return; disposed = true; owner?.dispose(); host.remove(); for (const fn of cleanup.reverse()) fn();},
  }; cleanups.push(api.dispose); return api;
}
// Rendering assertions serialize a genuinely mounted owner; no SSR or replacement view.
let lastEnvironment;
const render = props => {const fixture = activityLifecycle(); lastEnvironment = fixture.env; fixture.render(props);
  const html = fixture.host.innerHTML; assert.deepEqual(fixture.env.forbiddenCalls, []); fixture.dispose(); return html;};
const documentOf = html => {const host = lastEnvironment.document.createElement('div'); host.innerHTML = html; return host;};

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
  // Canonical presentation uses the table host measurement, not window width.
  fixture.env.setRect(fixture.host.querySelector('.album-track-table--collection'), {width: 1600, height: 600});
  tree = fixture.render({value});
  fixture.emit('onClick', fixture.host.querySelector('[data-home-activity-row="high"]'));
  tree = fixture.render({value});
  for (const [key, metricOrder] of [['listens', 'listen_count'], ['duration', 'duration_seconds']]) {
    for (const [direction, expected, order] of [
      ['ascending', ['zero', 'middle', 'high', 'unknown'], metricOrder],
      ['descending', ['high', 'middle', 'zero', 'unknown'], metricOrder],
      ['none', ['unknown', 'high', 'zero', 'middle'], 'server'],
    ]) {
      const heading = fixture.host.querySelector(`[data-cdt-sort="${key}"]`);
      assert.equal(heading.closest('[data-cdt-responsive-hidden]'), null, 'Sort interaction targets a visible column');
      heading.focus();
      const event = fixture.env.event('click', heading.querySelector('.compact-data-table__sort-label'));
      event.target.dispatchEvent(event); assert.equal(event.defaultPrevented, true);
      tree = fixture.render({value});
      assert.equal(choiceValue(tree), order);
      assert.equal(fixture.host.querySelector(`[role="columnheader"][data-cdt-column="${key}"]`).getAttribute('aria-sort'), direction);
      assert.deepEqual(fixture.host.querySelectorAll('[data-home-activity-select]').map(node => node.dataset.homeActivitySelect), expected);
      assert.equal(fixture.host.querySelector('[data-cdt-row-key="high"]').getAttribute('aria-selected'), 'true');
      assert.equal(fixture.env.document.activeElement, fixture.host.querySelector(`[data-cdt-sort="${key}"]`));
    }
  }
  fixture.choose('duration_seconds'); tree = fixture.render({value});
  assert.equal(fixture.host.querySelector('[data-cdt-column="duration"]').getAttribute('aria-sort'), 'descending');
  const direction = fixture.host.querySelectorAll('[aria-label]').find(node => node.getAttribute('aria-label').startsWith('Sort '));
  fixture.emit('onClick', direction); tree = fixture.render({value});
  assert.equal(fixture.host.querySelector('[data-cdt-column="duration"]').getAttribute('aria-sort'), 'ascending');
  fixture.choose('server'); tree = fixture.render({value});
  assert.deepEqual(fixture.host.querySelectorAll('[data-home-activity-select]').map(node => node.dataset.homeActivitySelect), ids(rows));
  assert.deepEqual(ids(rows), ['unknown', 'high', 'zero', 'middle']);
  for (const [metadata, scope] of [[{next_cursor: 'opaque:next'}, 'Sorted within loaded history'],
    [{pagination: {mode: 'numbered', page: 2, page_size: 100, total_rows: 104}}, 'Sorted within this page']]) {
    const paged = {...value, data: {...value.data, ...metadata}};
    tree = fixture.render({value: paged});
    assert.equal(tree.querySelectorAll('.home-friends__muted').some(node => visible(node) && node.textContent.startsWith('Sorted within ')), false);
    fixture.choose('listen_count'); tree = fixture.render({value: paged});
    assert.equal(tree.querySelectorAll('span').some(node => visible(node) && node.textContent === scope), true);
    assert.deepEqual(ids(paged.data.rows), ids(rows), 'scoped sorting preserves provider-owned row order');
    fixture.choose('server'); tree = fixture.render({value: paged});
  }
});

test('pending activity sort focus never revives a replaced scope or steals another connected control', t => {
  for (const change of ['scope', 'resource', 'friend', 'period', 'focus']) {
    const fixture = activityLifecycle(); t.after(() => fixture.dispose());
    const value = ready([row('a', {listen_count: 2}), row('b', {listen_count: 1})]);
    fixture.render({value});
    fixture.env.setRect(fixture.host.querySelector('.album-track-table--collection'), {width: 1600, height: 600});
    const tree = fixture.render({value}), heading = fixture.host.querySelector('[data-cdt-sort="listens"]');
    assert.equal(heading.closest('[data-cdt-responsive-hidden]'), null, 'Retirement begins from a visible sort control');
    heading.focus(); fixture.emit('onClick', heading);
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
  assert.deepEqual(lastEnvironment.forbiddenCalls, []);
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
    assert.equal(Boolean(tree.querySelector('.home-detail__selection')), false);
    fixture.emit('onClick', fixture.host.querySelector(`[data-home-${kind === 'artist' ? 'artist' : 'activity'}-select="resource"]`));
    assert.equal(selections.length, 1); assert.equal(selections[0][0], selected); assert.equal(selections[0][1], kind);
    tree = fixture.render({...props, selectedResourceId: selected.id});
    assert.equal(hasDetail(tree) || Boolean(tree.querySelector('.home-detail__selection')), false);
    if (kind === 'artist') assert.equal(artistSelected(tree), selected.id);
    else if (view === 'rows') assert.equal(fixture.host.querySelector('[data-cdt-row-key="resource"]').getAttribute('aria-selected'), 'true');
    else assert.equal(tree.querySelector('[data-home-activity-select="resource"]').getAttribute('aria-pressed') === 'true', true);
    assert.deepEqual(plays, []);
  }
});

test('controlled resources retire on source, query or access changes and require deliberate reselection after restoration', t => {
  for (const change of ['source', 'scope', 'friend', 'period', 'kind', 'denied', 'removed', 'grant']) {
    const selected = row('resource', {kind: 'artist', detail_ref: 'artist:canonical', allowed_actions: {can_view_details: true}});
    const value = ready([selected]), selections = [], fixture = activityLifecycle(); t.after(() => fixture.dispose());
    const onResourceSelect = (...args) => selections.push(args);
    const props = {value, kind: 'artists', selectedResourceId: selected.id, onResourceSelect};
    assert.equal(artistSelected(fixture.render(props)), selected.id);
    const replacement = {...props, ...{
      source: {value: ready([selected])}, scope: {scopeKey: 'activity:other'}, friend: {account_ref: 'friend:other'},
      period: {period: 'all'}, kind: {kind: 'albums'},
      denied: {value: ready([{...selected, source_readable: false}])}, removed: {value: ready([])},
      grant: {value: ready([{...selected, allowed_actions: {can_view_details: false}}])},
    }[change]};
    const retired = fixture.render(replacement);
    if (change !== 'kind') assert.equal(artistSelected(retired), null, change);
    assert.equal(selections.length, 1, change); assert.equal(selections[0][0], null, change);
    fixture.render(replacement); assert.equal(selections.length, 1, `${change} clears once`);
    const restored = fixture.render(props);
    assert.equal(artistSelected(restored), null, `${change} cannot revive an old id`);
    fixture.emit('onClick', restored.querySelector('[data-home-artist-select="resource"]'));
    assert.equal(selections.length, 2); assert.equal(selections[1][0], selected); assert.equal(selections[1][1], 'artist');
    assert.equal(artistSelected(fixture.render(props)), selected.id);
  }
});

test('Artist consumer sorts exact rows, owns only its outlet, and rejects retired or forged child callbacks', t => {
  const a = row('a', {kind: 'artist', listen_count: 1}), b = row('b', {kind: 'artist', listen_count: 9});
  const value = ready([a, b]), selections = [], outlets = [], fixture = activityLifecycle(); t.after(() => fixture.dispose());
  const onResourceSelect = (...args) => selections.push(args), listenedAlbumsRef = element => outlets.push(element);
  const props = {value, kind: 'artists', onResourceSelect, listenedAlbumsRef, selectedResourceId: null};
  const artistIds = () => fixture.host.querySelectorAll('[data-home-artist-select]').map(node => node.dataset.homeArtistSelect);
  let tree = fixture.render(props), retired = tree.querySelector('[data-home-artist-select="a"]');
  assert.deepEqual(artistIds(), ['a', 'b']);
  assert.equal(outlets.filter(Boolean).length, 1); assert.equal(outlets[0], tree.querySelector('.home-activity__listened-albums'));
  fixture.render({...props, kind: 'tracks'}); assert.equal(outlets.at(-1), null);
  fixture.emit('onClick', retired); assert.deepEqual(selections, []);
  tree = fixture.render(props); fixture.choose('listen_count'); tree = fixture.render(props);
  assert.deepEqual(artistIds(), ['b', 'a']); assert.deepEqual(ids(value.data.rows), ['a', 'b']);
  // There is no public callback accepting a row object. Missing/forged DOM keys
  // cannot produce source authority; a live key resolves to the exact source row.
  const live = tree.querySelector('[data-home-artist-select="a"]');
  for (const key of ['', 'forged:not-a-source-row']) {
    live.setAttribute('data-home-artist-select', key); fixture.emit('onClick', live);
  }
  assert.deepEqual(selections, [], 'missing or forged keys are not current source authority');
  live.setAttribute('data-home-artist-select', 'a'); fixture.emit('onClick', live);
  assert.equal(selections.length, 1); assert.equal(selections[0][0], a); selections.length = 0;
  // Retain the actual old control across removal and same-ID reappearance.
  retired = live; fixture.render({...props, value: ready([])});
  fixture.render({...props, value: ready([a, b])}); fixture.emit('onClick', retired); assert.deepEqual(selections, []);
  tree = fixture.render(props); retired = tree.querySelector('[data-home-artist-select="a"]');
  fixture.dispose(); fixture.emit('onClick', retired); assert.deepEqual(selections, []);
});

test('Track details expose only granted canonical resource actions and ordinary selection remains local', t => {
  const target = kind => ({kind, ref: `${kind}:canonical`, allowed_actions: {can_view_details: true}});
  const selected = row('track', {album_target: target('album'), artist_target: target('artist')});
  const value = ready([selected]), selections = [], plays = [], fixture = activityLifecycle({trackIntent: (...args) => plays.push(args)});
  t.after(() => fixture.dispose()); const onResourceSelect = (...args) => selections.push(args);
  const props = {value, selectedResourceId: 'external-resource', onResourceSelect};
  fixture.render(props); fixture.emit('onClick', fixture.host.querySelector('[data-home-activity-select="track"]'));
  let tree = fixture.render(props);
  assert.ok(hasDetail(tree));
  assert.deepEqual(selections, []); assert.deepEqual(plays, []);
  const actions = resourceActions(tree);
  assert.equal(actions.length, 2);
  for (const action of actions) fixture.emit('onClick', action);
  assert.equal(selections.length, 2);
  for (const [index, kind] of ['album', 'artist'].entries()) {assert.equal(selections[index][0], selected); assert.equal(selections[index][1], kind);}
  const retired = actions[0];
  tree = fixture.render({...props, value: ready([{...selected, source_readable: false}])});
  fixture.emit('onClick', retired); assert.equal(selections.length, 2); assert.deepEqual(plays, []);
  for (const extra of [{}, {artist_target: {...target('artist'), ref: ''}},
    {album_target: {...target('album'), allowed_actions: {can_view_details: false}}}]) {
    const next = ready([row('next', extra)]); fixture.render({value: next, onResourceSelect});
    fixture.emit('onClick', fixture.host.querySelector('[data-home-activity-select="next"]'));
    tree = fixture.render({value: next, onResourceSelect});
    assert.equal(resourceActions(tree).length > 0, false);
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
  assert.equal(missing.querySelector('[data-home-activity-play]').hasAttribute('hidden'), true);
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
    assert.ok(hasDetail(tree));
    await controller.loadMoreActivity(); tree = fixture.render({value: controller.getSnapshot().activity, kind: 'listens'});
    assert.equal(hasDetail(tree), false);
    assert.equal(fixture.host.querySelector('[data-home-activity-row="a"]').hasAttribute('aria-selected'), false);
    assert.doesNotMatch(fixture.host.innerHTML, /Revoked|artwork\/revoked|detail:revoked|Obsessed/);
    tree = fixture.render({value: ready([original]), kind: 'listens'});
    assert.equal(hasDetail(tree), false);
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
    const detailReads = [], fixture = activityLifecycle(); t.after(() => fixture.dispose());
    const readDetail = request => {detailReads.push(request); return new Promise(() => {});};
    const props = () => ({value: controller.getSnapshot().activity, kind: `${kind}s`, view, readDetail});
    let tree = fixture.render(props());
    fixture.emit('onClick', tree.querySelector(`[data-home-${kind === 'artist' ? 'artist' : 'activity'}-select="a"]`));
    tree = fixture.render(props());
    assert.ok(hasDetail(tree));
    assert.ok(tree.querySelector('.home-detail__selection'), 'Actual ResourceDetail owner is mounted');
    assert.equal(detailReads.at(-1)?.ref, 'detail:revoked');
    await controller.loadMoreActivity(); tree = fixture.render(props());
    assert.equal(controller.getSnapshot().activityNavigation.status, 'error'); assert.equal(controller.getSnapshot().activity.data.rows.length, 1);
    assert.equal(hasDetail(tree) || Boolean(tree.querySelector('.home-detail__selection')), false);
    const html = render(props()), host = documentOf(html), button = host.querySelector(`[data-home-${kind === 'artist' ? 'artist' : 'activity'}-select="a"]`);
    assert.equal(button.disabled, true); assert.equal(button.getAttribute('aria-disabled'), 'true');
    assert.match(html, new RegExp(`Unavailable ${kind}`)); assert.doesNotMatch(html, /Revoked|artwork\/revoked|detail:revoked/);
    const control = tree.querySelector(`[data-home-${kind === 'artist' ? 'artist' : 'activity'}-select="a"]`);
    assert.equal(control.disabled, true); fixture.emit('onClick', control);
    tree = fixture.render(props()); assert.equal(hasDetail(tree), false);
  }
});

test('retired playback callbacks recheck current resource, scope, query and native action owners', async t => {
  for (const change of ['resource', 'scope', 'friend', 'period', 'kind', 'grant', 'action', 'dispose']) {
    const plays = [], track = row('same', {source_readable: true, availability: 'local'}), value = ready([track]);
    let duringAuthorityCheck = null;
    const fixture = activityLifecycle({canTrackIntent: () => {const callback = duringAuthorityCheck; duringAuthorityCheck = null; callback?.(); return true;},
      trackIntent: (...args) => plays.push(args)});
    t.after(() => fixture.dispose()); fixture.render({value});
    const button = fixture.host.querySelector('[data-home-activity-play]');
    // Actual public native authority callback may synchronously retire ownership.
    // The original private React handler cannot be captured in the native API.
    duringAuthorityCheck = () => {
      if (change === 'grant') fixture.runtime.canTrackIntent = () => false;
      else if (change === 'action') fixture.runtime.trackIntent = (...args) => plays.push(args);
      else if (change === 'dispose') fixture.dispose();
      else fixture.render({value, ...{
        resource: {value: ready([track])}, scope: {scopeKey: 'other:actor'}, friend: {account_ref: 'friend:one'},
        period: {period: 'all'}, kind: {kind: 'listens'},
      }[change]});
    };
    fixture.emit('onClick', button);
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
    const tree = fixture.render({value: next}), html = tree.innerHTML;
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
  const readonlyLove = fixture.host.querySelector('[data-track-love-cell] [role="img"]');
  assert.ok(readonlyLove);
  assert.equal(readonlyLove.getAttribute('aria-label'), 'Loved');
  assert.equal(readonlyLove.getAttribute('data-love-tier'), 'loved');
});


test('confirmed available replacement restores the Recent Play affordance', t => {
  const fixture = activityLifecycle({canTrackIntent: () => true, trackIntent() {}}); t.after(() => fixture.dispose());
  fixture.render({value: ready([row('same', {availability: 'missing', source_readable: true})])});
  assert.equal(fixture.host.querySelector('[data-home-activity-play]').hasAttribute('hidden'), true);
  fixture.render({value: ready([row('same', {availability: 'local', source_readable: true})])});
  const play = fixture.host.querySelector('[data-home-activity-play]');
  assert.equal(play.hasAttribute('hidden'), false); assert.equal(play.disabled, false);
});
