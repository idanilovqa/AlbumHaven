const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..', '..', '..');
const componentPath = path.join(repoRoot, 'music_app', 'static', 'js', 'button-component.js');

test('shared icon renderer emits normalized decorative SVGs from a fixed registry', () => {
  const button = require(componentPath);
  for (const name of ['play', 'pause', 'edit', 'close', 'more', 'delete', 'previous', 'next']) {
    const html = button.renderIconSvg(name, { className: `ui-icon--${name}` });
    assert.match(html, /^<svg class="ui-icon ui-icon--/);
    assert.match(html, /viewBox="0 0 24 24"/);
    assert.match(html, /aria-hidden="true"/);
    assert.match(html, /focusable="false"/);
    assert.match(html, /<path d="[^"]+"\/>/);
  }
  assert.throws(() => button.renderIconSvg('invented'), /Unknown icon/);
  assert.throws(
    () => button.renderIconSvg('play', { className: 'safe\" onclick=\"alert' }),
    /Invalid icon class/,
  );
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
  assert.match(css, /\.ui-button\s*\{[^}]*outline:\s*1px solid transparent[^}]*outline-offset:\s*1px[^}]*transition:[^;}]*outline-color 150ms ease/s);
  assert.match(css, /\.ui-button:hover:not\(:disabled\):not\(\[aria-disabled='true'\]\)\s*\{[^}]*border-color:\s*var\(--appearance-interaction-outline,[^}]*outline-color:\s*var\(--appearance-interaction-outline,/s);
  assert.match(css, /\.ui-button:active:not\(:disabled\):not\(\[aria-disabled='true'\]\)\s*\{[^}]*background:\s*var\(--appearance-item-action-pressed,/s);
  assert.match(css, /\.ui-button:focus-visible\s*\{[^}]*outline-color:\s*var\(--appearance-interaction-outline,/s);
  assert.match(css, /\.ui-button--quiet:hover:not\(:disabled\):not\(\[aria-disabled='true'\]\)\s*\{[^}]*background:\s*color-mix\(in srgb, currentColor 6%, transparent\)/s);
  assert.match(css, /\.ui-button--quiet:active:not\(:disabled\):not\(\[aria-disabled='true'\]\)\s*\{[^}]*background:\s*color-mix\(in srgb, currentColor 10%, transparent\)/s);
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

test('ActionButton CSS owns one 34px theme-aware surface and inert disabled treatment', () => {
  const css = fs.readFileSync(path.join(repoRoot, 'music_app', 'static', 'css', 'button-component.css'), 'utf8');
  assert.match(css, /\.action-button\s*\{[^}]*width:\s*34px[^}]*height:\s*34px[^}]*min-width:\s*34px[^}]*min-height:\s*34px/s);
  assert.match(css, /\.action-button\s*\{[^}]*border-radius:\s*8px[^}]*background:\s*var\(--appearance-control,/s);
  assert.match(css, /\.action-button:hover:not\(:disabled\):not\(\[aria-disabled='true'\]\)\s*\{[^}]*border-color:\s*var\(--appearance-interaction-outline,/s);
  assert.match(css, /\.action-button\s*\{[^}]*outline:\s*1px solid transparent[^}]*outline-offset:\s*1px[^}]*transition:[^;}]*outline-color 150ms ease/s);
  assert.match(css, /\.action-button:hover:not\(:disabled\):not\(\[aria-disabled='true'\]\)\s*\{[^}]*outline-color:\s*var\(--appearance-interaction-outline,/s);
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
