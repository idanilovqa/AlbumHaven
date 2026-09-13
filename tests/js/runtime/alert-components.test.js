const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.join(__dirname, '..', '..', '..');

function loadAlertComponents() {
  const context = {
    escapeHtml(value) {
      return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
    },
  };
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(repoRoot, 'music_app', 'static', 'js', 'runtime', 'alert-components.js'), 'utf8'),
    context,
  );
  return context;
}

test('SmallAlert exposes a near-circular compact error that expands to Album not found', () => {
  const context = loadAlertComponents();
  const html = context.buildSmallAlertHtml({ severity: 'error', message: 'Album not found' });

  assert.match(html, /class="small-alert small-alert--error"/);
  assert.doesNotMatch(html, /tabindex=/);
  assert.match(html, /role="status"/);
  assert.match(html, /small-alert__icon/);
  assert.match(html, /small-alert__text">Album not found</);
});

test('OnPageAlert supports semantic variants and shared action slots', () => {
  const context = loadAlertComponents();
  const html = context.buildOnPageAlertHtml({
    severity: 'warning',
    title: 'Album details unavailable',
    message: 'Cannot find <album>.',
    actionsHtml: '<button class="ui-button">Keep as missing</button>',
  });

  assert.match(html, /class="on-page-alert on-page-alert--warning"/);
  assert.match(html, /role="alert"/);
  assert.match(html, /Album details unavailable/);
  assert.match(html, /Cannot find &lt;album&gt;\./);
  assert.match(html, /on-page-alert__actions/);
  assert.match(html, /Keep as missing/);
});

test('AlertLabel renders static and interactive semantic problem pills', () => {
  const context = loadAlertComponents();
  const staticHtml = context.buildAlertLabelHtml({
    severity: 'error',
    message: 'Missing cover art',
  });
  const interactiveHtml = context.buildAlertLabelHtml({
    severity: 'error',
    message: 'Missing year',
    interactive: true,
    pressed: true,
    disabled: true,
    className: 'utility-problem-exclusion-pill',
    attributes: {
      'data-problem-exclusion-row-key': 'album:&1',
      'data-ignored-attribute': '<unsafe>',
    },
  });

  assert.match(staticHtml, /^<span class="alert-label alert-label--error" data-alert-label="error">Missing cover art<\/span>$/);
  assert.match(interactiveHtml, /^<button class="alert-label alert-label--error utility-problem-exclusion-pill is-active"/);
  assert.match(interactiveHtml, /type="button"/);
  assert.match(interactiveHtml, /data-problem-exclusion-row-key="album:&amp;1"/);
  assert.doesNotMatch(interactiveHtml, /data-ignored-attribute/);
  assert.match(interactiveHtml, /aria-pressed="true"/);
  assert.match(interactiveHtml, /aria-disabled="true"/);
  assert.match(interactiveHtml, / disabled/);
});

test('shared alert CSS uses the same tinted surface family and honors reduced motion', () => {
  const css = fs.readFileSync(
    path.join(repoRoot, 'music_app', 'static', 'css', 'runtime', 'alert-components.css'),
    'utf8',
  );
  assert.match(css, /--alert-tint/);
  assert.match(css, /\.small-alert\s*\{[^}]*border-radius:\s*999px/s);
  assert.match(css, /\.small-alert:hover/);
  assert.match(css, /\.small-alert:focus-visible/);
  assert.doesNotMatch(css, /\.album-card__artbox-trigger:hover \.small-alert/);
  assert.match(css, /\.album-card__artbox-trigger:focus-visible \.small-alert/);
  assert.match(css, /\.small-alert:hover[^}]*width:\s*min\(154px,\s*100%\)/s);
  assert.match(css, /\.small-alert__text\s*\{[^}]*padding:\s*0 14px 0 4px/s);
  assert.match(css, /\.on-page-alert__actions \.ui-button--primary\s*\{[^}]*background:\s*var\(--alert-edge\)/s);
  assert.match(css, /\.on-page-alert__actions \.ui-button--secondary\s*\{[^}]*border-color:\s*color-mix\([^;]*var\(--alert-edge\)/s);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
});

test('AlertLabel interaction states retain the gallery alert severity color family', () => {
  const css = fs.readFileSync(
    path.join(repoRoot, 'music_app', 'static', 'css', 'runtime', 'alert-components.css'),
    'utf8',
  );

  assert.match(css, /\.small-alert,\s*\.alert-label,\s*\.on-page-alert\s*\{[^}]*--alert-edge:[^}]*--alert-tint:[^}]*--alert-ink:/s);
  assert.match(css, /\.alert-label\s*\{[^}]*border:[^;]*var\(--alert-edge\)[^}]*background:\s*var\(--alert-tint\)[^}]*color:\s*var\(--alert-ink\)/s);
  assert.match(css, /button\.alert-label:is\(:hover,\s*:focus-visible[^}]*outline:\s*2px solid color-mix\(in srgb, var\(--alert-edge\)/s);
  assert.match(css, /button\.alert-label:is\(\.is-active,\s*\[aria-pressed="true"\]\)/s);
  const labelRules = css.match(/[^{}]*\.alert-label[^{}]*\{[^}]*\}/g)?.join('\n') || '';
  assert.doesNotMatch(labelRules, /--appearance-interaction-outline/);
});
