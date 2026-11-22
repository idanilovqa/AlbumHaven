const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const css = fs.readFileSync(path.join(
  __dirname, '..', '..', '..', 'music_app', 'static', 'css', 'runtime', 'cover-lookup-modal.css',
), 'utf8').replace(/\r\n/g, '\n');

function declarations(selector) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, selectors]) => selectors.replace(/\/\*[\s\S]*?\*\//g, '').split(',').map((part) => part.trim()).includes(selector))
    .map(([, , body]) => body)
    .join(';');
}

test('the shared modal header keeps the title and X on one centre line, as Cover Art Look Up does', () => {
  assert.equal(declarations('.ui-modal-header'), declarations('.cover-lookup-modal-header'));
  assert.match(declarations('.ui-modal-header'), /align-items:\s*center/);
  assert.equal(declarations('.ui-modal-title'), declarations('.cover-lookup-modal-title'));
  assert.match(declarations('.ui-modal-header--compact'), /padding:\s*12px 12px 12px 16px/);
});
