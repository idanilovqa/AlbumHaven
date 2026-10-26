const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..', '..');

test('compatibility-sensitive source-indicator migrations retain canonical LF bytes', () => {
  const attributes = fs.readFileSync(path.join(root, '.gitattributes'), 'utf8');

  for (const migration of [
    '0082_library_source_indicators.sql',
    '0087_library_source_indicators.sql',
  ]) {
    assert.match(
      attributes,
      new RegExp(`^migrations/postgres/${migration.replace('.', '\\.')}`
        + ' text eol=lf$', 'm'),
      `${migration} must be checked out with the bytes recorded in the migration ledger`,
    );
  }
});
