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
  'bootstrap-refocus-helpers.js',
);
const helperSource = fs.readFileSync(helperPath, 'utf8');

class FakeElement {
  constructor(tagName = 'div', options = {}) {
    this.tagName = String(tagName || 'div').toUpperCase();
    this.id = options.id || '';
    this.dataset = options.dataset || {};
    this.parentElement = null;
    this.children = [];
    this._classes = new Set(options.classes || []);
    this.className = Array.from(this._classes).join(' ');
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  closest(selector) {
    let current = this;
    while (current) {
      if (matchesSelectorList(current, selector)) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }
}

function matchesSelectorList(element, selectorList) {
  return String(selectorList || '')
    .split(',')
    .map((selector) => selector.trim())
    .filter(Boolean)
    .some((selector) => matchesSimpleSelector(element, selector));
}

function matchesSimpleSelector(element, selector) {
  if (!selector) return false;
  if (selector.startsWith('.')) {
    return element._classes.has(selector.slice(1));
  }
  if (selector.startsWith('#')) {
    return element.id === selector.slice(1);
  }
  if (selector.startsWith('[data-') && selector.endsWith(']')) {
    const dataKey = selector.slice(6, -1).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    return Object.prototype.hasOwnProperty.call(element.dataset, dataKey);
  }
  return element.tagName.toLowerCase() === selector.toLowerCase();
}

function loadHelpers() {
  let now = 1000;
  const document = {
    visibilityState: 'visible',
  };
  const context = {
    Element: FakeElement,
    document,
    Date: {
      now() {
        return now;
      },
    },
    state: {
      ui: {
        pendingAppRefocusSuppression: false,
        suppressNextViewportClick: false,
        suppressClickSequenceUntil: 0,
        refocusHoverIntentCount: 0,
        refocusLastHoverIntentKey: '',
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  return {
    context,
    document,
    setNow(value) {
      now = value;
    },
  };
}

function createEvent(target) {
  return {
    target,
    prevented: false,
    stopped: false,
    immediateStopped: false,
    preventDefault() {
      this.prevented = true;
    },
    stopPropagation() {
      this.stopped = true;
    },
    stopImmediatePropagation() {
      this.immediateStopped = true;
    },
  };
}

{
  const { context } = loadHelpers();
  const albumCard = new FakeElement('button', {
    classes: ['album-card'],
    dataset: { albumKey: 'broadcast-tender-buttons' },
  });
  context.armViewportRefocusSuppression();
  const event = createEvent(albumCard);
  assert.equal(context.suppressRefocusViewportInteraction(event), true);
  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
  assert.equal(event.immediateStopped, true);
  assert.equal(context.state.ui.suppressNextViewportClick, false);
  assert.equal(context.state.ui.suppressClickSequenceUntil, 1400);
}

{
  const { context } = loadHelpers();
  const modal = new FakeElement('div', { id: 'track-modal' });
  const modalButton = new FakeElement('button');
  modal.appendChild(modalButton);
  context.armViewportRefocusSuppression();
  const pointerEvent = createEvent(modalButton);
  assert.equal(context.suppressRefocusViewportInteraction(pointerEvent), true);
  assert.equal(pointerEvent.prevented, true);
  const clickEvent = createEvent(modalButton);
  assert.equal(context.suppressRefocusViewportClick(clickEvent), true);
  assert.equal(clickEvent.prevented, true);
  assert.equal(context.state.ui.suppressClickSequenceUntil, 0);
  const secondPointerEvent = createEvent(modalButton);
  assert.equal(context.suppressRefocusViewportInteraction(secondPointerEvent), false);
  assert.equal(secondPointerEvent.prevented, false);
}

{
  const { context } = loadHelpers();
  const modal = new FakeElement('div', { id: 'loop-delete-confirm-modal' });
  const cancelButton = new FakeElement('button', { id: 'loop-delete-confirm-cancel' });
  modal.appendChild(cancelButton);
  assert.equal(
    context.isViewportRefocusExemptTarget(cancelButton),
    true,
    'controls inside the foreground loop-delete dialog are classified as refocus-exempt',
  );
  assert.equal(context.isViewportRefocusExemptTarget(new FakeElement('button')), false);
}

{
  const { context } = loadHelpers();
  const modal = new FakeElement('div', { id: 'cover-lookup-modal' });
  const coverCard = new FakeElement('button', {
    dataset: { selectLocalCover: 'C:/music/Artist/Album/alternate.jpg' },
  });
  const modalHeader = new FakeElement('h2');
  const ordinaryModalButton = new FakeElement('button', { id: 'cover-lookup-find-better-button' });
  modal.appendChild(coverCard);
  modal.appendChild(modalHeader);
  modal.appendChild(ordinaryModalButton);

  context.armViewportRefocusSuppression();
  const coverPointerEvent = createEvent(coverCard);
  assert.equal(context.suppressRefocusViewportInteraction(coverPointerEvent), true);
  assert.equal(coverPointerEvent.prevented, true);

  context.armViewportRefocusSuppression();
  const ordinaryPointerEvent = createEvent(ordinaryModalButton);
  assert.equal(context.suppressRefocusViewportInteraction(ordinaryPointerEvent), true);
  assert.equal(ordinaryPointerEvent.prevented, true);
  const ordinaryClickEvent = createEvent(ordinaryModalButton);
  assert.equal(context.suppressRefocusViewportClick(ordinaryClickEvent), true);
  assert.equal(ordinaryClickEvent.prevented, true);

  context.armViewportRefocusSuppression();
  const headerPointerEvent = createEvent(modalHeader);
  assert.equal(context.suppressRefocusViewportInteraction(headerPointerEvent), true);
  assert.equal(headerPointerEvent.prevented, true);
  const headerClickEvent = createEvent(modalHeader);
  assert.equal(context.suppressRefocusViewportClick(headerClickEvent), true);
  assert.equal(headerClickEvent.prevented, true);
  assert.equal(context.state.ui.suppressNextViewportClick, false);
  const nextCoverPointerEvent = createEvent(coverCard);
  assert.equal(context.suppressRefocusViewportInteraction(nextCoverPointerEvent), false);
  assert.equal(nextCoverPointerEvent.prevented, false);
}

{
  const { context } = loadHelpers();
  const firstCard = new FakeElement('button', {
    classes: ['album-card'],
    dataset: { albumKey: 'broadcast-tender-buttons' },
  });
  const secondCard = new FakeElement('button', {
    classes: ['album-card'],
    dataset: { albumKey: 'stereolab-dots-and-loops' },
  });
  context.armViewportRefocusSuppression();
  assert.equal(context.noteViewportRefocusHoverIntent(createEvent(firstCard)), false);
  assert.equal(context.state.ui.suppressNextViewportClick, true);
  assert.equal(context.noteViewportRefocusHoverIntent(createEvent(secondCard)), true);
  assert.equal(context.state.ui.suppressNextViewportClick, false);
  const clickEvent = createEvent(secondCard);
  assert.equal(context.suppressRefocusViewportInteraction(clickEvent), false);
  assert.equal(clickEvent.prevented, false);
}

{
  const { context } = loadHelpers();
  const scrollTarget = new FakeElement('div', { id: 'albums-scroll' });
  context.armViewportRefocusSuppression();
  assert.equal(context.noteViewportRefocusWheelIntent(createEvent(scrollTarget)), true);
  assert.equal(context.state.ui.suppressNextViewportClick, false);
}

{
  const { context, document } = loadHelpers();
  context.armViewportRefocusSuppression();
  context.state.ui.pendingAppRefocusSuppression = true;
  document.visibilityState = 'visible';
  context.handleViewportRefocusVisibilityChange();
  assert.equal(context.state.ui.suppressNextViewportClick, false);
  assert.equal(context.state.ui.pendingAppRefocusSuppression, false);
}
