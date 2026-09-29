const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ButtonComponent = require('../../../music_app/static/js/button-component.js');
const escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

test('shared back glyph is an actual bare ActionButton with accessible name', () => {
  const markup = ButtonComponent.renderActionButton({ icon: 'back', presentation: 'bare', ariaLabel: 'Back to library' });
  assert.match(markup, /action-button--bare/);
  assert.match(markup, /aria-label="Back to library"/);
  assert.match(markup, /<svg/);
  assert.match(markup, /M19 12H5/);
});

test('loading artbox reuses existing artwork without changing empty/missing states', () => {
  const context = vm.createContext({ escapeHtml });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../../music_app/static/js/runtime/album-artbox.js'), 'utf8'), context);
  const loading = context.buildAlbumArtboxHtml({ state: 'loading', label: 'Loading cover art' });
  assert.match(loading, /data-album-artbox-state="loading"/);
  assert.match(loading, /\/static\/images\/loading-idea.png/);
  assert.doesNotMatch(context.buildAlbumArtboxHtml({ state: 'empty', label: 'No cover' }), /loading-idea/);
  assert.doesNotMatch(context.buildAlbumArtboxHtml({ state: 'missing', label: 'Missing album' }), /loading-idea/);
});

function searchHarness(value = '') {
  const node = () => ({
    attrs: new Map(), dataset: {},
    classList: { toggle() {} },
    setAttribute(name, value) { this.attrs.set(name, value); },
    removeAttribute(name) { this.attrs.delete(name); },
  });
  const button = node(), input = node(), clear = node(), bar = node();
  const form = { contains: target => [input, button, clear].includes(target), closest: () => bar };
  const suggestion = node(), popover = { contains: target => target === suggestion };
  const nodes = { 'search-input': input, 'mobile-search-button': button, 'search-form': form,
    'mobile-navigation': node(), 'recent-search-popover': popover };
  const document = { activeElement: null, getElementById: id => nodes[id],
    dispatchEvent() {}, addEventListener() {}, querySelectorAll: () => [] };
  input.id = 'search-input'; input.value = value;
  input.closest = () => ({ querySelector: () => clear });
  input.focus = () => { document.activeElement = input; };
  input.blur = () => { document.activeElement = null; };
  const context = vm.createContext({ document, window: { innerWidth: 390 },
    CustomEvent: class {}, closeRecentSearchPopover() {} });
  for (const file of ['mobile-navigation.js', 'search-input.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../../music_app/static/js/runtime', file), 'utf8'), context);
  }
  return { context, document, input, button, clear, suggestion };
}

test('mobile search collapses without clearing its query and exposes retained-query state', () => {
  const { context, input, button, document } = searchHarness('Sixteen Horizons');
  context.setMobileSearchOpen(true);
  assert.equal(document.activeElement, input);
  context.setMobileSearchOpen(false);
  assert.equal(input.value, 'Sixteen Horizons');
  assert.equal(input.inert, true);
  assert.equal(button.attrs.get('aria-expanded'), 'false');
  assert.equal(button.attrs.get('data-has-query'), 'true');
  assert.equal(button.attrs.get('aria-description'), 'Search query present');
  assert.notEqual(document.activeElement, input);
  context.setMobileSearchOpen(true);
  assert.equal(input.value, 'Sixteen Horizons');
  assert.equal(input.inert, false);
  assert.equal(document.activeElement, input);
});

for (const query of ['', 'Northlight']) {
  test(`outside search activation collapses ${query ? 'populated' : 'empty'} input without consuming the target action`, () => {
    const { context, input, button } = searchHarness(query);
    context.setMobileSearchOpen(true);
    context.handleMobileSearchOutsideClick({ target: {},
      preventDefault() { throw Error('The outside action must remain actionable'); },
      stopPropagation() { throw Error('The outside action must remain actionable'); } });
    assert.equal(button.attrs.get('aria-expanded'), 'false');
    assert.equal(input.value, query);
  });
}

test('input, clear, submit and recent suggestions remain inside the search interaction', () => {
  const { context, input, button, clear, suggestion } = searchHarness('Northlight');
  context.setMobileSearchOpen(true);
  for (const target of [input, button, clear, suggestion]) {
    context.handleMobileSearchOutsideClick({ target });
    assert.equal(button.attrs.get('aria-expanded'), 'true');
  }
});

test('shared input updates clear the query indicator, including whitespace-only drafts', () => {
  const { context, input, button } = searchHarness('Northlight');
  context.setMobileSearchOpen(false);
  for (const value of ['', '  ']) {
    input.value = value;
    context.updateSearchClearAction(input);
    assert.equal(button.attrs.get('data-has-query'), 'false');
    assert.equal(button.attrs.has('aria-description'), false);
  }
  input.value = 'A different album';
  context.updateSearchClearAction(input);
  assert.equal(button.attrs.get('data-has-query'), 'true');
});

test('desktop outside actions do not collapse the input or add a mobile query description', () => {
  const { context, input, button } = searchHarness('Northlight');
  context.setMobileSearchOpen(true);
  context.window.innerWidth = 1180;
  context.handleMobileSearchOutsideClick({ target: {} });
  context.syncMobileSearchQueryIndicator();
  assert.equal(button.attrs.get('aria-expanded'), 'true');
  assert.equal(input.inert, false);
  assert.equal(button.attrs.has('aria-description'), false);
});
