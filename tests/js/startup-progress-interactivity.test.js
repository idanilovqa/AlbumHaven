const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadStartupProgress() {
  const frames = new Map();
  let nextFrameId = 0;
  const fill = { style: {} };
  const percentLabel = { textContent: '' };
  const bar = { hidden: false, setAttribute() {} };
  const error = { hidden: true };
  const retry = { addEventListener() {}, focus() {} };
  const content = { inert: false };
  const root = {
    dataset: { startupProgress: '50' },
    hidden: true,
    querySelector(selector) {
      return {
        '.progress-fill': fill,
        '[role="progressbar"]': bar,
        '[data-startup-percent]': percentLabel,
        '[data-startup-error]': error,
        '[data-startup-retry]': retry,
      }[selector];
    },
  };
  const window = {
    addEventListener() {},
    cancelAnimationFrame(id) { frames.delete(id); },
    location: { reload() {} },
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame(callback) {
      const id = ++nextFrameId;
      frames.set(id, callback);
      return id;
    },
  };
  const document = {
    addEventListener() {},
    body: { children: [root, content] },
    querySelector: () => root,
  };
  const sourcePath = path.resolve(__dirname, '../../music_app/static/js/startup-progress.js');
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), { document, window });
  const runNextFrame = (timestamp) => {
    const next = frames.entries().next().value;
    assert.ok(next, 'expected a queued animation frame');
    frames.delete(next[0]);
    next[1](timestamp);
  };
  return {
    content,
    controller: window.AlbumHavenStartupProgress,
    root,
    runNextFrame,
    startupMarks: window.__ALBUM_HAVEN_STARTUP_MARKS__,
  };
}

test('startup progress records the first visible feedback boundary', () => {
  const ui = loadStartupProgress();

  assert.equal(ui.startupMarks.length, 1);
  assert.equal(ui.startupMarks[0].name, 'startup_ui_feedback_visible');
  assert.equal(typeof ui.startupMarks[0].atMs, 'number');
});

test('startup completion releases the usable app within two paint frames', () => {
  const ui = loadStartupProgress();
  ui.runNextFrame(0);
  assert.equal(ui.root.hidden, false);
  assert.equal(ui.content.inert, true);

  ui.controller.finish();
  ui.runNextFrame(16);
  ui.runNextFrame(32);

  assert.equal(ui.root.hidden, true);
  assert.equal(ui.content.inert, false);
});

test('bounded interaction: startup progress animation frames stay constant beside 200 page regions', async () => {
  const { countedCollection, createInteractionCounter, measureScalePair } = require('./helpers/bounded-interaction-counter.js');
  const { createCountedDom } = require('./helpers/counted-dom.js');
  const run = async (regions) => {
    const counter = createInteractionCounter();
    const { CountedElement } = createCountedDom(counter);
    const frames = [];
    const fill = new CountedElement('DIV');
    const percentLabel = new CountedElement('SPAN');
    const bar = new CountedElement('DIV');
    const elements = { '.progress-fill': fill, '[role="progressbar"]': bar, '[data-startup-percent]': percentLabel,
      '[data-startup-error]': new CountedElement('DIV'), '[data-startup-retry]': new CountedElement('BUTTON') };
    const root = new CountedElement('DIV', { dataset: { startupProgress: '50' } });
    root.querySelector = selector => { counter.count('domQueries'); return elements[selector]; };
    const window = {
      addEventListener() {},
      cancelAnimationFrame() {},
      location: { reload() {} },
      matchMedia: () => ({ matches: false }),
      requestAnimationFrame(callback) { counter.count('animationFrames'); frames.push(callback); return frames.length; },
    };
    const document = {
      addEventListener() {},
      body: { children: countedCollection([root, ...Array.from({ length: regions }, () => ({ inert: false }))], counter) },
      querySelector: () => root,
    };
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../music_app/static/js/startup-progress.js'), 'utf8'), { document, window });
    frames.shift()(0);
    const work = await counter.measure(() => {
      for (let frame = 1; frame <= 10; frame += 1) frames.shift()(frame * 16);
    });
    assert.equal(root.hidden, false);
    assert.ok(Number(bar.getAttribute('aria-valuenow')) > 25, 'the bar advances toward 50%');
    return work;
  };
  await measureScalePair({
    id: 'js:startup-progress.js#animate',
    small: 2,
    large: 200,
    run,
    budgets: { itemsVisited: 0, domQueries: 10, domMutations: 20, animationFrames: 10 },
    growth: { metric: 'itemsVisited', largeMinusSmallMax: 0 },
  });
});
