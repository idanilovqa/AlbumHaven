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
    dataset: { startupProgress: '25' },
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
    fill,
    percentLabel,
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

test('startup completion releases the usable app two paint frames after reaching 100', () => {
  const ui = loadStartupProgress();
  ui.runNextFrame(0);
  assert.equal(ui.root.hidden, false);
  assert.equal(ui.content.inert, true);

  ui.controller.finish();
  ui.runNextFrame(16);
  ui.runNextFrame(716);
  assert.equal(ui.root.hidden, false);
  ui.runNextFrame(732);
  ui.runNextFrame(748);

  assert.equal(ui.root.hidden, true);
  assert.equal(ui.content.inert, false);
});

test('startup completion animates the visible bar to 100 before hiding', () => {
  const ui = loadStartupProgress();
  ui.runNextFrame(100);
  ui.controller.show(75);
  ui.runNextFrame(200);
  ui.runNextFrame(550);
  const widthBeforeFinish = Number.parseFloat(ui.fill.style.width);

  ui.controller.finish();

  assert.equal(ui.root.hidden, false);
  assert.equal(ui.percentLabel.textContent, `${Math.round(widthBeforeFinish)}%`);
  assert.equal(Number.parseFloat(ui.fill.style.width), widthBeforeFinish);
  ui.runNextFrame(600);
  ui.runNextFrame(1300);
  assert.equal(ui.root.hidden, false);
  assert.equal(ui.percentLabel.textContent, '100%');
  assert.equal(ui.fill.style.width, '100.000%');
  ui.runNextFrame(1316);
  assert.equal(ui.root.hidden, false);
  ui.runNextFrame(1332);
  assert.equal(ui.root.hidden, true);
});
