const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const load = file => import(pathToFileURL(path.join(__dirname, '../e2e/poms', file)).href);

function selectedItem(edgeOverrides = {}, present = true) {
  const item = {};
  const edge = { backgroundColor: 'rgb(161, 178, 195)', width: '3px', height: '32px',
    content: '""', display: 'block', visibility: 'visible', opacity: '1',
    top: '0px', bottom: '0px', left: '0px', ...edgeOverrides };
  return { evaluateAll: callback => vm.runInNewContext(`(${callback.toString()})(elements)`, {
    elements: present ? [item] : [],
    getComputedStyle(element, pseudo) {
      assert.equal(element, item);
      if (pseudo) { assert.equal(pseudo, '::before'); return edge; }
      return { backgroundColor: 'rgb(43, 43, 43)', color: 'rgb(249, 250, 251)', boxShadow: 'rgb(255, 0, 0) 3px 0px inset' };
    },
  }) };
}

function tagRow(fill = 'rgb(43, 43, 43)', accentColor = 'rgb(161, 178, 195)', ink = '#F9FAFB') {
  const accent = {}, row = { querySelector: selector => { assert.equal(selector, '.tag-editor-track-accent'); return accent; } };
  return { evaluate: callback => vm.runInNewContext(`(${callback.toString()})(row)`, {
    row, getComputedStyle(element) {
      if (element === accent) return { backgroundColor: accentColor };
      assert.equal(element, row);
      return { backgroundColor: fill, getPropertyValue: name => {
        if (name === '--text') return ink;
        assert.ok(['--tag-editor-selection-fill', '--selection-body-background'].includes(name));
        return 'color-mix(in srgb, white 10%, black)';
      } };
    },
  }) };
}

test('NavigationTree observation reports the actual pseudo edge, independent of a stale shadow', async () => {
  const { readNavigationSelectionPaint } = await load('components/navigationTree.js');
  const paint = await readNavigationSelectionPaint(selectedItem());
  assert.equal(paint.fill, 'rgb(43, 43, 43)');
  assert.equal(paint.accent.backgroundColor, 'rgb(161, 178, 195)');
  assert.equal(paint.accent.width, '3px');
  assert.equal(await readNavigationSelectionPaint(selectedItem({}, false)), null);
});

test('Tag selection keeps independently observed row and NavigationTree paint separate', async () => {
  const { InteractionSurfaces } = await load('interactionSurfaces.js');
  const paint = await InteractionSurfaces.prototype.readTagSelectionPaint.call({
    selectedTreeItem: selectedItem(), tagRows: { nth: index => { assert.equal(index, 1); return tagRow('rgb(1, 2, 3)', 'rgb(4, 5, 6)'); } },
  }, 1);
  assert.equal(paint.fill, 'rgb(1, 2, 3)');
  assert.equal(paint.expectedFill, 'color(srgb 0.225176 0.225451 0.225725)');
  assert.equal(paint.accent, 'rgb(4, 5, 6)');
  assert.equal(paint.expectedAccent, 'rgb(161, 178, 195)');
});

test('Tag selection rejects a missing or unpainted NavigationTree accent without a token fallback', async () => {
  const { InteractionSurfaces } = await load('interactionSurfaces.js');
  for (const reference of [selectedItem({}, false), ...[
    { content: 'none' }, { width: '0px' }, { height: '0px' }, { display: 'none' },
    { visibility: 'hidden' }, { opacity: '0' },
    { backgroundColor: 'transparent' }, { backgroundColor: 'rgba(52, 202, 120, 0)' },
    { backgroundColor: 'color(srgb 0.2 0.7 0.4 / 0)' },
  ].map(edge => selectedItem(edge))]) {
    await assert.rejects(InteractionSurfaces.prototype.readTagSelectionPaint.call({
      selectedTreeItem: reference, tagRows: { nth: () => { throw new Error('Row read must not replace missing reference'); } },
    }, 0), /configured 3px selection edge/);
  }
});

test('Tag selected fill preserves exact navigation paint on odd rows and the approved stripe on even rows', async () => {
  const { InteractionSurfaces } = await load('interactionSurfaces.js');
  const context = { selectedTreeItem: selectedItem(), tagRows: { nth: () => tagRow() } };
  const odd = await InteractionSurfaces.prototype.readTagSelectionPaint.call(context, 0);
  const even = await InteractionSurfaces.prototype.readTagSelectionPaint.call(context, 1);
  assert.equal(odd.expectedFill, 'rgb(43, 43, 43)');
  assert.equal(even.expectedFill, 'color(srgb 0.225176 0.225451 0.225725)');
  assert.notEqual(even.fill, even.expectedFill, 'the oracle must expose an incorrectly uniform selected row');
});

test('striped Tag selection uses local content ink independently of the NavigationTree panel ink', async () => {
  const { InteractionSurfaces } = await load('interactionSurfaces.js');
  const paint = await InteractionSurfaces.prototype.readTagSelectionPaint.call({
    selectedTreeItem: selectedItem(),
    tagRows: { nth: () => tagRow('color(srgb 0.225176 0.225451 0.225725)', 'rgb(161, 178, 195)', '#202124') },
  }, 1);
  assert.equal(paint.expectedFill, 'color(srgb 0.165608 0.165882 0.166706)');
  assert.notEqual(paint.fill, paint.expectedFill, 'a stripe painted with the other surface ink must be rejected');
});
