const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const helperPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'music_app',
  'static',
  'js',
  'runtime',
  'browser-dialog-helpers.js',
);
const helperSource = fs.readFileSync(helperPath, 'utf8');
const utilitiesCss = fs.readFileSync(path.join(
  __dirname, '..', '..', '..', 'music_app', 'static', 'css', 'runtime', 'utilities.css',
), 'utf8');
const confirmModalsMarkup = fs.readFileSync(path.join(
  __dirname, '..', '..', '..', 'music_app', 'templates', 'partials', 'confirm-modals.html',
), 'utf8');

function cssRuleBody(selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return utilitiesCss.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`))?.[1] || '';
}

function cssZIndex(selector) {
  return Number(cssRuleBody(selector).match(/z-index:\s*(\d+)/)?.[1] || 0);
}

function loadHelper(windowOverrides = {}, contextOverrides = {}) {
  const context = {
    window: {},
    ...contextOverrides,
  };
  Object.defineProperties(
    context.window,
    Object.getOwnPropertyDescriptors(windowOverrides),
  );
  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  return context;
}

class FakeElement {
  constructor(options = {}) {
    this.hidden = Boolean(options.hidden);
    this.value = options.value || '';
    this.textContent = options.textContent || '';
    this.style = {};
    this.dataset = {};
    this.listeners = new Map();
    this.focusCalls = 0;
    this.selectCalls = 0;
  }

  addEventListener(name, handler) {
    const handlers = this.listeners.get(name) || [];
    handlers.push(handler);
    this.listeners.set(name, handlers);
  }

  removeEventListener(name, handler) {
    const handlers = this.listeners.get(name) || [];
    this.listeners.set(name, handlers.filter((candidate) => candidate !== handler));
  }

  dispatch(name, event = {}) {
    const handlers = this.listeners.get(name) || [];
    handlers.forEach((handler) => handler({
      preventDefault() {},
      ...event,
    }));
  }

  focus() {
    this.focusCalls += 1;
  }

  select() {
    this.selectCalls += 1;
  }
}

function createLoopNameDialog() {
  const trigger = new FakeElement();
  const modal = new FakeElement({ hidden: true });
  const input = new FakeElement();
  const error = new FakeElement();
  const cancel = new FakeElement();
  const submit = new FakeElement();
  const elements = new Map([
    ['loop-name-modal', modal],
    ['loop-name-input', input],
    ['loop-name-error', error],
    ['loop-name-cancel', cancel],
    ['loop-name-submit', submit],
  ]);
  const document = {
    activeElement: trigger,
    getElementById(id) {
      return elements.get(id) || null;
    },
  };
  const context = loadHelper({}, {
    document,
    HTMLElement: FakeElement,
    HTMLInputElement: FakeElement,
    HTMLButtonElement: FakeElement,
  });
  return { context, document, trigger, modal, input, error, cancel, submit };
}

function createLoopDeleteConfirmDialog() {
  const trigger = new FakeElement();
  const modal = new FakeElement({ hidden: true });
  const text = new FakeElement();
  const cancel = new FakeElement();
  const accept = new FakeElement();
  const elements = new Map([
    ['loop-delete-confirm-modal', modal],
    ['loop-delete-confirm-text', text],
    ['loop-delete-confirm-cancel', cancel],
    ['loop-delete-confirm-accept', accept],
  ]);
  const document = {
    activeElement: trigger,
    getElementById(id) {
      return elements.get(id) || null;
    },
  };
  const context = loadHelper({}, {
    document,
    bindOverlayPointerOrigin(overlay) {
      overlay.dataset.pointerDownStartedOnOverlay = '0';
      overlay.addEventListener('pointerdown', (event) => {
        overlay.dataset.pointerDownStartedOnOverlay = event.target === overlay ? '1' : '0';
      });
    },
    overlayClickStartedOnOverlay(overlay, event) {
      return event.target === overlay && overlay.dataset.pointerDownStartedOnOverlay === '1';
    },
  });
  return { context, document, trigger, modal, text, cancel, accept };
}

{
  const calls = [];
  const context = loadHelper({
    alert(message) {
      calls.push(['alert', message]);
    },
    prompt(message, defaultValue) {
      calls.push(['prompt', message, defaultValue]);
      return 'Loop Name';
    },
    confirm(message) {
      calls.push(['confirm', message]);
      return 1;
    },
  });

  assert.equal(context.showBrowserAlert('Heads up'), true);
  assert.equal(context.showBrowserPrompt('Name it', 'Demo'), 'Loop Name');
  assert.equal(context.showBrowserConfirm('Delete it?'), true);
  assert.deepEqual(calls, [
    ['alert', 'Heads up'],
    ['prompt', 'Name it', 'Demo'],
    ['confirm', 'Delete it?'],
  ]);
}

{
  const context = loadHelper({});
  assert.equal(context.showBrowserAlert('No-op'), false);
  assert.equal(context.showBrowserPrompt('Missing prompt', 'Fallback'), null);
  assert.equal(context.showBrowserConfirm('Missing confirm'), false);
}

async function verifyLoopNameDialogContract() {
  {
    const utilityZ = cssZIndex('.utility-modal');
    const genericConfirmZ = cssZIndex('.confirm-modal');
    const loopNameRule = cssRuleBody('#loop-name-modal');
    assert.ok(genericConfirmZ < utilityZ, 'unrelated confirm modals retain their existing layer');
    assert.ok(cssZIndex('#loop-name-modal') > utilityZ, 'loop naming must paint above Utility');
    assert.doesNotMatch(loopNameRule, /pointer-events:\s*none/);
    assert.match(confirmModalsMarkup, /id="loop-name-modal"[^]*id="loop-name-form"[^]*role="dialog"[^]*aria-modal="true"/);
    assert.match(confirmModalsMarkup, /id="loop-name-cancel"/);
  }

  {
    const { context, modal, input, cancel, submit } = createLoopNameDialog();
    const firstResult = context.showLoopNameDialog();
    const secondResult = context.showLoopNameDialog();
    let firstSettles = 0;
    let secondSettles = 0;
    firstResult.then(() => { firstSettles += 1; });
    secondResult.then(() => { secondSettles += 1; });

    assert.strictEqual(secondResult, firstResult);
    assert.equal(modal.hidden, false);
    assert.equal(input.focusCalls, 1);
    assert.equal(input.selectCalls, 1);
    assert.equal(submit.listeners.get('click')?.length, 1);
    assert.equal(cancel.listeners.get('click')?.length, 1);

    input.value = '  Shared Loop  ';
    submit.dispatch('click');

    assert.equal(await firstResult, 'Shared Loop');
    assert.equal(await secondResult, 'Shared Loop');
    await Promise.resolve();
    assert.equal(firstSettles, 1);
    assert.equal(secondSettles, 1);
    assert.equal(submit.listeners.get('click')?.length, 0);
    assert.equal(cancel.listeners.get('click')?.length, 0);

    cancel.dispatch('click');
    assert.equal(firstSettles, 1);
    assert.equal(secondSettles, 1);
  }

  {
    const { context, modal, input, error, submit } = createLoopNameDialog();
    let settled = false;
    const result = context.showLoopNameDialog().then((value) => {
      settled = true;
      return value;
    });

    assert.equal(modal.hidden, false);
    assert.equal(input.focusCalls, 1);
    assert.equal(input.selectCalls, 1);

    input.value = '   ';
    submit.dispatch('click');
    await Promise.resolve();

    assert.equal(settled, false);
    assert.equal(modal.hidden, false);
    assert.match(error.textContent, /name.*required|required.*name/i);

    input.value = '  Warmup Loop  ';
    submit.dispatch('click');

    assert.equal(await result, 'Warmup Loop');
    assert.equal(modal.hidden, true);
  }

  {
    const { context, trigger, modal, input } = createLoopNameDialog();
    const result = context.showLoopNameDialog();

    input.value = '  Entered Loop  ';
    modal.dispatch('keydown', { key: 'Enter', target: input });

    assert.equal(await result, 'Entered Loop');
    assert.equal(modal.hidden, true);
    assert.equal(trigger.focusCalls, 1);
  }

  {
    const { context, trigger, modal, cancel } = createLoopNameDialog();
    const result = context.showLoopNameDialog();

    cancel.dispatch('click');

    assert.equal(await result, null);
    assert.equal(modal.hidden, true);
    assert.equal(trigger.focusCalls, 1);
  }

  {
    const { context, trigger, modal, input } = createLoopNameDialog();
    const result = context.showLoopNameDialog();

    modal.dispatch('keydown', { key: 'Escape', target: input });

    assert.equal(await result, null);
    assert.equal(modal.hidden, true);
    assert.equal(trigger.focusCalls, 1);
  }

  {
    const { context, document, modal, input, submit } = createLoopNameDialog();
    const result = context.showLoopNameDialog();
    let prevented = 0;

    document.activeElement = submit;
    modal.dispatch('keydown', { key: 'Tab', preventDefault() { prevented += 1; } });
    assert.equal(prevented, 1);
    assert.equal(input.focusCalls, 2);

    document.activeElement = input;
    modal.dispatch('keydown', { key: 'Tab', shiftKey: true, preventDefault() { prevented += 1; } });
    assert.equal(prevented, 2);
    assert.equal(submit.focusCalls, 1);

    modal.dispatch('keydown', { key: 'Escape', target: input });
    assert.equal(await result, null);
  }
}

verifyLoopNameDialogContract().catch((error) => {
  process.nextTick(() => {
    throw error;
  });
});

async function verifyLoopDeleteConfirmDialogContract() {
  assert.match(
    confirmModalsMarkup,
    /id="loop-delete-confirm-modal"[^]*role="dialog"[^]*aria-modal="true"[^]*>No<[^]*>Yes</,
  );
  assert.ok(cssZIndex('#loop-delete-confirm-modal') > cssZIndex('.utility-modal'));

  {
    const { context, modal, text, cancel, accept } = createLoopDeleteConfirmDialog();
    const firstResult = context.showLoopDeleteConfirmDialog('Warmup Loop');
    const secondResult = context.showLoopDeleteConfirmDialog('Ignored Loop');

    assert.strictEqual(secondResult, firstResult);
    assert.equal(modal.hidden, false);
    assert.ok(
      Number(modal.style.zIndex) > cssZIndex('.utility-modal'),
      'opening the delete confirmation must enforce a foreground layer independent of cached CSS',
    );
    assert.equal(text.textContent, 'Remove "Warmup Loop"? This will delete the saved loop file.');
    assert.equal(cancel.focusCalls, 1);

    cancel.dispatch('click');
    assert.equal(await firstResult, false);
    assert.equal(await secondResult, false);
    assert.equal(modal.hidden, true);
    assert.equal(cancel.listeners.get('click')?.length, 0);
    assert.equal(accept.listeners.get('click')?.length, 0);
  }

  {
    const { context, trigger, modal, accept } = createLoopDeleteConfirmDialog();
    const result = context.showLoopDeleteConfirmDialog('Transition Loop');
    accept.dispatch('click');

    assert.equal(await result, true);
    assert.equal(modal.hidden, true);
    assert.equal(trigger.focusCalls, 1);
  }

  {
    const { context, trigger, modal } = createLoopDeleteConfirmDialog();
    const result = context.showLoopDeleteConfirmDialog('Escape Loop');
    let prevented = 0;
    let stopped = 0;
    modal.dispatch('keydown', {
      key: 'Escape',
      preventDefault() { prevented += 1; },
      stopPropagation() { stopped += 1; },
    });

    assert.equal(await result, false);
    assert.equal(prevented, 1);
    assert.equal(stopped, 1);
    assert.equal(trigger.focusCalls, 1);
  }

  {
    const { context, document, modal, cancel, accept } = createLoopDeleteConfirmDialog();
    const result = context.showLoopDeleteConfirmDialog('Focus Loop');
    let prevented = 0;

    document.activeElement = accept;
    modal.dispatch('keydown', { key: 'Tab', preventDefault() { prevented += 1; } });
    assert.equal(prevented, 1);
    assert.equal(cancel.focusCalls, 2);

    document.activeElement = cancel;
    modal.dispatch('keydown', { key: 'Tab', shiftKey: true, preventDefault() { prevented += 1; } });
    assert.equal(prevented, 2);
    assert.equal(accept.focusCalls, 1);

    cancel.dispatch('click');
    assert.equal(await result, false);
  }

  {
    const { context, modal, text, cancel } = createLoopDeleteConfirmDialog();
    const result = context.showLoopDeleteConfirmDialog('Selection Loop');

    modal.dispatch('pointerdown', { target: text });
    modal.dispatch('click', { target: modal });

    assert.equal(modal.hidden, false, 'releasing a dialog-originated selection over the backdrop must not dismiss');
    cancel.dispatch('click');
    assert.equal(await result, false);
  }

  {
    const { context, modal } = createLoopDeleteConfirmDialog();
    const result = context.showLoopDeleteConfirmDialog('Backdrop Loop');

    modal.dispatch('pointerdown', { target: modal });
    modal.dispatch('click', { target: modal });

    assert.equal(await result, false);
    assert.equal(modal.hidden, true, 'a gesture that starts and ends on the backdrop must still dismiss');
  }
}

verifyLoopDeleteConfirmDialogContract().catch((error) => {
  process.nextTick(() => {
    throw error;
  });
});
