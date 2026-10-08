const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..', '..', '..');
const componentPath = path.join(repoRoot, 'music_app', 'static', 'js', 'button-component.js');

test('vertical more is a distinct reusable decorative icon while horizontal more remains unchanged', () => {
  const button = require(componentPath);
  assert.match(button.renderIconSvg('more-vertical'), /M12 6\.5h\.01M12 12h\.01M12 17\.5h\.01/);
  assert.match(button.renderIconSvg('more'), /M6\.5 12h\.01M12 12h\.01M17\.5 12h\.01/);
  const html = button.renderActionButton({icon: 'more-vertical', ariaLabel: 'Section actions', disabled: true});
  assert.match(html, /aria-label="Section actions"/); assert.match(html, /disabled aria-disabled="true"/);
  assert.match(html, /aria-hidden="true" focusable="false"/);
});

test('Love metric artwork preserves the approved heart anchor and distinct explicit states', () => {
  const button = require(componentPath);
  const heart = 'M20.8 4.8a5.5 5.5 0 0 0-7.8 0L12 5.9l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.4a5.5 5.5 0 0 0 0-7.8Z';
  const icons = new Map(['off', 'loved', 'obsessed'].map(tier => [tier,
    button.renderIconSvg(`love-${tier}`, { className: 'ui-icon--love' }),
  ]));
  for (const [tier, html] of icons) {
    assert.ok(html.includes(`<path class="ui-love-heart ui-love-heart--${tier}" d="${heart}"/>`));
    assert.match(html, /aria-hidden="true" focusable="false"/);
    assert.doesNotMatch(html, /<button|tabindex|aria-pressed|data-.*action/);
  }
  assert.doesNotMatch(icons.get('off'), /ui-love-flame/);
  assert.doesNotMatch(icons.get('loved'), /ui-love-flame/);
  assert.match(icons.get('obsessed'), /<g transform="translate\(-4 -10\.666667\) scale\(1\.333333\)">/);
  assert.match(icons.get('obsessed'), /<path class="ui-love-flame" d="M12 1c2 4 5 4 4 9 2-1 3-3 3-5 4 5 5 9 2 14-2 3-5 4-9 4S5 22 3 19C0 14 3 10 6 7c-1 3 0 5 2 6-1-5 4-6 4-12Z"\/>/);
  assert.match(icons.get('obsessed'), /<path class="ui-love-flame-core" d="M12 5c1 4 5 5 3 10 2-1 3-3 3-5 4 6 1 11-6 11-6 0-9-5-5-10 0 3 1 4 3 5-1-4 2-6 2-11Z"\/>/);
  assert.throws(() => button.renderIconSvg('love-unknown'), /Unknown icon/);
  assert.throws(() => button.renderIconSvg(), /Unknown icon/);

  const css = fs.readFileSync(path.join(repoRoot, 'music_app/static/css/button-component.css'), 'utf8');
  assert.match(css, /\.ui-icon\.ui-icon--love\s*\{[^}]*width:\s*18px[^}]*height:\s*18px[^}]*overflow:\s*visible[^}]*stroke-width:\s*1\.6/s);
  assert.match(css, /\.ui-love-heart--off\s*\{[^}]*stroke:\s*var\(--muted,\s*var\(--appearance-muted\)\)/s);
  assert.match(css, /\.ui-love-heart--loved\s*\{[^}]*fill:\s*#f15d75[^}]*stroke:\s*#f15d75/s);
  assert.match(css, /\.ui-love-heart--obsessed\s*\{[^}]*fill:\s*#ef405b[^}]*stroke:\s*#98213c[^}]*stroke-width:\s*1\.2/s);
  assert.match(css, /\.ui-love-flame\s*\{[^}]*fill:\s*#fb8c24[^}]*stroke:\s*#a9470a[^}]*stroke-width:\s*\.7/s);
  assert.match(css, /\.ui-love-flame-core\s*\{[^}]*fill:\s*#ffdc69[^}]*stroke:\s*none/s);
});

test('shared icon renderer emits normalized decorative SVGs from a fixed registry', () => {
  const button = require(componentPath);
  for (const name of ['play', 'pause', 'edit', 'close', 'more', 'delete', 'previous', 'next', 'bolt']) {
    const html = button.renderIconSvg(name, { className: `ui-icon--${name}` });
    assert.match(html, /^<svg class="ui-icon ui-icon--/);
    assert.match(html, /viewBox="0 0 24 24"/);
    assert.match(html, /aria-hidden="true"/);
    assert.match(html, /focusable="false"/);
    assert.match(html, /<path d="[^"]+"\/>/);
  }
  assert.match(button.renderIconSvg('bolt'), /<path d="m13 2-9 12h7l-1 8 10-13h-7z"\/>/);
  assert.throws(() => button.renderIconSvg('invented'), /Unknown icon/);
  assert.throws(() => button.renderIconSvg('constructor'), /Unknown icon/);
  assert.throws(
    () => button.renderIconSvg('play', { className: 'safe\" onclick=\"alert' }),
    /Invalid icon class/,
  );
});

test('shared icons preserve approved compound artwork across JavaScript and Jinja renderers', () => {
  const button = require(componentPath);
  const macro = fs.readFileSync(path.join(repoRoot, 'music_app', 'templates', 'partials', 'button.html'), 'utf8');
  const templateIcons = new Map([...macro.matchAll(/^\s*'([^']+)': '([^']*)',?$/gm)].map((match) => [match[1], match[2]]));
  const names = ['add', 'missing-playlist', 'album-top', 'create-top', 'share', 'filters', 'save', 'download', 'friends', 'compare', 'expand', 'collapse', 'ascending', 'descending', 'love-off', 'love-loved', 'love-obsessed'];
  for (const name of names) assert.ok(templateIcons.has(name), `Jinja is missing ${name}`);
  for (const [name, markup] of templateIcons) {
    assert.equal(button.renderIconSvg(name), `<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${markup}</svg>`, name);
  }
  for (const name of names) {
    const html = button.renderActionButton({ ariaLabel: `Action ${name}`, icon: name, presentation: 'bare', disabled: true });
    assert.match(html, /action-button--bare/);
    assert.match(html, /disabled aria-disabled="true"/);
    assert.match(html, /<svg class="ui-icon action-button__icon ui-icon--/);
  }
  assert.match(button.renderIconSvg('add'), /transform="rotate\(45 12 12\)"/);
  assert.match(button.renderIconSvg('create-top'), /data-top-crown=""[^>]*transform="translate\(0 2\.5\)"/);
  assert.match(button.renderIconSvg('create-top'), /data-top-plus=""/);
  assert.match(button.renderIconSvg('missing-playlist'), /<circle data-missing-warning-dot="" cx="3\.5" cy="18" r="1\.35" fill="currentColor" stroke="none"\/>/);
  assert.match(button.renderIconSvg('missing-playlist'), /data-missing-warning=""[^>]*stroke-width="2\.8"/);
  assert.match(button.renderIconSvg('missing-playlist'), /data-missing-inspect-lens=""/);
  assert.match(button.renderIconSvg('missing-playlist'), /data-missing-inspect-handle=""/);
  assert.equal((button.renderIconSvg('share').match(/<circle /g) || []).length, 3);
  assert.equal((button.renderIconSvg('friends').match(/<circle /g) || []).length, 2);
  assert.match(macro, /macro action_button\([^)]*icon=none, icon_class=''/);
  assert.match(macro, /if icon %\}\{\{ ui_icon\(icon,/);
});

test('shared Button renderer centers safe text and exposes canonical variants and actions', () => {
  const button = require(componentPath);
  const html = button.renderButton({
    label: 'Save <changes>', variant: 'primary', size: 'medium', action: 'save',
    className: 'background-save', attributes: { 'data-background-save': true, disabled: true },
  });
  assert.match(html, /^<button type="button"/);
  assert.match(html, /class="button ui-button ui-button--primary ui-button--medium background-save"/);
  assert.match(html, /data-ui-button-action="save"/);
  assert.match(html, /data-background-save/);
  assert.match(html, / disabled/);
  assert.match(html, /<span class="ui-button__content">Save &lt;changes&gt;<\/span>/);
  assert.throws(() => button.renderButton({ label: 'Bad', variant: 'invented' }), /Unknown Button variant/);
});

test('shared Button renderer exposes a reusable quiet interaction modifier', () => {
  const button = require(componentPath);
  const html = button.renderButton({ label: 'Cancel', variant: 'secondary', quiet: true });
  assert.match(html, /class="button ui-button ui-button--secondary ui-button--medium ui-button--quiet"/);
});

test('shared Button CSS centers content on both axes and EditorFooter composes the renderer', () => {
  const css = fs.readFileSync(path.join(repoRoot, 'music_app', 'static', 'css', 'button-component.css'), 'utf8');
  const editor = fs.readFileSync(path.join(repoRoot, 'music_app', 'static', 'js', 'editor-page.js'), 'utf8');
  const bootstrap = fs.readFileSync(path.join(repoRoot, 'music_app', 'templates', 'partials', 'appearance-bootstrap.html'), 'utf8');
  assert.match(css, /\.ui-button\s*\{[^}]*display:\s*inline-flex[^}]*align-items:\s*center[^}]*justify-content:\s*center[^}]*line-height:\s*1/s);
  assert.match(css, /\.ui-button\[hidden\]\s*\{[^}]*display:\s*none\s*!important/s);
  assert.match(css, /\.ui-button\s*\{[^}]*outline:\s*1px solid transparent[^}]*outline-offset:\s*-1px[^}]*transition:[^;}]*outline-color 150ms ease/s);
  assert.match(css, /\.ui-button:hover:not\(:disabled\):not\(\[aria-disabled='true'\]\)\s*\{[^}]*border-color:\s*var\(--appearance-item-action-hover-border,[^}]*background:\s*var\(--appearance-item-action-hover-background,/s);
  assert.match(css, /\.ui-button:active:not\(:disabled\):not\(\[aria-disabled='true'\]\)\s*\{[^}]*background:\s*var\(--appearance-item-action-pressed,/s);
  assert.match(css, /\.ui-button:focus-visible\s*\{[^}]*outline-color:\s*var\(--appearance-interaction-outline,/s);
  assert.match(css, /:root \.ui-button\.ui-button--quiet\s*\{[^}]*border-color:\s*var\(--appearance-line,[^}]*background:\s*transparent/s);
  assert.match(css, /:root \.ui-button\.ui-button--quiet:hover:not\(:disabled\):not\(\[aria-disabled='true'\]\)\s*\{[^}]*background:\s*transparent/s);
  assert.match(css, /:root \.ui-button\.ui-button--quiet:active:not\(:disabled\):not\(\[aria-disabled='true'\]\)\s*\{[^}]*background:\s*var\(--appearance-item-action-pressed,/s);
  assert.match(editor, /ButtonComponent\.renderButton/);
  assert.match(editor, /label:\s*secondary\.label \|\| 'Cancel'[\s\S]*quiet:\s*true/);
  assert.doesNotMatch(editor, /<button/);
  assert.ok(bootstrap.indexOf('button-component.js') < bootstrap.indexOf('editor-page.js'));
  assert.match(bootstrap, /button-component\.css/);
});

test('Jinja Button macro shares the component contract and supports text and icon content', () => {
  const macro = fs.readFileSync(path.join(repoRoot, 'music_app', 'templates', 'partials', 'button.html'), 'utf8');
  assert.match(macro, /macro ui_button\([^)]*quiet=false/);
  assert.match(macro, /ui-button--\{\{ variant \}\}/);
  assert.match(macro, /\{% if quiet %\} ui-button--quiet\{% endif %\}/);
  assert.match(macro, /data-ui-button-action/);
  assert.match(macro, /ui-button__content/);
  assert.match(macro, /caller\(\)/);
});

test('ActionButton renderer owns the approved icon-button geometry and safe native states', () => {
  const button = require(componentPath);
  const html = button.renderActionButton({
    ariaLabel: 'Edit album tags',
    title: 'Edit album tags',
    className: 'track-modal-edit-tags album-details-header__action',
    iconClass: 'album-details-header__action-icon album-details-header__action-icon--edit',
    attributes: { id: 'track-modal-edit-tags', 'data-open-track-modal-editor': '1' },
  });

  assert.match(html, /^<button type="button"/);
  assert.match(html, /class="button ui-button ui-button--icon ui-button--medium action-button track-modal-edit-tags album-details-header__action"/);
  assert.match(html, /id="track-modal-edit-tags"/);
  assert.match(html, /data-open-track-modal-editor="1"/);
  assert.match(html, /aria-label="Edit album tags"/);
  assert.match(html, /title="Edit album tags"/);
  assert.match(html, /<span class="ui-button__content action-button__content"><span class="action-button__icon album-details-header__action-icon album-details-header__action-icon--edit" aria-hidden="true"><\/span><\/span>/);
  assert.throws(() => button.renderActionButton({ iconClass: 'icon' }), /accessible label/i);
});

test('ActionButton exposes native disabled state and rejects unsafe icon classes', () => {
  const button = require(componentPath);
  const html = button.renderActionButton({
    ariaLabel: 'Unavailable',
    disabled: true,
    iconClass: 'album-details-header__action-icon',
  });

  assert.match(html, / disabled/);
  assert.match(html, /aria-disabled="true"/);
  assert.throws(
    () => button.renderActionButton({ ariaLabel: 'Unsafe', iconClass: 'safe\" onclick=\"alert(1)' }),
    /Invalid ActionButton icon class/,
  );
});

test('ActionButton supports shared round and destructive specializations with a centered SVG', () => {
  const button = require(componentPath);
  const html = button.renderActionButton({
    ariaLabel: 'Remove loop',
    icon: 'delete',
    shape: 'round',
    semantic: 'destructive',
  });

  assert.match(html, /action-button action-button--round action-button--destructive/);
  assert.match(html, /<svg class="ui-icon action-button__icon ui-icon--delete"/);
  assert.match(html, /aria-hidden="true" focusable="false"/);
  assert.throws(
    () => button.renderActionButton({ ariaLabel: 'Wrong shape', shape: 'triangle' }),
    /Unknown ActionButton shape/,
  );
  assert.throws(
    () => button.renderActionButton({ ariaLabel: 'Wrong semantic', semantic: 'celebratory' }),
    /Unknown ActionButton semantic/,
  );
});

test('ActionButton Save uses the shared success semantic while disabled Save keeps native inactive semantics', () => {
  const button = require(componentPath);
  const config = {ariaLabel: 'Save', icon: 'save', semantic: 'save', presentation: 'bare'};
  const enabled = button.renderActionButton(config), disabled = button.renderActionButton({...config, disabled: true});
  assert.match(enabled, /action-button--save/); assert.match(enabled, /aria-label="Save"/);
  assert.doesNotMatch(enabled, /aria-disabled/);
  assert.match(disabled, /action-button--save/); assert.match(disabled, / disabled aria-disabled="true"/);
  const css = fs.readFileSync(path.join(repoRoot, 'music_app', 'static', 'css', 'button-component.css'), 'utf8');
  assert.match(css, /\.action-button--save:not\(:disabled\):not\(\[aria-disabled='true'\]\)\s*\{[^}]*color:\s*var\(--appearance-play,\s*var\(--success\)\)/s);
});

test('ActionButton accepts the shared bare presentation and rejects unknown presentations', () => {
  const button = require(componentPath);
  const html = button.renderActionButton({ ariaLabel: 'Fold artists', icon: 'previous', presentation: 'bare' });
  assert.match(html, /action-button action-button--bare/);
  assert.throws(
    () => button.renderActionButton({ ariaLabel: 'Wrong presentation', presentation: 'floating' }),
    /Unknown ActionButton presentation/,
  );
});

test('ActionButton opts into shared pressed ink only for explicit boolean toggle states', () => {
  const button = require(componentPath);
  const config = { ariaLabel: 'Friends', icon: 'friends', presentation: 'bare' };
  for (const pressed of [true, false]) {
    const html = button.renderActionButton({ ...config, pressed, attributes: { 'aria-pressed': String(!pressed) } });
    assert.match(html, /action-button--bare action-button--toggle/);
    assert.ok(html.includes(`aria-pressed="${pressed}"`));
    assert.equal((html.match(/aria-pressed=/g) || []).length, 1);
  }
  const ordinary = button.renderActionButton({ ...config, attributes: { 'aria-pressed': 'true' } });
  assert.doesNotMatch(ordinary, /action-button--toggle/);
  assert.match(ordinary, /aria-pressed="true"/);
  assert.doesNotMatch(button.renderActionButton(config), /action-button--toggle|aria-pressed/);
  const disabled = button.renderActionButton({ ...config, pressed: true, disabled: true });
  assert.match(disabled, /aria-pressed="true"/);
  assert.match(disabled, /disabled aria-disabled="true"/);

  const css = fs.readFileSync(path.join(repoRoot, 'music_app', 'static', 'css', 'button-component.css'), 'utf8');
  const selected = css.match(/\.action-button--toggle\[aria-pressed="true"\]([^{}]+)\{([^}]+)\}/);
  assert.ok(selected);
  assert.match(selected[1], /:not\(:disabled\):not\(\[aria-disabled="true"\]\):not\(\.action-button--destructive\)/);
  assert.equal(selected[2].trim(), 'color: var(--appearance-selected-accent, var(--accent));');
  const macro = fs.readFileSync(path.join(repoRoot, 'music_app', 'templates', 'partials', 'button.html'), 'utf8');
  assert.match(macro, /macro action_button\([^)]*pressed=none/);
  assert.match(macro, /set is_toggle = pressed is sameas true or pressed is sameas false/);
  assert.match(macro, /if is_toggle %\} action-button--toggle/);
  assert.match(macro, /if is_toggle %\} aria-pressed="\{\{ 'true' if pressed else 'false' \}\}"/);
});

test('ActionButton CSS owns one 34px theme-aware surface and inert disabled treatment', () => {
  const css = fs.readFileSync(path.join(repoRoot, 'music_app', 'static', 'css', 'button-component.css'), 'utf8');
  assert.match(css, /\.action-button\s*\{[^}]*width:\s*34px[^}]*height:\s*34px[^}]*min-width:\s*34px[^}]*min-height:\s*34px/s);
  assert.match(css, /\.action-button\s*\{[^}]*border-radius:\s*8px[^}]*background:\s*var\(--appearance-neutral-button-background,\s*var\(--appearance-control,/s);
  assert.match(css, /\.action-button:hover:not\(:disabled\):not\(\[aria-disabled='true'\]\)\s*\{[^}]*border-color:\s*var\(--appearance-item-action-hover-border,/s);
  assert.match(css, /\.action-button\s*\{[^}]*outline:\s*1px solid transparent[^}]*outline-offset:\s*1px[^}]*transition:[^;}]*outline-color 150ms ease/s);
  assert.doesNotMatch(css, /\.action-button:hover:not\(:disabled\):not\(\[aria-disabled='true'\]\)\s*\{[^}]*outline-color:/s);
  assert.match(css, /\.action-button:focus-visible\s*\{[^}]*outline-color:\s*var\(--appearance-interaction-outline,/s);
  assert.match(css, /\.action-button:disabled,[^{]*\.action-button\[aria-disabled='true'\]\s*\{[^}]*opacity:[^;}]+;[^}]*cursor:\s*not-allowed/s);
  assert.match(css, /\.action-button--round\s*\{[^}]*border-radius:\s*50%/s);
  assert.match(css, /\.action-button__icon\.ui-icon\s*\{[^}]*display:\s*block[^}]*stroke:\s*currentColor[^}]*fill:\s*none/s);
  assert.match(css, /\.action-button--destructive:hover:not\(:disabled\):not\(\[aria-disabled='true'\]\)[^{]*\{[^}]*border-color:\s*var\(--alert-error-edge[^}]*outline-color:\s*var\(--alert-error-focus/s);
  assert.match(css, /\.action-button--destructive:focus-visible\s*\{[^}]*outline-color:\s*var\(--alert-error-focus/s);
});

test('Jinja ActionButton macro shares the JavaScript contract and accepts structured attributes', () => {
  const macro = fs.readFileSync(path.join(repoRoot, 'music_app', 'templates', 'partials', 'button.html'), 'utf8');
  assert.match(macro, /macro action_button\([^)]*shape='default'[^)]*semantic='default'/);
  assert.match(macro, /ui-button--icon ui-button--medium action-button/);
  assert.match(macro, /action-button--\{\{ shape \}\}/);
  assert.match(macro, /action-button--\{\{ semantic \}\}/);
  assert.match(macro, /aria-label="\{\{ aria_label \}\}"/);
  assert.match(macro, /for attribute_name, attribute_value in attributes\.items\(\)/);
  assert.match(macro, /action-button__content/);
  assert.match(macro, /caller\(\)/);
});

test('shared Button state changes update both native and accessible disabled state', () => {
  const { setDisabled } = require(componentPath);
  const attributes = new Map([['aria-disabled', 'true']]);
  const element = { disabled: true, setAttribute(name, value) { attributes.set(name, value); } };
  assert.equal(typeof setDisabled, 'function');
  setDisabled(element, false);
  assert.equal(element.disabled, false);
  assert.equal(attributes.get('aria-disabled'), 'false');
  setDisabled(element, true);
  assert.equal(element.disabled, true);
  assert.equal(attributes.get('aria-disabled'), 'true');
});

test('pressed text choices expose native selection semantics and shared selection paint', () => {
  const button = require(componentPath);
  const selected = button.renderButton({label: 'Yours first', attributes: {'aria-pressed': 'true'}});
  const unselected = button.renderButton({label: 'General', attributes: {'aria-pressed': 'false'}});
  assert.match(selected, /aria-pressed="true"/); assert.match(unselected, /aria-pressed="false"/);
  assert.match(selected, /ui-button--secondary/);
  const css = fs.readFileSync(path.join(repoRoot, 'music_app/static/css/button-component.css'), 'utf8');
  assert.match(css, /\.ui-button\[aria-pressed="true"\]:not\(\.action-button\):not\(:disabled\):not\(\[aria-disabled="true"\]\)\s*\{[^}]*color:\s*var\(--appearance-selected-accent[^}]*font-weight:\s*700/s);
  assert.match(css, /\[aria-pressed="true"\][^{]+:not\(:hover\):not\(:active\)\s*\{[^}]*background:\s*var\(--selection-body-background/s);
});
