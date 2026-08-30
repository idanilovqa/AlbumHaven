const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const runtimeCssRoot = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'music_app',
  'static',
  'css',
  'runtime',
);

function readCss(filename) {
  return fs.readFileSync(path.join(runtimeCssRoot, filename), 'utf8');
}

function zIndexFor(source, selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`${escapedSelector}\\s*\\{[^}]*z-index:\\s*(\\d+)`, 'm'));
  assert.ok(match, `Expected ${selector} to declare a numeric z-index.`);
  return Number(match[1]);
}

test('Problematic Files stacks above each modal that can launch it', () => {
  const utilitiesCss = readCss('utilities.css');
  const trackModalCss = readCss('track-modal-and-lightbox.css');
  const nonAlbumCss = readCss('non-album-and-player.css');
  const utilityZ = zIndexFor(utilitiesCss, '.utility-modal');

  assert.ok(
    utilityZ > zIndexFor(trackModalCss, '.track-modal'),
    'Problematic Files must remain above Album Details.',
  );
  assert.ok(
    utilityZ > zIndexFor(nonAlbumCss, '.non-album-modal'),
    'Problematic Files must remain above Loose Non-Album Tracks.',
  );
  assert.ok(
    zIndexFor(utilitiesCss, '.tag-editor-modal') > utilityZ,
    'Edit Tags launched from Problematic Files must remain above Utilities.',
  );
});

test('repair confirmation launched from Utilities has its own foreground stacking contract', () => {
  const utilitiesCss = readCss('utilities.css');

  assert.ok(
    zIndexFor(utilitiesCss, '#repair-confirm-modal') > zIndexFor(utilitiesCss, '.utility-modal'),
    'Repair confirmation must remain clickable above the utility modal that launches it.',
  );
});

test('loop naming launched from Utilities stays above its owning modal', () => {
  const utilitiesCss = readCss('utilities.css');

  assert.ok(
    zIndexFor(utilitiesCss, '#loop-name-modal') > zIndexFor(utilitiesCss, '.utility-modal'),
    'Loop naming must remain clickable above the utility modal that launches it.',
  );
});
