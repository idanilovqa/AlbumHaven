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
    { ...base, key: `js:${FILE}#install:event:message`, kind: 'event', trigger: 'message', line: 7, hot: true },
    { ...base, key: `js:${FILE}#install:event:pointermove`, kind: 'event', trigger: 'pointermove', line: 3, hot: true },
    { ...base, key: `js:${FILE}#install:observer:MutationObserver`, kind: 'observer', trigger: 'MutationObserver', line: 5, hot: true },
    {
      ...base, key: `js:${FILE}#install:request:fetch`, kind: 'request', trigger: 'fetch', line: 6, targets: [{ target: '/api/view-data', line: 6 }], hot: false,
    },
    { ...base, key: `js:${FILE}#install:timer:setInterval`, kind: 'timer', trigger: 'setInterval', line: 4, hot: true },
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

test('reports broad work in low-frequency handlers for a contract without rejecting it', () => {
  const hazards = findJavaScriptHazards(`
    root.addEventListener('click', () => { document.querySelectorAll('.row').forEach(update); });
  `, FILE);
  assert.deepEqual(operations(hazards), [['BI-01', 'querySelectorAll'], ['BI-01', 'forEach']]);
  assert.ok(hazards.every(hazard => !hazard.reject));
});

test('per-event work bounded once per event is a hazard only on high-frequency events', () => {
  const hazards = findJavaScriptHazards(`
    root.addEventListener('click', () => {
      localStorage.getItem('k');
      JSON.parse(text);
      root.innerHTML = '<p></p>';
      return fetch('/api/save');
    });
  `, FILE);
  assert.deepEqual(hazards, []);
});

for (const trigger of ['mouseover', 'pointerover', 'dragover', 'resize']) {
  test(`rejects direct broad work inside a ${trigger} handler`, () => {
    const hazards = findJavaScriptHazards(`root.addEventListener('${trigger}', () => { document.querySelectorAll('.row'); });`, FILE);
    assert.deepEqual(hazards.map(hazard => [hazard.operation, hazard.reject]), [['querySelectorAll', true]]);
  });
}

test('computes reachable hazards for timers, observers, worker messages, and request owners', () => {
  const { analyzeJavaScriptSources } = require('../../scripts/ci/bounded-interaction-discovery.cjs');
  const { hazards } = analyzeJavaScriptSources({ [FILE]: `
    function scanRows() { document.querySelectorAll('.row').forEach(row => row.remove()); }
    function startPoll() { setInterval(scanRows, 1000); }
    function watchSize(node) { new ResizeObserver(() => scanRows()).observe(node); }
    function listen(worker) { worker.onmessage = () => scanRows(); }
    async function save() { await fetch('/api/save'); state.rows.forEach(row => row.saved = true); }
  ` });
  const byEntrypoint = new Map();
  for (const hazard of hazards) byEntrypoint.set(hazard.entrypoint.split('#')[1], [...(byEntrypoint.get(hazard.entrypoint.split('#')[1]) || []), hazard]);
  assert.deepEqual([...byEntrypoint.keys()].sort(), [
    'listen:event:message', 'save:request:fetch', 'startPoll:timer:setInterval', 'watchSize:observer:ResizeObserver',
  ]);
  assert.ok(hazards.every(hazard => !hazard.reject));
  assert.deepEqual(byEntrypoint.get('save:request:fetch').map(hazard => [hazard.operation, hazard.depth]), [['forEach', 'direct']]);
  // The timer's callback is scanRows itself, so its hazards are direct.
  assert.deepEqual(byEntrypoint.get('startPoll:timer:setInterval').map(hazard => [hazard.operation, hazard.depth]), [
    ['forEach', 'direct'], ['querySelectorAll', 'direct'],
  ]);
  assert.deepEqual(byEntrypoint.get('watchSize:observer:ResizeObserver').map(hazard => hazard.via), [['scanRows'], ['scanRows']]);
});

test('resolves calls on global singletons, window functions, instance fields, and optional chains', () => {
  const { analyzeJavaScriptSources } = require('../../scripts/ci/bounded-interaction-discovery.cjs');
  const { hazards } = analyzeJavaScriptSources({ [FILE]: `
    class Grid { render() { document.querySelectorAll('.card'); } }
    class Panel {
      constructor(root) { this.grid = new Grid(); root.addEventListener('scroll', () => this.grid?.render()); }
    }
    const virtualGrid = new Grid();
    window.panelGrid = new Grid();
    function rescan() { document.querySelectorAll('.row'); }
    function install(root) {
      root.addEventListener('wheel', () => virtualGrid?.render?.());
      root.addEventListener('touchmove', () => window.rescan());
      root.addEventListener('pointermove', () => window.panelGrid.render());
      root.addEventListener('mousemove', () => rescan.call(null));
    }
  ` });
  const reached = hazards.map(hazard => `${hazard.entrypoint.split('#')[1]} via ${hazard.via.join('>')}`).sort();
  assert.deepEqual(reached, [
    'Panel.constructor:event:scroll via Grid.render',
    'install:event:mousemove via rescan',
    'install:event:pointermove via Grid.render',
    'install:event:touchmove via rescan',
    'install:event:wheel via Grid.render',
  ]);
});

test('a call chain deeper than the depth limit is a hazard, never a silent pass', () => {
  const { analyzeJavaScriptSources } = require('../../scripts/ci/bounded-interaction-discovery.cjs');
  const chain = [1, 2, 3, 4, 5, 6, 7].map(level => `function step${level}() { step${level + 1}(); }`).join('\n');
  const { hazards } = analyzeJavaScriptSources({ [FILE]: `${chain}\nfunction step8() {}\nroot.addEventListener('wheel', () => step1());` });
  assert.deepEqual(hazards.map(hazard => [hazard.operation, hazard.via.at(-1), hazard.reject, hazard.hot]), [['call-depth-exceeded', 'step7', false, true]]);
});

// Full reachable-hazard proof applies to hot paths; one-shot entrypoints keep
// route, request, and registration checks.
test('classifies hot paths by entrypoint kind: repeating events, observers, intervals, animation loops, and pollers', () => {
  const { analyzeJavaScriptSources } = require('../../scripts/ci/bounded-interaction-discovery.cjs');
  const { entrypoints } = analyzeJavaScriptSources({ [FILE]: `
    function onEvents(root, worker) {
      root.addEventListener('scroll', sync);
      root.addEventListener('timeupdate', sync);
      worker.addEventListener('message', sync);
      root.addEventListener('click', sync);
      root.addEventListener('keydown', sync);
    }
    function watch(node) { new ResizeObserver(sync).observe(node); }
    function tick() { setInterval(sync, 1000); }
    function paint() { requestAnimationFrame(sync); }
    function debounce() { setTimeout(sync, 100); }
    async function poll() { await fetch('/status'); setTimeout(poll, 2000); }
    function schedulePoll() { setTimeout(() => { sync(); refresh(); }, 2000); }
    function refresh() { schedulePoll(); }
    function retry() { load().then(() => { setTimeout(retry, 500); }); }
    function load() { return Promise.resolve(); }
    function sync() {}
  ` });
  const hot = Object.fromEntries(entrypoints.map(item => [item.key.split('#')[1], item.hot]));
  assert.deepEqual(hot, {
    'debounce:timer:setTimeout': false,
    'onEvents:event:click': false,
    'onEvents:event:keydown': false,
    'onEvents:event:message': true,
    'onEvents:event:scroll': true,
    'onEvents:event:timeupdate': true,
    'paint:timer:requestAnimationFrame': false,
    'poll:request:fetch': false,
    'poll:timer:setTimeout': true,
    'retry:timer:setTimeout': true,
    'schedulePoll:timer:setTimeout': true,
    'tick:timer:setInterval': true,
    'watch:observer:ResizeObserver': true,
  });
});

test('hazards reachable only from one-shot entrypoints are reported but not hot', () => {
  const { analyzeJavaScriptSources } = require('../../scripts/ci/bounded-interaction-discovery.cjs');
  const { hazards } = analyzeJavaScriptSources({ [FILE]: `
    function scanRows() { document.querySelectorAll('.row').forEach(row => row.remove()); }
    function install(root) {
      root.addEventListener('click', () => scanRows());
      root.addEventListener('scroll', () => scanRows());
      setTimeout(scanRows, 100);
    }
    async function save() { await fetch('/api/save'); scanRows(); }
    function poll() { scanRows(); setTimeout(poll, 1000); }
  ` });
  const hot = new Map();
  for (const hazard of hazards) hot.set(hazard.entrypoint.split('#')[1], hazard.hot);
  assert.deepEqual(Object.fromEntries(hot), {
    'install:event:click': false,
    'install:event:scroll': true,
    'install:timer:setTimeout': false,
    'poll:timer:setTimeout': true,
    'save:request:fetch': false,
  });
  assert.ok(hazards.every(hazard => !hazard.reject));
});

test('a function that schedules its own callback parameter is a timer helper whose callers are timer entrypoints', () => {
  const { analyzeJavaScriptSources } = require('../../scripts/ci/bounded-interaction-discovery.cjs');
  const { entrypoints, hazards } = analyzeJavaScriptSources({ [FILE]: `
    function scheduleTimeout(callback, delay) { return window.setTimeout(callback, delay); }
    function afterPaint(callback) { return scheduleFrame(callback); }
    function scheduleFrame(callback) { return window.requestAnimationFrame(callback); }
    function schedulePoll(delay) { scheduleTimeout(() => pollStatus(), delay); }
    async function pollStatus() { state.rows.forEach(row => row.seen = true); schedulePoll(1000); }
    function openMenu() { scheduleTimeout(() => focus(), 0); afterPaint(measure); }
    function focus() {}
    function measure() {}
  ` });
  const hot = Object.fromEntries(entrypoints.map(item => [item.key.split('#')[1], item.hot]));
  assert.deepEqual(hot, {
    'afterPaint:timer:scheduleFrame': false,
    'openMenu:timer:afterPaint': false,
    'openMenu:timer:scheduleTimeout': false,
    'scheduleFrame:timer:requestAnimationFrame': false,
    'schedulePoll:timer:scheduleTimeout': true,
    'scheduleTimeout:timer:setTimeout': false,
  });
  assert.deepEqual(hazards.map(hazard => [hazard.entrypoint.split('#')[1], hazard.operation, hazard.hot]), [
    ['schedulePoll:timer:scheduleTimeout', 'forEach', true],
  ]);
});

// A requestAnimationFrame is hot only when its callback can schedule it again,
// directly or through a timer helper (an animation loop). A one-shot frame
// scheduled from a hot handler stays covered as part of that handler's
// reachable work.
test('a one-shot animation frame is not hot, an animation loop is, and a hot handler covers the frames it schedules', () => {
  const { analyzeJavaScriptSources } = require('../../scripts/ci/bounded-interaction-discovery.cjs');
  const { entrypoints, hazards } = analyzeJavaScriptSources({ [FILE]: `
    function scheduleFrame(callback) { return window.requestAnimationFrame(callback); }
    function openPanel() { requestAnimationFrame(() => state.rows.forEach(row => row.open = true)); }
    function afterPaint() { scheduleFrame(measureRows); }
    function measureRows() { state.rows.forEach(row => row.measured = true); }
    function animate() { state.rows.forEach(row => row.step()); requestAnimationFrame(animate); }
    function tween() { scheduleFrame(step); }
    function step() { state.rows.forEach(row => row.step()); tween(); }
    function install(root) {
      root.addEventListener('scroll', () => { scheduleFrame(renderRows); });
    }
    function renderRows() { state.rows.forEach(row => row.render()); }
  ` });
  const hot = Object.fromEntries(entrypoints.map(item => [item.key.split('#')[1], item.hot]));
  assert.deepEqual(hot, {
    'afterPaint:timer:scheduleFrame': false,
    'animate:timer:requestAnimationFrame': true,
    'install:event:scroll': true,
    'install:timer:scheduleFrame': false,
    'openPanel:timer:requestAnimationFrame': false,
    'scheduleFrame:timer:requestAnimationFrame': false,
    'tween:timer:scheduleFrame': true,
  });
  const hotHazards = hazards.filter(hazard => hazard.hot).map(hazard => [hazard.entrypoint.split('#')[1], hazard.operation, hazard.via.at(-1) || '<handler>']);
  // `row.step()` names an application function on an unknown receiver.
  assert.deepEqual(hotHazards, [
    ['animate:timer:requestAnimationFrame', 'forEach', '<handler>'],
    ['animate:timer:requestAnimationFrame', 'unresolved-call:row.step', '<handler>'],
    ['install:event:scroll', 'forEach', 'renderRows'],
    ['tween:timer:scheduleFrame', 'forEach', '<handler>'],
    ['tween:timer:scheduleFrame', 'unresolved-call:row.step', '<handler>'],
  ]);
});

test('a name bound inside the enclosing function never resolves to a same-named function elsewhere', () => {
  const { analyzeJavaScriptSources } = require('../../scripts/ci/bounded-interaction-discovery.cjs');
  const { hazards } = analyzeJavaScriptSources({ [FILE]: `
    function cancel() { document.querySelectorAll('.row').forEach(row => row.remove()); }
    function resolve() { state.rows.forEach(row => row.done = true); }
    function install(root, resolve) {
      const cancel = () => root.classList.remove('open');
      root.addEventListener('scroll', () => { cancel(); resolve(); });
    }
    function global(root) { root.addEventListener('wheel', () => cancel()); }
  ` });
  // The parameter `resolve` is not the global `resolve`; on a hot path its
  // unknown callee is itself a hazard.
  assert.deepEqual(hazards.map(hazard => [hazard.entrypoint.split('#')[1], hazard.operation]), [
    ['global:event:wheel', 'forEach'],
    ['global:event:wheel', 'querySelectorAll'],
    ['install:event:scroll', 'unresolved-call:resolve'],
  ]);
});

test('aliases, singleton aliases, and object literal members resolve to the code they run', () => {
  const { analyzeJavaScriptSources } = require('../../scripts/ci/bounded-interaction-discovery.cjs');
  const { hazards } = analyzeJavaScriptSources({
    [FILE]: `
      class VirtualArtistGrid { relayout() { document.querySelectorAll('.card').forEach(card => card.remove()); } }
      const virtualGrid = new VirtualArtistGrid();
      function heavy() { state.rows.forEach(row => row.seen = true); }
      function install(root) {
        const hooks = { onScroll() { state.tracks.forEach(track => track.seen = true); } };
        root.addEventListener('scroll', () => { const run = heavy; run(); });
        root.addEventListener('wheel', () => { const grid = virtualGrid; grid.relayout(); });
        root.addEventListener('pointermove', () => hooks.onScroll());
      }
    `,
    'music_app/static/js/runtime/api.js': `
      (function (scope) {
        function renderRows() { state.rows.map(row => row.html).join(''); }
        const api = { renderRows };
        if (scope) scope.RowApi = api;
      })(typeof window !== 'undefined' ? window : null);
    `,
    'music_app/static/js/runtime/consumer.js': `
      document.addEventListener('scroll', () => RowApi.renderRows());
    `,
  });
  const reached = trigger => hazards.filter(hazard => hazard.entrypoint.endsWith(`:event:${trigger}`)).map(hazard => [hazard.operation, hazard.via.at(-1)]);
  assert.deepEqual(reached('scroll').filter(([operation]) => operation === 'forEach'), [['forEach', 'heavy']]);
  assert.deepEqual(reached('wheel'), [['forEach', 'VirtualArtistGrid.relayout'], ['querySelectorAll', 'VirtualArtistGrid.relayout']]);
  assert.deepEqual(reached('pointermove'), [['forEach', '<inline>']]);
  assert.deepEqual(hazards.filter(hazard => hazard.path.endsWith('api.js')).map(hazard => [hazard.operation, hazard.via.at(-1)]), [
    ['join', 'renderRows'], ['map', 'renderRows'],
  ]);
});

test('on a hot path a call that resolves to nothing is a hazard unless it is platform work', () => {
  const { analyzeJavaScriptSources } = require('../../scripts/ci/bounded-interaction-discovery.cjs');
  const { hazards } = analyzeJavaScriptSources({ [FILE]: `
    var Panel = class { refreshRows() { state.rows.forEach(row => row.seen = true); } };
    function install(root, onScroll, handlers) {
      root.addEventListener('scroll', (event) => {
        onScroll(event);
        handlers[event.type]();
        root.contains(event.target);
        localStore.getItem('k');
        requestIdleCallback(() => {});
        event.target.panel.refreshRows();
      });
      root.addEventListener('click', () => onScroll());
    }
  ` });
  assert.deepEqual(hazards.map(hazard => [hazard.entrypoint.split('#')[1], hazard.operation, hazard.reject]), [
    ['install:event:scroll', 'unresolved-call:handlers[…]', false],
    ['install:event:scroll', 'unresolved-call:onScroll', false],
    ['install:event:scroll', 'unresolved-call:….refreshRows', false],
  ]);
});

test('a called parameter is known from its call sites, and a function passed on is followed from its caller', () => {
  const { analyzeJavaScriptSources } = require('../../scripts/ci/bounded-interaction-discovery.cjs');
  const { hazards } = analyzeJavaScriptSources({ [FILE]: `
    function heavy() { state.rows.forEach(row => row.seen = true); }
    function light() { return 1; }
    function each(visit) { visit(); }
    function notify({ onDone }) { onDone(); }
    function settle(options) { options.onSettled?.(); }
    function wait() { return new Promise(resolve => resolve()); }
    function install(root, external) {
      root.addEventListener('scroll', () => {
        each(heavy);
        notify({ onDone: light });
        settle({ onSettled: light });
        wait();
      });
      root.addEventListener('wheel', () => each(light));
      root.addEventListener('pointermove', () => external());
    }
  ` });
  assert.deepEqual(hazards.map(hazard => [hazard.entrypoint.split(':event:')[1], hazard.operation, hazard.via.at(-1)]), [
    ['pointermove', 'unresolved-call:external', undefined],
    ['scroll', 'forEach', 'heavy'],
  ]);
});

test('listener event names resolve through constant lists, object keys, tuples, and call sites, each with its own handler', () => {
  const { analyzeJavaScriptSources } = require('../../scripts/ci/bounded-interaction-discovery.cjs');
  const { entrypoints, hazards } = analyzeJavaScriptSources({ [FILE]: `
    function heavy() { state.rows.forEach(row => row.seen = true); }
    function light() {}
    function loops(root) {
      for (const type of ['pointerdown', 'wheel']) root.addEventListener(type, light);
      const EVENT = 'keydown';
      root.addEventListener(EVENT, light);
    }
    function entries(root) {
      const listeners = { ...{ scroll: heavy }, click() {} };
      for (const [type, handler] of Object.entries(listeners)) root.addEventListener(type, handler);
      Object.keys({ focusin: 1 }).forEach(type => root.addEventListener(type, light));
    }
    function tuples() {
      const targets = [[window, 'resize'], [document, 'load']].filter(([target]) => target);
      targets.forEach(([target, event]) => target.addEventListener(event, light));
    }
    function dialog(modal) {
      const listen = (node, name, handler) => node.addEventListener(name, handler);
      listen(modal, 'input', heavy);
      listen(modal, 'submit', light);
    }
  ` });
  assert.deepEqual(entrypoints.filter(item => item.kind === 'event').map(item => item.key.split('#')[1]), [
    'entries:event:click', 'entries:event:focusin', 'entries:event:scroll',
    'listen:event:input', 'listen:event:submit',
    'loops:event:keydown', 'loops:event:pointerdown', 'loops:event:wheel',
    'tuples:event:load', 'tuples:event:resize',
  ]);
  // Each event runs its own handler: only the scroll entry and input call site reach `heavy`.
  assert.deepEqual([...new Set(hazards.map(hazard => hazard.entrypoint.split('#')[1]))], ['entries:event:scroll', 'listen:event:input']);
});

test('a listener whose event name does not resolve is rejected until it is made resolvable', async () => {
  const { analyzeJavaScriptSources } = require('../../scripts/ci/bounded-interaction-discovery.cjs');
  const { validateInventory } = require('../../scripts/ci/validate-bounded-interactions.cjs');
  const discovery = analyzeJavaScriptSources({ [FILE]: `
    function install(root, options) { root.addEventListener(options.type, () => {}); }
    function computed(root, prefix) { root.addEventListener(\`\${prefix}move\`, () => {}); }
  ` });
  assert.deepEqual(discovery.entrypoints, []);
  const errors = validateInventory({ interactions: [] }, discovery);
  assert.equal(errors.length, 2);
  assert.ok(errors.every(error => /^unresolved-trigger at music_app\/static\/js\/runtime\/example\.js:\d+: discovery cannot resolve/.test(error)), errors.join('\n'));
});

test('a hot entrypoint whose own callback does not resolve is a hazard', () => {
  const { analyzeJavaScriptSources } = require('../../scripts/ci/bounded-interaction-discovery.cjs');
  const { hazards } = analyzeJavaScriptSources({ [FILE]: `
    function install(root, handlers) { root.addEventListener('scroll', handlers.scroll); }
  ` });
  assert.deepEqual(hazards.map(hazard => hazard.operation), ['unresolved-call:handlers.scroll']);
});

test('lookup and copy methods and indexed loops over shared collections are hazards', () => {
  const hazards = findJavaScriptHazards(`
    root.addEventListener('scroll', (event) => {
      state.rows.includes(event.target);
      state.rows.indexOf(event.target);
      state.rows.slice(0, 10);
      state.rows.join(',');
      state.rows.findLast(Boolean);
      for (let index = 0; index < state.rows.length; index += 1) state.rows[index].seen = true;
    });
    root.addEventListener('wheel', () => { let cursor = 0; while (cursor < this.items.length) cursor += 1; });
  `, FILE);
  assert.deepEqual(hazards.map(hazard => hazard.operation), ['includes', 'indexOf', 'slice', 'join', 'findLast', 'indexed-loop', 'indexed-loop']);
});

test('lookups and indexed loops over owned collections and primitives are not hazards', () => {
  assert.deepEqual(findJavaScriptHazards(`
    root.addEventListener('scroll', (event) => {
      const owned = [1, 2];
      owned.includes(2);
      for (let index = 0; index < owned.length; index += 1) owned[index] += 1;
      String(event.target.dataset.path).slice(1).includes('/');
    });
  `, FILE), []);
});

test('reverse and count-down loops, copying methods, and borrowed array methods over shared collections are hazards', () => {
  const hazards = findJavaScriptHazards(`
    // One report per operation and handler, so each loop has its own handler.
    root.addEventListener('scroll', () => {
      for (let index = state.rows.length - 1; index >= 0; index -= 1) state.rows[index].seen = true;
    });
    root.addEventListener('wheel', () => {
      let remaining = state.rows.length;
      while (remaining--) state.rows[remaining].seen = true;
    });
    root.addEventListener('pointermove', () => {
      const total = state.rows.length;
      for (let index = 0; index < total; index += 1) state.rows[index].seen = true;
    });
    root.addEventListener('scroll', () => {
      state.rows.reduceRight((sum, row) => sum + row.size, 0);
      state.rows.findLastIndex(Boolean);
      state.rows.lastIndexOf(null);
      state.rows.toSorted();
      state.rows.toReversed();
      state.rows.toSpliced(0, 1);
      state.rows.flat();
      state.rows.concat([]);
      Array.prototype.forEach.call(state.rows, row => row.step());
      [].map.apply(state.rows, [row => row.id]);
    });
  `, FILE);
  assert.deepEqual(hazards.map(hazard => hazard.operation), [
    'indexed-loop', 'indexed-loop', 'indexed-loop', 'reduceRight', 'findLastIndex', 'lastIndexOf', 'toSorted', 'toReversed',
    'toSpliced', 'flat', 'concat', 'Array.prototype.forEach', 'Array.prototype.map',
  ]);
});

test('a binary search or a loop that only starts at a shared length does not walk the collection', () => {
  assert.deepEqual(findJavaScriptHazards(`
    root.addEventListener('scroll', (event) => {
      for (let low = 0, high = state.rows.length - 1; low <= high;) {
        const middle = (low + high) >> 1;
        if (state.rows[middle].top < event.y) low = middle + 1; else high = middle - 1;
      }
      const owned = [1, 2];
      for (let index = state.seen.length; index < owned.length; index += 1) owned[index] = 0;
      Array.prototype.forEach.call(owned, item => item);
      let countdown = owned.length;
      while (countdown--) owned[countdown] = 0;
    });
  `, FILE), []);
});

test('string-typed bindings are not collections, however they are reassigned or passed on', () => {
  assert.deepEqual(findJavaScriptHazards(`
    root.addEventListener('scroll', (event) => {
      const source = String(event.target.dataset.src || '').trim();
      let path = source;
      const hash = path.indexOf('#');
      if (hash >= 0) path = path.slice(0, hash);
      const id = Math.random().toString(16).slice(2);
      const label = \`\${id}:\${path}\`;
      label.includes('?') ? record(label) : record(path.slice(1));
      for (const part of label.split('&')) part.indexOf('=');
    });
  `, FILE), []);
});

test('a binding counts as a string only when every value it is ever given is one', () => {
  const hazards = findJavaScriptHazards(`
    root.addEventListener('scroll', () => {
      let path = String(state.path);
      if (state.flag) path = state.rows;
      path.includes('x');
      let other = String(state.path);
      [other] = state.rows;
      other.slice(1);
    });
  `, FILE);
  assert.deepEqual(hazards.map(hazard => hazard.operation), ['includes', 'slice']);
});

test('fixed-length typed arrays, strings split apart, and URLs are bounded by construction', () => {
  assert.deepEqual(findJavaScriptHazards(`
    root.addEventListener('scroll', (event) => {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 15) | 64;
      const hex = [...bytes].map(value => value.toString(16)).join('');
      Array.from(window.crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16)).join('');
      const parsed = new URL(event.target.href, location.href);
      [...parsed.searchParams.keys()].every(key => key === 'token');
      const sources = [event.target.src, event.target.dataset.fallback].map(String).filter(Boolean);
      sources.filter((source, index) => sources.indexOf(source) === index);
      return hex;
    });
  `, FILE), []);
});

// `owner:operation` for each reported hazard; one owner per case, because a
// handler reports each operation once.
const reportedByOwner = source => findJavaScriptHazards(source, FILE)
  .map(hazard => `${hazard.entrypoint.split('#')[1].split(':')[0]}:${hazard.operation}`).sort();

test('a value bounded by construction stays a hazard once it can grow or escape', () => {
  assert.deepEqual(reportedByOwner(`
    function grownUrl() {
      root.addEventListener('click', () => {
        const params = new URL(location.href);
        state.rows.forEach(row => params.searchParams.append('id', row.id));
        return [...params.searchParams.keys()];
      });
    }
    function escapedUrl() {
      root.addEventListener('click', () => {
        const params = new URL(location.href);
        fill(params);
        return [...params.searchParams.keys()];
      });
    }
    function bounded() {
      root.addEventListener('click', () => {
        const params = new URL(location.href);
        return [...params.searchParams.keys()];
      });
    }
  `), ['escapedUrl:spread', 'grownUrl:forEach', 'grownUrl:spread']);
});

test('spreading or enumerating a fixed-shape object is bounded', () => {
  assert.deepEqual(findJavaScriptHazards(`
    function claimContext() { return active() ? { clientId: tabId(), claimToken: token() } : {}; }
    function emptyFields(session) { if (!session) return {}; return { id: session.id, total: session.total }; }
    root.addEventListener('scroll', (event) => {
      const claim = claimContext();
      const payload = { ...emptyFields(event.session), ...claim, path: String(event.target.dataset.path) };
      for (const key in payload) record(key);
      Object.keys(claim).forEach(key => record(key));
      return payload;
    });
  `, FILE), []);
});

test('spreading or enumerating a keyed map, shared state, or an object that escapes stays a hazard', () => {
  assert.deepEqual(reportedByOwner(`
    const DEFAULTS = { theme: 'dark', size: 2 };
    const index = {};
    const target = {};
    function addRow(row) { index[row.id] = row; }
    function fill() { Object.assign(target, state.byId); }
    function cached() { return state.cache; }
    function fixed() { root.addEventListener('click', () => [{ ...DEFAULTS }, Object.keys(DEFAULTS)]); }
    function keyed() { root.addEventListener('click', () => [{ ...index }, Object.keys(index)]); }
    function escaped() { root.addEventListener('click', () => ({ ...target })); }
    function returnsShared() { root.addEventListener('click', () => ({ ...cached() })); }
    function shared() { root.addEventListener('click', () => ({ ...state.byId })); }
  `), [
    'escaped:spread',
    'keyed:Object.keys',
    'keyed:spread',
    'returnsShared:spread',
    'shared:spread',
  ]);
});

test('an element or member of a bounded value is not itself bounded', () => {
  assert.deepEqual(reportedByOwner(`
    const LISTS = [state.rows, state.albums];
    const CONTEXT = { rows: state.rows };
    function element() { root.addEventListener('click', () => LISTS[0].forEach(row => row.seen)); }
    function found() { root.addEventListener('click', () => LISTS.find(Boolean).map(row => row.id)); }
    function member() { root.addEventListener('click', () => CONTEXT.rows.filter(Boolean)); }
    function count() { root.addEventListener('click', () => LISTS.map(list => list.length)); }
  `), ['element:forEach', 'found:map', 'member:filter']);
});

test('Object.entries and Array.from are as large as their argument', () => {
  assert.deepEqual(reportedByOwner(`
    function build(query) { Object.entries(query || {}).forEach(([key, value]) => record(key, value)); }
    function fromParam() { root.addEventListener('click', event => build(event.query)); }
    function fromState() {
      root.addEventListener('click', () => {
        Object.entries(state.byId).forEach(entry => record(entry));
        return Array.from(state.rows).map(row => row.id);
      });
    }
  `), ['fromState:Array.from', 'fromState:Object.entries', 'fromState:forEach', 'fromState:map']);
});

test('a top-level binding is proven only when no other runtime script can grow it', () => {
  const { analyzeJavaScriptSources } = require('../../scripts/ci/bounded-interaction-discovery.cjs');
  const handler = "root.addEventListener('scroll', () => KEYS.forEach(key => record(key)));";
  const alone = analyzeJavaScriptSources({ [FILE]: `const KEYS = ['a', 'b'];\n${handler}` });
  assert.deepEqual(alone.hazards, []);
  const grown = analyzeJavaScriptSources({
    [FILE]: `const KEYS = ['a', 'b'];\n${handler}`,
    'music_app/static/js/runtime/other.js': 'function grow() { state.rows.forEach(row => KEYS.push(row.id)); }',
  });
  assert.deepEqual(grown.hazards.filter(hazard => hazard.path === FILE).map(hazard => hazard.operation), ['forEach']);
});

test('a template hole that only appends a query string keeps the literal request path', () => {
  const [request] = discoverJavaScriptSource('function load(qs) { return fetch(`/view-data${qs ? `?${qs}` : \'\'}`); }', FILE);
  assert.deepEqual(request.targets.map(item => item.target), ['/view-data?${}']);
  const [pathHole] = discoverJavaScriptSource('function load(id) { return fetch(`/albums/${id}`); }', FILE);
  assert.deepEqual(pathHole.targets.map(item => item.target), ['/albums/${}']);
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

test('resolves request targets through constants, URL objects, and URL builders', () => {
  const requests = discoverJavaScriptSource(`
    const STATUS_URL = '/status';
    function buildApiUrl(view) {
      if (view.surface === 'home') return view.compact ? '/home-data?omit_sidebar=1' : '/home-data';
      return \`/view-data?surface=\${view.surface}\`;
    }
    async function load(view) {
      const settings = new URL('/library-settings', location.origin);
      await fetch(STATUS_URL);
      await fetch(settings.href);
      await fetch(buildApiUrl(view));
    }
  `, FILE);
  assert.deepEqual(requests[0].targets.map(item => item.target), [
    '/status', '/library-settings', '/home-data?omit_sidebar=1', '/home-data', '/view-data?surface=${}',
  ]);
});

test('a function that passes its own parameter to fetch becomes a request helper', () => {
  const requests = discoverJavaScriptSource(`
    async function requestJson(url, options) { return (await fetch(url, options)).json(); }
    function openAccount() { return requestJson('/account'); }
    function openUnknown(link) { return requestJson(link.href); }
  `, FILE);
  assert.deepEqual(requests.map(item => [item.key.split('#')[1], item.targets.map(({ target, delegated }) => (delegated ? 'delegated' : target))]), [
    ['openAccount:request:requestJson', ['/account']],
    ['openUnknown:request:requestJson', [null]],
    ['requestJson:request:fetch', ['delegated']],
  ]);
});
