const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const stylesheet = fs.readFileSync(path.join(
  __dirname,
  '..',
  '..',
  'music_app',
  'static',
  'css',
  'runtime',
  'track-modal-and-lightbox.css',
), 'utf8');
const overlayShell = fs.readFileSync(path.join(
  __dirname,
  '..',
  '..',
  'music_app',
  'templates',
  'partials',
  'overlay-shells.html',
), 'utf8');

function readRule(selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = stylesheet.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `Expected ${selector} in the production lightbox stylesheet.`);
  return match[1];
}

test('fullscreen close control stays above the transformed zoom image', () => {
  const imageRule = readRule('.image-lightbox-image');
  const closeRule = readRule('.image-lightbox-close');

  assert.match(imageRule, /will-change:\s*transform\s*;/);
  assert.match(closeRule, /position:\s*absolute\s*;/);
  assert.match(closeRule, /z-index:\s*3\s*;/);
});

test('fullscreen cover uses an accessible loading status without exposing a pending image', () => {
  const loadingRule = readRule('.image-lightbox-loading');
  const spinnerRule = readRule('.image-lightbox-loading-spinner');

  assert.match(overlayShell, /id="image-lightbox-loading"[^>]*role="status"[^>]*aria-label="Loading full-size album cover"[^>]*hidden/);
  assert.match(overlayShell, /id="image-lightbox-image"[^>]*alt=""[^>]*aria-hidden="true"[^>]*hidden/);
  assert.match(loadingRule, /place-items:\s*center\s*;/);
  assert.match(spinnerRule, /animation:\s*image-lightbox-spin/);
  assert.match(stylesheet, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*\.image-lightbox-loading-spinner\s*\{[\s\S]*animation:\s*none\s*;/);
  assert.match(stylesheet, /\.image-lightbox-image\[hidden\]\s*\{\s*display:\s*none\s*;/);
});
