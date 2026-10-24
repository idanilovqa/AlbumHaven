// Additive fixture from exact Home composition test. Original tests are unchanged.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const React = require('react');
const {buildSync} = require('esbuild');

const source = path.resolve(__dirname, '../../../music_app/static/js/home-friends/app.jsx');
const bundle = buildSync({entryPoints: [source], bundle: true, platform: 'node', format: 'cjs',
  write: false, external: ['react', 'react-dom']}).outputFiles[0].text;
const elements = node => React.isValidElement(node)
  ? [node, ...React.Children.toArray(node.props.children).flatMap(elements)] : [];
const find = (tree, predicate) => elements(tree).find(predicate);
const kinds = tree => find(tree, node => node.props.id === 'home-recent-kinds');

// Exercise the real view's state and child contracts, without claiming DOM
// reconciliation, native dashboard geometry, or browser/player verification.
function viewFixture({width = 1200, presentation, section = 'recent', friend = null, activity, authenticated = false, accountRoot = null} = {}) {
  const slots = [], saved = [], listeners = new Set(); let cursor = 0, effects = [];
  const window = {innerWidth: width, matchMedia: () => media};
  const media = {matches: width <= 900, addEventListener: (_event, handler) => listeners.add(handler),
    removeEventListener: (_event, handler) => listeners.delete(handler)};
  const hooks = {...React,
    useRef(value) {const index = cursor++; return slots[index] ||= {current: value};},
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = {value: typeof initial === 'function' ? initial() : initial};
      return [slots[index].value, value => {slots[index].value = typeof value === 'function' ? value(slots[index].value) : value;}];
    },
    useEffect(effect, deps) {
      const index = cursor++, previous = slots[index];
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
        effects.push(() => {previous?.cleanup?.(); slots[index] = {deps, cleanup: effect()};});
      }
    },
    useMemo(factory, deps) {
      const index = cursor++, previous = slots[index];
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) slots[index] = {deps, value: factory()};
      return slots[index].value;
    },
    useLayoutEffect() {cursor++;},
  };
  const fixtureModule = {exports: {}};
  vm.runInNewContext(bundle, {module: fixtureModule, exports: fixtureModule.exports, window, document: {getElementById: id => id === 'app-shell' ? accountRoot : null},
    require: name => name === 'react' ? hooks : require(name), clearTimeout, setTimeout, console});
  const state = {scopeKey: 'viewer/library', selectedFriendRef: friend?.account_ref || null,
    recent: {status: 'ready', data: {recent_local_albums: [], recent_not_local_albums: []}},
    friends: friend ? {status: 'ready', data: {friends: [friend]}} : {status: 'unavailable', data: null},
    activity: activity ? {status: 'ready', data: {rows: [], total_listens: 0, range_label: 'Supplied date range'}} : {status: 'unavailable', data: null},
    activityNavigation: {query: activity, status: 'idle'}, comparison: {status: 'unavailable', data: null}, mutation: {status: 'idle'}};
  const shell = {authenticated, section, friendRef: friend?.account_ref || '', presentation};
  const runtime = {savePresentation: value => saved.push(value)};
  const controller = {selectFriend() {return true;}, loadActivity() {}, getSnapshot: () => state};
  return {
    saved, shell, state,
    render() {
      cursor = 0; effects = [];
      const tree = fixtureModule.exports.HomeFriendsView({runtime, controller, state, shell});
      for (const effect of effects) effect();
      return tree;
    },
    resize(nextWidth) {window.innerWidth = nextWidth; media.matches = nextWidth <= 900; for (const handler of listeners) handler();},
    dispose() {for (const slot of slots) slot?.cleanup?.(); assert.equal(listeners.size, 0);},
  };
}

module.exports = {viewFixture, elements, find};
