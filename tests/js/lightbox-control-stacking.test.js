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

test('fullscreen artwork controls suppress resting outlines but retain keyboard focus', () => {
  const closeRule = readRule('.image-lightbox-close');
  const navRule = readRule('.image-lightbox-nav');

  assert.match(closeRule, /outline:\s*none\s*!important\s*;/);
  assert.match(navRule, /outline:\s*none\s*!important\s*;/);
  assert.match(
    stylesheet,
    /\.image-lightbox-close:focus-visible,\s*\.image-lightbox-nav:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--lightbox-control-accent\)\s*!important\s*;[^}]*outline-offset:\s*2px\s*!important\s*;/s,
  );
});

test('fullscreen cover retry stays above the image and inside the viewport', () => {
  const retryRule = readRule('.image-lightbox-retry');
  assert.match(overlayShell, /id="image-lightbox-retry"[^>]*type="button"[^>]*hidden>Retry full-size cover<\/button>/);
  assert.match(retryRule, /position:\s*absolute\s*;/);
  assert.match(retryRule, /left:\s*50%\s*;/);
  assert.match(retryRule, /bottom:\s*max\(16px,\s*env\(safe-area-inset-bottom\)\)\s*;/);
  assert.match(retryRule, /transform:\s*translateX\(-50%\)\s*;/);
  assert.match(retryRule, /max-width:\s*calc\(100vw\s*-\s*40px\)\s*;/);
  assert.match(retryRule, /z-index:\s*3\s*;/);
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

test('fullscreen cover navigation uses centered SVG chevrons instead of baseline glyphs', () => {
  const navRule = readRule('.image-lightbox-nav');
  const iconRule = readRule('.image-lightbox-nav svg');

  assert.match(overlayShell, /id="image-lightbox-prev"[^>]*>\s*<svg[^>]*viewBox="0 0 24 24"[^>]*aria-hidden="true"[^>]*>\s*<path[^>]*d="M15 18l-6-6 6-6"/);
  assert.match(overlayShell, /id="image-lightbox-next"[^>]*>\s*<svg[^>]*viewBox="0 0 24 24"[^>]*aria-hidden="true"[^>]*>\s*<path[^>]*d="M9 6l6 6-6 6"/);
  assert.doesNotMatch(overlayShell, /id="image-lightbox-(?:prev|next)"[^>]*>[‹›]/);
  assert.match(navRule, /align-items:\s*center\s*;/);
  assert.match(navRule, /justify-content:\s*center\s*;/);
  assert.match(iconRule, /display:\s*block\s*;/);
  assert.match(iconRule, /width:\s*24px\s*;/);
  assert.match(iconRule, /height:\s*24px\s*;/);
});

test('fullscreen controls keep light ink on the dark overlay in every theme', () => {
  const overlayRule = readRule('.image-lightbox');
  const closeRule = readRule('.image-lightbox-close');
  const navRule = readRule('.image-lightbox-nav');

  assert.match(overlayRule, /--lightbox-control-ink:\s*#f8fafc\s*;/);
  assert.match(closeRule, /color:\s*var\(--lightbox-control-ink\)\s*;/);
  assert.match(navRule, /color:\s*var\(--lightbox-control-ink\)\s*;/);
});
