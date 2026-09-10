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
