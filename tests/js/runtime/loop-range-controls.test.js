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
  const context = {
    console,
    document: {
      addEventListener(name, listener) {
        const listeners = documentListeners.get(name) || [];
        listeners.push(listener);
        documentListeners.set(name, listeners);
      },
      removeEventListener() {},
    },
    formatLoopTime(value) { return `T${Number(value).toFixed(3)}`; },
    requestAnimationFrame(callback) {
      animationFrames.push(callback);
      return animationFrames.length;
    },
    cancelAnimationFrame() {},
  };
  vm.createContext(context);
  if (fs.existsSync(runtimePath)) {
    vm.runInContext(fs.readFileSync(runtimePath, 'utf8'), context, { filename: runtimePath });
  }
  return {
    context,
    dispatchDocument(name, event = {}) {
      for (const listener of documentListeners.get(name) || []) listener(event);
    },
    flushAnimationFrame() {
      const callbacks = animationFrames.splice(0);
      callbacks.forEach((callback) => callback(16));
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
  const { context } = loadSharedControls();
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
  assert.equal(root.getAttribute('data-loop-action-engaged'), 'false');
  root.dispatch('focusin');
  assert.equal(root.getAttribute('data-loop-action-engaged'), 'true');
  root.dispatch('focusout', { relatedTarget: null });
  assert.equal(root.getAttribute('data-loop-action-engaged'), 'false');

  root.create.dispatch('click');
  root.cancel.dispatch('click');
  assert.deepEqual(calls, ['create', 'cancel']);
});

test('shared scissors remembers idle pointer entry through the synchronous active child swap', () => {
  const { context } = loadSharedControls();
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
  const { context } = loadSharedControls();
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
  assert.equal(focusedRoot.getAttribute('data-loop-action-engaged'), 'false');
});

test('shared scissors CSS overlays an attached pod and never uses a waiting cursor', () => {
  const css = fs.readFileSync(path.join(
    __dirname, '..', '..', '..', 'music_app', 'static', 'css', 'runtime', 'non-album-and-player.css',
  ), 'utf8');
  assert.match(css, /\.loop-edit-action-pod\s*\{[^}]*position:\s*relative/s);
  assert.match(css, /\.loop-edit-actions\.is-active[^,{]*\[data-loop-action-engaged="true"\][^{]*\.loop-edit-action-pod\s*\{[^}]*position:\s*absolute/s);
  assert.match(css, /\.loop-edit-action-divider\s*\{[^}]*(?:width:\s*1px|border-left:)/s);
  assert.match(css, /\.loop-edit-actions\.is-active\[data-loop-action-engaged="false"\]/);
  assert.match(css, /\.loop-edit-action-create:(?:hover|focus-visible)[^{]*\{[^}]*(?:rgba?\([^}]*74,\s*222,\s*128|#4ade80)/s);
  assert.match(css, /\.loop-edit-action-cancel:(?:hover|focus-visible)[^{]*\{[^}]*(?:#ef4444|239,\s*68,\s*68)/s);
  assert.match(css, /\.loop-edit-action:disabled\s*\{[^}]*cursor:\s*not-allowed/s);
  assert.doesNotMatch(css, /\.loop-edit-action:disabled\s*\{[^}]*cursor:\s*(?:wait|progress)/s);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)[^]*\.loop-edit-action-pod/s);
});

test('shared scissors matches the owner-approved compact pod proportions and interaction colors', () => {
  const css = fs.readFileSync(path.join(
    __dirname, '..', '..', '..', 'music_app', 'static', 'css', 'runtime', 'non-album-and-player.css',
  ), 'utf8');
  const playerPlayRule = css.match(/\.loop-play-control-button\s*\{([^}]*)\}/s)?.[1] || '';
  const playerActionMountRule = css.match(/\.loop-play-control-actions\s*\{([^}]*)\}/s)?.[1] || '';
  const actionRootRule = css.match(/\.loop-edit-actions\s*\{([^}]*)\}/s)?.[1] || '';
  const activeActionRootRule = css.match(
    /\.loop-edit-actions\.is-active\[data-loop-action-engaged="true"\]\s*\{([^}]*)\}/s,
  )?.[1] || '';
  const podRule = css.match(/\.loop-edit-action-pod\s*\{([^}]*)\}/s)?.[1] || '';
  const activePodRule = css.match(
    /\.loop-edit-actions\.is-active\[data-loop-action-engaged="true"\]\s+\.loop-edit-action-pod\s*\{([^}]*)\}/s,
  )?.[1] || '';
  const iconRule = css.match(/\.loop-edit-action-icon\s*\{([^}]*)\}/s)?.[1] || '';
  const savedActionRule = css.match(
    /\.utility-loop-play-cluster\s+\.loop-edit-action\s*\{([^}]*)\}/s,
  )?.[1] || '';

  assert.match(playerPlayRule, /width:\s*var\(--loop-play-control-size\)/);
  assert.match(playerPlayRule, /height:\s*var\(--loop-play-control-size\)/);
  assert.match(
    playerActionMountRule,
    /width:\s*39px/,
    'the player mount must reserve only the collapsed one-button footprint',
  );
  assert.doesNotMatch(
    playerActionMountRule,
    /margin-inline-end:\s*-15px/,
    'the player mount must not reserve and compensate the expanded two-button width',
  );
  assert.match(
    playerActionMountRule,
    /position:\s*absolute/,
    'the main pod must stay out of the player grid flow',
  );
  assert.match(playerActionMountRule, /left:\s*60\.4166667cqw/);
  assert.match(playerActionMountRule, /top:\s*58\.3333333cqw/);
  assert.match(actionRootRule, /width:\s*39px/);
  assert.match(actionRootRule, /height:\s*18px/);
  assert.match(
    activeActionRootRule,
    /width:\s*55px/,
    'the engaged root must cover the full active pod so Cancel remains hoverable',
  );
  assert.doesNotMatch(
    activeActionRootRule,
    /margin-inline-end:\s*-15px/,
    'the absolutely positioned wider hit region needs no layout compensation',
  );
  assert.match(podRule, /width:\s*39px/);
  assert.match(podRule, /height:\s*18px/);
  assert.match(activePodRule, /width:\s*55px/);
  assert.match(activePodRule, /height:\s*18px/);
  assert.match(iconRule, /width:\s*12px/);
  assert.match(iconRule, /height:\s*11px/);
  assert.doesNotMatch(
    savedActionRule,
    /(?:width|height|min-width|min-height)\s*:/,
    'saved-loop controls must reuse the shared compact sizing instead of overriding it',
  );

  assert.match(
    css,
    /\.loop-edit-actions(?=[^{]*:not\(\.is-disabled\))(?=[^{]*:hover)[^{]*\.loop-edit-action-pod\s*\{[^}]*(?=[^}]*border-color:)(?=[^}]*box-shadow:)[^}]*\}/s,
    'idle hover needs a visible pod-edge and glow change, not only an icon tint',
  );
  const neutralCreateIndex = css.indexOf(
    '.loop-edit-actions.is-active[data-loop-action-engaged="true"] .loop-edit-action-create {',
  );
  const hoveredCreateIndex = css.lastIndexOf(
    '.loop-edit-actions.is-active[data-loop-action-engaged="true"] .loop-edit-action-create:hover',
  );
  assert.ok(neutralCreateIndex >= 0, 'active create must have a neutral baseline');
  assert.ok(
    hoveredCreateIndex > neutralCreateIndex,
    'the bright-green create hover rule must follow and override the active neutral rule',
  );
  assert.match(
    css.slice(hoveredCreateIndex),
    /\.loop-edit-actions\.is-active\[data-loop-action-engaged="true"\][^}]*\.loop-edit-action-create:hover[^}]*\{[^}]*(?:#4ade80|74,\s*222,\s*128)[^}]*text-shadow:/s,
  );
  assert.match(css, /\.loop-edit-action-cancel:hover[^}]*\{[^}]*(?:#ef4444|239,\s*68,\s*68)/s);
  assert.match(css, /\.loop-edit-action:disabled\s*\{[^}]*cursor:\s*not-allowed[^}]*color:\s*#9ca3af/s);
  assert.match(css, /\.loop-edit-actions\.is-disabled\s+\.loop-edit-action-pod\s*\{[^}]*border-color:\s*rgba\(156,\s*163,\s*175/s);
});

test('shared scissors matches the owner-reference hover intensity and neutral icon states', () => {
  const css = fs.readFileSync(path.join(
    __dirname, '..', '..', '..', 'music_app', 'static', 'css', 'runtime', 'non-album-and-player.css',
  ), 'utf8');
  const idleHoverPodRule = css.match(
    /\.loop-edit-actions:not\(\.is-disabled\):hover\s+\.loop-edit-action-pod\s*\{([^}]*)\}/s,
  )?.[1] || '';
  const createHoverIconRule = css.match(
    /\.loop-edit-actions\.is-active\[data-loop-action-engaged="true"\]\s+\.loop-edit-action-create:hover\s+\.loop-edit-action-icon,[^{]*\{([^}]*)\}/s,
  )?.[1] || '';
  const neutralCreateRule = css.match(
    /\.loop-edit-actions\.is-active\[data-loop-action-engaged="true"\]\s+\.loop-edit-action-create\s*\{([^}]*)\}/s,
  )?.[1] || '';
  const neutralCancelRule = css.match(/\.loop-edit-action-cancel\s*\{([^}]*)\}/s)?.[1] || '';

  assert.match(neutralCreateRule, /color:\s*#9ca3af/);
  assert.match(neutralCancelRule, /color:\s*#9ca3af/);
  assert.match(
    idleHoverPodRule,
    /0\s+0\s+7px\s+rgba\(74,\s*222,\s*128,\s*0\.48\)/,
    'the owner reference uses a compact halo rather than a full-control-height bloom',
  );
  assert.match(
    createHoverIconRule,
    /drop-shadow\(0\s+0\s+5px\s+rgba\(74,\s*222,\s*128,\s*1\)\)/,
    'active Create hover needs the stronger focused scissors glow from the reference',
  );
});

test('shared scissors keeps owner-measured glyph centers inside the compact idle and active pods', () => {
  const css = fs.readFileSync(path.join(
    __dirname, '..', '..', '..', 'music_app', 'static', 'css', 'runtime', 'non-album-and-player.css',
  ), 'utf8');
  const scissorsMaskRule = css.match(/\.loop-edit-action-icon\.is-scissors\s*\{([^}]*)\}/s)?.[1] || '';
  const idleScissorsRule = css.match(
    /\.loop-edit-action-enter\s+\.loop-edit-action-icon\.is-scissors\s*\{([^}]*)\}/s,
  )?.[1] || '';
  const activeCreateRule = css.match(
    /\.loop-edit-actions\.is-active\[data-loop-action-engaged="true"\]\s+\.loop-edit-action-create\s*\{([^}]*)\}/s,
  )?.[1] || '';
  const activeScissorsRule = css.match(
    /\.loop-edit-actions\.is-active\[data-loop-action-engaged="true"\]\s+\.loop-edit-action-create\s+\.loop-edit-action-icon\.is-scissors\s*\{([^}]*)\}/s,
  )?.[1] || '';
  const dividerRule = css.match(/\.loop-edit-action-divider\s*\{([^}]*)\}/s)?.[1] || '';
  const cancelRule = css.match(/\.loop-edit-action-cancel\s*\{([^}]*)\}/s)?.[1] || '';
  const cancelIconRule = css.match(
    /\.loop-edit-action-cancel\s+\.loop-edit-action-icon\.is-cancel\s*\{([^}]*)\}/s,
  )?.[1] || '';

  assert.match(scissorsMaskRule, /(?:-webkit-)?mask-size:\s*135%/);
  assert.match(
    idleScissorsRule,
    /transform:\s*translateX\(5px\)/,
    'the idle visible scissors center must sit about 24px from the fitted pod start',
  );
  assert.match(activeCreateRule, /width:\s*33px/);
  assert.match(activeCreateRule, /min-width:\s*33px/);
  assert.match(
    activeScissorsRule,
    /transform:\s*translateX\(7px\)/,
    'the active scissors center must remain about 24px from the pod start after Play overlap',
  );
  assert.match(dividerRule, /margin-block:\s*2px/);
  assert.match(cancelRule, /width:\s*19px/);
  assert.match(cancelRule, /min-width:\s*19px/);
  assert.match(cancelIconRule, /width:\s*9px/);
  assert.match(cancelIconRule, /height:\s*9px/);
  assert.match(cancelIconRule, /(?:-webkit-)?mask-size:\s*120%/);
  assert.match(cancelIconRule, /transform:\s*translateX\(-2px\)/);
  assert.doesNotMatch(
    css,
    /\.utility-loop-play-cluster\s+\.(?:loop-edit-action-create|loop-edit-action-cancel|loop-edit-action-icon\.is-scissors)\s*\{[^}]*(?:width|transform)\s*:/s,
    'saved loops must inherit the same reusable internal placement instead of overriding it',
  );
});

test('shared scissors keeps a small main-player gap and the fitted saved-player silhouette', () => {
  const css = fs.readFileSync(path.join(
    __dirname, '..', '..', '..', 'music_app', 'static', 'css', 'runtime', 'non-album-and-player.css',
  ), 'utf8');
  const playerPlayRule = css.match(/\.loop-play-control-button\s*\{([^}]*)\}/s)?.[1] || '';
  const playerMountRule = css.match(/\.loop-play-control-actions\s*\{([^}]*)\}/s)?.[1] || '';
  const rootRule = css.match(/\.loop-edit-actions\s*\{([^}]*)\}/s)?.[1] || '';
  const podRule = css.match(/\.loop-edit-action-pod\s*\{([^}]*)\}/s)?.[1] || '';
  const activeRootRule = css.match(
    /\.loop-edit-actions\.is-active\[data-loop-action-engaged="true"\]\s*\{([^}]*)\}/s,
  )?.[1] || '';
  const activePodRule = css.match(
    /\.loop-edit-actions\.is-active\[data-loop-action-engaged="true"\]\s+\.loop-edit-action-pod\s*\{([^}]*)\}/s,
  )?.[1] || '';
  const hoverPodRule = css.match(
    /\.loop-edit-actions:not\(\.is-disabled\):hover\s+\.loop-edit-action-pod\s*\{([^}]*)\}/s,
  )?.[1] || '';
  const borderAlpha = (rule) => Number(
    rule.match(/border(?:-color)?:[^;]*rgba\(74,\s*222,\s*128,\s*([\d.]+)\)/)?.[1],
  );

  assert.match(rootRule, /width:\s*39px/);
  assert.match(rootRule, /height:\s*18px/);
  assert.match(rootRule, /flex:\s*0\s+0\s+39px/);
  assert.match(podRule, /width:\s*39px/);
  assert.match(podRule, /height:\s*18px/);
  assert.ok(borderAlpha(podRule) >= 0.75, 'idle fitted pod needs a hard green outline');
  assert.match(activeRootRule, /width:\s*55px/);
  assert.doesNotMatch(activeRootRule, /margin-inline-end/);
  assert.match(activePodRule, /width:\s*55px/);
  assert.match(activePodRule, /height:\s*18px/);
  assert.ok(borderAlpha(activePodRule) >= 0.9, 'engaged fitted pod needs a hard green outline');
  assert.ok(borderAlpha(hoverPodRule) >= 0.9, 'hovered fitted pod needs a hard green outline');

  assert.match(playerMountRule, /width:\s*39px/);
  assert.doesNotMatch(playerMountRule, /margin-inline-end:\s*-15px/);
  assert.match(playerMountRule, /position:\s*absolute/);
  assert.match(playerMountRule, /left:\s*60\.4166667cqw/);
  assert.match(playerMountRule, /z-index:\s*4/);
  assert.match(playerPlayRule, /z-index:\s*5/);
  assert.match(
    css,
    /\.loop-play-control-actions\s+\.loop-edit-action-pod::before,[^]*\.loop-play-control-actions\s+\.loop-edit-action-pod::after\s*\{[^}]*display:\s*none/s,
    'the shared pod must remove the painted rings that made its circular edge look ragged',
  );
  assert.doesNotMatch(css, /\.utility-loop-play-cluster\s+\.loop-edit-actions\s*\{/);
  assert.doesNotMatch(css, /\.utility-loop-play\s*\{[^}]*(?:width|height)\s*:/s);
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
  assert.match(playRule, /border-color:\s*#[0-9a-f]{6}\b/i);
  assert.match(playRule, /pointer-events:\s*auto/);
  assert.match(playRule, /z-index:\s*5/);
  assert.match(mountRule, /z-index:\s*4/);
});

test('expanded loop edit controls overlay the waveform without reserving their two-button width', () => {
  const css = fs.readFileSync(path.join(
    __dirname, '..', '..', '..', 'music_app', 'static', 'css', 'runtime', 'non-album-and-player.css',
  ), 'utf8');
  const playerMountRule = css.match(/\.loop-play-control-actions\s*\{([^}]*)\}/s)?.[1] || '';
  const activeRootRule = css.match(
    /\.loop-edit-actions\.is-active\[data-loop-action-engaged="true"\]\s*\{([^}]*)\}/s,
  )?.[1] || '';
  const activePodRule = css.match(
    /\.loop-edit-actions\.is-active\[data-loop-action-engaged="true"\]\s+\.loop-edit-action-pod\s*\{([^}]*)\}/s,
  )?.[1] || '';
  const sharedClusterRule = css.match(/\.loop-play-control-cluster\s*\{([^}]*)\}/s)?.[1] || '';

  assert.match(playerMountRule, /width:\s*39px/);
  assert.match(playerMountRule, /min-width:\s*39px/);
  assert.match(playerMountRule, /max-width:\s*39px/);
  assert.match(playerMountRule, /overflow:\s*visible/);
  assert.doesNotMatch(
    playerMountRule,
    /width:\s*55px|margin-inline-end:\s*-15px/,
    'the main grid must reserve only the collapsed one-button footprint',
  );
  assert.match(activeRootRule, /width:\s*55px/);
  assert.match(activePodRule, /position:\s*absolute/);
  assert.match(activePodRule, /width:\s*55px/);

  assert.match(sharedClusterRule, /width:\s*var\(--loop-play-control-size\)/);
  assert.match(sharedClusterRule, /position:\s*relative/);
  assert.doesNotMatch(
    playerMountRule,
    /width:\s*55px/,
    'expansion must overflow the fixed shared Play cluster rather than widening it',
  );
});

test('shared loop edit pod uses a clean transparent cutout aligned to the Play circle', () => {
  const css = fs.readFileSync(path.join(
    __dirname, '..', '..', '..', 'music_app', 'static', 'css', 'runtime', 'non-album-and-player.css',
  ), 'utf8');
  const clusterRule = css.match(/\.loop-play-control-cluster\s*\{([^}]*)\}/s)?.[1] || '';
  const mountRule = css.match(/\.loop-play-control-actions\s*\{([^}]*)\}/s)?.[1] || '';
  const actionRule = css.match(/\.loop-edit-action\s*\{([^}]*)\}/s)?.[1] || '';
  const fittedPodRule = css.match(
    /\.loop-play-control-actions\s+\.loop-edit-action-pod\s*\{([^}]*)\}/s,
  )?.[1] || '';

  assert.match(clusterRule, /--loop-play-control-size:\s*48px/);
  assert.match(clusterRule, /container-type:\s*inline-size/);
  assert.match(mountRule, /left:\s*60\.4166667cqw/);
  assert.match(mountRule, /top:\s*58\.3333333cqw/);
  assert.match(actionRule, /position:\s*relative/);
  assert.match(actionRule, /z-index:\s*2/);
  assert.match(fittedPodRule, /-webkit-mask:\s*radial-gradient\(circle\s+calc\(50cqw\s*\+\s*0\.5px\)\s+at\s+-10\.4166667cqw\s+-11\.4583333cqw,\s*transparent\s+calc\(50cqw\s*\+\s*0\.5px\),\s*#000\s+calc\(50cqw\s*\+\s*1px\)\)/);
  assert.match(fittedPodRule, /mask:\s*radial-gradient\(circle\s+calc\(50cqw\s*\+\s*0\.5px\)\s+at\s+-10\.4166667cqw\s+-11\.4583333cqw,\s*transparent\s+calc\(50cqw\s*\+\s*0\.5px\),\s*#000\s+calc\(50cqw\s*\+\s*1px\)\)/);
  assert.match(
    css,
    /\.loop-play-control-actions\s+\.loop-edit-action-pod::before,[^]*\.loop-play-control-actions\s+\.loop-edit-action-pod::after\s*\{[^}]*display:\s*none/s,
    'neither player seam may contain leftover painted attachment rings',
  );
  assert.doesNotMatch(css, /\.player-loop-actions\s*\{/);
  assert.doesNotMatch(css, /\.utility-loop-play-cluster\s+\.loop-edit-actions\s*\{/);
});

test('persistent and saved-loop players share one relational Play control cluster contract', () => {
  const css = fs.readFileSync(path.join(
    __dirname, '..', '..', '..', 'music_app', 'static', 'css', 'runtime', 'non-album-and-player.css',
  ), 'utf8');
  const template = fs.readFileSync(path.join(
    __dirname, '..', '..', '..', 'music_app', 'templates', 'index.html',
  ), 'utf8');
  const clusterRule = css.match(/\.loop-play-control-cluster\s*\{([^}]*)\}/s)?.[1] || '';
  const buttonRule = css.match(/\.loop-play-control-button\s*\{([^}]*)\}/s)?.[1] || '';
  const actionRule = css.match(/\.loop-play-control-actions\s*\{([^}]*)\}/s)?.[1] || '';
  const fittedPodRule = css.match(
    /\.loop-play-control-actions\s+\.loop-edit-action-pod\s*\{([^}]*)\}/s,
  )?.[1] || '';

  assert.match(
    template,
    /class="loop-play-control-cluster player-play-cluster"[^]*class="loop-play-control-button player-play"[^]*class="loop-play-control-actions player-loop-actions"/s,
    'the persistent player must render the shared Play/edit-control cluster hierarchy',
  );
  assert.match(clusterRule, /--loop-play-control-size:\s*48px/);
  assert.match(clusterRule, /container-type:\s*inline-size/);
  assert.match(clusterRule, /width:\s*var\(--loop-play-control-size\)/);
  assert.match(clusterRule, /height:\s*var\(--loop-play-control-size\)/);
  assert.match(buttonRule, /width:\s*var\(--loop-play-control-size\)/);
  assert.match(buttonRule, /height:\s*var\(--loop-play-control-size\)/);
  assert.match(buttonRule, /z-index:\s*5/);
  assert.match(actionRule, /left:\s*60\.4166667cqw/);
  assert.match(actionRule, /top:\s*58\.3333333cqw/);
  assert.match(actionRule, /z-index:\s*4/);
  assert.match(fittedPodRule, /radial-gradient\(circle\s+calc\(50cqw\s*\+\s*0\.5px\)\s+at\s+-10\.4166667cqw\s+-11\.4583333cqw/);
  assert.match(
    css,
    /\.loop-play-control-actions\s+\.loop-edit-action-pod::before,[^]*\.loop-play-control-actions\s+\.loop-edit-action-pod::after\s*\{[^}]*display:\s*none/s,
  );
  assert.doesNotMatch(css, /\.utility-loop-play\s*\{[^}]*(?:width|height|min-width|min-height):/s);
  assert.doesNotMatch(css, /\.utility-loop-play-cluster\s+\.loop-edit-actions\s*\{/s);
  assert.doesNotMatch(css, /\.player-loop-actions\s*\{/s);
});

test('active-away scissors keeps the idle one-button geometry with subdued styling', () => {
  const css = fs.readFileSync(path.join(
    __dirname, '..', '..', '..', 'music_app', 'static', 'css', 'runtime', 'non-album-and-player.css',
  ), 'utf8');
  const collapsedPodRule = css.match(
    /\.loop-edit-actions\.is-active\[data-loop-action-engaged="false"\]\s+\.loop-edit-action-pod\s*\{([^}]*)\}/s,
  )?.[1] || '';
  const collapsedCreateIconRule = css.match(
    /\.loop-edit-actions\.is-active\[data-loop-action-engaged="false"\]\s+\.loop-edit-action-create\s+\.loop-edit-action-icon\.is-scissors\s*\{([^}]*)\}/s,
  )?.[1] || '';
  const collapsedCreateRule = css.match(
    /\.loop-edit-actions\.is-active\[data-loop-action-engaged="false"\]\s+\.loop-edit-action-create\s*\{([^}]*)\}/s,
  )?.[1] || '';
  const sharedMountRule = css.match(/\.loop-play-control-actions\s*\{([^}]*)\}/s)?.[1] || '';

  assert.match(collapsedPodRule, /width:\s*39px/);
  assert.match(collapsedPodRule, /opacity:\s*1/);
  assert.match(collapsedPodRule, /transform:\s*none/);
  assert.match(collapsedPodRule, /border-color:\s*rgba\(74,\s*222,\s*128,\s*0\.58\)/);
  assert.match(collapsedCreateRule, /width:\s*39px/);
  assert.match(collapsedCreateRule, /min-width:\s*39px/);
  assert.match(collapsedCreateRule, /color:\s*#4fa46f/);
  assert.match(
    collapsedCreateIconRule,
    /transform:\s*translateX\(5px\)/,
    'the active-away scissors must keep the regular idle icon position',
  );
  assert.match(sharedMountRule, /left:\s*60\.4166667cqw/);
  assert.match(sharedMountRule, /top:\s*58\.3333333cqw/);
  assert.match(sharedMountRule, /z-index:\s*4/);
  assert.doesNotMatch(sharedMountRule, /right:\s*-\d|bottom:\s*\d/);
  assert.doesNotMatch(
    css,
    /\.utility-loop-play-cluster\s+\.loop-edit-actions\.is-active\[data-loop-action-engaged="false"\][^{]*(?:\.loop-edit-action-pod|\.loop-edit-action-create)[^{]*\{[^}]*(?:transform|width|opacity)\s*:/s,
    'saved players must inherit the same active-away geometry',
  );
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
