'use strict';
// Execute only under the root-authorized runner. Whole native owners, no builder
// replacement, source rewriting, browser, application bootstrap or database.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = process.env.ALBUM_TOP_TEST_ROOT || path.resolve(__dirname, '../../..');
const read = relative => fs.readFileSync(path.join(ROOT, 'music_app/static', relative), 'utf8');
const css = () => read('css/runtime/album-artbox-and-gallery-card.css');
const marker = 'album-card--search-match';
function owner() {
  const context = vm.createContext({});
  context.window = context;
  for (const relative of ['js/button-component.js', 'js/runtime/markup-format-helpers.js',
    'js/runtime/gallery-main-components.js', 'js/runtime/gallery-card-component.js']) {
    vm.runInContext(read(relative), context, {filename: relative});
  }
  return config => context.buildGalleryCardHtml(config);
}
const config = (interaction, displayMode = 'cards') => ({interaction, displayMode,
  identity: 'search-card-0', renderKey: 'render-0', title: 'A record', artist: 'An artist',
  year: '2026', trackCount: 3, lengthDisplay: '10m', albumKey: 'album-safe-key',
  albumVersionKey: 'version-safe-key', albumFallback: 'safe-album',
  artboxHtml: '<div class="album-artbox album-artbox--empty"></div>',
  actionRef: 'search-action-0', actions: {open: true, play: true, select: true}});
const rootClasses = html => html.match(/<section class="([^"]+)"/)[1].split(/\s+/u);
const withoutMarker = html => html.replace(` ${marker}`, '');
// Parse declarations from flat native CSS rules, not computed browser styles.
function rules(source) {
  return [...source.replace(/\/\*[\s\S]*?\*\//gu, '').matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
    .map(([, selector, body]) => ({selector: selector.trim(), body,
      declarations: Object.fromEntries(body.split(';').map(x => x.trim()).filter(Boolean)
        .map(x => {const at = x.indexOf(':'); return [x.slice(0, at).trim(), x.slice(at + 1).trim()];}))}));
}
for (const interaction of ['native', 'controlled', 'none']) {
  for (const displayMode of ['cards', 'list', 'covers']) {
    test(`${interaction}/${displayMode}: explicit witness adds only the native root modifier`, () => {
      const build = owner(), input = config(interaction, displayMode);
      const before = build(input), matching = build({...input, isSearchMatch: true});
      assert.ok(rootClasses(matching).includes(marker), 'an admitted witness must have a match modifier');
      assert.equal(rootClasses(matching).filter(value => value === marker).length, 1);
      assert.equal(withoutMarker(matching), before, 'match presentation must not change controls, content or identity');
      assert.equal(build({...input, isSearchMatch: false}), before, 'clear removes match without removing the card');
    });
  }
  test(`${interaction}: default and nonboolean inputs never mark or grant authority`, () => {
    const build = owner(), input = config(interaction), before = build(input);
    for (const value of [undefined, false, null, 0, 1, '', 'true', 'false', {}, []]) {
      assert.equal(build({...input, isSearchMatch: value}), before);
    }
    assert.equal(rootClasses(before).includes(marker), false);
  });
  test(`${interaction}: marked title, identity and action reference preserve native escaping`, () => {
    const build = owner(), input = {...config(interaction), title: '<img src=x onerror="bad">',
      identity: 'card" data-injected="bad', renderKey: 'render" data-injected="bad',
      albumKey: 'album" data-injected="bad', actionRef: 'safe" data-injected="bad'};
    const html = build({...input, isSearchMatch: true});
    assert.ok(rootClasses(html).includes(marker));
    assert.equal(withoutMarker(html), build(input));
    assert.doesNotMatch(html, /<img src=x| data-injected="bad/u);
    assert.match(html, /&lt;img src=x onerror=&quot;bad&quot;&gt;/u);
    assert.match(html, /data-gallery-card-key="card&quot; data-injected=&quot;bad"/u);
  });
}
test('controlled and inert witness cards cannot acquire native hooks or ungranted actions', () => {
  const build = owner();
  for (const interaction of ['controlled', 'none']) {
    for (const actions of [{}, {open: true}, {select: true}, {play: true}]) {
      const input = {...config(interaction), actions};
      const html = build({...input, isSearchMatch: true});
      assert.equal(withoutMarker(html), build(input));
      assert.doesNotMatch(html, /data-open-tracklist|data-album-key|data-album-version-key|album-open-trigger/u);
      for (const intent of ['open', 'select', 'play']) {
        assert.equal(html.includes(`data-gallery-card-intent="${intent}"`), interaction === 'controlled' && actions[intent] === true);
      }
    }
    const html = build({...config(interaction), isSearchMatch: true, actionRef: ''});
    assert.doesNotMatch(html, /data-gallery-card-intent/u);
  }
});
test('shared card CSS owns persistent witness treatment with native appearance accent', () => {
  const matchRules = rules(css()).filter(rule => rule.selector.includes(`.${marker}`));
  assert.ok(matchRules.length, 'native shared card CSS must define the match state');
  const idle = matchRules.find(rule => rule.selector.split(',').some(selector =>
    /^\.album-card\.album-card--search-match$/u.test(selector.trim())));
  assert.ok(idle, 'match must be visible without focus, hover or selection');
  assert.equal(idle.declarations['--album-card-search-accent'],
    'var(--appearance-player-accent, var(--appearance-waveform-edge, var(--appearance-accent, var(--accent, #55c7ff))))');
  assert.match(idle.body, /(?:background|border-color|box-shadow|filter)\s*:[^;]*var\(--album-card-search-accent\)/u);
  // Match styling cannot take ownership of focus, selected/pressed state or layout.
  for (const rule of matchRules) {
    assert.doesNotMatch(rule.selector, /:focus|aria-pressed|is-selected|::before|::after/u);
    for (const property of ['outline', 'outline-offset', 'transform', 'display', 'position', 'padding', 'margin', 'height', 'width']) {
      assert.equal(rule.declarations[property], undefined, `match must not alter ${property}`);
    }
    assert.doesNotMatch(rule.body, /appearance-(?:focus|interaction|selected)/u);
  }
});
test('native controlled keyboard focus and selected outlines remain independent of witness state', () => {
  const source = rules(css());
  for (const suffix of [':focus-visible', '[aria-pressed="true"]']) {
    const rule = source.find(value => value.selector === `.album-card[data-gallery-card-interaction] [data-gallery-card-intent="select"]${suffix}`);
    assert.ok(rule, `existing ${suffix} rule remains available`);
    assert.match(rule.declarations.outline, /^2px solid var\(--appearance-interaction-outline,/u);
    assert.equal(rule.declarations['outline-offset'], '-2px');
    assert.doesNotMatch(rule.body, /album-card-search-accent/u);
  }
});
test('native hover and focus glow stays on its original non-search owner', () => {
  const source = rules(read('css/runtime/non-album-and-player.css'));
  const rule = source.find(value => value.selector === '.album-card:hover::before,\n.album-card:focus-within::before');
  assert.ok(rule);
  assert.equal(rule.declarations.opacity, '1');
  assert.equal(rule.declarations.filter, 'blur(26px)');
  assert.equal(rule.declarations.transform, 'scale(1.03)');
  assert.doesNotMatch(rule.body, /album-card-search-accent/u);
});

test('witness owns a root drop-shadow independent of opaque children and native interaction paint', () => {
  // index.html loads non-album-and-player.css after this shared card owner.
  // Its equally specific :hover/:focus-within rule changes border and box-shadow;
  // .album-body and .album-artbox also paint over a root background. Inspect the
  // owner contract directly rather than pretending to calculate browser pixels.
  const matchRules = rules(css()).filter(rule => rule.selector.includes(`.${marker}`));
  const idle = matchRules.find(rule => rule.selector.split(',').some(selector =>
    selector.trim() === '.album-card.album-card--search-match'));
  assert.ok(idle, 'shared root match selector is required');
  assert.match(idle.declarations.filter || '',
    /^drop-shadow\([^;]*var\(--album-card-search-accent\)[^;]*\)$/u,
    'witness requires its own accent drop-shadow; root background and border alone can disappear');
  for (const rule of matchRules) {
    assert.equal(rule.declarations['box-shadow'], undefined,
      'witness must not replace the native elevation or hover/focus shadow');
    assert.doesNotMatch(rule.selector, /::before|::after|:hover|:focus/u,
      'persistent witness paint must not commandeer interaction pseudo-elements or states');
  }
});
