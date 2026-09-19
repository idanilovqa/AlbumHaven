const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const runtimePath = path.join(
  __dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'loop-range-controls.js',
);

class FakeElement {
  constructor({ attributes = {}, rect = { left: 100, width: 200 }, tagName = 'DIV' } = {}) {
    this.attributes = { ...attributes };
    this.dataset = {};
    this.disabled = false;
    this.hidden = false;
    this.hovered = false;
    this.listeners = new Map();
    this.rect = rect;
    const styleProperties = new Map();
    this.style = {
      setProperty(name, value) { styleProperties.set(name, String(value)); },
      getPropertyValue(name) { return styleProperties.get(name) || ''; },
    };
    this.tagName = tagName;
    this.textContent = '';
    this.classNames = new Set();
    this.classList = {
      toggle: (name, force) => {
        if (force) this.classNames.add(name);
        else this.classNames.delete(name);
      },
      contains: (name) => this.classNames.has(name),
    };
  }

  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) || [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  removeEventListener(name, listener) { this.listeners.set(name, (this.listeners.get(name) || []).filter(item => item !== listener)); }

  dispatch(name, event = {}) {
    if (name === 'pointerenter') this.hovered = true;
    if (name === 'pointerleave') this.hovered = false;
    for (const listener of this.listeners.get(name) || []) {
      listener({ preventDefault() {}, pointerId: 1, ...event });
    }
  }

  focus() { this.focused = true; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  getBoundingClientRect() { return this.rect; }
  matches(selector) { return selector === ':hover' && this.hovered; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  setPointerCapture(pointerId) { this.capturedPointerId = pointerId; }
}

function loadSharedControls() {
  const documentListeners = new Map();
  const animationFrames = [];
  const timers = new Map();
  let now = 0;
  let timerId = 0;
  const context = {
    console,
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    document: {
      addEventListener(name, listener) {
        const listeners = documentListeners.get(name) || [];
        listeners.push(listener);
        documentListeners.set(name, listeners);
      },
      removeEventListener(name, listener) { documentListeners.set(name, (documentListeners.get(name) || []).filter(item => item !== listener)); },
    },
    formatLoopTime(value) { return `T${Number(value).toFixed(3)}`; },
    requestAnimationFrame(callback) {
      animationFrames.push(callback);
      return animationFrames.length;
    },
    cancelAnimationFrame(id) { animationFrames[id - 1] = null; },
  };
  vm.createContext(context);
  if (fs.existsSync(runtimePath)) {
    vm.runInContext(fs.readFileSync(runtimePath, 'utf8'), context, { filename: runtimePath });
  }
  return {
    context,
    tick(elapsed) {
      const end = now + elapsed;
      while (true) {
        const due = [...timers.entries()].filter(([, item]) => item.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at; timers.delete(due[0]); due[1].callback();
      }
      now = end;
    },
    documentListenerCount: () => [...documentListeners.values()].reduce((sum, listeners) => sum + listeners.length, 0),
    dispatchDocument(name, event = {}) {
      for (const listener of documentListeners.get(name) || []) listener(event);
    },
    flushAnimationFrame() {
      const callbacks = animationFrames.splice(0);
      callbacks.forEach((callback) => callback?.(16));
    },
  };
}

function createActionRoot() {
  const idle = new FakeElement({ attributes: { 'data-loop-action': 'enter' }, tagName: 'BUTTON' });
  const create = new FakeElement({ attributes: { 'data-loop-action': 'create' }, tagName: 'BUTTON' });
  const cancel = new FakeElement({ attributes: { 'data-loop-action': 'cancel' }, tagName: 'BUTTON' });
  const expanded = new FakeElement({ attributes: { 'data-loop-action-expanded': '' } });
  const divider = new FakeElement({ attributes: { 'data-loop-action-divider': '' } });
  const root = new FakeElement({ attributes: { 'data-loop-action-state': 'idle' } });
  root.idle = idle;
  root.create = create;
  root.cancel = cancel;
  root.expanded = expanded;
  root.divider = divider;
  root.ownerDocument = { activeElement: null };
  root.contains = (element) => [root, idle, create, cancel, expanded, divider].includes(element);
  root.querySelector = (selector) => ({
    '[data-loop-action="enter"]': idle,
    '[data-loop-action="create"]': create,
    '[data-loop-action="cancel"]': cancel,
    '[data-loop-action-expanded]': expanded,
    '[data-loop-action-divider]': divider,
  }[selector] || null);
  return root;
}

function createRangeRoot() {
  const surface = new FakeElement({ attributes: { 'data-loop-range-surface': '' } });
  const start = new FakeElement({ attributes: { 'data-loop-range-handle': 'start' }, tagName: 'BUTTON' });
  const end = new FakeElement({ attributes: { 'data-loop-range-handle': 'end' }, tagName: 'BUTTON' });
  const startTime = new FakeElement({ attributes: { 'data-loop-range-time': 'start' } });
  const endTime = new FakeElement({ attributes: { 'data-loop-range-time': 'end' } });
  const bySelector = {
    '[data-loop-range-surface]': surface,
    '[data-loop-range-handle="start"]': start,
    '[data-loop-range-handle="end"]': end,
    '[data-loop-range-time="start"]': startTime,
    '[data-loop-range-time="end"]': endTime,
  };
  const styleProperties = new Map();
  const style = {
    setProperty(name, value) { styleProperties.set(name, String(value)); },
    getPropertyValue(name) { return styleProperties.get(name) || ''; },
  };
  return {
    surface,
    start,
    end,
    startTime,
    endTime,
    style,
    querySelector: (selector) => bySelector[selector] || null,
  };
}

test('shared scissors action expands into create and cancel actions with accessible state', () => {
  const { context } = loadSharedControls();
  assert.equal(typeof context.buildLoopEditActionControl, 'function', 'shared action markup builder must exist');
  assert.equal(typeof context.mountLoopEditActionControl, 'function', 'shared action controller must exist');

  const markup = context.buildLoopEditActionControl({
    ownerId: 'player', enterLabel: 'Edit loop', createLabel: 'Create loop', cancelLabel: 'Cancel loop edit',
  });
  assert.match(markup, /data-loop-action-owner="player"/);
  assert.match(markup, /data-loop-action="enter"/);
  assert.match(markup, /aria-label="Edit loop"/);
  assert.match(markup, /data-loop-action="create"[^>]*aria-label="Create loop"/);
  assert.match(markup, /data-loop-action="cancel"[^>]*aria-label="Cancel loop edit"/);

  const root = createActionRoot();
  const calls = [];
  const controller = context.mountLoopEditActionControl({
    root, active: false, busy: false,
    onEnter: () => calls.push('enter'), onCreate: () => calls.push('create'), onCancel: () => calls.push('cancel'),
  });
  root.idle.dispatch('click');
  controller.update({ active: true, busy: false });
  root.create.dispatch('click');
  root.cancel.dispatch('click');

  assert.deepEqual(calls, ['enter', 'create', 'cancel']);
  assert.equal(root.idle.getAttribute('aria-pressed'), 'true');
  assert.equal(root.idle.hidden, true);
  assert.equal(root.create.hidden, false);
  assert.equal(root.cancel.hidden, false);
});

test('shared scissors uses one persistent pod with stable create divider and cancel nodes', () => {
  const { context } = loadSharedControls();
  const markup = context.buildLoopEditActionControl({ ownerId: 'player' });
  assert.equal((markup.match(/data-loop-action-owner=/g) || []).length, 1);
  assert.match(markup, /data-loop-action-pod/);
  assert.match(markup, /data-loop-action="create"[^]*data-loop-action-divider[^]*data-loop-action="cancel"/);

  const root = createActionRoot();
  const stableNodes = [root.create, root.divider, root.cancel];
  const controller = context.mountLoopEditActionControl({ root, enabled: true, active: false, busy: false });
  assert.equal(typeof controller.destroy, 'function');
  controller.update({ enabled: true, active: true, busy: false });
  controller.update({ enabled: true, active: false, busy: false });
  assert.deepEqual(
    [root.create, root.divider, root.cancel],
    stableNodes,
    'state changes retain the exact same pod nodes',
  );
});

test('shared scissors exposes disabled semantics and equivalent pointer and focus engagement', () => {
  const { context, tick } = loadSharedControls();
  const root = createActionRoot();
  const calls = [];
  const controller = context.mountLoopEditActionControl({
    root,
    active: false,
    busy: false,
    enabled: false,
    disabledLabel: 'Start playing the track to edit the loop',
    onEnter: () => calls.push('enter'),
    onCreate: () => calls.push('create'),
    onCancel: () => calls.push('cancel'),
  });

  root.idle.dispatch('click');
  assert.deepEqual(calls, []);
  assert.equal(root.idle.disabled, true);
  assert.equal(root.idle.getAttribute('aria-disabled'), 'true');
  assert.equal(root.idle.getAttribute('title'), 'Start playing the track to edit the loop');
  assert.equal(root.getAttribute('data-loop-action-state'), 'disabled');

  controller.update({ enabled: true, active: true, busy: false });
  assert.equal(root.getAttribute('data-loop-action-engaged'), 'false');
  root.dispatch('pointerenter');
  assert.equal(root.getAttribute('data-loop-action-engaged'), 'true');
  root.dispatch('pointerleave');
  tick(500);
  assert.equal(root.getAttribute('data-loop-action-engaged'), 'false');
  root.dispatch('focusin');
  assert.equal(root.getAttribute('data-loop-action-engaged'), 'true');
  root.dispatch('focusout', { relatedTarget: null });
  tick(500);
  assert.equal(root.getAttribute('data-loop-action-engaged'), 'false');

  root.create.dispatch('click');
  root.cancel.dispatch('click');
  assert.deepEqual(calls, ['create', 'cancel']);
});

test('shared scissors remembers idle pointer entry through the synchronous active child swap', () => {
  const { context, tick } = loadSharedControls();
  const root = createActionRoot();
  const calls = [];
  const hoverDuringActivation = [];
  let controller;
  controller = context.mountLoopEditActionControl({
    root,
    enabled: true,
    active: false,
    busy: false,
    onEnter: () => {
      calls.push('enter');
      root.hovered = false;
      hoverDuringActivation.push(root.matches(':hover'));
      controller.update({ active: true });
    },
  });

  root.dispatch('pointerenter');
  assert.equal(root.matches(':hover'), true);
  assert.equal(root.getAttribute('data-loop-action-engaged'), 'false');
  root.idle.dispatch('click');
  assert.deepEqual(calls, ['enter']);
  assert.deepEqual(
    hoverDuringActivation,
    [false],
    'the enter-to-create child swap can make :hover unavailable during the synchronous update',
  );
  assert.equal(
    root.getAttribute('data-loop-action-engaged'),
    'true',
    'the controller must remember the prior root pointer entry and unfold the replacement actions',
  );

  root.dispatch('focusout', { relatedTarget: null });
  assert.equal(
    root.getAttribute('data-loop-action-engaged'),
    'true',
    'hiding the clicked enter button can drop focus, but the pod stays engaged until pointerleave',
  );
  root.dispatch('pointerleave');
  tick(500);
  assert.equal(root.getAttribute('data-loop-action-engaged'), 'false');

  root.dispatch('focusin');
  assert.equal(root.getAttribute('data-loop-action-engaged'), 'true');
  root.dispatch('pointerenter');
  root.dispatch('pointerleave');
  assert.equal(
    root.getAttribute('data-loop-action-engaged'),
    'true',
    'focus inside the active pod keeps it engaged after the pointer leaves',
  );
  root.dispatch('focusout', { relatedTarget: null });
  tick(500);
  assert.equal(root.getAttribute('data-loop-action-engaged'), 'false');

  const awayRoot = createActionRoot();
  const awayController = context.mountLoopEditActionControl({
    root: awayRoot,
    enabled: true,
    active: false,
    busy: false,
  });
  awayController.update({ active: true });
  assert.equal(awayRoot.matches(':hover'), false);
  assert.equal(awayRoot.getAttribute('data-loop-action-engaged'), 'false');
});

test('shared scissors reconciles async activation from live hover and focus ownership', () => {
  const { context, tick } = loadSharedControls();
  const awayRoot = createActionRoot();
  const awayController = context.mountLoopEditActionControl({
    root: awayRoot,
    enabled: true,
    active: false,
    busy: false,
  });
  awayController.update({ active: true });
  assert.equal(awayRoot.matches(':hover'), false);
  assert.equal(awayRoot.contains(awayRoot.ownerDocument.activeElement), false);
  assert.equal(awayRoot.getAttribute('data-loop-action-engaged'), 'false');

  const hoveredRoot = createActionRoot();
  const hoveredController = context.mountLoopEditActionControl({
    root: hoveredRoot,
    enabled: true,
    active: false,
    busy: false,
  });

  hoveredRoot.hovered = true;
  assert.equal(hoveredRoot.matches(':hover'), true);
  assert.equal(hoveredRoot.getAttribute('data-loop-action-engaged'), 'false');
  hoveredController.update({ active: true });
  assert.equal(
    hoveredRoot.getAttribute('data-loop-action-engaged'),
    'true',
    'a later active update must reconcile stale pointer memory with the live root hover state',
  );
  hoveredRoot.dispatch('pointerleave');
  tick(500);
  assert.equal(hoveredRoot.getAttribute('data-loop-action-engaged'), 'false');

  const focusedRoot = createActionRoot();
  const focusedController = context.mountLoopEditActionControl({
    root: focusedRoot,
    enabled: true,
    active: false,
    busy: false,
  });
  focusedRoot.ownerDocument.activeElement = focusedRoot.idle;
  assert.equal(focusedRoot.contains(focusedRoot.ownerDocument.activeElement), true);
  assert.equal(focusedRoot.getAttribute('data-loop-action-engaged'), 'false');
  focusedController.update({ active: true });
  assert.equal(
    focusedRoot.getAttribute('data-loop-action-engaged'),
    'true',
    'a later active update must reconcile stale focus memory with live focus ownership',
  );
  focusedRoot.ownerDocument.activeElement = null;
  focusedRoot.dispatch('focusout', { relatedTarget: null });
  tick(499);
  assert.equal(focusedRoot.getAttribute('data-loop-action-engaged'), 'true');
  tick(1);
  assert.equal(focusedRoot.getAttribute('data-loop-action-engaged'), 'false');
});

test('shared scissors CSS overlays an attached pod and never uses a waiting cursor', () => {
  const css = fs.readFileSync(path.join(
    __dirname, '..', '..', '..', 'music_app', 'static', 'css', 'runtime', 'non-album-and-player.css',
  ), 'utf8');
  assert.match(css, /\.loop-edit-action-pod\s*\{[^}]*position:\s*relative/s);
  assert.match(css, /\.loop-play-control-actions\s*\{[^}]*position:\s*absolute/s);
  assert.match(css, /\.loop-edit-action-divider\s*\{[^}]*(?:width:\s*1px|border-left:)/s);
  assert.match(css, /\.loop-edit-actions\s*\{[^}]*opacity:\s*0/s);
  assert.match(css, /\.loop-edit-action-create:(?:hover|focus-visible)[^{]*\{[^}]*var\(--loop-action-save-color\)/s);
  assert.match(css, /\.loop-edit-action-cancel:(?:hover|focus-visible)[^{]*\{[^}]*var\(--loop-action-cancel-color\)/s);
  assert.match(css, /\.loop-edit-action:disabled\s*\{[^}]*cursor:\s*not-allowed/s);
  assert.doesNotMatch(css, /\.loop-edit-action:disabled\s*\{[^}]*cursor:\s*(?:wait|progress)/s);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)[^]*\.loop-edit-action-pod/s);
});

function loopStyleRules(style, predicate = () => true) {
  const css = fs.readFileSync(path.join(__dirname, '../../../music_app/static/css/runtime/non-album-and-player.css'), 'utf8');
  return Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g))
    .filter(match => (match[1].includes(`data-loop-control-style="${style}"`) || (style === 'capsule' && !match[1].includes('data-loop-control-style=') && /loop-play-control|loop-edit-action/.test(match[1]))) && predicate(match[1]))
    .map(match => match[2]).join('\n');
}

// B01/B02 replace the superseded 39/55px component geometry with the approved
// Settings variants. Behavioral timer tests above and browser layout checks
// independently cover the component's interaction and computed positioning.
test('capsule uses a 56px stationary shell with 48px Play and 90/123px revealed outlines', () => {
  const css = loopStyleRules('capsule');
  assert.match(css, /(?:width|--[\w-]*(?:shell|cluster)[\w-]*):\s*56px/);
  assert.match(css, /(?:--loop-play-control-size|--[\w-]*play[\w-]*|width):\s*48px/);
  assert.match(css, /width:\s*90px/);
  assert.match(css, /width:\s*123px/);
  const reveal = loopStyleRules('capsule', selector => /engaged|revealed/.test(selector));
  assert.match(reveal, /width:\s*90px/);
  assert.match(reveal, /width:\s*123px/);
});

test('companion uses 52px Play and a 26px-high pod at 26px with 58/88px widths', () => {
  const css = loopStyleRules('companion');
  assert.match(css, /(?:--loop-play-control-size|--[\w-]*play[\w-]*|width):\s*52px/);
  const mount = loopStyleRules('companion', selector => /\.loop-play-control-actions\s*$/.test(selector.trim()));
  assert.match(mount, /left:\s*26px/);
  assert.match(mount, /top:\s*26px/);
  const pod = loopStyleRules('companion', selector => /\.loop-edit-action-pod(?:\s|:|$)/.test(selector));
  assert.match(pod, /height:\s*26px/);
  assert.match(pod, /width:\s*58px/);
  assert.match(pod, /width:\s*88px/);
});

test('both styles center full-size glyphs in shared action slots', () => {
  const capsule = loopStyleRules('capsule', selector => /\.loop-edit-action(?:\s|$)/.test(selector));
  const capsuleIcons = loopStyleRules('capsule', selector => selector.includes('.loop-edit-action-icon'));
  const companionIcons = loopStyleRules('companion', selector => selector.includes('.loop-edit-action-icon'));
  assert.match(capsule, /width:\s*32px/);
  assert.match(capsuleIcons, /width:\s*26px/);
  assert.match(capsuleIcons, /height:\s*26px/);
  assert.match(companionIcons, /width:\s*22px/);
  assert.match(companionIcons, /height:\s*22px/);
  const cancel = loopStyleRules('companion', selector => /is-cancel|loop-edit-action-cancel/.test(selector));
  assert.match(cancel, /width:\s*18px/);
  assert.match(cancel, /height:\s*18px/);
  const css = fs.readFileSync(path.join(__dirname, '../../../music_app/static/css/runtime/non-album-and-player.css'), 'utf8');
  assert.match(css, /\.loop-edit-action\s*\{[^}]*place-items:\s*center/s);
  assert.match(css, /\.loop-edit-action-icon\s*\{[^}]*mask-size:\s*contain/s);
  assert.doesNotMatch(loopStyleRules('capsule') + loopStyleRules('companion'), /transform:\s*translateX\((?:5|7|-2)px\)/);
});

test('active hover uses semantic glyph color and soft outward glow without filled action surfaces', () => {
  const css = fs.readFileSync(path.join(__dirname, '../../../music_app/static/css/runtime/non-album-and-player.css'), 'utf8');
  assert.match(css, /--loop-action-save-color:\s*var\(/);
  assert.match(css, /--loop-action-cancel-color:\s*(?:var\(|#ff3030)/i);
  for (const semantic of ['save', 'cancel']) {
    assert.match(css, new RegExp(`color:\\s*var\\(--loop-action-${semantic}-color\\)`));
    const glowRules = Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g))
      .filter(match => /:hover|:focus-visible/.test(match[1]) && match[1].includes('loop-edit-action') && match[2].includes(`--loop-action-${semantic}-glow`))
      .map(match => match[2]).join('\n');
    for (const blur of [2, 5, 10, 16]) assert.match(glowRules, new RegExp(`drop-shadow\\(0\\s+0\\s+${blur}px`));
  }
  const active = Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g))
    .filter(match => match[1].includes('.is-active') && /:hover|:focus-visible/.test(match[1]) && !match[1].includes('icon'))
    .map(match => match[2]).join('\n');
  assert.match(active, /background:\s*transparent/);
  assert.match(active, /box-shadow:\s*none/);
});

test('cancel is neutral at rest and active glyph halos remain unclipped', () => {
  const css = fs.readFileSync(path.join(__dirname, '../../../music_app/static/css/runtime/non-album-and-player.css'), 'utf8');
  const baseline = Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g))
    .filter(match => /\.loop-edit-action(?:-cancel)?\s*$/.test(match[1].trim()) && !/:hover|:focus|:active/.test(match[1]))
    .map(match => match[2]).join('\n');
  assert.match(baseline, /color:\s*var\(/);
  assert.doesNotMatch(baseline, /color:\s*var\(--loop-action-cancel-color\)|color:\s*#(?:ff3030|ef4444)/i);
  const activePod = Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g))
    .filter(match => /\.loop-edit-action-pod\s*$/.test(match[1].trim()))
    .map(match => match[2]).join('\n');
  assert.match(activePod, /overflow:\s*visible/);
  const companionPod = loopStyleRules('companion', selector => selector.includes('.is-active') && /\.loop-edit-action-pod\s*$/.test(selector.trim()));
  assert.doesNotMatch(companionPod, /clip-path:\s*(?!none)[^;]+/);
});

test('companion idle hover fills the full curved pod while active contour leaves glyph overflow free', () => {
  const idlePod = loopStyleRules('companion', selector => selector.includes('.loop-edit-action-pod') && /:has|:hover|:focus-visible/.test(selector) && /:not\(\.is-active\)/.test(selector));
  assert.match(idlePod, /background:\s*(?:var\(|color-mix\()/);
  const contour = loopStyleRules('companion', selector => /\.loop-edit-action-pod(?:::before|::after)?/.test(selector));
  assert.match(contour, /(?:clip-path:\s*path\(|mask:\s*radial-gradient\()/);
  assert.match(contour, /border-radius:/);
});

test('opaque Play surfaces retain pointer ownership at the loop-control edge', () => {
  const css = fs.readFileSync(path.join(
    __dirname, '..', '..', '..', 'music_app', 'static', 'css', 'runtime', 'non-album-and-player.css',
  ), 'utf8');
  const playRule = css.match(/\.loop-play-control-button\s*\{([^}]*)\}/s)?.[1] || '';
  const mountRule = css.match(/\.loop-play-control-actions\s*\{([^}]*)\}/s)?.[1] || '';

  assert.match(playRule, /background:\s*linear-gradient\([^;]+\)/);
  assert.doesNotMatch(
    playRule,
    /background:[^;]*(?:rgba\(|rgb\([^)]*\/\s*(?:0|\.)|#[0-9a-f]{8}\b)/i,
    'the shared Play surface must be fully opaque so the attached pod cannot show through it',
  );
  assert.match(playRule, /border:\s*1px solid var\(--loop-control-border\)/);
  assert.match(playRule, /pointer-events:\s*auto/);
  assert.match(playRule, /z-index:\s*5/);
  assert.match(mountRule, /z-index:\s*4/);
});

test('saved-loop Play hover preserves its surface and uses only a subtle one-pixel outline', () => {
  const playerCss = fs.readFileSync(path.join(
    __dirname, '..', '..', '..', 'music_app', 'static', 'css', 'runtime', 'non-album-and-player.css',
  ), 'utf8');
  const appearanceCss = fs.readFileSync(path.join(
    __dirname, '..', '..', '..', 'music_app', 'static', 'css', 'appearance-backgrounds.css',
  ), 'utf8');
  const playRule = playerCss.match(/\.loop-play-control-button\s*\{([^}]*)\}/s)?.[1] || '';
  const baseRule = appearanceCss.match(/:root \.utility-loop-play\s*\{([^}]*)\}/s)?.[1] || '';
  const interactionRule = appearanceCss.match(
    /:root \.utility-loop-play:is\(:hover,\s*:active,\s*:focus-visible\):not\(:disabled\):not\(\[aria-disabled='true'\]\)\s*\{([^}]*)\}/s,
  )?.[1] || '';
  const restingSurface = playRule.match(/background:\s*([^;]+);/)?.[1]?.trim() || '';
  const restingBorder = (playRule.match(/border-color:\s*([^;]+);/)
    || playRule.match(/border:\s*1px solid\s+([^;]+);/))?.[1]?.trim() || '';
  assert.ok(restingBorder, 'the shared Play control must declare its resting border color');
  assert.ok(baseRule.includes(`background: var(--appearance-play, ${restingSurface}) !important;`));
  assert.ok(baseRule.includes(`border-color: var(--appearance-player-control-border, ${restingBorder}) !important;`));
  assert.match(baseRule, /outline:\s*none\s*!important/);
  assert.doesNotMatch(interactionRule, /(?:background|border-color):/, 'interaction keeps the same theme-linked surface and border');
  assert.match(interactionRule, /outline:\s*1px solid color-mix\([^;]+transparent\)\s*!important/);
  assert.match(interactionRule, /outline-offset:\s*1px\s*!important/);
});
test('saved-loop green controls use a thin subdued hover outline below pressed intensity', () => {
  const css = fs.readFileSync(path.join(
    __dirname, '..', '..', '..', 'music_app', 'static', 'css', 'appearance-backgrounds.css',
  ), 'utf8');
  const genericHoverRule = css.match(
    /:root :is\(button,[^{]+:hover:not\(:disabled\):not\(\[aria-disabled='true'\]\)\s*\{([^}]*)\}/s,
  )?.[0] || '';
  const loopHoverRule = css.match(
    /:root :is\(\.utility-loop-pitch-control button, \.utility-loop-repeat, \.utility-loop-speed-step, \.utility-loop-speed-value\):hover:not\(:disabled\)\s*\{([^}]*)\}/s,
  )?.[1] || '';

  assert.match(genericHoverRule, /:not\(\.utility-loop-control button\)/);
  assert.match(genericHoverRule, /:not\(\.utility-loop-repeat\)/);
  assert.match(genericHoverRule, /:not\(\.utility-loop-speed-step\)/);
  assert.match(genericHoverRule, /:not\(\.utility-loop-speed-value\)/);
  assert.match(loopHoverRule, /outline:\s*1px solid rgba\(110,\s*231,\s*183,\s*0\.18\)/);
  assert.match(loopHoverRule, /outline-offset:\s*1px/);
});

test('expanded loop controls overlay the waveform from a fixed-size Play compound', () => {
  const css = fs.readFileSync(path.join(__dirname, '../../../music_app/static/css/runtime/non-album-and-player.css'), 'utf8');
  const mount = css.match(/\.loop-play-control-actions\s*\{([^}]*)\}/s)?.[1] || '';
  const cluster = css.match(/\.loop-play-control-cluster\s*\{([^}]*)\}/s)?.[1] || '';
  assert.match(mount, /position:\s*absolute/);
  assert.match(mount, /overflow:\s*visible/);
  assert.match(cluster, /position:\s*relative/);
  assert.match(cluster, /(?:width|--[\w-]*(?:shell|cluster)[\w-]*):\s*(?:var\(|56px)/);
  for (const style of ['capsule', 'companion']) {
    const activeCluster = loopStyleRules(style, selector => /engaged|revealed|is-editing/.test(selector) && !/::before|loop-play-control-actions|loop-edit-action/.test(selector));
    assert.doesNotMatch(activeCluster, /(?:width|flex-basis):\s*(?:90|123|58|88)px/, 'reveal must never widen the in-flow compound');
  }
});

test('both reusable variants hide folded actions without introducing a second consumer geometry', () => {
  const css = fs.readFileSync(path.join(__dirname, '../../../music_app/static/css/runtime/non-album-and-player.css'), 'utf8');
  const mounted = Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g))
    .filter(match => /\.(?:loop-play-control-actions|loop-edit-actions)(?:\[data-loop-action-engaged="true"\])?\s*$/.test(match[1].trim())).map(match => match[2]).join('\n');
  assert.match(mounted, /opacity:\s*0/);
  assert.match(mounted, /pointer-events:\s*none/);
  const revealed = Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g))
    .filter(match => /revealed|engaged/.test(match[1]) && /\.(?:loop-play-control-actions|loop-edit-actions)(?:\[data-loop-action-engaged="true"\])?\s*$/.test(match[1].trim()))
    .map(match => match[2]).join('\n');
  assert.match(revealed, /opacity:\s*1/);
  assert.match(revealed, /pointer-events:\s*auto/);
  assert.doesNotMatch(css, /\.utility-loop-play-cluster\s+\.loop-edit-actions\s*\{/);
  assert.doesNotMatch(css, /\.player-loop-actions\s*\{/);
});

test('persistent and saved-loop players share the same styled Play action compound', () => {
  const macro = fs.readFileSync(path.join(__dirname, '../../../music_app/templates/partials/playback-control-cluster.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '../../../music_app/static/js/runtime/playback-control-cluster.js'), 'utf8');
  for (const source of [macro, renderer]) {
    assert.match(source, /data-playback-control-cluster/);
    assert.match(source, /data-loop-control-style/);
    assert.match(source, /loop-play-control-button/);
    assert.match(source, /loop-play-control-actions/);
  }
  assert.match(renderer, /saved-loop/);
  assert.match(renderer, /expanded-player/);
});

test('saved-loop panels reserve padding for the full border and overhanging controls', () => {
  const css = fs.readFileSync(path.join(__dirname, '../../../music_app/static/css/runtime/non-album-and-player.css'), 'utf8');
  const entry = Array.from(css.matchAll(/\.utility-loop-entry\s*\{([^}]*)\}/g), match => match[1]).join('\n');
  const first = Array.from(css.matchAll(/\.utility-loop-entry:first-child\s*\{([^}]*)\}/g), match => match[1]).join('\n');
  assert.match(entry, /padding:\s*(?!0(?:px)?[;\s])/);
  assert.match(entry, /border:\s*1px\s+solid/);
  assert.doesNotMatch(first, /padding-bottom:\s*0|border(?:-top)?:\s*(?:0|none)/);
});

test('reduced motion disables reveal geometry transitions while keeping hidden semantics', () => {
  const css = fs.readFileSync(path.join(__dirname, '../../../music_app/static/css/runtime/non-album-and-player.css'), 'utf8');
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)[^]*loop-play-control-cluster[^]*transition:\s*none/);
  assert.match(css, /\.loop-edit-action\[hidden\]\s*\{[^}]*display:\s*none/s);
});

test('shared loop actions keep hidden state authoritative over their author display style', () => {
  const css = fs.readFileSync(path.join(
    __dirname, '..', '..', '..', 'music_app', 'static', 'css', 'runtime', 'non-album-and-player.css',
  ), 'utf8');
  assert.match(
    css,
    /\.loop-edit-action\[hidden\]\s*\{[^}]*display:\s*none/s,
    'the hidden idle Enter button must not remain rendered inside the active pod',
  );
});

test('both loop editors share quiet compact handles and advertise dragging only on the handles', () => {
  const css = fs.readFileSync(path.join(
    __dirname, '..', '..', '..', 'music_app', 'static', 'css', 'runtime', 'non-album-and-player.css',
  ), 'utf8');
  const rangeSurfaceRule = css.match(/\.loop-range-surface\s*\{([^}]*)\}/s)?.[1] || '';
  const playerRangeSurfaceRule = css.match(
    /\.player-timeline-wrap\s*>\s*\.loop-range-surface\s*\{([^}]*)\}/s,
  )?.[1] || '';
  const selectionRule = css.match(/\.loop-range-selection\s*\{([^}]*)\}/s)?.[1] || '';
  const handleRule = css.match(/\.loop-range-handle\s*\{([^}]*)\}/s)?.[1] || '';
  const handleVisualRule = css.match(/\.loop-range-handle::after\s*\{([^}]*)\}/s)?.[1] || '';

  assert.match(rangeSurfaceRule, /cursor:\s*default/);
  assert.match(
    playerRangeSurfaceRule,
    /z-index:\s*[3-9]\d*/,
    'the active edit surface must receive empty-space pointer gestures above the native timeline',
  );
  assert.match(handleRule, /--loop-handle-hit-size:\s*30px/);
  assert.match(handleRule, /cursor:\s*grab/);
  assert.match(css, /\.loop-range-handle:(?:active|focus-visible)\s*\{[^}]*cursor:\s*grabbing/s);
  assert.match(handleVisualRule, /width:\s*[3-6]px/);
  assert.match(handleVisualRule, /top:\s*[5-9]px/);
  assert.match(handleVisualRule, /bottom:\s*[5-9]px/);
  assert.match(selectionRule, /background:\s*rgba\(74,\s*222,\s*128,\s*0\.0[4-9]\)/);
  assert.doesNotMatch(
    css,
    /\.player-timeline-wrap\s*>\s*\.loop-range-surface\s+\.loop-range-handle::after\s*\{/,
    'the persistent player must not replace the shared compact handle with a larger visual',
  );
});

test('shared loop actions render mask-backed scissors and cancel icons from nonempty assets', () => {
  const { context } = loadSharedControls();
  const markup = context.buildLoopEditActionControl({
    ownerId: 'icon-contract',
    enterLabel: 'Create a loop',
    createLabel: 'Create loop',
    cancelLabel: 'Cancel loop creation',
  });
  const css = fs.readFileSync(path.join(
    __dirname, '..', '..', '..', 'music_app', 'static', 'css', 'runtime', 'non-album-and-player.css',
  ), 'utf8');
  const iconDirectory = path.join(
    __dirname, '..', '..', '..', 'music_app', 'static', 'images', 'icons',
  );

  assert.equal((markup.match(/class="loop-edit-action-icon is-scissors"/g) || []).length, 2);
  assert.equal((markup.match(/class="loop-edit-action-icon is-cancel"/g) || []).length, 1);
  assert.doesNotMatch(markup, /&#9986;|&times;/);
  assert.match(css, /url\(['"]\/static\/images\/icons\/loop-scissors-mask\.png['"]\)/);
  assert.match(css, /url\(['"]\/static\/images\/icons\/loop-cancel-mask\.png['"]\)/);

  for (const filename of ['loop-scissors-mask.png', 'loop-cancel-mask.png']) {
    const assetPath = path.join(iconDirectory, filename);
    assert.equal(fs.existsSync(assetPath), true, `${filename} must exist`);
    assert.ok(fs.statSync(assetPath).size > 0, `${filename} must not be empty`);
  }
});

test('waveform click seeks without changing either loop boundary', () => {
  const harness = loadSharedControls();
  const root = createRangeRoot();
  const previews = [];
  const commits = [];
  const seeks = [];
  const controller = harness.context.createLoopRangeController({
    root,
    getDuration: () => 20,
    getRange: () => ({ startSeconds: 2, endSeconds: 16 }),
    onRangePreview: (range) => previews.push({ ...range }),
    onRangeCommit: (range) => commits.push({ ...range }),
    onSeek: (seconds) => seeks.push(seconds),
    onCancel() {},
  });

  root.surface.dispatch('pointerdown', { clientX: 150 });
  assert.deepEqual(seeks, [], 'a press is not a click until it is released without dragging');
  harness.dispatchDocument('pointerup', { clientX: 150, pointerId: 1 });

  assert.deepEqual(seeks, [5]);
  assert.equal(controller.getRange().startSeconds, 2);
  assert.equal(controller.getRange().endSeconds, 16);
  assert.deepEqual(previews, []);
  assert.deepEqual(commits, []);
});

test('dragging from empty waveform space moves the boundary that was closest on pointerdown', () => {
  const harness = loadSharedControls();
  const root = createRangeRoot();
  const previews = [];
  const commits = [];
  const seeks = [];
  const controller = harness.context.createLoopRangeController({
    root,
    getDuration: () => 20,
    getRange: () => ({ startSeconds: 2, endSeconds: 16 }),
    onRangePreview: (range) => previews.push({ ...range }),
    onRangeCommit: (range) => commits.push({ ...range }),
    onSeek: (seconds) => seeks.push(seconds),
    onCancel() {},
  });

  root.surface.dispatch('pointerdown', { clientX: 150 });
  harness.dispatchDocument('pointermove', { clientX: 180, pointerId: 1 });
  harness.flushAnimationFrame();
  harness.dispatchDocument('pointerup', { clientX: 180, pointerId: 1 });

  assert.deepEqual(seeks, []);
  assert.equal(controller.getRange().startSeconds, 8);
  assert.equal(controller.getRange().endSeconds, 16);
  assert.equal(previews.at(-1).startSeconds, 8);
  assert.equal(commits.length, 1);
});

test('handles stay fixed on pointerdown and move only after drag movement', () => {
  const harness = loadSharedControls();
  assert.equal(typeof harness.context.createLoopRangeController, 'function', 'shared range controller must exist');
  const root = createRangeRoot();
  const previews = [];
  const commits = [];
  const interactions = [];
  const controller = harness.context.createLoopRangeController({
    root,
    getDuration: () => 20,
    getRange: () => ({ startSeconds: 2, endSeconds: 16 }),
    onRangePreview: (range) => previews.push({ ...range }),
    onRangeCommit: (range) => commits.push({ ...range }),
    onRangeInteractionStart: (role) => interactions.push(role),
    onCancel() {},
  });

  root.start.dispatch('pointerdown', { clientX: 150 });
  assert.deepEqual(interactions, ['start'], 'grabbing a boundary renews its active edit session immediately');
  assert.deepEqual(previews, [], 'pointerdown alone must not move a handle');
  assert.equal(controller.getRange().startSeconds, 2);
  assert.equal(controller.getRange().endSeconds, 16);
  harness.dispatchDocument('pointermove', { clientX: 170, pointerId: 1 });
  harness.dispatchDocument('pointermove', { clientX: 190, pointerId: 1 });
  assert.equal(previews.length, 0, 'move previews must be requestAnimationFrame bounded');
  harness.flushAnimationFrame();
  assert.equal(previews.at(-1).startSeconds, 9, 'the latest move in the frame wins');
  harness.dispatchDocument('pointerup', { clientX: 190, pointerId: 1 });
  assert.equal(commits.length, 1, 'release performs one streaming-loop commit');
});

test('selection variables and handle centers share exact normalized percentages before and during drag', () => {
  const harness = loadSharedControls();
  const root = createRangeRoot();
  harness.context.createLoopRangeController({
    root,
    getDuration: () => 40,
    getRange: () => ({ startSeconds: 10, endSeconds: 30 }),
    onRangePreview() {},
    onRangeCommit() {},
    onCancel() {},
  });

  assert.equal(root.style.getPropertyValue('--loop-range-start'), '25%');
  assert.equal(root.style.getPropertyValue('--loop-range-end'), '75%');
  assert.equal(root.start.style.left, '25%');
  assert.equal(root.end.style.left, '75%');

  root.start.dispatch('pointerdown', { clientX: 180 });
  assert.equal(root.style.getPropertyValue('--loop-range-start'), '25%');
  harness.dispatchDocument('pointermove', { clientX: 180, pointerId: 1 });
  harness.flushAnimationFrame();
  assert.equal(root.style.getPropertyValue('--loop-range-start'), '40%');
  assert.equal(root.style.getPropertyValue('--loop-range-end'), '75%');
  assert.equal(root.start.style.left, '40%');
  assert.equal(root.end.style.left, '75%');

  harness.dispatchDocument('pointermove', { clientX: 220, pointerId: 1 });
  harness.flushAnimationFrame();
  assert.equal(root.style.getPropertyValue('--loop-range-start'), '60%');
  assert.equal(root.style.getPropertyValue('--loop-range-end'), '75%');
  assert.equal(root.start.style.left, '60%');
  assert.equal(root.end.style.left, '75%');
});

test('both handles cross by swapping active roles while timestamps and ARIA remain ordered', () => {
  const harness = loadSharedControls();
  assert.equal(typeof harness.context.createLoopRangeController, 'function', 'shared range controller must exist');
  const root = createRangeRoot();
  let range = { startSeconds: 4, endSeconds: 12 };
  const controller = harness.context.createLoopRangeController({
    root, getDuration: () => 20, getRange: () => range,
    onRangePreview(next) { range = { ...next }; }, onRangeCommit() {}, onCancel() {},
  });

  root.start.dispatch('pointerdown', { clientX: 240 });
  harness.dispatchDocument('pointermove', { clientX: 240, pointerId: 1 });
  harness.flushAnimationFrame();
  assert.deepEqual(range, { startSeconds: 12, endSeconds: 14 });
  harness.dispatchDocument('pointermove', { clientX: 260, pointerId: 1 });
  harness.flushAnimationFrame();
  assert.deepEqual(range, { startSeconds: 12, endSeconds: 16 });
  harness.dispatchDocument('pointerup', { clientX: 260, pointerId: 1 });

  root.end.dispatch('pointerdown', { clientX: 120 });
  harness.dispatchDocument('pointermove', { clientX: 120, pointerId: 1 });
  harness.flushAnimationFrame();
  assert.deepEqual(range, { startSeconds: 2, endSeconds: 12 });
  assert.equal(root.start.getAttribute('aria-valuenow'), '2');
  assert.equal(root.end.getAttribute('aria-valuenow'), '12');
  assert.equal(root.startTime.textContent, 'T2.000');
  assert.equal(root.endTime.textContent, 'T12.000');
});

test('keyboard movement preserves a positive range and Escape or pointercancel cancels editing', () => {
  const harness = loadSharedControls();
  assert.equal(typeof harness.context.createLoopRangeController, 'function', 'shared range controller must exist');
  const root = createRangeRoot();
  let range = { startSeconds: 5, endSeconds: 5 };
  let cancels = 0;
  harness.context.createLoopRangeController({
    root, getDuration: () => 10, getRange: () => range,
    onRangePreview(next) { range = { ...next }; }, onRangeCommit() {}, onCancel() { cancels += 1; },
  });
  assert.ok(range.endSeconds > range.startSeconds, 'coincident bounds normalize to a positive range');
  root.start.dispatch('keydown', { key: 'ArrowRight', shiftKey: true });
  assert.ok(range.endSeconds > range.startSeconds);
  root.start.dispatch('keydown', { key: 'Escape' });
  root.end.dispatch('pointerdown', { clientX: 180 });
  harness.dispatchDocument('pointercancel', { pointerId: 1 });
  assert.equal(cancels, 2);
});

test('keyboard Start crossing transfers focus and continued movement to End', () => {
  const harness = loadSharedControls();
  const root = createRangeRoot();
  let range = { startSeconds: 7.9, endSeconds: 8 };
  harness.context.createLoopRangeController({
    root, getDuration: () => 10, getRange: () => range,
    onRangePreview(next) { range = { ...next }; }, onRangeCommit() {}, onCancel() {},
  });

  root.start.dispatch('keydown', { key: 'ArrowRight', shiftKey: true });
  assert.deepEqual(range, { startSeconds: 8, endSeconds: 8.4 });
  assert.equal(root.end.focused, true, 'crossing Start must transfer keyboard ownership to End');

  root.end.dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(range.startSeconds, 8);
  assert.ok(Math.abs(range.endSeconds - 8.45) < Number.EPSILON * 8.45);
});

test('keyboard End crossing transfers focus and continued movement to Start', () => {
  const harness = loadSharedControls();
  const root = createRangeRoot();
  let range = { startSeconds: 8, endSeconds: 8.1 };
  harness.context.createLoopRangeController({
    root, getDuration: () => 10, getRange: () => range,
    onRangePreview(next) { range = { ...next }; }, onRangeCommit() {}, onCancel() {},
  });

  root.end.dispatch('keydown', { key: 'ArrowLeft', shiftKey: true });
  assert.deepEqual(range, { startSeconds: 7.6, endSeconds: 8 });
  assert.equal(root.start.focused, true, 'crossing End must transfer keyboard ownership to Start');

  root.start.dispatch('keydown', { key: 'ArrowLeft' });
  assert.deepEqual(range, { startSeconds: 7.55, endSeconds: 8 });
});

test('combined waveform averages L and R peaks into discrete pixel-symmetric mono bars', () => {
  const { context } = loadSharedControls();
  assert.equal(typeof context.drawCombinedLoopWaveform, 'function', 'combined waveform renderer must exist');
  const rects = [];
  const strokes = [];
  const dots = [];
  let currentPath = [];
  const canvas = {
    width: 100, height: 32, clientWidth: 100, clientHeight: 32,
    getContext: () => ({
      clearRect() {}, fillRect(...args) { rects.push(args); },
      save() {}, restore() {}, clip() {}, fill() {},
      beginPath() { currentPath = []; },
      rect(...args) { currentPath.push(['rect', ...args]); },
      moveTo(...args) { currentPath.push(['moveTo', ...args]); },
      lineTo(...args) { currentPath.push(['lineTo', ...args]); },
      stroke() { strokes.push([...currentPath]); },
      arc(...args) { dots.push(args); },
      set fillStyle(value) { this.color = value; },
      set strokeStyle(value) { this.strokeColor = value; },
      set shadowColor(value) { this.shadow = value; },
      set shadowBlur(value) { this.blur = value; },
      set lineWidth(value) { this.width = value; },
    }),
  };
  context.drawCombinedLoopWaveform(canvas, {
    left: [0.02, 0.08, 0.2],
    right: [0.08, 0.02, 0.4],
  }, 0.25);

  assert.equal(rects.length, 3, 'one averaged mono bar is rendered per stereo bin');
  assert.equal(rects[0][3], rects[1][3], 'equal 0.05 channel averages produce equal bar heights');
  assert.ok(rects[2][3] > rects[0][3], 'the larger 0.3 channel average produces a taller bar');
  assert.ok(rects.every(([, , , height]) => height <= 32), 'combined mono bars stay within the canvas height');
  for (const [, y, , height] of rects) {
    assert.ok(Number.isInteger(y), 'each bar starts on a discrete pixel row');
    assert.ok(Number.isInteger(height), 'each bar covers a discrete number of pixel rows');
    assert.equal(height % 2, 1, 'each bar has an odd height so it can share the center pixel');
    assert.equal(y + Math.floor(height / 2), 16, 'each bar is exactly centered on the 32px canvas');
    assert.equal(16 - y, (y + height - 1) - 16, 'each bar covers equal rows above and below center');
  }
  assert.deepEqual(strokes.at(-1), [['moveTo', 25, 0], ['lineTo', 25, 32]]);
  assert.deepEqual(dots.at(-1)?.slice(0, 3), [25, 16, 3.2]);
});

test('duration correction preserves range fractions through repeated crossings without collapsing handles', () => {
  const harness = loadSharedControls();
  const root = createRangeRoot();
  let duration = 100;
  let range = { startSeconds: 0, endSeconds: 100 };
  const controller = harness.context.createLoopRangeController({
    root,
    getDuration: () => duration,
    getRange: () => range,
    onRangePreview(next) { range = { ...next }; },
    onRangeCommit(next) { range = { ...next }; },
    onCancel() {},
  });

  root.start.dispatch('pointerdown', { clientX: 100 });
  harness.dispatchDocument('pointermove', { clientX: 140, pointerId: 1 });
  harness.flushAnimationFrame();
  harness.dispatchDocument('pointerup', { clientX: 140, pointerId: 1 });
  assert.deepEqual(range, { startSeconds: 20, endSeconds: 100 });

  duration = 20;
  range = { ...controller.render(range) };
  assert.deepEqual(range, { startSeconds: 4, endSeconds: 20 }, 'adapter can persist corrected values before another drag');
  root.end.dispatch('pointerdown', { clientX: 190 });
  harness.dispatchDocument('pointermove', { clientX: 190, pointerId: 1 });
  harness.flushAnimationFrame();
  harness.dispatchDocument('pointerup', { clientX: 190, pointerId: 1 });
  assert.deepEqual(range, { startSeconds: 4, endSeconds: 9 }, 'duration correction keeps the selected fractions');

  root.start.dispatch('pointerdown', { clientX: 270 });
  harness.dispatchDocument('pointermove', { clientX: 270, pointerId: 1 });
  harness.flushAnimationFrame();
  harness.dispatchDocument('pointerup', { clientX: 270, pointerId: 1 });
  assert.deepEqual(range, { startSeconds: 9, endSeconds: 17 }, 'start crossing right becomes the ordered end');
  assert.equal(root.startTime.textContent, 'T9.000');
  assert.equal(root.endTime.textContent, 'T17.000');

  root.end.dispatch('pointerdown', { clientX: 120 });
  harness.dispatchDocument('pointermove', { clientX: 120, pointerId: 1 });
  harness.flushAnimationFrame();
  harness.dispatchDocument('pointerup', { clientX: 120, pointerId: 1 });
  assert.deepEqual(range, { startSeconds: 2, endSeconds: 9 }, 'swapped end crossing left remains reachable and ordered');
  assert.ok(Number(root.end.getAttribute('aria-valuenow')) > Number(root.start.getAttribute('aria-valuenow')));
});

test('main and Utility editors share the same selection and edge-safe handle primitives', () => {
  const template = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'music_app', 'templates', 'index.html'), 'utf8');
  const builder = fs.readFileSync(path.join(
    __dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'utility-list-builders.js',
  ), 'utf8');
  const css = fs.readFileSync(path.join(
    __dirname, '..', '..', '..', 'music_app', 'static', 'css', 'runtime', 'non-album-and-player.css',
  ), 'utf8');
  for (const source of [template, builder]) {
    assert.match(source, /class="[^"]*loop-range-selection/);
    assert.equal((source.match(/class="[^"]*loop-range-handle/g) || []).length, 2);
  }
  assert.match(css, /\.loop-range-handle\s*\{[^}]*--loop-handle-hit-size/s);
  assert.match(css, /\.loop-range-handle\.is-start/);
  assert.match(css, /\.loop-range-handle\.is-end/);
});

function readGenericInteractionSelectors() {
  const css = fs.readFileSync(path.join(
    __dirname, '..', '..', '..', 'music_app', 'static', 'css', 'appearance-backgrounds.css',
  ), 'utf8');
  const selectors = [...css.matchAll(/([^{}]+)\{[^}]*\}/g)]
    .map(match => match[1].trim())
    .filter(selector => selector.startsWith(':root')
      && selector.includes(':is(button,')
      && /:(hover|active|focus-visible)/.test(selector));
  assert.equal(selectors.length, 5, 'all generic hover, pressed, and keyboard-focus rules must be checked');
  return selectors;
}

test('shared loop range handles are excluded from generic button interaction painting', () => {
  for (const selector of readGenericInteractionSelectors()) {
    assert.ok(selector.includes(':not(.loop-range-handle)'), `${selector} must exclude range handles`);
    assert.ok(selector.includes(':not(.global-player *)'), `${selector} must exclude the global player`);
  }
});

test('saved-loop action children do not paint a moving outline beside the fixed divider', () => {
  for (const selector of readGenericInteractionSelectors()) {
    assert.ok(selector.includes(':not(.loop-edit-action)'), `${selector} must exclude saved-loop action children`);
  }
});

test('player and Utility adapters persist the controller range returned after duration correction', () => {
  const player = fs.readFileSync(path.join(
    __dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'player-loop-playback.js',
  ), 'utf8');
  const utility = fs.readFileSync(path.join(
    __dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'utility-loop-playback.js',
  ), 'utf8');
  assert.match(player, /const reconciledRange\s*=\s*els\.loopRange\?\._loopRangeController\?\.render/);
  assert.match(player, /state\.player\.loopStart\s*=\s*reconciledRange\.startSeconds/);
  assert.match(utility, /const reconciledRange\s*=\s*elements\.root\?\._loopRangeController\?\.render/);
  assert.match(utility, /syncSavedLoopRange\(id, reconciledRange\)/);
});

test('themed player delegates action painting to the shared variant tokens', () => {
  const css = fs.readFileSync(path.join(__dirname, '../../../music_app/static/css/appearance-backgrounds.css'), 'utf8');
  const legacyPainting = Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g))
    .filter(match => match[1].includes('.global-player') && match[1].includes('.loop-edit-action') && !match[1].includes(':not(.loop-edit-action)'))
    .filter(match => /(?:^|[;\n])\s*(?:background|border-color|box-shadow|filter|text-shadow|color)\s*:/.test(match[2]));
  assert.deepEqual(legacyPainting.map(match => match[1].trim()), [],
    'higher-specificity legacy painting must not replace the component active contour, neutral cancel or soft glyph falloff');
});

test('destroying a range controller mid-drag removes owned listeners and queued work without committing', () => {
  const harness = loadSharedControls();
  const root = createRangeRoot();
  const effects = [];
  const controller = harness.context.createLoopRangeController({
    root, getDuration: () => 20, getRange: () => ({ startSeconds: 2, endSeconds: 16 }),
    onRangePreview: () => effects.push('preview'), onRangeCommit: () => effects.push('commit'),
    onCancel: () => effects.push('cancel'), onSeek: () => effects.push('seek'),
  });
  root.start.dispatch('pointerdown', { clientX: 120 });
  harness.dispatchDocument('pointermove', { clientX: 160, pointerId: 1 });
  assert.equal(harness.documentListenerCount(), 3);
  assert.equal(typeof controller.destroy, 'function');
  controller.destroy();
  controller.destroy();
  assert.equal(harness.documentListenerCount(), 0);
  harness.flushAnimationFrame();
  harness.dispatchDocument('pointerup', { clientX: 180, pointerId: 1 });
  root.start.dispatch('keydown', { key: 'ArrowRight' });
  root.surface.dispatch('pointerdown', { clientX: 150 });
  assert.equal(harness.documentListenerCount(), 0);
  assert.deepEqual(effects, []);
  assert.equal(controller.getRange().startSeconds, 2);
  assert.equal(controller.getRange().endSeconds, 16);
});

test('saved compound control stacks above timeline and foreground range handles for pointer activation', () => {
  const css = fs.readFileSync(path.join(path.dirname(runtimePath), '../../css/runtime/non-album-and-player.css'), 'utf8');
  const rules = selector => Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g)).filter(match => match[1].trim() === selector).map(match => match[2]).join('\n');
  const layer = selector => Number(Array.from(rules(selector).matchAll(/z-index:\s*(\d+)/g)).at(-1)?.[1] || 0);
  assert.ok(layer('.utility-loop-play-cluster') > layer('.utility-loop-timeline'), 'the isolated compound parent must clear the timeline layer');
  assert.ok(layer('.utility-loop-play-cluster') > layer('[data-loop-range-front="end"] .loop-range-handle.is-end'), 'the compound parent must clear foreground range handles');
});

test('main compound control stacks above timeline and foreground range handles for pointer activation', () => {
  const css = fs.readFileSync(path.join(path.dirname(runtimePath), '../../css/runtime/non-album-and-player.css'), 'utf8');
  const rules = selector => Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g)).filter(match => match[1].trim() === selector).map(match => match[2]).join('\n');
  const layer = selector => Number(Array.from(rules(selector).matchAll(/z-index:\s*(\d+)/g)).at(-1)?.[1] || 0);
  assert.ok(layer('.player-play-cluster') > layer('.player-timeline-wrap.is-waveform .player-timeline'), 'main compound must clear its sibling timeline');
  assert.ok(layer('.player-play-cluster') > layer('[data-loop-range-front="end"] .loop-range-handle.is-end'), 'main compound must clear foreground range handles');
});
