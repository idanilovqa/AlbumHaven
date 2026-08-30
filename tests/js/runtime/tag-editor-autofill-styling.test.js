const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const utilitiesCss = fs.readFileSync(
  path.join(
    __dirname,
    '..',
    '..',
    '..',
    'music_app',
    'static',
    'css',
    'runtime',
    'utilities.css',
  ),
  'utf8',
);

test('tag editor autofill keeps the same field colors as ordinary inputs', () => {
  const autofillRule = utilitiesCss.match(
    /\.tag-editor-form input:autofill,\s*\.tag-editor-form input:-webkit-autofill\s*\{([^}]*)\}/,
  );

  assert.ok(autofillRule, 'Expected a tag-editor-scoped autofill rule.');
  assert.match(autofillRule[1], /-webkit-text-fill-color:\s*var\(--text\)/);
  assert.match(autofillRule[1], /caret-color:\s*var\(--text\)/);
  assert.match(
    autofillRule[1],
    /background-color\s+9999s\s+ease-out\s+0s/,
  );
});
