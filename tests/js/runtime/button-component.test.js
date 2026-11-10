const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..', '..', '..');
const componentPath = path.join(repoRoot, 'music_app', 'static', 'js', 'button-component.js');

test('shared icon renderer emits normalized decorative SVGs from a fixed registry', () => {
  const button = require(componentPath);
  for (const name of ['play', 'pause', 'edit', 'close', 'more', 'delete', 'previous', 'next', 'refresh', 'bolt']) {
    const html = button.renderIconSvg(name, { className: `ui-icon--${name}` });
    assert.match(html, /^<svg class="ui-icon ui-icon--/);
    assert.match(html, /viewBox="0 0 24 24"/);
    assert.match(html, /aria-hidden="true"/);
    assert.match(html, /focusable="false"/);
    assert.match(html, /<path d="[^"]+"\/>/);
  }
  assert.match(button.renderIconSvg('bolt'), /<path d="m13 2-9 12h7l-1 8 10-13h-7z"\/>/);
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
  assert.match(css, /\.ui-button--medium\s*\{[^}]*box-sizing:\s*border-box[^}]*height:\s*34px[^}]*padding:\s*0 12px/s);
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

test('ActionButton accepts the shared bare presentation and rejects unknown presentations', () => {
  const button = require(componentPath);
  const html = button.renderActionButton({ ariaLabel: 'Fold artists', icon: 'previous', presentation: 'bare' });
  assert.match(html, /action-button action-button--bare/);
  assert.throws(
    () => button.renderActionButton({ ariaLabel: 'Wrong presentation', presentation: 'floating' }),
    /Unknown ActionButton presentation/,
  );
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
  assert.match(css, /\.action-button\[aria-busy='true'\][^{]*::before\s*\{[^}]*animation:\s*spin/s);
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

test('external service links render safe plain anchors with a decorative icon slot', () => {
  const button = require(componentPath);
  const mbid = 'c0926f5d-098c-4f29-a463-5489b43a273a';
  assert.equal(
    button.renderExternalServiceLink({ service: 'musicbrainz', href: `https://musicbrainz.org/artist/${mbid}`, subject: 'Neal Morse' }),
    `<a class="ui-external-link ui-external-link--musicbrainz" href="https://musicbrainz.org/artist/${mbid}" target="_blank" rel="noopener noreferrer" aria-label="Open Neal Morse on MusicBrainz">`
      + '<span class="ui-external-link__icon" aria-hidden="true"></span><span class="ui-external-link__text">MusicBrainz</span></a>',
  );
  assert.match(button.renderExternalServiceLink({ service: 'discogs', href: 'https://www.discogs.com/artist/309345' }),
    /^<a class="ui-external-link ui-external-link--discogs" href="https:\/\/www\.discogs\.com\/artist\/309345"[^>]*aria-label="Open on Discogs">/);
  assert.equal(button.renderExternalServiceLink({ service: 'discogs', href: 'https://evil.example/artist/1' }), '');
  assert.throws(() => button.renderExternalServiceLink({ service: 'invented', href: 'https://example.com' }), /Unknown external service/);
});

test('external service link CSS uses panel text, a non-colour cue and the real service favicons', () => {
  const css = fs.readFileSync(path.join(repoRoot, 'music_app', 'static', 'css', 'button-component.css'), 'utf8');
  const rules = new Map([...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(([, selector, body]) => [selector.trim(), body]));
  const rule = (selector) => {
    assert.ok(rules.has(selector), `missing rule ${selector}`);
    return rules.get(selector);
  };
  assert.match(rule('.ui-external-link'), /color:\s*inherit;/, 'link text uses the surrounding text colour, not the link accent');
  assert.match(rule('.ui-external-link'), /text-decoration:\s*none;/);
  assert.match(rule('.ui-external-link:hover'), /text-decoration:\s*underline/);
  assert.match(rule('.ui-external-link:focus-visible'), /text-decoration:\s*underline;\s*text-decoration-thickness:\s*2px/,
    'keyboard focus shows a thicker underline');
  assert.match(rule('.ui-external-link'), /outline:\s*none/, 'no outline box in any state, including the browser focus ring');
  assert.match(rule('.ui-external-link-list'), /display:\s*flex;\s*flex-wrap:\s*wrap;\s*align-items:\s*center;\s*justify-content:\s*flex-start;\s*gap:\s*8px 16px/,
    'links share one left-aligned row with a normal inline gap');
  assert.doesNotMatch(rule('.ui-external-link-list'), /flex-direction:\s*column/);

  const icon = rule('.ui-external-link__icon');
  assert.match(icon, /width:\s*16px;/);
  assert.match(icon, /height:\s*16px;/);
  assert.match(icon, /background:\s*var\(--ui-external-link-icon\) center \/ 16px 16px no-repeat/);
  const externalLinkRules = [...rules].filter(([selector]) => selector.includes('.ui-external-link'));
  assert.ok(externalLinkRules.length >= 6);
  for (const [selector, body] of externalLinkRules) {
    assert.doesNotMatch(body, /mask/, `${selector}: icons keep their own colours instead of a single-colour mask`);
    assert.doesNotMatch(body, /outline:(?!\s*none)|box-shadow|border:/, `${selector}: no outline box in any state`);
  }

  const icons = path.join(repoRoot, 'music_app', 'static', 'images', 'icons');
  for (const service of ['musicbrainz', 'discogs']) {
    assert.ok(rule(`.ui-external-link--${service}`).includes(`url("/static/images/icons/${service}-favicon-32.png")`));
    const png = fs.readFileSync(path.join(icons, `${service}-favicon-32.png`));
    assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG');
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [32, 32], `${service} favicon is a 32 px PNG drawn at 16 px`);
  }
  assert.ok(fs.existsSync(path.join(icons, 'SERVICE-FAVICONS-NOTICE.txt')), 'the trademark and licence note stays next to the icons');
  assert.ok(!fs.existsSync(path.join(icons, 'simple-icons-musicbrainz.svg')) && !fs.existsSync(path.join(icons, 'simple-icons-discogs.svg')));

  assert.match(rule(":root:not([data-appearance-mode='light']) .ui-external-link--discogs .ui-external-link__icon"), /^\s*filter:\s*invert\(1\);\s*$/,
    'dark themes, including the default, show the Discogs record in white');
  assert.equal((css.match(/invert\(/g) || []).length, 1, 'only the dark Discogs icon is inverted');
  for (const [selector, body] of externalLinkRules.filter(([selector]) => selector.includes('--musicbrainz'))) {
    assert.doesNotMatch(body, /filter/, `${selector}: the MusicBrainz hexagon is never recoloured`);
  }
});
