const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../../..');
const template = fs.readFileSync(path.join(root, 'music_app/templates/index.html'), 'utf8');
const runtime = fs.readFileSync(path.join(root, 'music_app/static/js/runtime/core-state-and-helpers.js'), 'utf8');
const galleryCss = fs.readFileSync(path.join(root, 'music_app/static/css/gallery-main.css'), 'utf8');
const scanCss = fs.readFileSync(path.join(root, 'music_app/static/css/runtime/cover-lookup-drawer-and-related.css'), 'utf8');

test('Library Status Page mounts a shared GalleryBar only while its FullPage body is active', () => {
  assert.match(template, /class="gallery-bar"[^>]*data-gallery-bar-instance="gallery"/);
  assert.doesNotMatch(template, /data-gallery-bar-instance="library-(?:scan|status)"/);
  assert.match(template, /id="library-loader"[^>]*data-full-page="library-status"/);
  assert.match(runtime, /data-close-scan-page="1"[^]*Library Status Page/);
  assert.doesNotMatch(template, /library-scan[^]*(?:state preview|simulation)/i);
});

test('status GalleryBar owns live status and real actions while the body owns phase content', () => {
  const bar = runtime.match(/function buildLibraryStatusBarHtml\(\)[^]*?^}/m)?.[0] || '';
  const body = template.match(/<section class="library-loader full-page"[^]*?<\/section>/)?.[0] || '';
  assert.match(bar, /id="library-scan-gallery-summary"/);
  assert.match(bar, /data-browse-scanned-library="1"/);
  assert.match(bar, /data-cancel-library-scan="1"/);
  assert.match(body, /Discover files/);
  assert.match(body, /Read tags &amp; metadata/);
  assert.match(body, /Update cover art/);
  assert.match(body, /Refresh artist relations/);
});

test('rendering detaches and restores the GalleryBar instance and uses truthful stages', () => {
  assert.match(runtime, /function mountLibraryStatusBar\(/);
  assert.match(runtime, /galleryBar\.remove\(\)/);
  assert.match(runtime, /function unmountLibraryStatusBar\(/);
  assert.match(runtime, /insertBefore\(detachedGalleryBar, anchor\)/);
  assert.match(runtime, /\? 'Scanning the library'/);
  assert.match(runtime, /const stages = \['discover', 'metadata', 'covers', 'relations'\]/);
  assert.match(runtime, /item\.classList\.toggle\('is-current'/);
  assert.match(runtime, /item\.classList\.toggle\('is-complete'/);
  assert.match(runtime, /item\.classList\.toggle\('is-future'/);
});

test('inactive GalleryBar instances remain hidden', () => {
  assert.match(galleryCss, /\.gallery-bar\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
});
test('status back control is quiet at rest and uses theme hover styling beside centered title text', () => {
  assert.match(runtime, /id="library-loader-back-button"[^]*class="library-scan-gallery-copy"[^]*Library Status Page[^]*id="library-scan-gallery-summary"/);
  assert.match(scanCss, /\.gallery-bar--scan \.gallery-bar__context\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*gap:\s*14px;/s);
  assert.match(scanCss, /\.gallery-bar--scan \.library-loader-back-icon\s*\{[^}]*border:\s*1px solid transparent;[^}]*background:\s*transparent;/s);
  assert.match(scanCss, /\.gallery-bar--scan \.library-loader-back-button:hover \.library-loader-back-icon\s*\{[^}]*border-color:\s*var\(--appearance-item-action-hover-border,[^}]*background:\s*var\(--appearance-item-action-hover-background,/s);
  assert.match(scanCss, /\.library-loader-back-button:focus-visible\s*\{[^}]*outline:\s*1px solid var\(--appearance-interaction-outline,/s);
});
