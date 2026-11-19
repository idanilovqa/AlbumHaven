const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { countedCollection, createInteractionCounter, measureScalePair } = require('../helpers/bounded-interaction-counter.js');
const { createCountedDom } = require('../helpers/counted-dom.js');

const runtimeDir = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime');
const sources = ['markup-format-helpers.js', 'trigger-anchor.js', 'date-range-picker.js']
  .map(name => fs.readFileSync(path.join(runtimeDir, name), 'utf8'));

// A Log History filter whose list already holds `rowCount` rendered entries.
function mountPicker(counter, rowCount) {
  const { CountedElement, createElement } = createCountedDom(counter);
  const windowListeners = new Map();
  const fromDate = new CountedElement('input', { name: 'fromDate', value: '2026-11-10' });
  const toDate = new CountedElement('input', { name: 'toDate', value: '' });
  const root = new CountedElement('div', { selectors: { '[name="fromDate"]': fromDate, '[name="toDate"]': toDate } });
  const container = new CountedElement('div', { selectors: { '[data-date-range-picker]': root } });
  container.appendChild(root);
  const trigger = new CountedElement('button', { matching: ['[data-calendar-trigger]'], rect: { left: 40, top: 200, right: 80, bottom: 232, width: 40, height: 32 } });
  trigger.dataset.calendarTrigger = 'fromDate';
  trigger.setAttribute('aria-label', 'Choose from date');
  root.appendChild(trigger);
  const rows = countedCollection(Array.from({ length: rowCount }, (_value, index) => new CountedElement('li', { id: `log-${index}` })), counter);
  rows.forEach(row => container.appendChild(row));
  const observer = class {
    constructor() { counter.count('observers'); }
    observe() {}
    disconnect() {}
  };
  const context = vm.createContext({
    document: {
      createElement(tagName) {
        const element = createElement(tagName);
        element.showPopover = () => {};
        element.selectors.set('button', new CountedElement('button'));
        return element;
      },
      addEventListener() {},
      removeEventListener() {},
    },
    window: {
      ButtonComponent: require('../../../music_app/static/js/button-component.js'),
      innerWidth: 1280,
      innerHeight: 800,
      addEventListener(type, listener) { counter.count('listeners'); windowListeners.set(type, listener); },
      removeEventListener(type) { windowListeners.delete(type); },
    },
    getComputedStyle: () => ({ backgroundColor: 'rgb(20, 24, 28)', getPropertyValue: () => '' }),
    MutationObserver: observer,
    ResizeObserver: observer,
    CustomEvent: class { constructor(type, init) { Object.assign(this, { type }, init); } },
    Event: class { constructor(type) { this.type = type; } },
  });
  sources.forEach(source => vm.runInContext(source, context));
  const dispose = context.mountDateRangePicker(container);
  return { container, root, trigger, windowListeners, dispose };
}

test('bounded interaction: page scroll repositions the open calendar beside 1,000 log rows', async () => {
  const run = async (cardinality) => {
    const counter = createInteractionCounter();
    const { container, root, trigger, windowListeners, dispose } = mountPicker(counter, cardinality);
    root.dispatch('click', { target: { closest: selector => (selector === '[data-calendar-trigger]' ? trigger : null) } });
    const popup = container.children.at(-1);
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    const scroll = windowListeners.get('scroll');
    const work = await counter.measure(() => {
      for (let step = 0; step < 10; step += 1) {
        trigger.rect = { ...trigger.rect, top: 200 - step * 10, bottom: 232 - step * 10 };
        scroll();
      }
    });
    assert.equal(popup.style.top, '146px', 'the calendar follows its trigger');
    dispose();
    return work;
  };
  await measureScalePair({
    id: 'js:runtime/date-range-picker.js#mountDateRangePicker',
    small: 20,
    large: 1000,
    run,
    budgets: { itemsVisited: 0, domQueries: 0, domMutations: 70, renderCommits: 0, nodesCreated: 0, listeners: 0, observers: 0 },
    growth: { metric: 'domMutations', largeMinusSmallMax: 0 },
  });
});
