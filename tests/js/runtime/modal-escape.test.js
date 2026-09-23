const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const runtime = path.resolve(__dirname, '../../../music_app/static/js/runtime');

function harness() {
  const nodes = [];
  const listeners = [];
  const closed = [];
  function modal(id, zIndex) {
    const node = {
      id, hidden: false, dataset: {}, parentElement: null,
      style: { zIndex: String(zIndex), position: 'fixed', display: 'block', visibility: 'visible', opacity: '1' },
      classList: { contains: () => false },
      addEventListener() {},
      closest(selector) { return selector.includes('[hidden]') ? (this.hidden ? this : null) : this; },
      getClientRects() { return this.hidden ? [] : [{}]; },
      compareDocumentPosition(other) { return nodes.indexOf(this) < nodes.indexOf(other) ? 4 : 2; },
      querySelector() { return { click: () => { closed.push(id); node.hidden = true; } }; },
    };
    nodes.push(node);
    return node;
  }
  const track = modal('track-modal', 100);
  const tags = modal('tag-editor-modal', 115);
  const context = {
    document: {
      querySelectorAll: () => nodes,
      getElementById: id => nodes.find(node => node.id === id),
      addEventListener: (type, handler, capture) => listeners.push({ type, handler, capture }),
    },
    getComputedStyle: node => node.style,
    getTrackModalElements: () => ({ overlay: track }),
    getTagEditorElements: () => ({ overlay: tags }),
    getLightboxElements: () => ({}),
    getRepairConfirmElements: () => ({}),
    getCoverLookupModalElements: () => ({}),
    getCoverLookupDeleteConfirmElements: () => ({}),
    getUtilityModalElements: () => ({}),
    getNonAlbumModalElements: () => ({}),
    bindOverlayPointerOrigin() {},
    state: { tagEditor: { tracks: [{ path: 'a' }, { path: 'b' }], selectedPaths: ['a', 'b'], selectedPath: 'a', values: { a: { title: 'draft' } } } },
    renderTagEditor() {},
  };
  vm.createContext(context);
  for (const file of ['utility-loaders-and-cover-lookup.js', 'track-modal-lightbox-helpers.js']) {
    vm.runInContext(fs.readFileSync(path.join(runtime, file), 'utf8'), context);
  }
  const close = id => () => { closed.push(id); nodes.find(node => node.id === id).hidden = true; };
  Object.assign(context, {
    closeTrackModal: close('track-modal'),
    closeTagEditor: close('tag-editor-modal'),
    closeTagEditConfirmModal: close('tag-edit-confirm-modal'),
    closeCoverLookupDeleteConfirm: close('cover-lookup-delete-confirm-modal'),
    closeCoverLookupModal: close('cover-lookup-modal'),
    closeUtilityModal: close('utility-modal'),
    closeImageLightbox: close('image-lightbox'),
    closeRepairConfirmModal: close('repair-confirm-modal'),
    closeNonAlbumModal: close('non-album-modal'),
    closeVersionPickerModal: close('version-picker-modal'),
    renderTagEditor() {},
  });
  context.attachModalEvents();
  function escape(properties = {}) {
    const event = {
      key: 'Escape', defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopImmediatePropagation() { this.stopped = true; },
      ...properties,
    };
    for (const { handler } of listeners.filter(item => item.type === 'keydown')) {
      handler(event);
      if (event.stopped) break;
    }
    return event;
  }
  return { context, nodes, modal, track, tags, closed, listeners, escape };
}

test('Escape clears multi-selection without closing tags or the album behind it', () => {
  const h = harness();
  const draft = h.context.state.tagEditor.values;
  const event = h.escape();
  assert.deepEqual(Array.from(h.context.getSelectedTagEditorPaths(h.context.state.tagEditor.tracks)), []);
  assert.equal(h.context.state.tagEditor.values, draft);
  assert.deepEqual(h.closed, []);
  assert.equal(event.stopped, true);
  h.escape();
  assert.deepEqual(h.closed, ['tag-editor-modal']);
  assert.equal(h.track.hidden, false);
});

test('Escape cancels only a confirmation above Edit tags', () => {
  const h = harness();
  h.modal('tag-edit-confirm-modal', 120);
  h.escape();
  assert.deepEqual(h.closed, ['tag-edit-confirm-modal']);
  assert.equal(h.tags.hidden, false);
  assert.equal(h.context.state.tagEditor.selectedPaths.length, 2);
});

test('computed stacking order beats the old hardcoded order and DOM order', () => {
  const h = harness();
  h.context.getCoverLookupModalElements = () => ({ overlay: h.modal('cover-lookup-modal', 110) });
  h.modal('cover-lookup-delete-confirm-modal', 125);
  h.escape();
  assert.deepEqual(h.closed, ['cover-lookup-delete-confirm-modal']);
  assert.equal(h.track.hidden, false);
});

test('equal z-index dialogs dismiss only the last painted one', () => {
  const h = harness();
  h.modal('app-confirm-modal', 125);
  h.modal('loop-name-modal', 125);
  h.escape();
  assert.deepEqual(h.closed, ['loop-name-modal']);
});

test('invisible dialogs and hidden ancestors cannot claim Escape', () => {
  const h = harness();
  const hidden = h.modal('app-confirm-modal', 999);
  hidden.hidden = true;
  h.context.state.tagEditor.selectedPaths = ['a'];
  h.escape();
  assert.deepEqual(h.closed, ['tag-editor-modal']);
});

test('an undismissable progress overlay blocks all lower modal handlers', () => {
  const h = harness();
  const progress = h.modal('repair-progress-overlay', 130);
  progress.querySelector = () => null;
  h.escape();
  assert.deepEqual(h.closed, []);
});

test('a held Escape cannot cascade through modal layers', () => {
  const h = harness();
  h.escape({ repeat: true });
  assert.deepEqual(h.closed, []);
  assert.equal(h.context.state.tagEditor.selectedPaths.length, 2);
});

test('modal Escape owns capture phase and preserves already consumed keys', () => {
  const h = harness();
  assert.equal(h.listeners[0].capture, true);
  h.escape({ defaultPrevented: true });
  assert.deepEqual(h.closed, []);
});

test('deselecting files stays empty instead of silently selecting the first file', () => {
  const h = harness();
  h.context.setTagEditorSelectedPaths([]);
  assert.deepEqual(Array.from(h.context.getSelectedTagEditorPaths(h.context.state.tagEditor.tracks)), []);
});

for (const id of [
  'image-lightbox', 'repair-confirm-modal', 'cover-lookup-modal',
  'non-album-modal', 'version-picker-modal', 'app-confirm-modal',
  'app-form-modal', 'loop-name-modal', 'loop-delete-confirm-modal',
]) {
  test(`Escape cancels only the foreground ${id}`, () => {
    const h = harness();
    h.modal(id, 5000);
    h.escape();
    assert.deepEqual(h.closed, [id]);
    assert.equal(h.tags.hidden, false);
    assert.equal(h.track.hidden, false);
  });
}

test('Settings discards its appearance draft but cannot interrupt an in-flight save', () => {
  const h = harness();
  h.modal('utility-modal', 200);
  let saving = true;
  let discarded = false;
  h.context.getBackgroundAppearanceEditor = () => ({
    allowLeave(confirm) {
      if (saving) return false;
      discarded = confirm();
      return discarded;
    },
  });
  h.escape();
  assert.deepEqual(h.closed, []);
  saving = false;
  h.escape();
  assert.equal(discarded, true);
  assert.deepEqual(h.closed, ['utility-modal']);
});

test('a high child z-index cannot escape a lower ancestor stacking context', () => {
  const h = harness();
  const parent = {
    style: { zIndex: '90', position: 'relative', opacity: '1' },
    parentElement: null,
    compareDocumentPosition: () => 4,
  };
  const nested = h.modal('app-confirm-modal', 9999);
  nested.parentElement = parent;
  h.context.state.tagEditor.selectedPaths = ['a'];
  h.escape();
  assert.deepEqual(h.closed, ['tag-editor-modal']);
});

test('visibility-hidden and display-none ancestors are excluded', () => {
  const h = harness();
  const hidden = h.modal('app-confirm-modal', 9999);
  hidden.style.visibility = 'hidden';
  const collapsed = h.modal('loop-name-modal', 9999);
  collapsed.getClientRects = () => [];
  h.context.state.tagEditor.selectedPaths = ['a'];
  h.escape();
  assert.deepEqual(h.closed, ['tag-editor-modal']);
});

test('Escape cancels tag reordering before changing selection or closing', () => {
  const h = harness();
  h.context.state.tagEditor.reorder = { path: 'a' };
  h.escape();
  assert.equal(h.context.state.tagEditor.reorder, null);
  assert.equal(h.context.state.tagEditor.selectedPaths.length, 2);
  assert.deepEqual(h.closed, []);
});
