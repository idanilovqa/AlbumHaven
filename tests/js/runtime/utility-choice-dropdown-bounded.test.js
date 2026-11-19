const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  countedCollection,
  createInteractionCounter,
  measureScalePair,
} = require('../helpers/bounded-interaction-counter');

const root = path.resolve(__dirname, '../../../music_app/static/js');
const CHOICES = ['Playback Statistics XML', 'Text Tools — standard', 'Text Tools — enhanced'];

// The real shared choice dropdown, opened over a page holding `pageRows`
// gallery rows. Every DOM query is counted, and every element a query returns
// is a counted collection, so the rows the resize and keyboard listeners read
// are measured rather than assumed.
function openDropdown(pageRows) {
  const counter = createInteractionCounter();
  const windowListeners = {};
  const node = (extra = {}) => ({
    style: {}, listeners: {}, attributes: {}, isConnected: true, hidden: false,
    setAttribute(key, value) { this.attributes[key] = value; },
    getAttribute(key) { return this.attributes[key]; },
    addEventListener(type, callback) { this.listeners[type] = callback; },
    removeEventListener() {}, remove() {}, contains: () => false, focus() {},
    getBoundingClientRect: () => ({ left: 20, top: 100, bottom: 140, width: 120, height: 40 }),
    ...extra,
  });
  const pageRowNodes = Array.from({ length: pageRows }, () => node());
  const query = (items) => {
    counter.count('domQueries');
    return countedCollection(items, counter);
  };
  let menuRows = [];
  const menu = node({
    scrollHeight: 96,
    querySelectorAll: () => query(menuRows),
    querySelector: () => menuRows[0] || null,
  });
  // The rendered markup becomes one row per choice.
  Object.defineProperty(menu, 'innerHTML', {
    set(html) { menuRows = (html.match(/data-foobar-format=/g) || []).map(() => node({ firstElementChild: { scrollWidth: 160 } })); },
    get() { return ''; },
  });
  const document = {
    body: { append() {}, querySelectorAll: () => query(pageRowNodes) },
    activeElement: null,
    createElement: () => menu,
    addEventListener() {}, removeEventListener() {},
    querySelector: () => { counter.count('domQueries'); return null; },
    querySelectorAll: () => query(pageRowNodes),
  };
  const context = vm.createContext({
    console, document, state: { utility: {} }, innerWidth: 1280, innerHeight: 800,
    addEventListener: (type, callback) => { windowListeners[type] = callback; },
    removeEventListener() {},
    getComputedStyle: () => ({ paddingLeft: '8px', paddingRight: '8px', borderLeftWidth: '1px', borderRightWidth: '1px' }),
    syncTriggerAnchor() {}, clearTriggerAnchor() {},
  });
  context.window = context;
  vm.runInContext(fs.readFileSync(path.join(root, 'button-component.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'runtime', 'library-settings.js'), 'utf8'), context);
  const trigger = node({ querySelector: () => null });
  context.openUtilityChoiceDropdown(trigger, {
    formats: CHOICES, selected: CHOICES[0], label: 'Foobar export format', onSelect: () => true, matchTriggerWidth: true,
  });
  return { counter, menu, windowListeners, menuRows: () => menuRows };
}

test('BI choice dropdown resize and arrow keys read only the open menu rows at any page size', async () => {
  await measureScalePair({
    id: 'js:runtime/library-settings.js#openUtilityChoiceDropdown',
    small: 20,
    large: 5000,
    run: async (pageRows) => {
      const { counter, menu, windowListeners } = openDropdown(pageRows);
      return counter.measure(() => {
        windowListeners.resize();
        menu.listeners.keydown({ key: 'ArrowDown', preventDefault() {} });
      });
    },
    budgets: { domQueries: 3, itemsVisited: 6 },
    growth: { metric: 'itemsVisited', largeMinusSmallMax: 0 },
  });
});

test('the choice dropdown sizes itself from its own rows', () => {
  const { menu, menuRows } = openDropdown(20);
  assert.equal(menuRows().length, CHOICES.length);
  // Widest row (160) plus the row frame (18) and the list frame (18).
  assert.equal(menu.style.width, '196px');
});
