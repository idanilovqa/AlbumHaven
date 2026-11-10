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

test('an interactive SmallAlert is the regular compact alert as a button for its exact problem', () => {
  const context = loadAlertComponents();
  const html = context.buildSmallAlertHtml({
    severity: 'warning',
    message: 'MBID: Multiple matches',
    interactive: true,
    attributes: {
      'data-open-musicbrainz-artist-problem': 'artist-problem-19',
      'aria-label': 'Open MBID: Multiple matches for Axxis',
    },
  });

  assert.match(html, /^<button/);
  assert.match(html, /class="small-alert small-alert--warning"/);
  assert.match(html, /type="button"/);
  assert.match(html, /data-open-musicbrainz-artist-problem="artist-problem-19"/);
  assert.match(html, /aria-label="Open MBID: Multiple matches for Axxis"/);
  assert.match(html, /small-alert__icon[^]*<path d="M10\.3 3\.8/);
  assert.match(html, /small-alert__text">MBID: Multiple matches</);
});

test('the separator alert keeps its own column so the divider line stops at it', () => {
  const alertCss = fs.readFileSync(
    path.join(repoRoot, 'music_app', 'static', 'css', 'runtime', 'alert-components.css'),
    'utf8',
  );
  const galleryCss = fs.readFileSync(
    path.join(repoRoot, 'music_app', 'static', 'css', 'gallery-main.css'),
    'utf8',
  );
  assert.doesNotMatch(alertCss, /triangle-only/, 'the owner asked for the regular compact alert');
  assert.match(alertCss, /button\.small-alert\s*\{[^}]*padding:\s*0[^}]*cursor:\s*pointer/s);
  // The longest artist label must fit when the alert expands.
  assert.match(alertCss, /button\.small-alert:is\(:hover,\s*:focus-visible\)\s*\{[^}]*width:\s*200px/s);
  assert.match(alertCss, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*\.small-alert[^}]*transition:\s*none/s);
  // Name, i, alert, line, count: the alert is a grid column of its own.
  assert.match(galleryCss, /\.family-artist-header:has\(\.artist-musicbrainz-status:not\(:empty\)\)\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*auto\)\s+auto\s+auto\s+minmax\(0,\s*1fr\)\s+auto/s);
  assert.doesNotMatch(galleryCss, /\.family-artist-header:(?:hover|focus-within)[^}]*height:/s);
});

test('metadata pending uses a distinct non-error moving-dots treatment', () => {
  const galleryCss = fs.readFileSync(
    path.join(repoRoot, 'music_app', 'static', 'css', 'gallery-main.css'),
    'utf8',
  );
  assert.match(galleryCss, /\.artist-musicbrainz-pending\s*\{[^}]*color:/s);
  assert.doesNotMatch(galleryCss, /\.artist-musicbrainz-pending\s*\{[^}]*var\(--appearance-error/s);
  assert.match(galleryCss, /\.artist-musicbrainz-pending[^}]*data-pending-dot[\s\S]*animation:/s);
  assert.match(galleryCss, /@keyframes\s+artist-musicbrainz-pending-dots/);
  assert.match(galleryCss, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*data-pending-dot[^}]*animation:\s*none/s);
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
  assert.match(css, /button\.alert-label:is\(:hover,\s*:focus-visible[^}]*outline:\s*1px solid color-mix\(in srgb, var\(--alert-edge\)/s);
  assert.match(css, /button\.alert-label:is\(\.is-active,\s*\[aria-pressed="true"\]\)/s);
  assert.match(css, /button\.alert-label:is\(:hover,[^}]*outline-offset:\s*-1px/s);
  const labelRules = css.match(/[^{}]*\.alert-label[^{}]*\{[^}]*\}/g)?.join('\n') || '';
  assert.doesNotMatch(labelRules, /--appearance-interaction-outline/);
});

test('Library Health warning wraps its complete message without clipping action hover', () => {
  const css = fs.readFileSync(
    path.join(repoRoot, 'music_app/static/css/runtime/alert-components.css'), 'utf8',
  );
  const content = css.match(/#library-scan-warning \.on-page-alert--compact \.on-page-alert__content\s*\{([^}]*)\}/)?.[1] || '';
  const message = css.match(/#library-scan-warning \.on-page-alert--compact \.on-page-alert__message\s*\{([^}]*)\}/)?.[1] || '';
  assert.match(content, /overflow:\s*visible\s*;/);
  assert.match(content, /flex-wrap:\s*wrap\s*;/);
  assert.match(message, /white-space:\s*normal\s*;/);
  assert.match(message, /overflow-wrap:\s*anywhere\s*;/);
  assert.match(message, /overflow:\s*visible\s*;/);
  assert.match(message, /text-overflow:\s*clip\s*;/);
  assert.match(message, /flex:\s*1 1 16rem\s*;/);
  assert.match(message, /min-width:\s*0\s*;/);
  // Other compact alerts retain their existing one-line presentation.
  assert.match(css, /(?:^|\n)\.on-page-alert--compact \.on-page-alert__message\s*\{[^}]*white-space:\s*nowrap/s);
});

test('Suggested Edit labels use a neutral idle edge and saturated green selected state', () => {
  const css = fs.readFileSync(
    path.join(repoRoot, 'music_app', 'static', 'css', 'runtime', 'utilities.css'),
    'utf8',
  );
  const idleRule = css.match(/\.utility-detected-table \.utility-problem-suggestion:not\(\[aria-pressed="true"\]\)\s*\{[^}]*\}/s)?.[0] || '';
  assert.match(idleRule, /border-color:\s*var\(--appearance-line, var\(--border\)\)/);
  assert.match(idleRule, /background:\s*color-mix\([^;]*var\(--appearance-panel-background/);
  assert.match(idleRule, /color:\s*var\(--appearance-ink, var\(--text\)\)/);
  assert.doesNotMatch(idleRule, /--alert-(?:tint|ink)/);
  const selectedRule = css.match(/#utility-modal \.utility-detected-table \.utility-problem-suggestion\[aria-pressed="true"\]\s*\{[^}]*\}/s)?.[0] || '';
  assert.match(selectedRule, /background:\s*#15803d !important/);
  assert.match(selectedRule, /border-color:\s*#0b5f31 !important/);
  assert.match(selectedRule, /color:\s*#fff !important/);
  assert.match(selectedRule, /box-shadow:\s*0 0 0 2px #22c55e[^;]*!important/);
});

test('standalone alert exports escape text and attribute values without runtime globals', () => {
  const css = fs.readFileSync(path.join(repoRoot, 'music_app/static/css/runtime/alert-components.css'), 'utf8');
  assert.match(css, /\.on-page-alert\[hidden\]\s*\{\s*display:\s*none;/);
  assert.match(css, /color:\s*var\(--text,\s*var\(--appearance-ink,\s*#edf4fb\)\)/);
  assert.match(css, /color:\s*var\(--muted,\s*var\(--appearance-muted,\s*#b8c7d6\)\)/);
  const alerts = require('../../../music_app/static/js/runtime/alert-components.js');
  const html = alerts.buildOnPageAlertHtml({
    severity: 'warning', title: '<Error>', message: '<script>alert("x")</script>',
    messageId: '" onmouseover="bad', role: 'status',
  });
  assert.match(html, /on-page-alert--warning" role="status"/);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.match(html, /id="&quot; onmouseover=&quot;bad"/);
  assert.doesNotMatch(html, /<script| id="" onmouseover=/);
  assert.match(alerts.buildOnPageAlertHtml({ role: 'presentation' }), /role="alert"/);
});

test('alert browser exports tolerate standalone and bundled loading in the same window', () => {
  const context = { window: {} };
  vm.createContext(context);
  const source = fs.readFileSync(path.join(repoRoot, 'music_app/static/js/runtime/alert-components.js'), 'utf8');
  vm.runInContext(source, context);
  vm.runInContext(source, context);
  assert.equal(context.window.AlertComponent.buildOnPageAlertHtml, context.buildOnPageAlertHtml);
  assert.match(context.window.AlertComponent.buildSmallAlertHtml({ message: '<missing>' }), /&lt;missing&gt;/);
});

test('OnPageAlert supports the approved success severity with its own icon', () => {
  const context = loadAlertComponents();
  const html = context.buildOnPageAlertHtml({ severity: 'success', title: 'Connected', message: 'Ready' });
  assert.match(html, /on-page-alert--success/);
  assert.match(html, /data-on-page-alert="success"/);
  assert.match(html, /m7 12 3 3 7-7/);
});

test('OnPageAlert renders optional determinate progress below its actions', () => {
  const context = loadAlertComponents();
  const plain = context.buildOnPageAlertHtml({ severity: 'info', title: 'Downloading', message: 'Wait.', actionsHtml: '<button>Go</button>' });
  assert.doesNotMatch(plain, /progress/);
  const html = context.buildOnPageAlertHtml({
    severity: 'info', title: 'Downloading', message: 'Wait.', actionsHtml: '<button>Go</button>',
    progress: { value: 142.4, label: 'Download <progress>' },
  });
  assert.match(html, /<\/div><label class="on-page-alert__progress">Download &lt;progress&gt;<progress max="100" value="100" aria-label="Download &lt;progress&gt;"><\/progress><\/label><\/div><\/section>$/);
  const css = fs.readFileSync(path.join(repoRoot, 'music_app', 'static', 'css', 'runtime', 'alert-components.css'), 'utf8');
  assert.match(css, /\.on-page-alert__progress \{ display: grid;/);
});

test('StatusBadge renders a non-interactive label in its neutral, info or warning variant', () => {
  const alerts = require('../../../music_app/static/js/runtime/alert-components.js');
  assert.equal(alerts.buildStatusBadgeHtml({ label: 'Stable' }), '<span class="ui-status-badge ui-status-badge--neutral">Stable</span>');
  for (const variant of ['neutral', 'info', 'warning']) {
    assert.equal(alerts.buildStatusBadgeHtml({ label: 'S · Sandbox', variant }),
      `<span class="ui-status-badge ui-status-badge--${variant}">S · Sandbox</span>`);
  }
  assert.match(alerts.buildStatusBadgeHtml({ label: '<b>"x"</b>' }), />&lt;b&gt;&quot;x&quot;&lt;\/b&gt;</);
  for (const variant of ['error', 'success', 'constructor']) {
    assert.throws(() => alerts.buildStatusBadgeHtml({ label: 'x', variant }), /Unknown StatusBadge variant/);
  }
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(repoRoot, 'music_app/static/js/runtime/alert-components.js'), 'utf8'), context);
  assert.equal(context.window.AlertComponent.buildStatusBadgeHtml, context.buildStatusBadgeHtml);
});

test('StatusBadge CSS owns its shape and variant colors, with no interactive state', () => {
  const css = fs.readFileSync(path.join(repoRoot, 'music_app/static/css/runtime/alert-components.css'), 'utf8');
  assert.match(css, /\.ui-status-badge \{[^}]*--status-badge-ink: var\(--muted\);[^}]*--status-badge-line: var\(--border\);[^}]*padding: 6px 10px;[^}]*border-radius: 10px;/);
  assert.match(css, /\.ui-status-badge--info \{ --status-badge-ink: var\(--appearance-player-accent, #55c7ff\);/);
  assert.match(css, /\.ui-status-badge--warning \{ --status-badge-ink: var\(--appearance-warning, #e0aa50\);/);
  // Light themes darken only the warning ink, to WCAG AA text contrast on every light palette's card.
  const lightWarning = css.match(/:root\[data-appearance-mode='light'\] \.ui-status-badge--warning \{ --status-badge-ink: (#[0-9a-f]{6}); \}/u)?.[1];
  assert.ok(lightWarning, 'light themes give the warning badge its own ink');
  assert.equal((css.match(/ui-status-badge--warning/gu) || []).length, 2, 'dark themes keep the approved amber');
  const { palettes } = require('../../../music_app/static/js/appearance-palettes.js');
  const luminance = hex => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map(value => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
    .reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0);
  const lightCards = palettes.filter(palette => palette.mode === 'light').map(palette => palette.tokens.card);
  assert.ok(lightCards.length > 0);
  for (const card of lightCards) {
    const [lighter, darker] = [luminance(card), luminance(lightWarning)].sort((a, b) => b - a);
    assert.ok((lighter + 0.05) / (darker + 0.05) >= 4.5, `warning badge contrast on ${card}`);
  }
  assert.doesNotMatch(css, /\.ui-status-badge[^{]*:(?:hover|focus|active)|\.ui-status-badge[^{]*\.is-active/);
  // No page-local copy of the badge remains.
  const utilities = fs.readFileSync(path.join(repoRoot, 'music_app/static/css/runtime/utilities.css'), 'utf8');
  assert.doesNotMatch(utilities, /android-settings__channel|ui-status-badge/);
});
