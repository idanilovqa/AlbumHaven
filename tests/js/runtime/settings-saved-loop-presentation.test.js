const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../../..');
const read = name => fs.readFileSync(path.join(root, 'music_app/static/js/runtime', `${name}.js`), 'utf8');
const loops = [
  { id: 'first', name: 'First chorus', title: 'Owned song', start_seconds: 2.5, end_seconds: 6.75, duration_seconds: 4.25, original_start_seconds: 65.5, original_end_seconds: 69.75 },
  { id: 'second', name: 'Second chorus', title: 'Owned song', start_seconds: 8, end_seconds: 12, duration_seconds: 4, original_start_seconds: 71, original_end_seconds: 75 },
];
function setup() {
  const context = {
    window: {}, state: { coverLookup: { drawerOpen: false }, utility: {
      loops: loops.map(loop => ({ ...loop })), selectedLoopId: 'first', selectedLoopGroupKey: 'song',
      selectedLoopDetailMode: 'group', collapsedLoopGroups: {},
      allowedActions: { 'library.loops.read': true, 'library.loops.create': true, 'library.loops.delete': true },
    } },
    escapeHtml: value => String(value ?? ''),
    buildUtilityAlbumArtbox: () => '<span>Art</span>',
    renderPlaybackControlCluster: () => '<div data-playback-control-cluster></div>',
    document: { querySelectorAll: () => [], body: { classList: { add() {}, remove() {} } }, getElementById: () => ({ hidden: true }) },
    handleLibrarySettingsClick: () => false,
    renderUtilityModalContent() {}, showToast() {}, console,
  };
  vm.createContext(context);
  for (const name of ['button-component', 'navigation-tree']) {
    const file = path.join(root, 'music_app/static/js', `${name}.js`);
    if (fs.existsSync(file)) vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  }
  for (const name of ['player-and-waveform', 'utility-list-builders', 'bootstrap-utility-event-handlers', 'utility-loaders-and-cover-lookup', 'tag-editor-and-optimistic-updates']) {
    vm.runInContext(read(name), context);
  }
  context.groupUtilityLoops = () => [group(context)];
  return context;
}
function group(context) { return { key: 'song', loops: context.state.utility.loops, representativeLoop: context.state.utility.loops[0] }; }
function target(attributes) {
  return { getAttribute: name => attributes[name] || '', closest(selector) {
    return Object.keys(attributes).some(name => selector === `[${name}]`) ? this : null;
  } };
}
function event(element, key) { return { target: element, key, preventDefault() {}, stopPropagation() {} }; }

test('L01 child activation keeps song selection and all mounted panel context', async () => {
  const context = setup();
  let renders = 0;
  context.renderUtilityModalContent = () => { renders += 1; };
  await context.handleUtilityBootstrapClick(event(target({ 'data-utility-loop-id': 'second', 'data-utility-loop-group-key': 'song' })));
  assert.equal(context.state.utility.selectedLoopId, 'first');
  assert.equal(context.state.utility.selectedLoopDetailMode, 'group');
  assert.equal(renders, 0, 'child activation must not remount audio panels');
});

test('L01 song double activation toggles expansion without selecting a child', async () => {
  const context = setup();
  const element = target({ 'data-utility-loop-group-key': 'song' });
  await context.handleUtilityBootstrapClick(event(element));
  await context.handleUtilityBootstrapClick(event(element));
  assert.equal(context.state.utility.collapsedLoopGroups.song, true);
  assert.equal(context.state.utility.selectedLoopDetailMode, 'group');
});

for (const key of ['Enter', ' ']) {
  test(`L01 explicit song expansion supports ${key === ' ' ? 'Space' : key}`, () => {
    const context = setup();
    context.handleUtilityBootstrapKeyDown(event(target({ 'data-utility-loop-collapse': 'song' }), key));
    assert.equal(context.state.utility.collapsedLoopGroups.song, true);
  });
}

test('L01 legacy child selection cannot hide sibling loop panels', () => {
  const context = setup();
  const html = context.buildUtilityLoopDetail(group(context), context.state.utility.loops[1]);
  assert.match(html, /data-utility-loop-entry="first"/);
  assert.match(html, /data-utility-loop-entry="second"/);
  assert.doesNotMatch(html, /1 loop selected|Add loop|data-edit-loop-name/);
});

test('L03 panels display original song timestamps separately from playback time', () => {
  const context = setup();
  const html = context.buildUtilityLoopEntry(context.state.utility.loops[0]);
  assert.match(html, /1:05(?:[.,]5)?/);
  assert.match(html, /1:09(?:[.,]75)?/);
  assert.match(html, /data-loop-time="first"/);
  assert.match(html, /data-loop-audio="first"/);
});

test('L04 trash is a shared destructive icon button with the loop name', () => {
  const context = setup();
  const html = context.buildUtilityLoopEntry(context.state.utility.loops[0]);
  const button = html.match(/<button[^>]*data-delete-saved-loop="first"[^>]*>/)?.[0] || '';
  assert.match(button, /ui-button--icon/);
  assert.match(button, /destructive/);
  assert.match(button, /aria-label="[^"]*First chorus/);
});

function confirmationSetup() {
  const context = setup();
  const element = () => ({ hidden: false, textContent: '', innerHTML: '', setAttribute() {}, removeAttribute() {}, focus() {} });
  const modal = Object.fromEntries(['overlay', 'dialog', 'title', 'text', 'accept', 'cancel'].map(key => [key, element()]));
  modal.overlay.hidden = true;
  context.getRepairConfirmElements = () => modal;
  const deletes = [];
  context.deleteSavedLoop = async id => { deletes.push(id); return true; };
  return { context, modal, deletes };
}

test('L04 trash opens a named No/Yes confirmation and cancellation makes no mutation', async () => {
  const { context, modal, deletes } = confirmationSetup();
  await context.handleUtilityBootstrapClick(event(target({ 'data-delete-saved-loop': 'first' })));
  assert.deepEqual(deletes, []);
  assert.equal(modal.overlay.hidden, false);
  assert.match(modal.text.textContent + modal.text.innerHTML, /First chorus/);
  assert.equal(modal.cancel.textContent, 'No');
  assert.equal(modal.accept.textContent, 'Yes');
  context.closeRepairConfirmModal();
  assert.deepEqual(deletes, []);
});

test('L04 Yes invokes existing deletion reconciliation for only the confirmed ID', async () => {
  const { context, deletes } = confirmationSetup();
  assert.equal(typeof context.openSavedLoopDeleteConfirm, 'function');
  context.openSavedLoopDeleteConfirm('first');
  context.state.utility.selectedLoopId = 'second';
  await context.confirmRepairSelectedAlbum();
  assert.deepEqual(deletes, ['first']);
});

test('L06 every saved panel retains its complete border including the first panel', () => {
  const css = fs.readFileSync(path.join(root, 'music_app/static/css/runtime/non-album-and-player.css'), 'utf8');
  const panels = Array.from(css.matchAll(/\.utility-loop-entry\s*\{([^}]+)\}/g), match => match[1]).join('\n');
  const first = Array.from(css.matchAll(/\.utility-loop-entry:first-child\s*\{([^}]+)\}/g), match => match[1]).join('\n');
  assert.match(panels, /(?:^|[;\n])\s*border\s*:\s*1px\s+solid/);
  assert.doesNotMatch(first, /border(?:-top)?\s*:\s*(?:0|none)/);
});


test('L01 tree children show duration and grip without selected styling or Add loop', () => {
  const context = setup();
  context.state.utility.selectedLoopDetailMode = 'loop';
  context.window.NavigationTree.renderItem = options => '<button>' + options.label + options.trailingHtml + '</button>';
  const html = context.buildUtilityLoopTree(group(context), 'song', 'first');
  const child = html.match(/<[^>]*class="utility-loop-tree-child(?:\s|")[^>]*>/)?.[0] || '';
  assert.doesNotMatch(child, /is-active|aria-selected="true"/);
  assert.match(html, /utility-loop-drag-handle/);
  assert.match(html, /0:04/);
  assert.doesNotMatch(html, /Add loop|data-edit-loop-name/);
});



test('L01 activating the selected song retains a playing child and mounted panels', async () => {
  const context = setup();
  context.state.utility.selectedLoopId = 'second';
  context.getUtilityModalElements = () => ({ list: { scrollTop: 100 } });
  let treeRenders = 0;
  context.renderUtilityLoopList = () => { treeRenders += 1; };
  let renders = 0;
  context.renderUtilityModalContent = () => { renders += 1; };
  const element = target({ 'data-utility-loop-group-key': 'song' });
  await context.handleUtilityBootstrapClick(event(element));
  assert.equal(context.state.utility.selectedLoopId, 'second');
  assert.equal(renders, 0);
  await context.handleUtilityBootstrapClick(event(element));
  assert.equal(context.state.utility.collapsedLoopGroups.song, true);
  assert.equal(context.state.utility.selectedLoopId, 'second');
  assert.equal(renders, 0);
  assert.equal(treeRenders, 1);
});

test('L06 narrow saved-panel heading puts original timestamps below reachable title and trash', () => {
  const css = fs.readFileSync(path.join(root, 'music_app/static/css/runtime/non-album-and-player.css'), 'utf8');
  const panels = Array.from(css.matchAll(/\.utility-loop-entry\s*\{([^}]+)\}/g), match => match[1]).join('\n');
  assert.match(panels, /container(?:-name)?\s*:\s*saved-loop-panel/);
  assert.match(panels, /container-type\s*:\s*inline-size|container\s*:[^;]*\/\s*inline-size/);
  const narrow = css.slice(css.indexOf('@container saved-loop-panel'));
  assert.match(narrow, /^@container saved-loop-panel\s*\(max-width:\s*420px\)/);
  assert.match(narrow, /\.utility-loop-heading\s*\{[^}]*display:\s*grid/);
  assert.match(narrow, /\.utility-loop-original-times\s*\{[^}]*grid-row:\s*2/);
  assert.match(narrow, /\[data-delete-saved-loop\][^{]*\{[^}]*grid-row:\s*1/);
  assert.match(css, /\.utility-loop-heading\s*\{[^}]*display:\s*flex/, 'wide panel heading remains the approved horizontal layout');
});

for (const key of ['Enter', ' ']) {
  test(`L01 ${key === ' ' ? 'Space' : 'Enter'} collapse retains toggle focus without scrolling or remounting panels`, () => {
    const context = setup();
    const previous = target({ 'data-utility-loop-collapse': 'song' });
    const focusCalls = [];
    const replacement = { getAttribute: name => name === 'data-utility-loop-collapse' ? 'song' : '', focus(options) { focusCalls.push(options); context.document.activeElement = this; } };
    const list = { scrollTop: 137, querySelector: () => replacement, querySelectorAll: () => [replacement] };
    context.document.activeElement = previous;
    context.document.querySelector = () => replacement;
    context.getUtilityModalElements = () => ({ list });
    let details = 0;
    context.renderUtilityModalContent = () => { details += 1; };
    context.renderUtilityLoopList = () => { context.document.activeElement = context.document.body; list.scrollTop = 0; };
    context.handleUtilityBootstrapKeyDown(event(previous, key));
    assert.strictEqual(context.document.activeElement, replacement);
    assert.deepEqual(JSON.parse(JSON.stringify(focusCalls)), [{ preventScroll: true }]);
    assert.equal(list.scrollTop, 137);
    assert.equal(details, 0);
  });
}

for (const phase of ['loading', 'empty']) {
  test(`L06 ${phase} saved-loop render disposes controls before replacing their DOM`, () => {
    const context = setup();
    vm.runInContext(read('utility-renderers-and-actions'), context);
    const events = [];
    const detail = { classList: { add() {} }, set innerHTML(value) { events.push('replace'); } };
    context.getUtilityModalElements = () => ({ overlay: { hidden: false }, list: {}, detail, count: {} });
    context.disposeMountedLoopActions = node => { assert.strictEqual(node, detail); events.push('dispose'); };
    context.clearUtilityLoopDragState = () => {};
    context.state.utility.loopsLoading = phase === 'loading';
    if (phase === 'empty') context.state.utility.loops = [];
    context.renderUtilityLoops();
    assert.deepEqual(events, ['dispose', 'replace']);
  });
}

test('L06 late loaded loops cannot mount controls while Settings is hidden', () => {
  const context = setup();
  vm.runInContext(read('utility-renderers-and-actions'), context);
  const detail = { classList: { add() {} } };
  context.getUtilityModalElements = () => ({ overlay: { hidden: true }, list: {}, detail, count: {} });
  context.getSelectedUtilityLoopGroup = () => group(context);
  context.renderUtilityLoopList = () => {};
  context.buildUtilityLoopDetail = () => '<section>saved panel</section>';
  context.disposeMountedLoopActions = () => {};
  context.updateUtilityLoopRepeatButton = () => {};
  let mounts = 0;
  context.initializeUtilityLoopPlayer = () => { mounts += 1; };
  context.renderUtilityLoops();
  assert.equal(mounts, 0);
});
