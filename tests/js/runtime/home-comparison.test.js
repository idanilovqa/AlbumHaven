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
// Source-level SSR/pure contract tests only. This is not a browser, provider,
// production transport, geometry, playback, or release-acceptance fixture.
const built = buildSync({entryPoints: [path.join(repo, 'music_app/static/js/home-friends/comparison.jsx')],
  bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react', 'react-dom']});
const loaded = new Module(`${__filename}.fixture.cjs`, module);
loaded.filename = `${__filename}.fixture.cjs`; loaded.paths = module.paths;
loaded._compile(built.outputFiles[0].text, loaded.filename);
const {ComparisonPanel, ComparisonControls, ComparisonCards, comparisonTableHtml,
  comparisonFacts, comparisonSelection, projectComparisonRows, restoreComparisonPresentation, reconcileComparisonSelection} = loaded.exports;
const model = import(pathToFileURL(path.join(repo, 'music_app/static/js/home-friends/model.mjs')));
const native = createNativeHomeRuntime();
for (const file of ['compact-data-table.js', 'trigger-anchor.js', 'library-settings.js']) {
  vm.runInContext(fs.readFileSync(path.join(repo, 'music_app/static/js/runtime', file), 'utf8'), native.context);
}
for (const file of ['unfolding-action-button.js', 'navigation-tree.js']) {
  vm.runInContext(fs.readFileSync(path.join(repo, 'music_app/static/js', file), 'utf8'), native.context);
}
const artistTemplate = native.document.createElement('script');
artistTemplate.id = 'navigation-tree-item-template';
artistTemplate.textContent = fs.readFileSync(path.join(repo, 'music_app/templates/components/navigation-tree-item.html'), 'utf8');
native.document.body.appendChild(artistTemplate);
const runtime = {
  openChoice: native.context.openUtilityChoiceDropdown,
  viewChooserHtml: config => native.context.UnfoldingActionButton.render(config),
  navigationItemHtml: config => native.context.NavigationTree.renderItem(config),
  buttonHtml: config => native.context.ButtonComponent.renderButton(config),
  actionHtml: config => native.context.ButtonComponent.renderActionButton(config),
  alertHtml: config => native.context.buildOnPageAlertHtml(config),
  tableHtml: config => native.context.buildCompactDataTable(config),
  galleryCardHtml: config => native.context.buildGalleryCardHtml(config),
  artboxHtml: config => native.context.buildAlbumArtboxHtml(config),
  escapeHtml: native.context.escapeHtml,
};
const side = (count, extra = {}) => ({listen_count: count, play_count: null, full_listen_count: null,
  favorite: null, rating: null, last_listened_at: null, ...extra});
const row = (id, yours, friend, extra = {}) => ({id, kind: 'track', title: `Title ${id}`, artist: 'An artist',
  yours: yours === null ? null : side(yours), friend: friend === null ? null : side(friend), ...extra});
const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, {runtime, ...props}));
const documentOf = html => {const element = native.document.createElement('div'); element.innerHTML = html; return element;};
const ids = rows => rows.map(item => item.id);
function allElements(node) {
  if (!React.isValidElement(node)) return [];
  return [node, ...React.Children.toArray(node.props.children).flatMap(allElements)];
}

test('default Common only requires known positive listens on both authorized sides', () => {
  const rows = Object.freeze([row('shared', 3, 2), row('own-only', 3, null), row('friend-only', null, 2),
    row('zero', 0, 2), row('unknown', null, null), row('invalid', 2, 2, {yours: side('2')}),
    row('other-kind', 5, 5, {kind: 'album'})].map(Object.freeze));
  assert.deepEqual(ids(projectComparisonRows(rows, 'tracks')), ['shared']);
  assert.equal(projectComparisonRows(rows, 'tracks', {commonOnly: false}).length, 6);
  assert.deepEqual(ids(rows), ['shared', 'own-only', 'friend-only', 'zero', 'unknown', 'invalid', 'other-kind']);
});

test('General ranks only known totals, keeps explicit zero and never treats an absent side as zero', () => {
  const rows = [row('a', 10, 1), row('b', 2, 20), row('z', 0, 0), row('missing', 100, null)];
  assert.deepEqual(ids(projectComparisonRows(rows, 'tracks', {commonOnly: false})), ['b', 'a', 'z', 'missing']);
  assert.deepEqual(ids(projectComparisonRows(rows, 'tracks', {commonOnly: false, ascending: true})), ['z', 'a', 'b', 'missing']);
  assert.equal(rows[3].friend, null);
});

test('each side order is independent and unknown scores stay last in both directions', () => {
  const rows = [row('a', 10, 1), row('b', 2, 20), row('unknown', null, null), row('zero', 0, 0)];
  assert.deepEqual(ids(projectComparisonRows(rows, 'tracks', {commonOnly: false, order: 'yours'})), ['a', 'b', 'zero', 'unknown']);
  assert.deepEqual(ids(projectComparisonRows(rows, 'tracks', {commonOnly: false, order: 'friend'})), ['b', 'a', 'zero', 'unknown']);
  assert.deepEqual(ids(projectComparisonRows(rows, 'tracks', {commonOnly: false, order: 'friend', ascending: true})), ['zero', 'a', 'b', 'unknown']);
});

test('sort ties are deterministic and combined overflow is not a fabricated total', () => {
  const rows = [row('b', 1, 1, {title: 'Same'}), row('a', 1, 1, {title: 'Same'}), row('large', Number.MAX_VALUE, Number.MAX_VALUE)];
  assert.deepEqual(ids(projectComparisonRows(rows, 'tracks')), ['a', 'b', 'large']);
  assert.deepEqual(ids(projectComparisonRows([...rows].reverse(), 'tracks', {ascending: true})), ['a', 'b', 'large']);
});

test('rating, favorite and PC remain separate nullable facts, including false and zero', () => {
  const own = comparisonFacts(side(0, {play_count: 7, rating: 0, favorite: false}), 'tracks');
  assert.deepEqual(own, [['listen_count', 'Listens', '0'], ['play_count', 'PC', '7'], ['rating', 'Rating', '0'], ['favorite', 'Favorite', 'No']]);
  assert.deepEqual(comparisonFacts(null, 'tracks').map(item => item[2]), ['–', '–', '–', '–']);
  assert.equal(comparisonFacts(side(4, {favorite: true}), 'tracks').at(-1)[2], 'Yes');
  assert.equal(comparisonFacts(side(4), 'albums').find(item => item[0] === 'full_listen_count')[2], '–');
  assert.deepEqual(comparisonFacts(side(4), 'artists').map(item => item[0]), ['listen_count', 'play_count']);
});

test('native comparison controls keep Common only and one native order Choice', () => {
  const changes = [];
  const props = {runtime, commonOnly: true, order: 'general',
    onCommonOnly: value => changes.push(['common', value]), onOrder: value => changes.push(['order', value])};
  const html = render(ComparisonControls, props), elements = allElements(ComparisonControls(props));
  const host = documentOf(html), choice = elements.find(element => element.type?.name === 'NativeChoice');
  assert.match(html, /type="checkbox" checked=""/);
  assert.equal(host.querySelector('button[aria-label="Comparison order: General"]').getAttribute('aria-haspopup'), 'menu');
  assert.deepEqual(choice.props.options, [['general', 'General'], ['yours', 'Yours first'], ['friend', 'Friend first']]);
  elements.find(element => element.type === 'input').props.onChange({target: {checked: false}});
  choice.props.onChange('friend');
  assert.deepEqual(changes, [['common', false], ['order', 'friend']]);
  assert.equal(host.querySelectorAll('button').length, 1, 'direction and view are owned by headings and the header chooser');
  assert.doesNotMatch(html, /Sort ascending|Sort descending|Small covers/);
});

test('native paired tables share one union row order and stable identity across both halves', () => {
  const rows = projectComparisonRows([row('two', 1, 2), row('one', 8, 3)], 'tracks');
  const element = documentOf(comparisonTableHtml(runtime, rows, 'tracks', 'Maya'));
  assert.equal(element.querySelectorAll('.compact-data-table').length, 1);
  assert.deepEqual(element.querySelectorAll('[data-comparison-id]').map(item => item.dataset.comparisonId), ['one', 'two']);
  for (const item of element.querySelectorAll('[data-comparison-id]')) {
    const triggers = item.querySelectorAll('[data-home-comparison-select]');
    assert.equal(triggers.length, 2);
    assert.deepEqual(triggers.map(button => button.dataset.homeComparisonSelect), [item.dataset.comparisonId, item.dataset.comparisonId]);
    assert.deepEqual(triggers.map(button => button.dataset.comparisonSide), ['yours', 'friend']);
  }
  assert.match(element.querySelectorAll('[data-cdt-column="yours"]')[0].textContent, /^Yours/);
  assert.match(element.querySelectorAll('[data-cdt-column="friend"]')[0].textContent, /^Maya/);
  assert.equal(element.querySelector('.compact-data-table').getAttribute('data-cdt-overflow'), 'none');
});

test('album Rows use paired native GalleryCard identities and supplied independent numeric cells', () => {
  const album = row('album:one', 8, null, {kind: 'album', artwork_url: '/artwork/album-1'});
  const html = comparisonTableHtml(runtime, [album], 'albums', 'Maya');
  const element = documentOf(html);
  assert.equal(element.querySelectorAll('.album-card').length, 2);
  assert.equal(element.querySelectorAll('.album-artbox').length, 2);
  assert.equal(element.querySelectorAll('[data-home-comparison-select]').length, 2);
  assert.match(html, /data-gallery-card-interaction="none"/);
  assert.match(html, /data-gallery-display="list"/);
  assert.match(html, /src="\/artwork\/album-1"/);
  assert.match(html, /Maya Track listens: unavailable/);
  assert.equal(element.querySelectorAll('[data-cdt-sort="yours:full_listen_count"]').length, 1);
  assert.doesNotMatch(html, /0 tracks|data-open-tracklist|data-album-key|data-track-path|play-track|data-gallery-card-intent/);
});

test('small covers preserve paired album identities with inert native cards and explicit Details controls', () => {
  const albums = [row('album-a', 8, null, {kind: 'album'}), row('album-b', 2, 4, {kind: 'album'})];
  const html = render(ComparisonCards, {rows: albums, friendName: 'Maya', onSelect() {}});
  const element = documentOf(html);
  assert.deepEqual(element.querySelectorAll('.home-comparison__pair').map(pair => pair.dataset.comparisonId), ['album-a', 'album-b']);
  for (const pair of element.querySelectorAll('.home-comparison__pair')) {
    assert.equal(pair.querySelectorAll('.album-card').length, 2);
    assert.deepEqual(pair.querySelectorAll('[data-home-comparison-select]').map(button => button.dataset.homeComparisonSelect), [pair.dataset.comparisonId, pair.dataset.comparisonId]);
    assert.deepEqual(pair.querySelectorAll('.home-comparison__person').map(label => label.textContent), ['Yours', 'Maya']);
  }
  assert.doesNotMatch(html, /data-open-tracklist|data-track-path|data-gallery-card-intent|>Play<|>Open</);
});

test('all identity/name strings are escaped and comparisons never invent native action payloads', () => {
  const unsafe = row('id" onclick="bad', 2, 3, {title: '<script>unsafe</script>', artist: '<img src=x onerror=bad>', artwork_url: 'javascript:bad'});
  const html = comparisonTableHtml(runtime, [unsafe], 'tracks', '<Friend>');
  assert.match(html, /&lt;script&gt;unsafe&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=bad&gt;/);
  assert.match(html, /&lt;Friend&gt;/);
  assert.doesNotMatch(html, /<script>|<Friend>|<img src=x|src="javascript:| onclick="bad|data-src=|data-track-path|data-open-tracklist/);
  assert.deepEqual(comparisonSelection({...unsafe, album_ref: '/private', allowed_actions: {can_play: true}}), {id: unsafe.id, kind: 'track'});
  assert.equal(comparisonSelection(null), null);
});

test('panel keeps page scope and one native sticky header for filters and supplied kind/Period', () => {
  const html = render(ComparisonPanel, {kind: 'tracks', friendName: 'Maya', value: {status: 'ready', data: {rows: [row('shared', 3, 2), row('not-common', 1, null)], next_cursor: 'more'}},
    headerControls: React.createElement('div', {className: 'header-proof'}, 'Tabs and Period')});
  assert.match(html, /Filtering and ordering this page only/);
  assert.match(html, /data-comparison-id="shared"/);
  assert.doesNotMatch(html, /data-comparison-id="not-common"/);
  assert.ok(html.indexOf('Comparison filters and order') < html.indexOf('header-proof'));
  assert.ok(html.indexOf('header-proof') < html.indexOf('home-comparison__table'));
  const header = documentOf(html).querySelector('header.home-comparison__header');
  assert.ok(header.classList.contains('gallery-bar'));
  assert.ok(header.querySelector('.home-comparison__controls')); assert.ok(header.querySelector('.header-proof'));
  assert.doesNotMatch(html, /Next page|all shared|complete union/i);
});

test('no matches on a page remain truthful and blocked projections render no private rows', () => {
  const data = {rows: [row('private-row', 0, 2)]};
  assert.match(render(ComparisonPanel, {value: {status: 'ready', data}}), /No confirmed shared listens on this page/);
  for (const status of ['loading', 'denied', 'unavailable', 'error']) {
    const html = render(ComparisonPanel, {value: {status, data: {rows: [row('private-row', 9, 3)]}}});
    assert.doesNotMatch(html, /private-row|data-comparison-id=/);
    assert.match(html, status === 'error' ? /role="alert"/ : /role="status"/);
  }
  assert.deepEqual(native.forbiddenCalls, []);
});

test('safe artwork accepts only provider root-relative same-origin paths', async () => {
  const {safeServerArtworkUrl} = await model;
  assert.equal(safeServerArtworkUrl('/artwork/opaque-id?size=small'), '/artwork/opaque-id?size=small');
  for (const value of [null, '', 'https://outside.example/cover', '//outside.example/cover', '/\\outside.example',
    'file:///private/cover', 'javascript:alert(1)', 'data:image/png;base64,abc', '/cover\n.png', 'relative.png']) {
    assert.equal(safeServerArtworkUrl(value), null, String(value));
  }
});

test('comparison DTO preserves explicit side facts and independent server summary without authority fields', async () => {
  const {createHomeFriendsController} = await model;
  const providerRow = row('album:1', 7, null, {kind: 'album', artwork_url: '/artwork/opaque-id',
    yours: side(7, {play_count: 0, full_listen_count: 2, favorite: false, rating: 0}),
    friend: side(null, {favorite: true, play_count: '0', full_listen_count: -1, rating: null}),
    album_ref: '/private/album', allowed_actions: {can_play_album: true}});
  let payload = {rows: [providerRow], total_listens: 912, range_label: 'Provider range', period_label: 'Provider period', next_cursor: 'cursor:next'};
  const controller = createHomeFriendsController({providers: {
    readFriends: async () => ({friends: [{account_ref: 'friend:1', relationship: 'accepted', display_name: 'Maya', allowed_actions: {can_compare: true}}], requests: [], profile: null}),
    readComparison: async () => payload,
  }});
  await controller.loadFriends(); assert.equal(controller.selectFriend('friend:1'), true);
  await controller.loadComparison({kind: 'albums'});
  const value = controller.getSnapshot().comparison;
  assert.equal(value.status, 'ready');
  assert.equal(value.data.total_listens, 912); assert.equal(value.data.range_label, 'Provider range');
  assert.equal(value.data.period_label, 'Provider period'); assert.equal(value.data.next_cursor, 'cursor:next');
  assert.equal(value.data.rows[0].yours.play_count, 0); assert.equal(value.data.rows[0].yours.favorite, false);
  assert.equal(value.data.rows[0].yours.rating, null); assert.equal(value.data.rows[0].yours.full_listen_count, 2);
  assert.equal(value.data.rows[0].friend.favorite, true); assert.equal(value.data.rows[0].friend.play_count, null);
  assert.equal(value.data.rows[0].friend.listen_count, null); assert.equal(value.data.rows[0].friend.full_listen_count, null);
  assert.equal(value.data.rows[0].artwork_url, '/artwork/opaque-id');
  assert.equal(value.data.rows[0].album_ref, undefined); assert.equal(value.data.rows[0].allowed_actions, undefined);
  assert.ok(Object.isFrozen(value.data.rows[0].yours));
  payload = {rows: [row('track:1', 1, 1, {artwork_url: '//outside.example/cover',
    yours: side(1, {rating: 6, favorite: 'true'}), friend: side(1, {rating: 5})})]};
  await controller.loadComparison({kind: 'tracks'});
  const replacement = controller.getSnapshot().comparison.data;
  assert.equal(replacement.rows[0].artwork_url, null); assert.equal(replacement.rows[0].yours.rating, null);
  assert.equal(replacement.rows[0].friend.rating, 5); assert.equal(replacement.rows[0].yours.favorite, null);
  assert.equal(replacement.total_listens, null); assert.equal(replacement.range_label, '');
  assert.equal(replacement.period_label, ''); assert.equal(replacement.next_cursor, null);
  controller.dispose();
});

test('responsive comparison retains one joined row at the native Home phone boundary', () => {
  const css = fs.readFileSync(path.join(repo, 'music_app/static/css/runtime/home-comparison.css'), 'utf8');
  assert.match(css, /@media \(max-width: 900px\)/);
  assert.match(css, /\.gallery-bar\.home-comparison__header \{ position: sticky; top: 0;/);
  assert.match(css, /background: var\(--appearance-main-surface,var\(--app-surface\)\)/);
  assert.match(css, /\.compact-data-table-row \[data-cdt-column="friend"\] \{ display: none/);
  assert.match(css, /\.home-comparison__pair \{ display: grid; grid-template-columns: repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css, /data-comparison-highlighted="true"/);
});


const comparisonContext = {friendRef: 'friend:1', kind: 'albums', period: 'month'};
const savedComparison = (extra = {}) => ({...comparisonContext, commonOnly: false, order: 'friend', ascending: true,
  view: 'covers', selection: {id: 'album:selected', kind: 'album'}, ...extra});

test('comparison restoration is scoped to the exact friend, kind and period, with identity-only selection', () => {
  const saved = savedComparison({selection: {id: 'album:selected', kind: 'album', title: 'Private title', yours: side(93)}, friendName: 'Private friend'});
  assert.deepEqual(restoreComparisonPresentation(saved, comparisonContext), savedComparison());
  for (const context of [{...comparisonContext, friendRef: 'friend:2'}, {...comparisonContext, kind: 'tracks'}, {...comparisonContext, period: 'year'}]) {
    assert.deepEqual(restoreComparisonPresentation(saved, context), {...context, commonOnly: true, order: 'general', ascending: false, view: 'rows', selection: null});
  }
  assert.doesNotMatch(JSON.stringify(restoreComparisonPresentation(saved, comparisonContext)), /Private|yours|93/);
});

test('comparison restoration rejects malformed controls and bounded or kind-mismatched selection', () => {
  const invalid = savedComparison({commonOnly: 'false', order: 'private', ascending: 1, view: 'cards', selection: {id: 'album:selected', kind: 'track'}});
  assert.deepEqual(restoreComparisonPresentation(invalid, comparisonContext), {...comparisonContext, commonOnly: true, order: 'general', ascending: false, view: 'rows', selection: null});
  for (const id of ['', '   ', 'x'.repeat(513), 'album:\nprivate', null]) {
    assert.equal(restoreComparisonPresentation(savedComparison({selection: {id, kind: 'album'}}), comparisonContext).selection, null);
  }
  assert.equal(restoreComparisonPresentation(savedComparison({selection: {id: 'x'.repeat(512), kind: 'album'}}), comparisonContext).selection.id.length, 512);
});

test('selection survives initial loading and transient failures but clears after rejected or revoked authorization', () => {
  const selection = {id: 'album:selected', kind: 'album'};
  for (const status of ['loading', 'unavailable', 'error']) assert.strictEqual(reconcileComparisonSelection(selection, status), selection);
  const rows = [row(selection.id, 4, 3, {kind: selection.kind})];
  assert.strictEqual(reconcileComparisonSelection(selection, 'ready', rows), selection);
  for (const status of ['denied', 'empty']) assert.equal(reconcileComparisonSelection(selection, status, rows), null);
  assert.equal(reconcileComparisonSelection(selection, 'ready', []), null, 'new page or filter removed the selected identity');
  assert.equal(reconcileComparisonSelection(selection, 'ready', [row(selection.id, 4, 3)]), null, 'same ID with a different kind is not a match');
  assert.equal(reconcileComparisonSelection(null, 'ready', rows), null);
});

test('restored comparison controls, cover view and selected summary use fresh authorized DTO values', () => {
  const html = render(ComparisonPanel, {...comparisonContext, presentation: savedComparison(), friendName: 'Maya',
    value: {status: 'ready', data: {rows: [row('album:selected', 8, null, {kind: 'album', title: 'Fresh title'})]}}});
  assert.match(html, /data-comparison-view="covers"/);
  assert.doesNotMatch(html, /type="checkbox" checked=""/);
  const host = documentOf(html);
  assert.equal(host.querySelector('button[aria-label="Comparison order: Friend first"]').getAttribute('aria-haspopup'), 'menu');
  assert.equal(host.querySelector('[role="columnheader"][data-cdt-column="friend"]').getAttribute('aria-sort'), 'ascending');
  const heading = host.querySelector('[data-cdt-sort="friend"]');
  assert.equal(heading.dataset.cdtSortDirection, 'asc');
  assert.match(heading.getAttribute('aria-label'), /ascending\. Activate for descending order\./);
  assert.equal(heading.querySelector('svg.compact-data-table__sort-icon').innerHTML,
    documentOf(native.context.ButtonComponent.renderIconSvg('ascending')).querySelector('svg').innerHTML);
  assert.match(html, /home-comparison__cards/);
  assert.match(html, /aria-label="Selected comparison details"/);
  assert.match(html, /<h3>Fresh title<\/h3>/);
  assert.match(html, /<dt>Track listens<\/dt><dd>8<\/dd>/);
});

test('a previous friend comparison cannot restore its filters, cover view or selection into another friend', () => {
  const html = render(ComparisonPanel, {...comparisonContext, friendRef: 'friend:2', presentation: savedComparison(),
    value: {status: 'ready', data: {rows: [row('album:selected', 4, 3, {kind: 'album'})]}}});
  assert.match(html, /data-comparison-view="rows"/);
  assert.match(html, /type="checkbox" checked=""/);
  assert.doesNotMatch(html, /aria-label="Selected comparison details"|home-comparison__cards/);
});

test('restored selection never exposes old details while a comparison projection is unreadable', () => {
  for (const status of ['loading', 'denied', 'unavailable', 'error', 'empty']) {
    const html = render(ComparisonPanel, {...comparisonContext, presentation: savedComparison(),
      value: {status, data: {rows: [row('album:selected', 9, 3, {kind: 'album', title: 'Private stale title'})]}}});
    assert.doesNotMatch(html, /Private stale title|album:selected|aria-label="Selected comparison details"/);
  }
});


test('supplied metrics keep known zero, missing sides and spoken compatible relations separate', () => {
  const values = row('numbers', 0, 0, {yours: side(0, {play_count: 8, rating: 0, favorite: false}),
    friend: side(0, {play_count: 3, rating: null, favorite: true})});
  const host = documentOf(comparisonTableHtml(runtime, [values, row('missing', 3, null)], 'tracks', 'Maya'));
  const numberRow = host.querySelector('[data-comparison-id="numbers"]');
  assert.equal(numberRow.querySelector('[data-cdt-column="yours:listen_count"] strong').textContent, '0');
  assert.equal(numberRow.querySelector('[data-cdt-column="friend:rating"] strong').textContent, '–');
  const relations = numberRow.querySelectorAll('.home-comparison__relation');
  assert.deepEqual(relations.map(node => node.textContent), ['=', '>']);
  assert.match(relations[0].getAttribute('aria-label'), /Yours 0, Maya 0; Yours is equal to Maya/);
  assert.match(relations[1].getAttribute('aria-label'), /PC: Yours 8, Maya 3; Yours is greater than Maya/);
  assert.equal(host.querySelector('[data-comparison-id="missing"]').querySelectorAll('.home-comparison__relation').length, 0);
  assert.match(numberRow.querySelector('[data-cdt-column="yours:favorite"]').textContent, /Favorite: No/);
  assert.match(numberRow.querySelector('[data-cdt-column="friend:favorite"]').textContent, /Favorite: Yes/);
  assert.doesNotMatch(host.textContent, /Obsessed|Loved|Love|Length/);
});

test('native metric headers own aria-sort and kind-specific metrics without fabricated actions', () => {
  for (const kind of ['albums', 'tracks', 'artists']) {
    const host = documentOf(comparisonTableHtml(runtime, [], kind, 'Maya', {
      order: 'yours', metricSort: {side: 'friend', key: 'play_count', direction: 'descending'},
    }));
    assert.equal(host.querySelector('[data-cdt-column="friend:play_count"]').getAttribute('aria-sort'), 'descending');
    assert.equal(host.querySelector('[data-cdt-column="yours"]').getAttribute('aria-sort'), 'none');
    assert.equal(Boolean(host.querySelector('[data-cdt-sort="yours:full_listen_count"]')), kind === 'albums');
    assert.equal(Boolean(host.querySelector('[data-cdt-sort="friend:rating"]')), kind !== 'artists');
    assert.equal(host.querySelector('[data-cdt-sort="friend:favorite"]'), null);
  }
});

test('Artist comparison identities reuse native NavigationTree with DTO selection only', () => {
  const host = documentOf(comparisonTableHtml(runtime, [row('artist:1', 1, 2, {kind: 'artist'})], 'artists', 'Maya'));
  assert.equal(host.querySelectorAll('[data-navigation-tree-item="wide"]').length, 2);
  assert.equal(host.querySelectorAll('[data-home-comparison-select="artist:1"]').length, 2);
  assert.doesNotMatch(host.innerHTML, /href=|data-open-tracklist|data-track-path|data-gallery-card-intent/);
});


test('phone comparison renders one identity and both sets of numbers and Favorite facts', () => {
  const host = documentOf(comparisonTableHtml(runtime, [row('phone', 0, 4, {kind: 'album',
    yours: side(0, {play_count: 0, full_listen_count: 0, favorite: false}), friend: side(4, {favorite: true})})],
  'albums', 'Maya', {phone: true}));
  assert.equal(host.querySelectorAll('.album-card').length, 1);
  assert.equal(host.querySelectorAll('[data-home-comparison-select]').length, 1);
  assert.equal(host.querySelectorAll('[data-cdt-sort="yours"]').length, 1);
  assert.equal(host.querySelectorAll('[data-cdt-sort="friend"]').length, 1);
  const pair = host.querySelector('[data-comparison-id="phone"]');
  assert.equal(pair.querySelector('[data-cdt-column="yours:full_listen_count"] strong').textContent, '0');
  assert.equal(pair.querySelector('[data-cdt-column="friend:full_listen_count"] strong').textContent, '–');
  assert.match(pair.querySelector('[data-cdt-column="friend:favorite"]').textContent, /Yes/);
});
