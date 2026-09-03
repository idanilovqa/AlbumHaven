const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
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
  'compact-player-helpers.js',
);
const templatePath = path.join(__dirname, '..', '..', '..', 'music_app', 'templates', 'index.html');
const stylePath = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'css', 'runtime', 'non-album-and-player.css');
const appChromeStylePath = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'css', 'app-chrome.css');
const controllerPath = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'compact-player-controller.js');

function loadHelper() {
  const context = {};
  vm.createContext(context);
  vm.runInContext(fs.existsSync(helperPath) ? fs.readFileSync(helperPath, 'utf8') : '', context, {
    filename: helperPath,
  });
  return context;
}

const plain = value => JSON.parse(JSON.stringify(value));

test('compact player is eligible only above the desktop shell breakpoint', () => {
  const helper = loadHelper();

  assert.equal(helper.isCompactPlayerEligible({ viewportWidth: 901, desktopBreakpoint: 900 }), true);
  assert.equal(helper.isCompactPlayerEligible({ viewportWidth: 900, desktopBreakpoint: 900 }), false);
  assert.equal(helper.isCompactPlayerEligible({ viewportWidth: 430, desktopBreakpoint: 900 }), false);
});

test('mobile ignores a persisted compact mode and desktop restores it', () => {
  const helper = loadHelper();

  assert.equal(helper.resolveCompactPlayerMode({ eligible: true, persistedMode: 'compact' }), 'compact');
  assert.equal(helper.resolveCompactPlayerMode({ eligible: false, persistedMode: 'compact' }), 'expanded');
  assert.equal(helper.resolveCompactPlayerMode({ eligible: true, persistedMode: 'unknown' }), 'expanded');
});

test('compact mode persistence writes only canonical presentation modes', () => {
  const helper = loadHelper();
  const writes = [];
  const storage = { setItem: (key, value) => writes.push([key, value]) };

  assert.equal(helper.persistCompactPlayerMode(storage, 'compact'), true);
  assert.equal(helper.persistCompactPlayerMode(storage, 'expanded'), true);
  assert.equal(helper.persistCompactPlayerMode(storage, 'floating'), false);
  assert.deepEqual(writes, [
    ['albumhaven.compactPlayer.mode.v1', 'compact'],
    ['albumhaven.compactPlayer.mode.v1', 'expanded'],
  ]);
});

test('docked is the default compact style and invalid stored values normalize safely', () => {
  const helper = loadHelper();

  assert.equal(helper.normalizeCompactPlayerStyle(), 'docked');
  assert.equal(helper.normalizeCompactPlayerStyle('docked'), 'docked');
  assert.equal(helper.normalizeCompactPlayerStyle('floating'), 'floating');
  assert.equal(helper.normalizeCompactPlayerStyle('bottom-left'), 'docked');
});

test('floating pointer movement becomes a drag only after crossing the threshold', () => {
  const helper = loadHelper();

  assert.equal(helper.didCompactPlayerDrag({ startX: 20, startY: 20, currentX: 23, currentY: 24, threshold: 6 }), false);
  assert.equal(helper.didCompactPlayerDrag({ startX: 20, startY: 20, currentX: 26, currentY: 20, threshold: 6 }), true);
  assert.equal(helper.didCompactPlayerDrag({ startX: 20, startY: 20, currentX: 25, currentY: 24, threshold: 6 }), true);
});

test('floating position is clamped inside the visible viewport with its safety margin', () => {
  const helper = loadHelper();

  assert.deepEqual(
    plain(helper.clampCompactPlayerPosition({
      x: 900,
      y: -20,
      playerWidth: 96,
      playerHeight: 96,
      viewportWidth: 1000,
      viewportHeight: 700,
      margin: 12,
    })),
    { x: 892, y: 12 },
  );
  assert.deepEqual(
    plain(helper.clampCompactPlayerPosition({
      x: 40,
      y: 500,
      playerWidth: 96,
      playerHeight: 96,
      viewportWidth: 1000,
      viewportHeight: 700,
      margin: 12,
    })),
    { x: 40, y: 500 },
  );
});

test('each visit creates a fresh floating default beside the lower-left artist tree', () => {
  const helper = loadHelper();
  const options = {
    treeRect: { left: 0, top: 64, width: 280, height: 636 },
    playerWidth: 96,
    playerHeight: 96,
    viewportWidth: 1200,
    viewportHeight: 700,
    margin: 12,
  };

  const first = helper.createCompactPlayerSessionPosition(options);
  first.x = 700;
  first.y = 100;
  const nextVisit = helper.createCompactPlayerSessionPosition(options);

  assert.deepEqual(plain(nextVisit), { x: 12, y: 592 });
});

test('docked queue controls disable previous and next at their respective boundaries', () => {
  const helper = loadHelper();

  assert.deepEqual(plain(helper.resolveCompactQueueControls({ queueLength: 3, currentIndex: 0 })), {
    previousDisabled: true,
    nextDisabled: false,
  });
  assert.deepEqual(plain(helper.resolveCompactQueueControls({ queueLength: 3, currentIndex: 1 })), {
    previousDisabled: false,
    nextDisabled: false,
  });
  assert.deepEqual(plain(helper.resolveCompactQueueControls({ queueLength: 3, currentIndex: 2 })), {
    previousDisabled: false,
    nextDisabled: true,
  });
  assert.deepEqual(plain(helper.resolveCompactQueueControls({ queueLength: 0, currentIndex: -1 })), {
    previousDisabled: true,
    nextDisabled: true,
  });
});

test('docked player geometry follows the rendered artist-tree panel', () => {
  const helper = loadHelper();

  assert.deepEqual(plain(helper.resolveDockedCompactGeometry({ left: 8, width: 264 })), {
    left: 8,
    width: 264,
  });
});

test('compact markup and layout expose only approved transport controls and reserve docked tree space', () => {
  const template = fs.readFileSync(templatePath, 'utf8');
  const compact = template.match(/<div class="compact-player-shell"[\s\S]*?<\/div>\s*<\/div>/)?.[0] || '';
  const css = fs.readFileSync(stylePath, 'utf8');
  const appChromeCss = fs.readFileSync(appChromeStylePath, 'utf8');
  const controller = fs.readFileSync(controllerPath, 'utf8');
  for (const name of ['Open album details', 'Previous track', 'Play', 'Next track']) {
    assert.match(compact, new RegExp(`aria-label="${name}"`));
  }
  for (const attribute of ['data-compact-player-previous', 'data-compact-player-next']) {
    const skipButton = compact.match(new RegExp(`<button[^>]+${attribute}[^>]*>[\\s\\S]*?<\\/button>`))?.[0] || '';
    assert.match(skipButton, /<svg[^>]+aria-hidden="true"/);
    assert.equal((skipButton.match(/<path /g) || []).length, 2);
    assert.doesNotMatch(skipButton, /[◀▶]/);
  }
  assert.equal((template.match(/data-player-toggle/g) || []).length, 1);
  assert.doesNotMatch(template, /data-player-(?:collapse|expand)/);
  assert.match(template, /data-player-toggle[^>]+aria-label="Collapse player"/);
  for (const hiddenFeature of ['waveform', 'seekbar', 'Loop', 'player-title', 'player-artist']) {
    assert.doesNotMatch(compact, new RegExp(hiddenFeature, 'i'));
  }
  assert.match(css, /:root\.has-docked-compact-player #shell-navigation-rail\s*\{[^}]*height:\s*calc\(100% - 76px\)/);
  assert.match(css, /:root\.has-floating-compact-player #shell-navigation-rail\s*\{[^}]*height:\s*100%/);
  assert.doesNotMatch(css, /:root\.has-docked-compact-player #shell-navigation-rail\s*\{[^}]*padding-bottom:\s*88px/);
  assert.match(appChromeCss, /\.shell-layout\s*\{[^}]*height:\s*calc\(100dvh - var\(--player-height\)\)/);
  assert.match(css, /:root\.has-compact-player\s*\{\s*--player-height:\s*0px/);
  assert.match(css, /width:\s*var\(--compact-docked-width/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /@property --player-height/);
  assert.match(css, /\.is-compact-player-dragging\s*\{[^}]*transition:[^}]*height[^}]*opacity/);
  assert.match(controller, /previousStyle !== 'floating'/);
  assert.match(controller, /toggle\.setAttribute\('aria-label', compact \? 'Expand player' : 'Collapse player'\)/);
  assert.match(controller, /getElementById\('shell-navigation-rail'\)/);
  assert.match(controller, /addEventListener\('pointercancel', finishDrag\)/);
  assert.match(controller, /hasPointerCapture\?\./);
  assert.match(controller, /compactPlayerDrag = null/);
});
