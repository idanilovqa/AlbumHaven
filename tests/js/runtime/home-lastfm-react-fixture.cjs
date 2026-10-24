// Additive fixture adapted verbatim from Home8a01 home-activity.test.js setup.
// Original published fixture/test bytes remain unchanged. No test executed.
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
      const trackHost = elements(tree).find(element => element.type === 'div' && element.props.className?.split(' ').includes('album-track-table') && element.props.ref);
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


module.exports = {activityLifecycle, ready, row};
