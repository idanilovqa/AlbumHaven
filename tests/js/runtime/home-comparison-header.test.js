const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const React = require('react');
const {renderToStaticMarkup} = require('react-dom/server');
const {buildSync} = require('esbuild');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');

const source = path.resolve(__dirname, '../../../music_app/static/js/home-friends/app.jsx');
const built = buildSync({entryPoints: [source], bundle: true, platform: 'node', format: 'cjs',
  write: false, external: ['react', 'react-dom']}).outputFiles[0].text;
const elements = node => React.isValidElement(node) ? [node, ...React.Children.toArray(node.props.children).flatMap(elements)] : [];
const find = (tree, predicate) => elements(tree).find(predicate);
const component = (tree, name) => find(tree, node => node.type?.name === name);
const hasClass = (node, name) => node.props.className?.split(' ').includes(name);
const backButtons = tree => elements(tree).filter(node => node.type?.name === 'Button' && node.props.icon === 'back');

// Inspect the real view before passive effects, following the existing Home
// composition tests. This tests header ownership and event dispatch, not React
// reconciliation, portal DOM placement, provider loading or dashboard geometry.
function fixture({mode = 'comparison', kind = 'albums', friend = true, profile = false} = {}) {
  const native = createNativeHomeRuntime(), slots = [], navigations = [], saves = [], reads = [];
  let cursor = 0;
  const hooks = {...React,
    useRef(value) {const index = cursor++; return slots[index] ||= {current: value};},
    useState(initial) {const index = cursor++; slots[index] ||= {value: typeof initial === 'function' ? initial() : initial};
      return [slots[index].value, value => {slots[index].value = typeof value === 'function' ? value(slots[index].value) : value;}];},
    useEffect() {cursor++;}, useLayoutEffect() {cursor++;},
  };
  const loaded = {exports: {}};
  vm.runInNewContext(built, {module: loaded, exports: loaded.exports, window: {innerWidth: 1200},
    require: name => name === 'react' ? hooks : require(name)});
  const person = {account_ref: 'friend:one', display_name: 'Maya', relationship: 'accepted',
    allowed_actions: {can_compare: true, can_view_activity: true}};
  const state = {scopeKey: 'account:one/library:one', selectedFriendRef: friend ? person.account_ref : null,
    recent: {status: 'ready', data: {recent_local_albums: [], recent_not_local_albums: []}},
    friends: {status: 'ready', data: {profile: {display_name: 'You'}, friends: friend ? [person] : []}},
    activity: {status: 'unavailable', data: null}, activityNavigation: {status: 'idle'},
    comparison: {status: 'ready', data: {rows: [], next_cursor: null}}, mutation: {status: 'idle'}};
  const shell = {section: 'friends', friendRef: friend && !profile ? person.account_ref : '', profileRef: profile ? 'member:one' : '',
    presentation: {friendMode: mode, friendKind: kind, friendPeriod: 'month'}};
  const runtime = {savePresentation: (value, expected) => saves.push({value, expected}),
    navigate: value => navigations.push(value), actionHtml: native.context.ButtonComponent.renderActionButton,
    artboxHtml: native.context.buildAlbumArtboxHtml};
  const controller = {getSnapshot: () => state, selectFriend: value => reads.push(['selectFriend', value]),
    loadComparison: value => reads.push(['comparison', value]), loadActivity: value => reads.push(['activity', value])};
  return {...native, state, shell, navigations, saves, reads,
    render() {cursor = 0; return loaded.exports.HomeFriendsView({runtime, controller, state, shell});},
    clickNativeButton(element) {
      const rendered = element.type(element.props), host = native.document.createElement('span');
      host.innerHTML = rendered.props.dangerouslySetInnerHTML.__html; native.document.body.appendChild(host);
      const button = host.querySelector('button'); assert.ok(button); assert.ok(button.querySelector('svg'));
      rendered.props.onClick(native.event('click', button.querySelector('svg'))); host.remove();
      return button;
    },
  };
}

test('comparison places its single Back action beside the identity and hands the header host to the panel', () => {
  for (const kind of ['albums', 'tracks', 'artists']) {
    const h = fixture({kind}), first = h.render();
    const header = find(first, node => hasClass(node, 'home-friends__page-header'));
    const context = find(header, node => hasClass(node, 'gallery-bar__context'));
    const actions = find(header, node => hasClass(node, 'gallery-bar__actions'));
    assert.ok(hasClass(context, 'home-comparison__header-context'));
    assert.equal(backButtons(first).length, 1); assert.equal(backButtons(context).length, 1);
    assert.equal(backButtons(context)[0].props.children, 'Back to friends');
    assert.ok(component(context, 'ComparisonIdentity')); assert.equal(component(context, 'ProfileIdentity'), undefined);
    assert.equal(find(header, node => node.props.attributes?.['data-home-open-friends']), undefined);
    const slot = find(actions, node => node.props['data-home-comparison-view-host'] === 'true'); assert.ok(slot);
    assert.equal(component(first, 'ComparisonPanel').props.viewControlsHost, null);
    const host = h.document.createElement('span'); h.document.body.appendChild(host); slot.props.ref(host);
    const mounted = h.render(), panel = component(mounted, 'ComparisonPanel');
    assert.strictEqual(panel.props.viewControlsHost, host);
    assert.equal(panel.props.kind, kind); assert.equal(panel.props.friendRef, 'friend:one'); assert.equal(panel.props.period, 'month');
    assert.ok(component(panel.props.headerControls, 'Tabs')); assert.ok(component(panel.props.headerControls, 'Period'));
    const widget = find(mounted, node => node.props['data-home-widget'] === 'friends');
    assert.equal(backButtons(widget).length, 0, 'the widget does not retain a duplicate Back action');
    assert.equal(find(widget, node => hasClass(node, 'home-friends__widget-header')).props.hidden, true,
      'the Dashboard keeps its required header node without a blank visible comparison bar');
    slot.props.ref(null); assert.equal(component(h.render(), 'ComparisonPanel').props.viewControlsHost, null);
    assert.deepEqual(h.reads, [], 'rendering and host handoff are presentation-only'); host.remove();
  }
});

test('comparison Back and long identity occupy separate horizontal tracks in the existing header context', () => {
  const h = fixture();
  h.state.friends.data.friends[0].display_name = 'A very long friend name that must wrap within the available identity track';
  const context = find(h.render(), node => hasClass(node, 'home-comparison__header-context'));
  const host = h.document.createElement('div'); host.innerHTML = renderToStaticMarkup(context);
  const header = host.firstElementChild;
  assert.equal(header.children.length, 2);
  assert.ok(header.children[0].querySelector('[data-home-comparison-back]'));
  assert.ok(header.children[1].classList.contains('home-profile__comparison-identity'));
  assert.ok(header.children[1].querySelector('h1').textContent.includes(h.state.friends.data.friends[0].display_name));
  // This proves the CSS/DOM composition contract, not browser geometry.
  const css = fs.readFileSync(path.resolve(__dirname, '../../../music_app/static/css/runtime/home-comparison.css'), 'utf8');
  const tracks = css.match(/\.home-comparison__header-context\s*\{([^}]+)\}/)?.[1];
  assert.match(tracks, /display:\s*grid/);
  assert.match(tracks, /grid-template-columns:\s*max-content\s+minmax\(0,\s*1fr\)/);
  assert.match(css, /\.home-comparison__header-context\s*>\s*\.home-profile__comparison-identity\s*\{\s*min-width:\s*0;/);
});

test('the header Back native icon preserves the Friends destination and does not start a comparison read', () => {
  const h = fixture(), tree = h.render(), back = backButtons(tree)[0];
  const button = h.clickNativeButton(back);
  assert.equal(button.getAttribute('data-home-comparison-back'), 'true');
  assert.equal(button.getAttribute('aria-label'), 'Back to friends');
  assert.deepEqual(JSON.parse(JSON.stringify(h.navigations)), [{section: 'friends', friend: '', profile: ''}]);
  assert.equal(h.saves.length, 1); assert.strictEqual(h.saves[0].expected, h.shell);
  assert.equal(h.saves[0].value.friendMode, 'comparison');
  assert.deepEqual(h.reads, []); assert.deepEqual(h.forbiddenCalls, []);
});

test('activity, directory and profile routes retain the Friends header action and their existing widget Back destinations', () => {
  for (const [options, destination] of [[{mode: 'activity'}, 'friends'], [{friend: false}, 'recent'], [{profile: true}, 'friends']]) {
    const h = fixture(options), tree = h.render();
    const header = find(tree, node => hasClass(node, 'home-friends__page-header'));
    assert.ok(component(header, 'ProfileIdentity')); assert.equal(component(header, 'ComparisonIdentity'), undefined);
    assert.equal(find(header, node => node.props['data-home-comparison-view-host']), undefined);
    const friends = find(header, node => node.props.attributes?.['data-home-open-friends'] === 'true'); assert.ok(friends);
    assert.equal(backButtons(header).length, 0); assert.equal(backButtons(tree).length, 1);
    h.clickNativeButton(backButtons(tree)[0]);
    assert.deepEqual(JSON.parse(JSON.stringify(h.navigations)), [{section: destination, friend: '', profile: ''}]);
    assert.deepEqual(h.reads, []);
  }
});
