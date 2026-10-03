const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function scenario(source, title, nextTitle) {
  const startMarker = `test('${title}'`;
  const endMarker = `test('${nextTitle}'`;
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `Missing scenario: ${title}`);
  assert.ok(end > start, `Missing scenario boundary after: ${title}`);
  return source.slice(start, end);
}

test('cover-provider scenarios assert the runtime-visible short provider labels', () => {
  const source = read('tests/e2e/specs/coverLookup.spec.js');
  const loading = scenario(
    source,
    'FTC-COVERS-022 cover gallery loading starts before the task list responds',
    'FTC-COVERS-012 fake-album fast cover search appears in the drawer and can be canceled and cleared',
  );
  const storage = scenario(
    source,
    'FTC-COVERS-019 Spotify stays linked while a downloadable provider reopens locally',
    'FTC-COVERS-011 selected local art remains authoritative after rescan and app restart',
  );
  const progressive = scenario(
    source,
    'FTC-COVERS-017 manual lookup progressively retains provider alternatives',
    'FTC-COVERS-020 provider deadline keeps candidates found by earlier services',
  );
  const deadline = scenario(
    source,
    'FTC-COVERS-020 provider deadline keeps candidates found by earlier services',
    'FTC-COVERS-021 artist conjunction differences still publish a visible remote candidate',
  );

  assert.match(loading, /candidate\.source\.toLocaleLowerCase\(\) === 'apple'/);
  assert.match(storage, /candidate\.source\.toLocaleLowerCase\(\) === 'apple'/);
  assert.match(progressive, /candidate\.source === 'CAA'/);
  assert.match(deadline, /candidate\.source === 'Apple'/);
});

test('cover lookup scenarios keep full modal identity and album-only drawer identity', () => {
  const source = read('tests/e2e/specs/coverLookup.spec.js');
  const matching = read('tests/e2e/specs/coverLookupMatching.spec.js');
  const persistence = scenario(
    source,
    'FTC-COVERS-013 partial cover results survive drawer reopen, save cancellation, and reload',
    'FTC-COVERS-019 Spotify stays linked while a downloadable provider reopens locally',
  );

  assert.match(persistence, /taskTitle = PARTIAL_COVER_LOOKUP_TARGET\.album;/);
  assert.match(
    persistence,
    /expect\(modal\.subtitle\)\.toBe\(Object\.values\(PARTIAL_COVER_LOOKUP_TARGET\)\.join\(' - '\)\)/,
  );
  assert.match(matching, /const taskTitle = TARGET\.album;/);
  assert.match(
    matching,
    /expect\(await coverLookupActions\.readModalSubtitle\(\)\)\s*\.toBe\(Object\.values\(TARGET\)\.join\(' - '\)\)/,
  );
});
