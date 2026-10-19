'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {readRepo} = require('./native-home-harness.cjs');
const shared = () => readRepo('music_app/static/css/runtime/non-album-and-player.css');
const collection = () => readRepo('music_app/static/css/runtime/collection-surfaces.css');
const normal = value => value.replace(/\s+/g, ' ').trim();
const uncomment = value => value.replace(/\/\*[\s\S]*?\*\//g, '');
function block(css, selector) {
  css = uncomment(css);
  const escaped = selector.trim().split(/\s+/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
  const match = new RegExp('(?:^|[{}])\\s*' + escaped + '\\s*\\{').exec(css);
  assert.ok(match, `exact shared selector ${selector}`); const open = match.index + match[0].lastIndexOf('{');
  let depth = 1, end = open + 1;
  for (; end < css.length && depth; end++) {if (css[end] === '{') depth++; else if (css[end] === '}') depth--;}
  assert.equal(depth, 0); return css.slice(open + 1, end - 1);
}
const declarations = body => Object.fromEntries(body.split(';').map(value => value.trim()).filter(Boolean).map(value => {
  const at = value.indexOf(':'); assert.ok(at > 0); return [value.slice(0, at).trim(), normal(value.slice(at + 1)).replace(/\s*,\s*/g, ',')];
}));
const rules = css => [...uncomment(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(match => ({selector: normal(match[1]), body: match[2]}));

// J8: source-level contracts only; these are deliberately not pixel claims.
test('shared opt-in joined primitive has two desktop columns, no nested panel shells and only an adjacent-pane separator', () => {
  const css = shared(), grid = declarations(block(css, '.app-form-joined'));
  assert.deepEqual(grid, {display: 'grid', 'grid-template-columns': 'repeat(2,minmax(0,1fr))', gap: '16px', 'min-width': '0'});
  assert.deepEqual(declarations(block(css, '.app-form-joined > .app-form-joined__pane')), {'min-width': '0'});
  assert.deepEqual(declarations(block(css, '.app-form-joined > .app-form-joined__pane + .app-form-joined__pane')),
    {'border-inline-start': '1px solid var(--border)', 'padding-inline-start': '16px'});
  assert.ok(block(css, '.app-form-joined__title').trim());
  for (const rule of rules(css).filter(rule => rule.selector.includes('.app-form-joined'))) {
    assert.doesNotMatch(rule.body, /(?:^|;)\s*(?:background(?:-[\w-]+)?|box-shadow|border-radius|border|border-width|border-color)\s*:/);
  }
});

test('only a non-mobile native modal containing the joined opt-in receives the wider width', () => {
  const css = shared(), selector = '#app-form-modal:not(.is-mobile-page) > .confirm-modal-dialog:has(.app-form-joined)';
  assert.deepEqual(declarations(block(css, selector)), {width: 'min(960px,calc(100vw - 32px))', 'max-width': '100%'});
  const widened = rules(css).filter(rule => /960px/.test(rule.body)); assert.equal(widened.length, 1); assert.equal(widened[0].selector, selector);
  assert.deepEqual(declarations(block(css, '#app-form-modal .confirm-modal-dialog')),
    {'box-sizing': 'border-box', display: 'flex', 'flex-direction': 'column', 'max-height': '100%', overflow: 'visible'});
  assert.deepEqual(declarations(block(css, '#app-form-content')),
    {'min-height': '0', padding: '4px', 'overflow-y': 'auto', 'overscroll-behavior': 'contain'});
  assert.deepEqual(declarations(block(css, '#app-form-modal .confirm-modal-title, #app-form-modal .confirm-modal-actions, #app-form-error')),
    {flex: '0 0 auto'});
});

test('narrow joined media rule preserves DOM order with one column and a horizontal separator', () => {
  const css = shared(), media = [...css.matchAll(/@media\s*\(max-width:\s*720px\)/g)]
    .map(match => block(css.slice(match.index), match[0])).filter(body => body.includes('.app-form-joined'));
  assert.equal(media.length, 1); const narrow = media[0];
  assert.deepEqual(declarations(block(narrow, '.app-form-joined')), {'grid-template-columns': 'minmax(0,1fr)'});
  assert.deepEqual(declarations(block(narrow, '.app-form-joined > .app-form-joined__pane + .app-form-joined__pane')),
    {'border-inline-start': '0', 'padding-inline-start': '0', 'border-block-start': '1px solid var(--border)', 'padding-block-start': '16px'});
  assert.doesNotMatch(narrow, /(?:^|[;{])\s*(?:order|grid-area|grid-row|grid-column)\s*:/);
});

test('Share content remains flat flex columns with unchanged fixed-height member/source scroll owners', () => {
  const css = collection(), content = rules(css).find(rule => rule.selector.includes('.album-top-share__people')
    && rule.selector.includes('.album-top-share__public') && rule.selector.includes('.album-top-share__publication-preview'));
  assert.ok(content); assert.deepEqual(declarations(content.body), {display: 'flex', 'flex-direction': 'column', gap: '8px', 'min-width': '0'});
  assert.deepEqual(declarations(block(css, '.album-top-share :is(.album-top-share__member-results, .album-top-share__source-results)')),
    {height: 'min(18rem,40vh)', 'min-height': '8rem', overflow: 'auto', 'overscroll-behavior': 'contain',
      'min-width': '0', 'max-width': '100%', 'box-sizing': 'border-box', padding: '4px'});
  assert.doesNotMatch(css, /\.album-top-share[^{}]*\[hidden\][^{]*\{/);
  assert.doesNotMatch(css, /\.album-top-share[^{}]*(?:tablist|tabpanel|panes-tabs)[^{]*\{/);
});
