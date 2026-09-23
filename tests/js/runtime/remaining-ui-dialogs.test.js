const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../../..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('remaining UI confirmations stay compact and Appearance offers explicit safe and destructive actions', () => {
  const css = read('music_app/static/css/runtime/utilities.css');
  const markup = read('music_app/templates/partials/confirm-modals.html');
  const bridge = read('music_app/static/js/runtime/appearance-backgrounds-bridge.js');

  assert.match(css, /\.confirm-modal-dialog\s*\{[^}]*width:\s*min\(440px,\s*calc\(100vw - 32px\)\)[^}]*padding:\s*20px/s);
  assert.doesNotMatch(css, /\.confirm-modal-(?:title|text|actions)\s*\{[^}]*(?:border-top|border-bottom)/s);
  assert.match(markup, /id="app-confirm-modal"[^]*role="dialog"[^]*aria-modal="true"/);
  assert.match(bridge, /cancelLabel:\s*'Keep editing'/);
  assert.match(bridge, /acceptLabel:\s*'Discard changes'/);
  assert.match(bridge, /danger:\s*true/);
});

test('alerts wrap adjacent actions and lightbox closure restores focus without closing its parent', () => {
  const alertCss = read('music_app/static/css/runtime/alert-components.css');
  const lightbox = read('music_app/static/js/runtime/track-modal-lightbox-helpers.js');

  assert.match(alertCss, /\.on-page-alert__actions\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*wrap/s);
  assert.match(lightbox, /let imageLightboxReturnFocus = null/);
  const closeLightbox = lightbox.match(/function closeImageLightbox\(\)[^]*?\n\}/)?.[0] || '';
  assert.match(closeLightbox, /const returnFocus = imageLightboxReturnFocus[^]*if \(returnFocus\?\.isConnected\) returnFocus\.focus\?\.\(\)/);
  assert.doesNotMatch(closeLightbox, /closeCoverLookupModal\s*\(/);
});

test('Cover Look Up puts its full-search action and description in the footer', () => {
  const markup = read('music_app/templates/partials/primary-modals.html');
  const modalStart = markup.indexOf('<div class="cover-lookup-modal"');
  const modal = markup.slice(modalStart, markup.indexOf('<div class="non-album-modal"', modalStart));
  const footerStart = modal.indexOf('cover-lookup-modal-actions');
  const footer = modal.slice(footerStart);

  assert.ok(modal.indexOf('cover-lookup-search-action') > footerStart);
  assert.ok(footerStart > modal.indexOf('cover-lookup-modal-body'));
  assert.equal((modal.match(/id="cover-lookup-find-better-button"/g) || []).length, 1);
  assert.doesNotMatch(modal.slice(0, footerStart), /Find Better Art|cover-lookup-search-action/);
  assert.doesNotMatch(modal, /Find better cover art|Search for higher-quality artwork/);
  assert.match(footer, /aria-describedby="cover-lookup-search-hint"/);
  assert.match(footer, /id="cover-lookup-search-hint">Runs a full cover art search/);
});

test('Album Details supplies mock-approved cover actions to AlbumArtbox', () => {
  const renderer = read('music_app/static/js/runtime/tag-editor-and-optimistic-updates.js');
  const css = read('music_app/static/css/runtime/track-modal-and-lightbox.css');

  assert.match(
    renderer,
    /ButtonComponent\.renderActionButton\(\{[\s\S]*icon: 'search'[\s\S]*data-open-track-modal-cover-lookup[\s\S]*ButtonComponent\.renderActionButton\(\{[\s\S]*icon: 'bolt'[\s\S]*data-track-modal-fast-cover-fetch[\s\S]*renderAlbumArtbox\(\{[\s\S]*overlayHtml: coverToolsHtml/,
  );
  assert.match(css, /\.track-modal-body\s*\{[^}]*grid-template-columns:\s*minmax\(228px,\s*288px\) minmax\(0,\s*1fr\)/s);
  assert.match(css, /\.track-modal-dialog:has\([^}]*editorial_canvas[^}]*\)\s*\{[^}]*grid-template-columns:\s*minmax\(228px,\s*288px\) minmax\(0,\s*1fr\)/s);
  assert.match(css, /\.track-modal-cover-shell\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)[^}]*position:\s*relative/s);
  assert.doesNotMatch(css, /\.track-modal-cover-shell\s*\{[^}]*38px/s);
  assert.match(css, /@media \(min-width:\s*721px\)[\s\S]*\.track-modal-cover-shell\s*\{[^}]*width:\s*auto[^}]*height:\s*min\(100%,\s*100cqw\)[^}]*aspect-ratio:\s*1/s);
  assert.doesNotMatch(css, /@media \(min-width:\s*721px\)[\s\S]*\.track-modal-cover-shell\s*\{[^}]*height:\s*100%/s);
  assert.doesNotMatch(renderer, /<div class="track-modal-cover-tools">/);
});

test('failed notification retry and clear remain separate actions that do not activate the card', () => {
  const drawer = read('music_app/static/js/runtime/cover-lookup-modal-and-drawer.js');
  const handlers = read('music_app/static/js/runtime/bootstrap-utility-event-handlers.js');

  assert.match(drawer, /status === 'failed'[^]*data-retry-cover-lookup-task/);
  assert.match(drawer, /data-clear-cover-lookup-task/);
  const retryHandler = handlers.match(/const retryCoverLookupTaskButton[^]*?\n\s*}\n\n/)?.[0] || '';
  assert.match(retryHandler, /event\.stopPropagation\(\)/);
  assert.match(retryHandler, /startCoverLookupForAlbum\(task\.album_payload, \{ backgroundOnly: true \}\)/);
});

test('cover lookup notifications use navigation cards, state labels, and shared compact actions', () => {
  const markup = read('music_app/templates/index.html');
  const drawer = read('music_app/static/js/runtime/cover-lookup-modal-and-drawer.js');
  const css = read('music_app/static/css/runtime/cover-lookup-drawer-and-related.css');

 const clear = markup.match(/{% call action_button\('Clear completed cover art lookups'[^]*?{% endcall %}/)?.[0] || '';
 const close = markup.match(/{% call action_button\('Close cover art lookups'[^]*?{% endcall %}/)?.[0] || '';
 assert.match(clear, /class_name='cover-lookup-drawer-clear'/);
 assert.match(clear, /id='cover-lookup-drawer-clear'/);
 assert.match(clear, /disabled=true/);
  assert.match(clear, /clear-notifications-icon-offwhite\.png/);
  assert.match(clear, /clear-notifications-icon\.png/);
 assert.match(close, /class_name='cover-lookup-drawer-close'/);
 assert.match(close, /action-button__icon/);
 assert.match(close, /m5 5 10 10M15 5 5 15/);
  assert.doesNotMatch(clear, /<span>Clear finished<\/span>/);
 assert.ok(markup.indexOf("id='cover-lookup-drawer-clear'") < markup.indexOf('data-close-cover-lookup-drawer'));
  assert.match(drawer, /cover-lookup-task-card navigation-tree-item/);
  assert.match(drawer, /taskStateClass = status === 'failed'[^]*'is-failed'[^]*'is-running'[^]*'is-completed'/s);
  assert.match(drawer, /cover-lookup-task-status-label \$\{taskStateClass\}/);
  assert.match(drawer, /ui-button--icon[^>]*cover-lookup-task-retry[^>]*aria-label="Retry lookup"[^]*?<svg/);
  assert.doesNotMatch(drawer, /data-retry-cover-lookup-task="[^]*>Retry<\/button>/);
  assert.match(drawer, /ButtonComponent\.renderActionButton\(\{\s*icon: 'delete',\s*semantic: 'destructive',[^]*?className: 'cover-lookup-task-clear',[^]*?'data-clear-cover-lookup-task': task.id/);
  assert.doesNotMatch(css, /\.cover-lookup-task-clear(?::hover)?\s*\{/);
  assert.doesNotMatch(drawer, /cover-lookup-task-clear[^]*clear-notifications-icon/s);
  assert.doesNotMatch(css, /\.cover-lookup-task-card::before/);
  assert.match(css, /\.cover-lookup-drawer-button\.has-active-lookups\s*\{[^}]*border-color:\s*var\(--appearance-line,\s*var\(--border\)\)/s);
  assert.doesNotMatch(css, /\.cover-lookup-drawer-button\.has-active-lookups\s*\{[^}]*border-color:[^;}]*appearance-accent/s);
  assert.match(css, /\.cover-lookup-drawer-badge\s*\{[^}]*background:\s*var\(--appearance-info,\s*#64a8ff\)/s);
  assert.match(css, /\.cover-lookup-task-card:hover[^}]*background:\s*var\(--appearance-item-hover/s);
  assert.match(css, /\.cover-lookup-task-open:hover[^}]*background:\s*transparent/s);
  assert.match(css, /\.cover-lookup-task-card\.is-running[^]*\.cover-lookup-task-progress span[^}]*var\(--appearance-info/s);
  assert.match(css, /\.cover-lookup-task-card\.is-completed[^]*\.cover-lookup-task-progress span[^}]*var\(--appearance-success/s);
  assert.match(css, /\.cover-lookup-task-card\.is-failed[^]*\.cover-lookup-task-progress span[^}]*var\(--appearance-error/s);
});
