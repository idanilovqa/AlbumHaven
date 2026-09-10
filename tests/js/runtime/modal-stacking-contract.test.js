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

test('Album Details covers the app bar without overtaking Utilities', () => {
  const utilitiesCss = readCss('utilities.css');
  const trackModalCss = readCss('track-modal-and-lightbox.css');
  const appChromeCss = fs.readFileSync(path.join(runtimeCssRoot, '..', 'app-chrome.css'), 'utf8');
  const trackZ = zIndexFor(trackModalCss, '.track-modal');

  assert.ok(trackZ > zIndexFor(appChromeCss, '.app-bar'), 'Album Details must cover the shell app bar.');
  assert.ok(trackZ < zIndexFor(utilitiesCss, '.utility-modal'), 'Utilities must remain above Album Details.');
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

test('missing album badge stays in the cover bottom-right and respects reduced motion', () => {
  const nonAlbumCss = readCss('non-album-and-player.css');
  const badgeRule = nonAlbumCss.match(/\.album-missing-badge\s*\{([^}]*)\}/m)?.[1] || '';
  const expandedRule = nonAlbumCss.match(
    /\.album-missing-badge:(?:hover|focus-visible)[^{]*\{([^}]*)\}/m,
  )?.[1] || '';

  assert.match(badgeRule, /position\s*:\s*absolute\s*;/);
  assert.match(badgeRule, /right\s*:\s*[^;]+;/);
  assert.match(badgeRule, /bottom\s*:\s*[^;]+;/);
  assert.match(badgeRule, /transition\s*:/, 'pointer and keyboard expansion must animate');
  assert.match(expandedRule, /(?:width|max-width|grid-template-columns)\s*:/);
  assert.match(
    nonAlbumCss,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)[^]*\.album-missing-badge[^}]*transition\s*:\s*none\s*;/m,
  );
});
