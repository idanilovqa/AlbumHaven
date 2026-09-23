const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.join(__dirname, '..', '..', '..');
const sourcePath = path.join(repoRoot, 'music_app', 'static', 'js', 'runtime', 'cover-lookup-modal-and-drawer.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const css = fs.readFileSync(
  path.join(repoRoot, 'music_app', 'static', 'css', 'runtime', 'cover-lookup-modal.css'),
  'utf8',
);

function cssRule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 's'))?.[1] || '';
}

test('cover source entry is compact, supports picker and drop, and omits redundant helper copy', () => {
  assert.match(source, /data-cover-lookup-file-input/);
  assert.match(source, /accept="image\/\*"[^>]*multiple/);
  assert.match(source, /data-cover-lookup-drop-zone/);
  assert.match(source, /rows="1"/);
  assert.doesNotMatch(source, /Find Better Art will also use anything pasted here/);
});

test('cover picker can select the same file again after staged-file removal', () => {
  const handlers = fs.readFileSync(path.join(repoRoot, 'music_app', 'static', 'js', 'runtime', 'bootstrap-utility-event-handlers.js'), 'utf8');
  assert.match(handlers, /addCoverLookupFiles\(coverLookupFiles\.files \|\| \[\]\)[^]*\.finally\(\(\) => \{ coverLookupFiles\.value = ''; \}\)/);
});

test('manual search keeps opened images in the composer until extraction', () => {
  assert.match(source, />MANUAL SEARCH</);
  assert.match(source, /aria-label="Add image"/);
  assert.match(source, /data-cover-lookup-pending-attachment/);
  assert.match(source, /manualImageAttachments/);
  assert.doesNotMatch(source, />Choose images</);
  assert.match(source, /Extract images<\/button>/);
  assert.doesNotMatch(source, /state\.coverLookup\.modal\.pendingPastedImageId\s*=\s*nextItem\.id/);
});

test('manual search enables extraction for either links or image attachments', () => {
  assert.match(source, /function coverLookupHasManualInput/);
  assert.match(source, /manualImageAttachments[^]*manualUrlText/s);
});

test('linked remote selection cannot duplicate the active local selection', () => {
  assert.match(source, /data-cover-lookup-saved-remote[^]*activeLocalSelectionPath/s);
  assert.match(source, /kind === 'local'[^]*pendingPastedImageId/s);
});

test('clipboard images stage only when pasted into the manual composer', () => {
  const handlers = fs.readFileSync(
    path.join(repoRoot, 'music_app/static/js/runtime/bootstrap-utility-event-handlers.js'),
    'utf8',
  );
  assert.match(handlers, /handleUtilityBootstrapPaste[^]*data-cover-lookup-drop-zone/s);
});

test('cover source validation is bounded and removable previews revoke their object URLs', () => {
  assert.match(source, /MAX_COVER_LOOKUP_STAGED_IMAGES\s*=\s*8/);
  assert.match(source, /MAX_COVER_LOOKUP_IMAGE_BYTES\s*=\s*10 \* 1024 \* 1024/);
  assert.match(source, /function removePastedImageFromCoverLookup/);

  const revoked = [];
  const context = {
    state: { coverLookup: { modal: { pastedImages: [
      { id: 'first', object_url: 'blob:first' },
      { id: 'second', object_url: 'blob:second' },
    ], pendingPastedImageId: 'first' } } },
    URL: { revokeObjectURL: value => revoked.push(value) },
    console,
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: sourcePath });
  context.renderCoverLookupModal = () => {};
  context.removePastedImageFromCoverLookup('first');
  assert.deepEqual(revoked, ['blob:first']);
  assert.deepEqual(context.state.coverLookup.modal.pastedImages.map(item => item.id), ['second']);
  assert.equal(context.state.coverLookup.modal.pendingPastedImageId, '');
});

test('gallery sections expose live image counts and omit empty remote and match sections', () => {
  assert.match(source, /formatCoverLookupImageCount/);
  assert.match(source, /remoteCover\s*\?\s*`<section/);
  assert.match(source, /possibleMatches\.length\s*\|\|\s*taskRunning/);
  assert.doesNotMatch(source, /No remote cover is currently selected/);
  assert.doesNotMatch(source, /No remote matches yet/);
});

test('provider rows include readable labels, Deezer heart, CAA, and external markers', () => {
  for (const label of ['Apple', 'Spotify', 'Deezer', 'Bandcamp', 'Discogs', 'CAA', 'YouTube Music']) {
    assert.match(source, new RegExp(`['\"]${label}['\"]`));
  }
  assert.match(source, /buildDeezerGlyph[^]*heart/s);
  assert.match(source, /cover-lookup-external-marker/);
  assert.match(source, /String\(source \|\| ''\)\.trim\(\)\.toLowerCase\(\)/);
});

test('manual search uses approved Google and Yandex brand images on neutral controls', () => {
  assert.match(source, /<img class="cover-lookup-search-chip-logo" src="\/static\/images\/google\.ico" alt="">/);
  assert.match(source, /<img class="cover-lookup-search-chip-logo" src="\/static\/images\/yandex\.ico" alt="">/);
  assert.doesNotMatch(source, /cover-lookup-search-chip-logo">[GY]</);

  const chip = cssRule('.cover-lookup-search-chip');
  const hover = cssRule('.cover-lookup-search-chip:hover');
  assert.match(chip, /border:\s*1px solid var\(--appearance-line, var\(--border\)\)/);
  assert.match(chip, /background:\s*var\(--appearance-control, var\(--panel\)\)/);
  assert.match(chip, /color:\s*var\(--appearance-ink, var\(--text\)\)/);
  assert.match(hover, /border-color:\s*var\(--appearance-item-action-hover-border/);
  assert.match(hover, /background:\s*var\(--appearance-item-action-hover-background/);
});

test('manual composer expands as one surface with a borderless Add image action', () => {
  const composer = cssRule('.cover-lookup-manual-row');
  const content = cssRule('.cover-lookup-manual-content');
  const attachments = cssRule('.cover-lookup-manual-attachments');
  const hiddenAttachments = cssRule('.cover-lookup-manual-attachments[hidden]');
  const input = cssRule(':root #cover-lookup-pasted-urls');
  const openButton = cssRule('.cover-lookup-manual-open');
  const openButtonStates = cssRule('.cover-lookup-manual-open:hover:not(:disabled),\n.cover-lookup-manual-open:focus,\n.cover-lookup-manual-open:focus-visible,\n.cover-lookup-manual-open:active');
  const focus = cssRule('.cover-lookup-manual-row:has(.cover-lookup-manual-input:focus)');
  const innerFocus = cssRule(':root #cover-lookup-pasted-urls:focus');

  assert.match(source, /class="cover-lookup-manual-open"[^>]*>\s*<span[^>]*>\+<\/span>\s*<span>Add image<\/span>/);
  assert.match(source, /class="cover-lookup-manual-content">\s*<div class="cover-lookup-manual-attachments"[\s\S]*?<textarea class="cover-lookup-manual-input"/);
  assert.match(composer, /display:\s*flex/);
  assert.match(composer, /flex-direction:\s*column/);
  assert.match(content, /overflow-y:\s*auto/);
  assert.match(content, /max-height:\s*160px/);
  assert.match(hiddenAttachments, /display:\s*none/);
  assert.match(input, /min-height:\s*42px/);
  assert.match(input, /field-sizing:\s*content/);
  assert.match(input, /max-height:\s*none/);
  assert.match(input, /overflow:\s*hidden/);
  assert.match(input, /resize:\s*none/);
  assert.match(input, /border:\s*0\s*!important/);
  assert.match(input, /outline:\s*none\s*!important/);
  assert.match(openButton, /align-self:\s*flex-start/);
  assert.match(openButton, /border:\s*0/);
  assert.match(openButton, /background:\s*transparent/);
  assert.match(openButtonStates, /outline:\s*none\s*!important/);
  assert.match(openButtonStates, /box-shadow:\s*none\s*!important/);
  assert.match(focus, /border-color:\s*var\(--appearance-interaction-outline/);
  assert.match(innerFocus, /outline:\s*none\s*!important/);
  assert.match(innerFocus, /outline-offset:\s*0\s*!important/);
  assert.match(innerFocus, /border:\s*0\s*!important/);
  assert.match(innerFocus, /box-shadow:\s*none/);
});

test('Find Better Art remains a solid primary action with a theme glow on hover', () => {
  const button = cssRule('#cover-lookup-find-better-button');
  const hover = cssRule('#cover-lookup-find-better-button:hover:not(:disabled)');
  const pressed = cssRule('#cover-lookup-find-better-button:active:not(:disabled)');
  assert.match(button, /background:\s*color-mix\(in srgb, var\(--appearance-primary-button/);
  assert.match(button, /border-width:\s*2px/);
  assert.match(button, /font-weight:\s*800/);
  assert.match(hover, /background:\s*color-mix\(in srgb, var\(--appearance-primary-button/);
  assert.match(hover, /box-shadow:[^;]*var\(--appearance-interaction-outline/);
  assert.doesNotMatch(hover, /appearance-item-action-hover-background/);
  assert.doesNotMatch(hover, /\boutline\s*:/);
  assert.match(pressed, /transform:\s*translateY\(1px\)/);
});

test('failed lookup Retry uses the shared Button family', () => {
  assert.match(source, /class="button ui-button ui-button--secondary ui-button--small ui-button--icon cover-lookup-task-retry"/);
});
