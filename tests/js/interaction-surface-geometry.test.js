const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '../e2e/poms/interactionSurfaces.js')).href);
function surfaces({ barBottom = 116, outlineLeft = '-2px', ownerPresent = true, ownerVisible = true } = {}) {
  const hiddenHeader = { getBoundingClientRect: () => ({ bottom: 0 }) };
  const galleryBar = { getBoundingClientRect: () => ({ bottom: barBottom, width: 1144, height: 54 }) };
  const panel = { getBoundingClientRect: () => ({ top: 116 }) };
  const trigger = {
    closest: selector => { assert.equal(selector, '[data-gallery-bar]'); return ownerPresent ? galleryBar : null; },
    getAttribute: name => { assert.equal(name, 'aria-controls'); return 'artist-family-panel'; },
  };
  const sandbox = {
    document: {
      querySelector: selector => { assert.equal(selector, '.gallery-bar'); return hiddenHeader; },
      getElementById: id => { assert.equal(id, 'artist-family-panel'); return panel; },
    },
    getComputedStyle: (element, pseudo) => {
      if (element === galleryBar) return { display: 'flex', visibility: ownerVisible ? 'visible' : 'hidden' };
      if (element === panel) return { top: '-1px', height: '2px', backgroundImage: 'linear-gradient(black, white)' };
      if (pseudo === '::after') return { left: outlineLeft, right: '-2px' };
      if (pseudo === '::before') return { left: '0px', right: '0px' };
      return { backgroundImage: 'linear-gradient(black, white)', borderTopWidth: '2px',
        boxShadow: 'none', transitionProperty: '--trigger-anchor-cap' };
    },
  };
  const evaluate = element => callback => vm.runInNewContext(`(${callback.toString()})(element)`, { ...sandbox, element });
  return { familyPanel: { evaluate: evaluate(panel) }, familyTrigger: { evaluate: evaluate(trigger) } };
}

test('Family divider uses its trigger-owned GalleryBar despite a preceding hidden page header', async () => {
  const { expectSharedOutlineGeometry } = await load();
  await expectSharedOutlineGeometry(surfaces());
});

test('Family divider still rejects a real owner-relative offset beyond the original 1px tolerance', async () => {
  const { expectSharedOutlineGeometry } = await load();
  await assert.rejects(expectSharedOutlineGeometry(surfaces({ barBottom: 120 })), /toBeLessThanOrEqual/);
});

test('Family outline still rejects a join narrower than the approved 2px', async () => {
  const { expectSharedOutlineGeometry } = await load();
  await assert.rejects(expectSharedOutlineGeometry(surfaces({ outlineLeft: '-1px' })), /toEqual/);
});

test('Family divider fails closed for a missing or hidden owning GalleryBar', async () => {
  const { expectSharedOutlineGeometry } = await load();
  await assert.rejects(expectSharedOutlineGeometry(surfaces({ ownerPresent: false })), /no owning GalleryBar/);
  await assert.rejects(expectSharedOutlineGeometry(surfaces({ ownerVisible: false })), /toBe/);
});
