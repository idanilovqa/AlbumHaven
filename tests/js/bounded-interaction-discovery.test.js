const test = require('node:test');
const assert = require('node:assert/strict');
const {
  discoverJavaScriptSource,
  findJavaScriptHazards,
} = require('../../scripts/ci/bounded-interaction-discovery.cjs');

const FILE = 'music_app/static/js/runtime/example.js';
const operations = hazards => hazards.map(({ rule, operation }) => [rule, operation]);

test('discovers listeners, timers, observers, requests, and worker messages in stable key order', () => {
  const source = `
    function install(root) {
      root.addEventListener('pointermove', onMove);
      setInterval(pollStatus, 1000);
      new MutationObserver(render).observe(root, { childList: true });
      fetch('/api/view-data');
      worker.addEventListener('message', onWorkerMessage);
    }
  `;
  const base = { language: 'javascript', path: FILE, owner: 'install' };
  assert.deepEqual(discoverJavaScriptSource(source, FILE), [
    { ...base, key: `js:${FILE}#install:event:message`, kind: 'event', trigger: 'message', line: 7 },
    { ...base, key: `js:${FILE}#install:event:pointermove`, kind: 'event', trigger: 'pointermove', line: 3 },
    { ...base, key: `js:${FILE}#install:observer:MutationObserver`, kind: 'observer', trigger: 'MutationObserver', line: 5 },
    { ...base, key: `js:${FILE}#install:request:fetch`, kind: 'request', trigger: 'fetch', line: 6, targets: [{ target: '/api/view-data', line: 6 }] },
    { ...base, key: `js:${FILE}#install:timer:setInterval`, kind: 'timer', trigger: 'setInterval', line: 4 },
  ]);
});

test('discovers handler maps and on-event assignments as event entrypoints', () => {
  const source = `
    var Picker = class {
      constructor(root) {
        this.handlers = { pointermove: event => this.move(event), click: event => this.click(event) };
        root.onscroll = () => this.sync();
      }
    };
  `;
  assert.deepEqual(discoverJavaScriptSource(source, FILE).map(item => item.key), [
    `js:${FILE}#Picker.constructor:event:pointermove`,
    `js:${FILE}#Picker.constructor:event:scroll`,
  ]);
});

test('flags direct broad work inside high-frequency handlers', () => {
  const hazards = findJavaScriptHazards(`
    root.addEventListener('pointermove', () => {
      document.querySelectorAll('[data-track]').forEach(update);
      JSON.stringify(state.rows);
      fetch('/api/refresh');
    });
  `, FILE);
  assert.deepEqual(operations(hazards), [
    ['BI-01', 'querySelectorAll'],
    ['BI-01', 'forEach'],
    ['BI-13', 'JSON.stringify'],
    ['BI-03', 'fetch'],
  ]);
});

test('does not flag iteration over a locally built delta or string helpers', () => {
  const hazards = findJavaScriptHazards(`
    root.addEventListener('pointermove', (event) => {
      const changes = new Map();
      for (let index = 0; index < 2; index += 1) changes.set(index, true);
      changes.forEach(apply);
      String(event.target.dataset.path || '').split('/').map(part => part.trim());
    });
  `, FILE);
  assert.deepEqual(hazards, []);
});

test('ignores broad work in low-frequency handlers', () => {
  assert.deepEqual(findJavaScriptHazards(`
    root.addEventListener('click', () => { document.querySelectorAll('.row').forEach(update); });
  `, FILE), []);
});

test('flags a dedicated Home action routed through generic view-data', () => {
  const hazards = findJavaScriptHazards(`
    function openHome() {
      fetchAndRender('/view-data?surface=home');
    }
  `, FILE);
  assert.deepEqual(operations(hazards), [
    ['BI-04', 'route-owner:/view-data?surface=home'],
    ['BI-13', 'generic-endpoint-for-dedicated-surface'],
  ]);
});

test('flags a dedicated surface passed as a request parameter object', () => {
  const hazards = findJavaScriptHazards(`
    function openHome() {
      return fetchJson(buildUrl('/view-data', { surface: 'home', page: 1 }));
    }
  `, FILE);
  assert.deepEqual(operations(hazards)[0], ['BI-04', 'route-owner:/view-data?surface=home']);
});

test('keeps dynamic request targets unresolved instead of claiming they are safe', () => {
  const [request] = discoverJavaScriptSource('function load(url) { return fetch(`${base}${url}`); }', FILE);
  assert.equal(request.kind, 'request');
  assert.deepEqual(request.targets, [{ target: null, line: 1 }]);
});

test('keeps every request target of one owner under its single entrypoint key', () => {
  const [request] = discoverJavaScriptSource(`
    async function poll() {
      await fetch('/status');
      await fetch('/view-data?include_non_album=1');
    }
  `, FILE);
  assert.deepEqual(request.targets.map(item => item.target), ['/status', '/view-data?include_non_album=1']);
});

// BI-H01: the Loose Tracks drag selection rescanned every rendered row on each
// pointermove (selectRange -> sync -> rows().forEach). The repaired controller
// applies only the rows entering or leaving the previous range.
const DRAG_SELECTION_BEFORE = `
var TrackSelectionController = class {
  constructor(root) {
    this.root = root;
    this.selectedPaths = new Set();
    this.pathList = Array.from(root.querySelectorAll('[data-track-row-path]')).map(row => row.dataset.trackRowPath);
    this.handlers = { pointermove: event => this.handlePointerMove(event) };
  }
  rows() { return Array.from(this.root.querySelectorAll('[data-track-row-path]')); }
  handlePointerMove(event) {
    const path = event.target.closest('[data-track-row-path]')?.dataset.trackRowPath;
    if (path) this.selectRange(this.gesture.path, path);
  }
  selectRange(fromPath, toPath) {
    const from = this.pathList.indexOf(fromPath);
    const to = this.pathList.indexOf(toPath);
    this.sync(this.pathList.slice(Math.min(from, to), Math.max(from, to) + 1));
  }
  sync(nextPaths) {
    this.selectedPaths = new Set(nextPaths);
    this.rows().forEach(row => row.classList.toggle('selected', this.selectedPaths.has(row.dataset.trackRowPath)));
    this.onChange(this.pathList.filter(path => this.selectedPaths.has(path)));
  }
};`;

const DRAG_SELECTION_AFTER = `
var TrackSelectionController = class {
  constructor(root) {
    this.rowByPath = new Map();
    this.indexByPath = new Map();
    this.handlers = { pointermove: event => this.handlePointerMove(event) };
  }
  handlePointerMove(event) {
    const path = event.target.closest('[data-track-row-path]')?.dataset.trackRowPath;
    if (path) this.selectGestureRange(path);
  }
  selectGestureRange(toPath) {
    const to = this.indexByPath.get(toPath) ?? -1;
    const changes = new Map();
    for (let index = this.gesture.previous; index <= to; index += 1) changes.set(this.pathList[index], true);
    changes.forEach((selected, path) => this.syncRow(path, selected));
    this.gesture.previous = to;
  }
  syncRow(path, selected) {
    this.rowByPath.get(path)?.classList.toggle('selected', selected);
  }
};`;

test('BI-H01 drag selection rescans are reported through the helper call graph', () => {
  const { analyzeJavaScriptSources } = require('../../scripts/ci/bounded-interaction-discovery.cjs');
  const before = analyzeJavaScriptSources({ [FILE]: DRAG_SELECTION_BEFORE }).hazards;
  assert.ok(before.length > 0 && before.every(hazard => hazard.depth === 'indirect'));
  assert.ok(before.some(hazard => hazard.operation === 'forEach' && hazard.via.at(-1) === 'TrackSelectionController.sync'));
  assert.ok(before.some(hazard => hazard.operation === 'querySelectorAll' && hazard.via.at(-1) === 'TrackSelectionController.rows'));
  assert.ok(before.every(hazard => hazard.entrypoint === `js:${FILE}#TrackSelectionController.constructor:event:pointermove`));
  assert.deepEqual(analyzeJavaScriptSources({ [FILE]: DRAG_SELECTION_AFTER }).hazards, []);
});

test('flags a generic Home URL that is only returned for a later fetch', () => {
  const hazards = findJavaScriptHazards(`
    function homeUrl(options) {
      return options.omitSidebar ? '/view-data?surface=home&omit_sidebar=1' : '/home-data';
    }
  `, FILE);
  assert.deepEqual(operations(hazards)[0], ['BI-04', 'route-owner:/view-data?surface=home']);
});
