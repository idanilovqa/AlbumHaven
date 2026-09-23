const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const css = fs.readFileSync(
  path.join(__dirname, '../../../music_app/static/css/appearance-backgrounds.css'),
  'utf8',
);
const buttonCss = fs.readFileSync(
  path.join(__dirname, '../../../music_app/static/css/button-component.css'),
  'utf8',
);
const albumTrackTableCss = fs.readFileSync(
  path.join(__dirname, '../../../music_app/static/css/runtime/album-track-table.css'),
  'utf8',
);
const compactDataTableCss = fs.readFileSync(
  path.join(__dirname, '../../../music_app/static/css/runtime/compact-data-table.css'),
  'utf8',
);

test('light themes keep all Album Details surfaces on light content colors', () => {
  const darkChromeRule = css.match(
    /:root\[data-appearance-palette='parchment-pine'\] :is\(([\s\S]*?)\)\s*\{[\s\S]*?--appearance-panel-ink/,
  );
  assert.ok(darkChromeRule);
  assert.doesNotMatch(darkChromeRule[1], /\.track-modal-dialog/);
  assert.match(
    css,
    /:root\[data-appearance-mode='light'\] \.track-modal-dialog\s*\{[^}]*--panel:\s*var\(--appearance-card\);[^}]*--text:\s*var\(--appearance-ink\);[^}]*background:\s*var\(--appearance-card\);[^}]*color:\s*var\(--appearance-ink\);/s,
  );
  assert.match(
    css,
    /:root\[data-appearance-mode='light'\] \.track-modal-dialog :is\(\.track-modal-header, \.track-modal-body\)\s*\{[^}]*background:\s*var\(--appearance-card\);/s,
  );
});

test('framed tables use a contrasting shade derived from the active theme', () => {
  assert.match(
    css,
    /--appearance-table-surface:\s*color-mix\(\s*in srgb,\s*var\(--appearance-card,[^;]+94%,\s*var\(--appearance-ink,/s,
  );
  for (const frame of ['outline', 'inset']) {
    assert.match(
      compactDataTableCss,
      new RegExp(`\\.compact-data-table\\[data-cdt-frame="${frame}"\\]\\s*\\{[^}]*background:\\s*var\\(--appearance-table-surface,`, 's'),
    );
  }
  assert.match(
    albumTrackTableCss,
    /\.album-track-table \.compact-data-table\s*\{[^}]*background:\s*var\(--appearance-table-surface,/s,
  );
});

test('light themes keep Edit Tags surfaces and fields on light content colors', () => {
  const darkChromeRule = css.match(
    /:root\[data-appearance-palette='parchment-pine'\] :is\(([\s\S]*?)\)\s*\{[\s\S]*?--appearance-panel-ink/,
  );
  assert.ok(darkChromeRule);
  assert.doesNotMatch(darkChromeRule[1], /\.tag-editor-dialog/);
  assert.match(
    css,
    /:root\[data-appearance-mode='light'\] \.tag-editor-dialog\s*\{[^}]*--panel:\s*var\(--appearance-card\);[^}]*--text:\s*var\(--appearance-ink\);[^}]*background:\s*var\(--appearance-card\);[^}]*color:\s*var\(--appearance-ink\);/s,
  );
  assert.match(
    css,
    /\.tag-editor-dialog :is\([^}]*\.tag-editor-header[^}]*\.tag-editor-form[^}]*\.editor-footer[^}]*\)\s*\{[^}]*background:\s*var\(--appearance-card\);/s,
  );
  assert.match(
    css,
    /\.tag-editor-dialog \.tag-editor-form :is\(input, select\)\s*\{[^}]*background:\s*var\(--appearance-control\);[^}]*color:\s*var\(--appearance-ink\);[^}]*border-color:\s*var\(--appearance-line\);/s,
  );
});

test('neutral shared buttons match the light content surface beneath them', () => {
  assert.match(
    buttonCss,
    /\.ui-button--secondary\s*\{[^}]*background:\s*var\(--appearance-neutral-button-background,\s*var\(--appearance-control,/s,
  );
  assert.match(
    buttonCss,
    /\.action-button\s*\{[^}]*background:\s*var\(--appearance-neutral-button-background,\s*var\(--appearance-control,/s,
  );
  assert.match(
    css,
    /:root\[data-appearance-mode='light'\] :is\(\.shell-main-surface, \.settings-main\)\s*\{[^}]*--appearance-neutral-button-background:\s*var\(--appearance-main-surface\);/s,
  );
  for (const selector of ['track-modal-dialog', 'tag-editor-dialog']) {
    assert.match(
      css,
      new RegExp(`:root\\[data-appearance-mode='light'\\] \\.${selector}\\s*\\{[^}]*--appearance-neutral-button-background:\\s*var\\(--appearance-card\\);`, 's'),
    );
  }
  assert.match(
    css,
    /:root\[data-appearance-mode='light'\] \.artist-info-overlay\s*\{[^}]*--appearance-neutral-button-background:\s*var\(--appearance-card\);/s,
  );
});
