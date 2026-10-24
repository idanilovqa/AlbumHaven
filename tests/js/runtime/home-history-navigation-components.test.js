const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const React = require('react');
const {renderToStaticMarkup} = require('react-dom/server');
const {buildSync} = require('esbuild');
const {createNativeHomeRuntime, buttonNamed} = require('./native-home-harness.cjs');

const repo = path.resolve(__dirname, '../../..');
const bundle = buildSync({entryPoints: [path.join(repo, 'music_app/static/js/home-friends/history-navigation.jsx')],
  bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react']}).outputFiles[0].text;
function load(hooks) {
  const module = {exports: {}};
  vm.runInNewContext(bundle, {module, exports: module.exports, Promise, require: name => {assert.equal(name, 'react'); return hooks;}});
  return module.exports.HistoryNavigation;
}
function environment() {
  const env = createNativeHomeRuntime();
  for (const file of ['trigger-anchor.js', 'library-settings.js']) {
    vm.runInContext(fs.readFileSync(path.join(repo, 'music_app/static/js/runtime', file), 'utf8'), env.context);
  }
  return {...env, runtime: {
    buttonHtml: config => env.context.ButtonComponent.renderButton(config),
    actionHtml: config => env.context.ButtonComponent.renderActionButton(config),
    alertHtml: config => env.context.buildOnPageAlertHtml(config),
    openChoice: env.context.openUtilityChoiceDropdown,
  }};
}
const numbered = (extra = {}) => ({mode: 'numbered', status: 'idle', page: 2, pageSize: 100,
  totalPages: 3, totalRows: 243, loadedCount: 100, hasMore: false, requestedPage: null, ...extra});
const progressive = (extra = {}) => ({mode: 'progressive', status: 'idle', page: null, pageSize: 100,
  totalPages: null, totalRows: null, loadedCount: 200, hasMore: true, requestedPage: null, ...extra});
const value = {status: 'ready', data: {rows: [{id: 'listen:one'}], total_listens: 9999999, next_cursor: 'provider-cursor'}};
const props = (env, extra = {}) => ({runtime: env.runtime, value, navigation: numbered(), queryKey: 'self:listens:week',
  onPage() {}, onLoadMore() {}, onRetry() {}, ...extra});
const walk = tree => !React.isValidElement(tree) ? [] : [tree, ...React.Children.toArray(tree.props.children).flatMap(walk)];
const find = (tree, predicate) => walk(tree).find(predicate);
const control = (tree, label) => find(tree, node => node.type?.name === 'Button' && node.props.children === label);
const choice = tree => find(tree, node => node.type?.name === 'NativeChoice');
const form = tree => find(tree, node => node.type === 'form');
const input = tree => find(tree, node => node.type === 'input');
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
const submit = tree => {let prevented = false; form(tree).props.onSubmit({preventDefault() {prevented = true;}}); assert.equal(prevented, true);};

function markup(env, extra = {}) {
  const host = env.document.createElement('section');
  host.innerHTML = renderToStaticMarkup(React.createElement(load(React), props(env, extra)));
  return host;
}

// Bounded hook commits exercise this component's callbacks and focus guards.
// The shared native Button/Choice owners have their own lifetime tests; this
// harness makes no claim about browser layout or React DOM reconciliation.
function lifecycle(env, initial = {}) {
  let cursor = 0, effects = [], slots = [], current = props(env, initial), tree;
  const hooks = {...React,
    useRef(value) {const index = cursor++; return slots[index] ||= {current: value};},
    useState(value) {
      const index = cursor++; if (!(index in slots)) slots[index] = value;
      return [slots[index], next => {slots[index] = typeof next === 'function' ? next(slots[index]) : next;}];
    },
    useId() {const index = cursor++; return slots[index] ||= `history-error-${index}`;},
    useLayoutEffect(callback, dependencies) {
      const index = cursor++, prior = slots[index];
      if (!prior || dependencies.some((value, offset) => !Object.is(value, prior.dependencies[offset]))) {
        effects.push(() => {prior?.cleanup?.(); slots[index] = {dependencies, cleanup: callback()};});
      }
    },
  };
  const Component = load(hooks), host = env.document.createElement('nav'), summary = env.document.createElement('p');
  env.document.body.append(host); host.append(summary);
  env.context.Element.prototype.focus = function () {env.document.activeElement = this;};
  return {host, summary,
    render(next = {}) {
      current = {...current, ...next}; cursor = 0; effects = []; tree = Component(current);
      if (tree) {tree.props.ref.current = host; tree.props.children[0].props.ref.current = summary;}
      for (const effect of effects) effect(); return tree;
    },
    button(label) {
      const holder = env.document.createElement('span'); holder.innerHTML = env.runtime.buttonHtml({label});
      host.append(holder); return holder.firstElementChild;
    },
    dispose() {for (const slot of slots) slot?.cleanup?.(); host.remove();},
  };
}

test('numbered navigation uses native Choice/actions, committed range and submitted jump', () => {
  const env = environment(), host = markup(env);
  assert.equal(host.querySelector('nav').getAttribute('aria-label'), 'Listening history pages');
  assert.equal(host.querySelector('[role="status"]').textContent, 'Page 2 of 3 · Items 101–200 of 243 · 100 per page');
  assert.equal(host.querySelector('[aria-live="polite"]').getAttribute('aria-atomic'), 'true');
  assert.equal(buttonNamed(host, /^Previous history page$/).classList.contains('action-button'), true);
  assert.equal(buttonNamed(host, /^Next history page$/).disabled, false);
  assert.equal(buttonNamed(host, /^History page: Page 2 of 3 · 100 per page$/).getAttribute('aria-haspopup'), 'menu');
  assert.equal(buttonNamed(host, /^Go$/).getAttribute('type'), 'submit');
  assert.equal(host.querySelector('form').getAttribute('aria-label'), 'Jump to history page');
  assert.equal(host.querySelector('input').getAttribute('inputMode') || host.querySelector('input').getAttribute('inputmode'), 'numeric');
  assert.equal(host.querySelector('select'), null);
  assert.doesNotMatch(host.textContent, /9999999|provider-cursor/);
});

test('large authoritative totals create a bounded native Choice while preserving an arbitrary jump', () => {
  const env = environment(), view = lifecycle(env, {navigation: numbered({page: 44001, totalPages: 90000, totalRows: 9000000})});
  const tree = view.render(), options = choice(tree).props.options;
  assert.deepEqual(Array.from(options, row => row[0]), ['1', '43999', '44000', '44001', '44002', '44003', '90000']);
  assert.equal(options.length, 7); assert.ok(form(tree)); view.dispose();
});

test('row ranges keep item semantics for aggregate albums, tracks and artists as well as listen events', () => {
  const env = environment();
  for (const kind of ['albums', 'tracks', 'artists', 'listens']) {
    const host = markup(env, {queryKey: `self:${kind}:week`, navigation: numbered({query: {account_ref: null, kind, period: 'week'}})});
    assert.match(host.querySelector('[role="status"]').textContent, /Items 101–200 of 243/);
    assert.doesNotMatch(host.querySelector('[role="status"]').textContent, /listens|9999999/i);
  }
});

test('empty numbered history has one disabled page and first/last bounds remain native', () => {
  const env = environment();
  const empty = markup(env, {value: {status: 'empty', data: {rows: []}}, navigation: numbered({page: 1, totalPages: 1, totalRows: 0, loadedCount: 0})});
  assert.match(empty.textContent, /Page 1 of 1 · 0 items · 100 per page/);
  for (const button of empty.querySelectorAll('button')) assert.equal(button.disabled, true);
  assert.equal(empty.querySelector('form'), null);
  const first = markup(env, {navigation: numbered({page: 1})});
  assert.equal(buttonNamed(first, /^Previous history page$/).disabled, true);
  assert.equal(buttonNamed(first, /^Next history page$/).disabled, false);
  const last = markup(env, {navigation: numbered({page: 3, loadedCount: 43})});
  assert.match(last.textContent, /Items 201–243 of 243/);
  assert.equal(buttonNamed(last, /^Next history page$/).disabled, true);
});

test('unvalidated and first-load/denied/unavailable resources expose no paging authority', () => {
  const env = environment();
  assert.equal(markup(env, {navigation: {mode: 'none'}}).textContent, '');
  assert.equal(markup(env, {navigation: null}).textContent, '');
  for (const status of ['loading', 'error', 'denied', 'unavailable']) {
    assert.equal(markup(env, {value: {...value, status}}).querySelector('nav'), null);
  }
});

test('progressive history reports only available rows and retains a disabled completion control', () => {
  const env = environment(), host = markup(env, {navigation: progressive()});
  assert.match(host.textContent, /200 items shown · More history available/);
  assert.equal(buttonNamed(host, /^Load more history$/).disabled, false);
  assert.equal(host.querySelector('form'), null);
  assert.doesNotMatch(host.textContent, /Page|9999999|of 200/);
  const end = markup(env, {navigation: progressive({hasMore: false, loadedCount: 231})});
  assert.match(end.textContent, /231 items shown · End of available history/);
  assert.equal(buttonNamed(end, /^Load more history$/).disabled, true);
});

test('busy and failed navigation retain committed page/range and native feedback/retry states', () => {
  const env = environment(), loading = markup(env, {navigation: numbered({status: 'loading', requestedPage: 3})});
  assert.equal(loading.querySelector('nav').getAttribute('aria-busy'), 'true');
  assert.match(loading.textContent, /Page 2 of 3 · Items 101–200 of 243/);
  assert.match(loading.textContent, /Loading page 3/);
  for (const element of loading.querySelectorAll('button, input')) assert.equal(element.disabled, true);
  const failed = markup(env, {navigation: numbered({status: 'error', requestedPage: 3})});
  assert.match(failed.querySelector('[role="alert"]').textContent, /Page 3 could not be loaded/);
  assert.ok(failed.querySelector('.on-page-alert'));
  assert.equal(buttonNamed(failed, /^Retry history loading$/).disabled, false);
  const append = markup(env, {navigation: progressive({status: 'error'})});
  assert.match(append.textContent, /200 items shown/);
  assert.match(append.querySelector('[role="alert"]').textContent, /Your listening history is still shown/);
});

test('submitted jump rejects invalid text, accepts whole pages and blocks duplicate navigation immediately', async () => {
  const env = environment(), calls = [], work = deferred(), view = lifecycle(env, {onPage: page => {calls.push(page); return work.promise;}});
  let tree = view.render();
  for (const text of ['', '0', '-1', '1.5', '1e2', '4', '9007199254740992']) {
    input(tree).props.onChange({target: {value: text}}); tree = view.render(); submit(tree); tree = view.render();
    assert.equal(input(tree).props['aria-invalid'], true); assert.deepEqual(calls, []);
    assert.equal(input(tree).props.value, text);
    const error = find(tree, node => node.props.id === input(tree).props['aria-describedby']); assert.ok(error);
  }
  input(tree).props.onChange({target: {value: ' 03 '}}); tree = view.render();
  assert.equal(input(tree).props['aria-invalid'], false);
  submit(tree); submit(tree); control(tree, 'Next history page').props.onClick();
  assert.deepEqual(calls, [3]); tree = view.render();
  assert.equal(tree.props['aria-busy'], true); assert.equal(input(tree).props.disabled, true);
  work.resolve(); await work.promise; tree = view.render({navigation: numbered({page: 3, loadedCount: 43})});
  assert.equal(tree.props['aria-busy'], false); assert.equal(input(tree).props.value, '3'); view.dispose();
});

test('Choice and previous/next use committed page bounds and ignore stale descriptor callbacks', async () => {
  const env = environment(), calls = [], view = lifecycle(env, {onPage: page => {calls.push(page);}});
  let tree = view.render(); const oldChoice = choice(tree), oldForm = form(tree);
  choice(tree).props.onChange('2'); choice(tree).props.onChange('4'); assert.deepEqual(calls, []);
  control(tree, 'Previous history page').props.onClick(); await Promise.resolve();
  assert.deepEqual(calls, [1]); tree = view.render({navigation: numbered({page: 1})});
  oldChoice.props.onChange('3'); oldForm.props.onSubmit({preventDefault() {}}); assert.deepEqual(calls, [1]);
  choice(tree).props.onChange('3'); await Promise.resolve(); assert.deepEqual(calls, [1, 3]); view.dispose();
});

test('Load more and retry each issue one operation while pending and preserve display authority', async () => {
  const env = environment(), work = deferred(); let loads = 0, retries = 0;
  const view = lifecycle(env, {navigation: progressive(), onLoadMore: () => {loads++; return work.promise;}, onRetry: () => {retries++; return work.promise;}});
  let tree = view.render(); const load = control(tree, 'Load more history');
  load.props.onClick(); load.props.onClick(); assert.equal(loads, 1);
  tree = view.render(); assert.equal(control(tree, 'Load more history').props.disabled, true);
  work.resolve(); await work.promise; tree = view.render({navigation: progressive({status: 'error'})});
  const retry = control(tree, 'Retry history loading'); retry.props.onClick(); retry.props.onClick(); assert.equal(retries, 1);
  await Promise.resolve(); tree = view.render({navigation: progressive({loadedCount: 243, hasMore: false})});
  assert.equal(control(tree, 'Load more history').props.disabled, true);
  control(tree, 'Load more history').props.onClick(); assert.equal(loads, 1); view.dispose();
});

test('throwing or rejected embedding callbacks report failure and release the navigation guard', async () => {
  for (const rejectAsync of [false, true]) {
    const env = environment(); let calls = 0;
    const view = lifecycle(env, {onPage: () => {
      calls++;
      if (rejectAsync) return Promise.reject(new Error('Embedding failed'));
      throw new Error('Embedding failed');
    }});
    let tree = view.render();
    assert.doesNotThrow(() => control(tree, 'Next history page').props.onClick());
    await Promise.resolve(); tree = view.render();
    assert.equal(tree.props['aria-busy'], false);
    assert.ok(find(tree, node => node.type?.name === 'NativeHtml' && /History navigation could not be started/.test(node.props.html)));
    assert.equal(control(tree, 'Next history page').props.disabled, false);
    control(tree, 'Next history page').props.onClick(); await Promise.resolve(); assert.equal(calls, 2);
    tree = view.render({queryKey: 'another:query'});
    assert.equal(find(tree, node => node.type?.name === 'NativeHtml' && /History navigation could not be started/.test(node.props.html)), undefined);
    view.dispose();
  }
});

test('request completion restores lost local focus without stealing focus from another control', async () => {
  for (const movedOutside of [false, true]) {
    const env = environment(), work = deferred(), view = lifecycle(env, {onPage: () => work.promise});
    const tree = view.render(), source = view.button('Next'); source.focus();
    control(tree, 'Next history page').props.onClick(); view.render({navigation: numbered({status: 'loading', requestedPage: 3})});
    source.disabled = true; env.document.activeElement = env.document.body;
    const outside = env.document.createElement('button'); env.document.body.append(outside);
    if (movedOutside) outside.focus();
    work.resolve(); await work.promise; view.render({navigation: numbered({page: 3, loadedCount: 43})});
    assert.equal(env.document.activeElement, movedOutside ? outside : view.summary); view.dispose();
  }
});

test('a replaced actor/query cannot receive stale jumps, completion focus or pending-state changes', async () => {
  const env = environment(), oldWork = deferred(), newWork = deferred(), calls = [];
  const view = lifecycle(env, {onPage: page => {calls.push(`old:${page}`); return oldWork.promise;}});
  const old = view.render(), source = view.button('Old next'); source.focus(); control(old, 'Next history page').props.onClick();
  env.document.activeElement = env.document.body;
  let tree = view.render({queryKey: 'friend:two:listens:month', navigation: numbered({page: 1}),
    onPage: page => {calls.push(`new:${page}`); return newWork.promise;}});
  control(old, 'Previous history page').props.onClick(); choice(old).props.onChange('3');
  input(old).props.onChange({target: {value: '3'}}); submit(old);
  assert.deepEqual(calls, ['old:3']); assert.equal(input(view.render()).props.value, '1');
  control(tree, 'Next history page').props.onClick(); oldWork.resolve(); await oldWork.promise;
  tree = view.render(); assert.equal(tree.props['aria-busy'], true); assert.equal(env.document.activeElement, env.document.body);
  assert.deepEqual(calls, ['old:3', 'new:2']);
  newWork.resolve(); await newWork.promise; view.dispose();
});

test('revisiting a query or committed page does not resurrect abandoned busy state or a stale jump draft', async () => {
  const env = environment(), work = deferred(), view = lifecycle(env, {onPage: () => work.promise});
  let tree = view.render(); input(tree).props.onChange({target: {value: '3'}}); tree = view.render();
  submit(tree); view.render({queryKey: 'another:query', navigation: numbered({page: 1})});
  tree = view.render({queryKey: 'self:listens:week', navigation: numbered()});
  assert.equal(tree.props['aria-busy'], false); assert.equal(input(tree).props.value, '2');
  input(tree).props.onChange({target: {value: '3'}}); view.render();
  view.render({navigation: numbered({page: 1})}); tree = view.render({navigation: numbered()});
  assert.equal(input(tree).props.value, '2');
  work.resolve(); await work.promise; view.dispose();
});

test('denial or unmount discards pending completion focus and unavailable callbacks disable controls', async () => {
  for (const unmount of [false, true]) {
    const env = environment(), work = deferred(), view = lifecycle(env, {onPage: () => work.promise});
    const tree = view.render(), source = view.button('Next'); source.focus(); control(tree, 'Next history page').props.onClick();
    env.document.activeElement = env.document.body;
    if (unmount) view.dispose(); else view.render({value: {status: 'denied', data: null}, navigation: {mode: 'none'}});
    work.resolve(); await work.promise;
    if (!unmount) {assert.equal(view.render(), null); view.dispose();}
    assert.equal(env.document.activeElement, env.document.body);
  }
  const env = environment(), host = markup(env, {onPage: null});
  for (const element of host.querySelectorAll('button, input')) assert.equal(element.disabled, true);
  const progressiveHost = markup(env, {navigation: progressive({status: 'error'}), onLoadMore: null, onRetry: null});
  for (const element of progressiveHost.querySelectorAll('button')) assert.equal(element.disabled, true);
});
