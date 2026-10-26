'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const N = require('./foobar-account-import-native-fixture.cjs');
const F = require('./foobar-account-import-fixture.cjs');

test('idle guidance does not restrict the Enhanced SQLite selection to TSV', async t => {
  const f = await N.native(t), mapping = f.field('mapping');
  // Use the actual option value rather than invent a second mapping contract.
  const enhanced = mapping.querySelectorAll('option').find(option => /SQLite/.test(option.textContent));
  assert.ok(enhanced); mapping.value = enhanced.value; f.change(mapping); await F.settle();
  assert.doesNotMatch(f.host.textContent, /Choose a supported TSV file to begin\./);
});

test('import guidance distinguishes unresolved TSV time from incomplete Enhanced instants', async t => {
  const f = await N.native(t), copy = f.host.textContent;
  assert.match(copy, /UTC offset/i);
  assert.match(copy, /raw (?:text|timestamp|date|value)/i);
  assert.match(copy, /unresolved[^.]*timezone|timezone[^.]*unresolved/i);
  assert.match(copy, /(?:do not|never|not)[^.]*guess/i);
  assert.match(copy, /FILETIME/i);
  assert.match(copy, /incomplete/i);
  assert.match(copy, /(?:not|never)[^.]*full|full[^.]*not/i);
});

test('import guidance separates a new manual snapshot from exact-file recovery and explains privacy', async t => {
  const f = await N.native(t), copy = f.host.textContent;
  assert.match(copy, /export a new file|re-export/i);
  assert.match(copy, /later (?:activity|playback)|data changes/i);
  assert.match(copy, /exact original file/i);
  assert.match(copy, /review[^.]*confirm/i);
  assert.match(copy, /sent to this server/i);
  assert.match(copy, /private|sensitive/i);
  assert.match(copy, /(?:does not|never)[^.]*configur/i);
  assert.match(copy, /(?:does not|never)[^.]*scripts/i);
});

test('reading guidance preserves native ownership and never imports or adds obsolete help navigation', async t => {
  const f = await N.native(t);
  assert.equal(f.host.querySelector('[data-foobar-help]'), null);
  assert.equal(f.host.querySelector('a[href="/utilities/integrations/foobar/help"]'), null);
  assert.equal(f.wire.calls.filter(call => /^\/(review|job)\/(start|resume|cancel)$/.test(call.route)).length, 0);
  assert.equal(f.action('preview').disabled, true);
  assert.equal(f.action('confirm').disabled, true);
  assert.equal(f.field('file').value, '');
});
