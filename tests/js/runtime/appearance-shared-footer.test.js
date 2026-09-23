const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Appearance removes the page footer host when the modal footer owns the actions', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../../../music_app/static/js/appearance-backgrounds.js'),
    'utf8',
  );

  assert.match(
    source,
    /if \(mountedFooter === dialogHost\) \{[\s\S]*?localHost\.remove\(\);[\s\S]*?dialogHost\.hidden = false;/,
  );
  assert.match(
    source,
    /mountedFooter = window\.EditorPage\?\.mountFooter && dialogHost \? dialogHost : localHost;/,
    'standalone Appearance mounts must retain the local footer fallback',
  );
});
