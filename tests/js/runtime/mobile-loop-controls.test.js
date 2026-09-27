const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ButtonComponent = require('../../../music_app/static/js/button-component.js');
const runtime = path.resolve(__dirname, '../../../music_app/static/js/runtime');
function load(file, globals = {}) {
  const context = vm.createContext({ console, ButtonComponent, ...globals });
  vm.runInContext(fs.readFileSync(path.join(runtime, file), 'utf8'), context);
  return context;
}

test('saved-loop renderer keeps one audio owner, desktop steps and a phone pitch picker', () => {
  const context = load('utility-list-builders.js', {
    window: { ButtonComponent }, state: { utility: { allowedActions: {} } },
    escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;'),
    canReorderUtilityLoop: () => false, buildUtilityLoopGroupKey: () => 'track:1',
    renderPlaybackControlCluster: () => '<div data-playback-control-variant="saved-loop"></div>',
  });
  const html = context.buildUtilityLoopEntry({ id: 'test-1', name: 'A < B', duration_seconds: 12 });
  assert.equal((html.match(/<audio\b/g) || []).length, 1);
  assert.match(html, /A &lt; B/);
  assert.match(html, /data-loop-duration="12"/);
  assert.match(html, /data-loop-pitch-value-button="test-1"/);
  assert.equal((html.match(/data-loop-pitch-option=/g) || []).length, 25);
  assert.match(html, /data-loop-pitch-step="-1"/);
  assert.match(html, /data-loop-speed-option="2.00"/);
});

test('rate controls reflect the same audio and preserve pitch while supporting 2x', () => {
  const audio = { dataset: { speed: '2', pitch: '-3' }, preservesPitch: false };
  const pitchText = {}, speedText = {}, buttonText = {}, attributes = {};
  const pitchButton = { querySelector: () => buttonText, setAttribute: (key, value) => { attributes[key] = value; } };
  const context = load('utility-loop-playback.js', { cssEscape: String,
    document: { querySelector(selector) {
      if (selector.includes('data-loop-audio')) return audio;
      if (selector.includes('data-loop-pitch-value-button')) return pitchButton;
      if (selector.includes('data-loop-pitch-control')) return pitchText;
      if (selector.includes('data-loop-speed-value-button')) return speedText;
    }, querySelectorAll: () => [] },
  });
  context.updateUtilityLoopAudioRate('test-1');
  assert.equal(audio.playbackRate, 2);
  assert.equal(audio.preservesPitch, true);
  assert.equal(speedText.textContent, '2x');
  assert.equal(pitchText.textContent, '-3 pst');
  assert.equal(buttonText.textContent, 'Pitch -3');
  assert.equal(attributes['aria-busy'], 'false');
});

test('a failed pitch preview restores the last applied pitch, not a pending choice', async () => {
  const audio = { dataset: { pitch: '2', appliedPitch: '0' }, paused: true };
  const context = load('utility-loop-playback.js', { cssEscape: String,
    document: { querySelector: selector => selector.includes('data-loop-audio') ? audio : null },
    fetch: async () => ({ ok: false, json: async () => ({ error: 'Preview failed' }) }),
    console: { error() {} }, showToast() {},
  });
  context.updateUtilityLoopAudioRate = () => {};
  await context.renderUtilityLoopPitchPreview('test-1', 4);
  assert.equal(audio.dataset.pitch, '0');
  assert.equal(audio.dataset.pitchPending, undefined);
});
