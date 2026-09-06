const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..', '..');
const appearanceCss = fs.readFileSync(path.join(root, 'music_app', 'static', 'css', 'appearance-backgrounds.css'), 'utf8');
const appearanceSource = fs.readFileSync(path.join(root, 'music_app', 'static', 'js', 'appearance-backgrounds.js'), 'utf8');
const playerCss = fs.readFileSync(path.join(root, 'music_app', 'static', 'css', 'runtime', 'non-album-and-player.css'), 'utf8');
const playerSource = fs.readFileSync(path.join(root, 'music_app', 'static', 'js', 'runtime', 'player-and-waveform.js'), 'utf8');
const playerTemplate = fs.readFileSync(path.join(root, 'music_app', 'templates', 'index.html'), 'utf8');
const appearance = require(path.join(root, 'music_app', 'static', 'js', 'appearance-backgrounds.js'));

function cssRule(css, selectorPattern) {
  return css.match(new RegExp(`${selectorPattern}\\s*\\{([^}]*)\\}`, 's'))?.[1] || '';
}

function styleTarget() {
  const values = new Map();
  const attributes = new Map();
  return {
    values,
    element: {
      style: {
        setProperty(name, value) { values.set(name, value); },
        removeProperty(name) { values.delete(name); },
      },
      setAttribute(name, value) { attributes.set(name, value); },
      removeAttribute(name) { attributes.delete(name); },
    },
  };
}

test('Appearance leaves the real stereo waveform and loop-selection geometry unchanged', () => {
  assert.match(playerSource, /state\.player\.loopActive \|\| state\.player\.appearance\.seekbarMode === 'waveform'/);
  assert.match(playerSource, /const topMid = height \* 0\.24;/);
  assert.match(playerSource, /const bottomMid = height \* 0\.76;/);
  assert.match(playerSource, /const halfBand = Math\.max\(3, height \* 0\.18\);/);
  assert.match(playerSource, /drawChannel\(peaksLeft, topMid, 0\.42\);\s*drawChannel\(peaksRight, bottomMid, 0\.42\);/s);
  assert.match(playerSource, /drawChannel\(peaksLeft, topMid, 0\.82\);\s*drawChannel\(peaksRight, bottomMid, 0\.82\);/s);

  assert.match(
    playerTemplate,
    /<div class="player-timeline-wrap"[^>]*>\s*<canvas[^>]*player-waveform-canvas[^>]*><\/canvas>\s*<input[^>]*player-timeline[^>]*>\s*<div class="loop-range-surface"[^>]*>\s*<div class="player-loop-region loop-range-selection"[^>]*><\/div>\s*<button[^>]*loop-range-handle is-start[^>]*><\/button>\s*<button[^>]*loop-range-handle is-end[^>]*><\/button>/s,
  );
  assert.match(cssRule(playerCss, '\\.loop-range-selection'), /left:\s*var\(--loop-range-start,\s*0%\)/);
  assert.match(cssRule(playerCss, '\\.loop-range-selection'), /right:\s*calc\(100%\s*-\s*var\(--loop-range-end,\s*100%\)\)/);
  assert.match(
    cssRule(playerCss, '\\.player-timeline-wrap\\s*>\\s*\\.loop-range-surface'),
    /height:\s*56px/,
  );
  assert.match(
    cssRule(playerCss, '\\.player-timeline-wrap\\s*>\\s*\\.loop-range-surface\\s+\\.loop-range-selection'),
    /inset-block:\s*-3px/,
  );
});

test('Default seekbar keeps player-wide controls and removes unavailable waveform controls', () => {
  const markup = appearance.seekbarMarkup('default');

  for (const visible of ['Player themes', 'Recent sets', 'Surface', 'Controls', 'Seekbar style', 'Compact player']) {
    assert.match(markup, new RegExp(visible));
  }
  assert.match(markup, /<input(?=[^>]*data-appearance-seekbar-mode="default")(?=[^>]*checked)[^>]*>/);
  assert.match(markup, /class="player-preview-seekbar"/);
  assert.doesNotMatch(markup, /class="player-preview-waveform"/);
  assert.doesNotMatch(markup, /data-player-tab="waveform"|data-player-tab="handles"/);
  assert.doesNotMatch(markup, /data-player-panel="waveform"|data-player-panel="handles"/);
  assert.doesNotMatch(markup, /data-waveform-recents|data-waveform-restore|data-player-style-color="handles\.color"/);
});

test('Waveform seekbar reveals its stereo preview and complete waveform controls', () => {
  const markup = appearance.seekbarMarkup('waveform');

  assert.match(markup, /<input(?=[^>]*data-appearance-seekbar-mode="waveform")(?=[^>]*checked)[^>]*>/);
  assert.match(markup, /class="player-preview-waveform"/);
  assert.doesNotMatch(markup, /class="player-preview-seekbar"/);
  assert.match(markup, /data-player-tab="waveform"/);
  assert.match(markup, /data-player-tab="handles"/);
  assert.match(markup, /data-player-panel="waveform"/);
  assert.match(markup, /data-player-panel="handles"/);
  assert.match(markup, /data-waveform-recents="fill"/);
  assert.match(markup, /data-waveform-recents="edge"/);
  assert.match(markup, /data-waveform-restore/);
});

test('Player & Seekbar starts with a real-player stereo preview and has no fake loop selection', () => {
  const previewPosition = appearanceSource.indexOf('data-player-live-preview');
  const tabsPosition = appearanceSource.indexOf('class="appearance-player-tabs"');
  assert.ok(previewPosition >= 0 && previewPosition < tabsPosition, 'the real-player preview belongs above the settings tabs');
  assert.match(appearanceSource, /class="player-preview-channel is-left"/);
  assert.match(appearanceSource, /class="player-preview-channel is-right"/);
  assert.match(appearanceSource, /data-player-preview-cover/);
  assert.match(appearanceSource, /data-player-preview-title/);
  assert.match(appearanceSource, /data-player-preview-time/);
  assert.doesNotMatch(appearanceSource, /waveform-color-preview/);
  const previewMarkup = appearanceSource.slice(previewPosition, tabsPosition);
  assert.doesNotMatch(previewMarkup, /loop-range-selection|loop-range-handle/);
});

test('Player & Seekbar uses the approved editor and history workspace', () => {
  assert.match(
    appearanceSource,
    /class="player-editor-workspace"[\s\S]*class="player-editor-controls"[\s\S]*class="player-set-history"/,
    'the tabbed editor and applied-set history must share one workspace',
  );
  const waveformPanel = appearanceSource.slice(
    appearanceSource.indexOf('data-player-panel="waveform"'),
    appearanceSource.indexOf('data-player-panel="handles"'),
  );
  assert.match(waveformPanel, /class="waveform-color-fields"/);
  assert.match(waveformPanel, /data-waveform-recents="\$\{field\}"/);
  assert.match(waveformPanel, /data-waveform-recents-help/);
  assert.match(appearanceCss, /\.player-editor-workspace\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*3fr\)\s+minmax\(260px,\s*2fr\)/s);
});

test('Player & Seekbar preserves independent player and waveform tabs when the utility shell remounts the editor', () => {
  const installBrowser = appearanceSource.slice(
    appearanceSource.indexOf('function installBrowser('),
  );
  const mountSeekbar = installBrowser.slice(
    installBrowser.indexOf('const mountSeekbar'),
    installBrowser.indexOf('return { controller, mount, mountSeekbar'),
  );

  assert.match(installBrowser, /let activePlayerTab = 'surface', activeWaveformTab = 'waveform';/);
  assert.doesNotMatch(mountSeekbar, /let activePlayerTab = 'surface'|let activeWaveformTab = 'waveform'/);
  assert.match(
    mountSeekbar,
    /\[data-player-tab-group="player"\]\[data-player-tab="\$\{activePlayerTab\}"\]/,
  );
  assert.match(
    mountSeekbar,
    /\[data-player-tab-group="waveform"\]\[data-player-tab="\$\{activeWaveformTab\}"\]/,
  );
  assert.match(
    mountSeekbar,
    /\[data-player-panel-group="player"\]\[data-player-panel\]/,
  );
  assert.match(
    mountSeekbar,
    /\[data-player-panel-group="waveform"\]\[data-player-panel\]/,
  );
});

test('Appearance settings are owned by the approved navigation pages', () => {
  const mainMarkup = appearanceSource.slice(
    appearanceSource.indexOf('function editorMarkup()'),
    appearanceSource.indexOf('function seekbarMarkup('),
  );
  const playerMarkup = appearanceSource.slice(
    appearanceSource.indexOf('function seekbarMarkup('),
    appearanceSource.indexOf('function selectionAccentMarkup()'),
  );
  const selectionMarkup = appearanceSource.slice(
    appearanceSource.indexOf('function selectionAccentMarkup()'),
    appearanceSource.indexOf('function installBrowser('),
  );

  assert.doesNotMatch(mainMarkup, /Compact player|interactionControlsMarkup\(\)/);
  assert.match(playerMarkup, /Compact player/);
  assert.match(selectionMarkup, /Selection &amp; Hover/);
  assert.match(selectionMarkup, /interactionControlsMarkup\(\)/);
});

test('themed loop handles retain a transparent 30px hit target and color only the thin visual', () => {
  const handleHitTarget = cssRule(playerCss, '\\.loop-range-handle');
  const baseVisual = cssRule(playerCss, '\\.loop-range-handle::after');
  const themedHitTarget = cssRule(
    appearanceCss,
    ':root\\[data-appearance-player\\][^{]*\\.player-loop-handle(?!::after)',
  );
  const themedVisual = cssRule(
    appearanceCss,
    ':root\\[data-appearance-player\\][^{]*\\.player-loop-handle::after',
  );

  assert.match(handleHitTarget, /--loop-handle-hit-size:\s*30px/);
  assert.match(handleHitTarget, /background:\s*transparent/);
  assert.match(baseVisual, /width:\s*[3-5]px/);
  assert.doesNotMatch(
    themedHitTarget,
    /(?:background|border|box-shadow)\s*:/,
    'Appearance must not paint the large pointer target',
  );
  assert.match(themedVisual, /width:\s*[3-5]px/);
  assert.match(
    themedVisual,
    /var\(--appearance-(?:player-handle|waveform-edge)\)/,
    'only the thin pseudo-element receives the saved edge/handle color',
  );
});

test('loop selection boundary and tint follow the effective handle color', () => {
  const themedSelection = cssRule(
    appearanceCss,
    ':root\\[data-appearance-player\\][^{]*\\.player-loop-region\\.loop-range-selection',
  );

  assert.match(themedSelection, /border-inline-color:\s*var\(--appearance-player-handle\)/);
  assert.match(themedSelection, /background:\s*color-mix\([^;]*var\(--appearance-player-handle\)/);
  assert.doesNotMatch(themedSelection, /#(?:86efac|4ade80|22c55e)/i);
});

test('changing only player colors cannot change Main-elements interaction tokens', () => {
  const first = styleTarget();
  const second = styleTarget();
  const common = {
    main_surface_color: null,
    panel_background_color: null,
    palette_id: 'steelblue',
    panel_index: 0,
  };
  appearance.applyTheme({
    ...common,
    player_override: {
      surface: { mode: 'gradient', angle: 135, start: '#10251F', end: '#071422' },
      controls: { fill: '#29B765', border: '#AFD8C2' },
      waveform: { fill: '#387F68', edge: '#AFD8C2' },
      handles: { color: '#AFD8C2' },
    },
  }, first.element);
  appearance.applyTheme({
    ...common,
    player_override: {
      surface: { mode: 'gradient', angle: 90, start: '#07111F', end: '#122941' },
      controls: { fill: '#357FB8', border: '#A9CAE4' },
      waveform: { fill: '#3A6D9A', edge: '#A9CAE4' },
      handles: { color: '#D2E8F5' },
    },
  }, second.element);

  const playerToken = /^--appearance-(?:player(?:-|$)|play(?:-|$)|waveform-)/;
  const firstInteractions = [...first.values].filter(([name]) => !playerToken.test(name));
  const secondInteractions = [...second.values].filter(([name]) => !playerToken.test(name));
  assert.deepEqual(secondInteractions, firstInteractions);
});

test('themed player boundaries preserve floating hover and focus strength', () => {
  const basePlayerRule = cssRule(
    appearanceCss,
    ':root\\[data-appearance-player\\] \\.global-player(?!:)\\b',
  );
  const nonFloatingBoundaryRule = cssRule(
    appearanceCss,
    ':root\\[data-appearance-player\\] \\.global-player:not\\(\\.is-floating-compact\\)',
  );

  assert.doesNotMatch(
    basePlayerRule,
    /border-color\s*:/,
    'the broad theme rule must not flatten the floating component edge state',
  );
  assert.match(
    nonFloatingBoundaryRule,
    /border-color:\s*var\(--appearance-player-ink\)/,
    'expanded and docked player boundaries still follow the saved player ink',
  );
  assert.match(
    playerCss,
    /\.global-player\.is-floating-compact:is\(:hover,:focus-within\)\s*\{[^}]*--compact-floating-edge-strength:\s*30%/s,
  );
});

test('NavigationTree, editor tabs, and Save use non-player Appearance tokens', () => {
  const relevantRules = [...appearanceCss.matchAll(/([^{}]*(?:navigation-tree|appearance-editor-tab|background-save|editor-footer)[^{}]*)\{([^}]*)\}/gs)];
  assert.ok(relevantRules.length > 0, 'Appearance must expose rules for its navigation, tabs, and shared footer');
  for (const [_, selector, declarations] of relevantRules) {
    assert.doesNotMatch(
      declarations,
      /var\(--appearance-(?:player(?:-|\))|play(?:-|\))|waveform-)/,
      `${selector.trim()} must not inherit player colors`,
    );
  }

  const saveRule = relevantRules.find(([_, selector]) => /background-save|editor-footer/.test(selector))?.[2] || '';
  assert.match(
    saveRule,
    /var\(--appearance-(?:primary-button|button-background)\)/,
    'Save uses the Main-elements button token rather than the player palette or a fixed accent',
  );
});
