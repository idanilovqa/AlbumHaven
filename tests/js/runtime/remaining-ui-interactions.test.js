const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..', '..', '..');
const appearance = require(path.join(repoRoot, 'music_app', 'static', 'js', 'appearance-backgrounds.js'));

test('automatic action interactions derive restrained fill and edge from the effective player background', () => {
  const first = appearance.resolveActionInteractionTokens(
    { interaction_overrides: { button_hover_background: null, button_pressed: null } },
    { tokens: { control: '#303C36', player: '#112233', 'player-surface-start': '#112233' } },
  );
  const second = appearance.resolveActionInteractionTokens(
    { interaction_overrides: { button_hover_background: null, button_pressed: null } },
    { tokens: { control: '#303C36', player: '#5C183E', 'player-surface-start': '#5C183E' } },
  );

  assert.deepEqual(first, {
    hoverBackground: 'color-mix(in srgb, #112233 14%, color-mix(in srgb, #303C36 85%, #EEEEEE))',
    hoverBorder: 'color-mix(in srgb, #112233 22%, #858985)',
    pressedBackground: 'color-mix(in srgb, #303C36 75%, #000000)',
  });
  assert.notEqual(first.hoverBackground, second.hoverBackground);
  assert.notEqual(first.hoverBorder, second.hoverBorder);
});

test('explicit action fill and pressed choices remain authoritative while the semantic edge stays automatic', () => {
  const tokens = appearance.resolveActionInteractionTokens(
    { interaction_overrides: { button_hover_background: '#234567', button_pressed: '#123456' } },
    { tokens: { control: '#303C36', player: '#112233' } },
  );
  assert.equal(tokens.hoverBackground, '#234567');
  assert.equal(tokens.pressedBackground, '#123456');
  assert.equal(tokens.hoverBorder, 'color-mix(in srgb, #112233 22%, #858985)');
});

test('shared action CSS supports outlined and bare chrome without changing focus, destructive, or player controls', () => {
  const css = fs.readFileSync(path.join(repoRoot, 'music_app', 'static', 'css', 'button-component.css'), 'utf8');
  assert.match(css, /--appearance-item-action-hover-border/);
  assert.match(css, /data-action-button-outlines='off'/);
  assert.match(css, /action-button--bare/);
  assert.match(css, /:not\(\.trigger-anchor-open\)/);
  assert.match(css, /:not\(\.global-player \*\)/);
  assert.match(css, /\.action-button--destructive/);
  assert.match(css, /\.action-button:focus-visible\s*\{[^}]*outline-color:/s);
});

test('checked native controls use a subdued shared selection color and playback remains excluded', () => {
  const css = fs.readFileSync(path.join(repoRoot, 'music_app', 'static', 'css', 'appearance-backgrounds.css'), 'utf8');
  assert.match(css, /input\[type='checkbox'\][^}]*input\[type='radio'\][^}]*accent-color:\s*var\(--appearance-control-selected/s);
  assert.match(css, /--appearance-control-selected:\s*color-mix\(/);
  assert.match(css, /:not\(\.global-player \*\)/);
});

test('gallery header actions use semantic hover fill and edge while keyboard focus remains distinct', () => {
  const css = fs.readFileSync(path.join(repoRoot, 'music_app', 'static', 'css', 'gallery-main.css'), 'utf8');
  assert.match(css, /\.gallery-action-button:hover[^}]*background:\s*var\(--appearance-item-action-hover-background[^}]*border-color:\s*var\(--appearance-item-action-hover-border/s);
  assert.match(css, /\.gallery-view-cluster:hover[^}]*background:\s*var\(--appearance-item-action-hover-background[^}]*border-color:\s*var\(--appearance-item-action-hover-border[^}]*box-shadow:/s);
  assert.match(css, /:root \.gallery-bar__actions \.gallery-view-cluster > \.gallery-view-choice:is\(:hover, :focus-visible\)[^}]*color:\s*var\(--appearance-play, #4ade80\)/s);
  assert.match(css, /\.gallery-action-button:focus-visible[^}]*outline:\s*1px solid var\(--appearance-interaction-outline/s);
  assert.doesNotMatch(css, /\.gallery-action-button:hover,\s*\.gallery-action-button:focus-visible/);
});

test('shared search markup orders conditional Clear before stable Search and optional filters', () => {
  const template = fs.readFileSync(path.join(repoRoot, 'music_app', 'templates', 'partials', 'search-input.html'), 'utf8');
  const searchIndex = template.indexOf('data-search-submit');
  const callerIndex = template.indexOf("caller('search-field-button')");
  const clearIndex = template.indexOf('data-search-clear');

  assert.ok(searchIndex >= 0, 'the shared Search action is always rendered');
  assert.ok(callerIndex > searchIndex, 'contextual actions such as Filters follow Search');
  assert.ok(clearIndex >= 0 && clearIndex < searchIndex, 'conditional Clear precedes stable actions');
  assert.match(template, /data-search-clear[^>]*hidden/);
});

test('shared search behavior reveals Clear for content and returns focus after clearing', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'music_app', 'static', 'js', 'runtime', 'search-input.js'), 'utf8');
  assert.match(source, /data-search-clear/);
  assert.match(source, /input\.value\s*=\s*''/);
  assert.match(source, /input\.focus\(\)/);
  assert.match(source, /dispatchEvent\(new Event\('input'/);
});

test('shared search hides the native clear glyph and tag selects use a centered SVG chevron', () => {
  const searchCss = fs.readFileSync(path.join(repoRoot, 'music_app', 'static', 'css', 'search-input.css'), 'utf8');
  const utilityCss = fs.readFileSync(path.join(repoRoot, 'music_app', 'static', 'css', 'utilities.css'), 'utf8');
  assert.match(searchCss, /::-webkit-search-cancel-button\s*\{[^}]*display:\s*none/s);
  assert.match(utilityCss, /\.tag-editor-form select\s*\{[^}]*url\(["']data:image\/svg\+xml/s);
  assert.match(utilityCss, /background-position:\s*right\s+12px\s+center/);
});

test('noneditable UI suppresses the caret while real editors preserve it', () => {
  const css = fs.readFileSync(path.join(repoRoot, 'music_app', 'static', 'css', 'base.css'), 'utf8');
  assert.match(css, /body\s*\{[^}]*caret-color:\s*transparent/s);
  assert.match(css, /input,\s*textarea,\s*select,\s*\[contenteditable="true"\]\s*\{[^}]*caret-color:\s*auto/s);
});

test('utility searches keep shared actions mounted and synchronize Clear after tab rendering', () => {
  const utilityCss = fs.readFileSync(path.join(repoRoot, 'music_app', 'static', 'css', 'runtime', 'utilities.css'), 'utf8');
  const utilitySource = fs.readFileSync(path.join(repoRoot, 'music_app', 'static', 'js', 'runtime', 'utility-renderers-and-actions.js'), 'utf8');
  assert.doesNotMatch(utilityCss, /\.search-field-action:has\(> \.utility-problem-filter-button\[hidden\]\)[^{]*\{[^}]*display:\s*none/s);
  assert.match(utilitySource, /updateSearchClearAction\(els\.search\)/);
});
