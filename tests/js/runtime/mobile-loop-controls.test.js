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


test('mobile loop detail requires an explicit, current song ID and resolves the whole group', () => {
  const loops = [{ id: 'one', song_key: 'track:1' }, { id: 'two', song_key: 'track:1' }];
  const context = load('mobile-navigation.js', {
    state: { utility: { activeTab: 'loops' } }, window: { innerWidth: 390 },
    buildUtilityLoopGroupKey: loop => loop.song_key,
    groupUtilityLoops: items => [{ key: 'track:1', loops: items }],
  });
  assert.equal(context.resolveMobileLoopSongGroup({ tab: 'loops' }, loops), null);
  assert.equal(context.resolveMobileLoopSongGroup({ tab: 'loops', loopSongId: 'removed' }, loops), null);
  assert.equal(context.resolveMobileLoopSongGroup({ tab: 'appearance', loopSongId: 'one' }, loops), null);
  assert.equal(context.resolveMobileLoopSongGroup({ tab: 'loops', loopSongId: 'two' }, loops).loops.length, 2);
  vm.runInContext("mobilePageState.pages.push({kind:'utilities',tab:'loops'})", context);
  assert.equal(context.getMobileLoopPage().tab, 'loops');
  context.window.innerWidth = 901;
  assert.equal(context.getMobileLoopPage(), null);
});

test('song activation snapshots the filtered index before pushing detail; Back follows that parent', () => {
  const loops = [{ id: 'first', song_key: 'track:1' }, { id: 'second', song_key: 'track:1' }];
  const writes = [], traversals = [];
  const outlet = { scrollTop: 123 };
  const context = load('mobile-navigation.js', {
    state: { utility: { activeTab: 'loops', loops, loopsSearchQuery: 'Bridge' } },
    window: { innerWidth: 390, history: { state: { albumHavenNavigationPosition: 5 }, go: delta => traversals.push(delta) } },
    document: { getElementById: id => id === 'mobile-page-outlet' ? outlet : { focus() {} } },
    buildUtilityLoopGroupKey: loop => loop.song_key,
    groupUtilityLoops: items => [{ key: 'track:1', loops: items }],
    closeGalleryMainSurface() {}, renderUtilityModalContent() {},
  });
  vm.runInContext("mobilePageState.pages.push({kind:'utilities',tab:'loops'})", context);
  context.writeMobilePageHistory = mode => writes.push({ mode: mode || 'push', ...context.getMobileLoopPage() });
  assert.equal(context.openMobileLoopSong('missing'), false);
  assert.equal(writes.length, 0);
  assert.equal(context.openMobileLoopSong('track:1'), true);
  assert.equal(writes.length, 2);
  assert.equal(writes[0].mode, 'replace');
  assert.equal(writes[0].loopSongId, undefined);
  assert.equal(writes[0].loopListScroll, 123);
  assert.equal(writes[0].loopFilter, 'Bridge');
  assert.equal(writes[1].mode, 'push');
  assert.equal(writes[1].loopSongId, 'first');
  assert.equal(outlet.scrollTop, 0);
  context.window.history.state.albumHavenNavigationPosition = 6;
  assert.equal(context.returnMobileLoopList(), true);
  assert.deepEqual(traversals, [-1]);
});

test('the mobile index mounts no loop players, and a song detail ignores the index filter', () => {
  const loops = [1, 2, 3, 4].map(id => ({ id: String(id), song_key: 'track:1' }));
  const page = { tab: 'loops' }, group = { key: 'track:1', loops };
  const detail = { classList: { add() {} }, innerHTML: 'old' };
  const els = { overlay: { hidden: false, dataset: {} }, list: {}, detail, count: {}, search: {} };
  const initialized = [], lists = [];
  const context = load('utility-renderers-and-actions.js', {
    state: { utility: { activeTab: 'loops', loops, loopsLoaded: true, loopsSearchQuery: 'one clip' } },
    getUtilityModalElements: () => els, getMobileLoopPage: () => page,
    resolveMobileLoopSongGroup: () => page.loopSongId ? group : null,
    getFilteredUtilityLoops: () => [loops[0]], groupUtilityLoops: () => [group],
    getSelectedUtilityLoopGroup: () => group,
    pauseOtherUtilityLoopPlayback() {}, clearUtilityLoopSpaceOwner() {}, restoreMobileLoopListScroll() {},
    buildUtilityLoopDetail: value => { assert.equal(value.loops.length, 4); return 'four players'; },
    initializeUtilityLoopPlayer: loop => initialized.push(loop.id), updateUtilityLoopRepeatButton() {},
  });
  context.renderUtilityLoopList = (_els, items) => lists.push(items.length);
  context.bindUtilityLoopDragAndDrop = () => {};
  context.syncUtilityLoopPanelVisibility = () => {};
  context.renderUtilityLoops();
  assert.equal(els.overlay.dataset.mobileLoopView, 'list');
  assert.equal(detail.innerHTML, '');
  assert.equal(initialized.length, 0);
  assert.deepEqual(lists, [1]);
  page.loopSongId = '1';
  context.renderUtilityLoops();
  assert.equal(els.overlay.dataset.mobileLoopView, 'song');
  assert.equal(detail.innerHTML, 'four players');
  assert.deepEqual(initialized, ['1', '2', '3', '4']);
});


test('loop picker aligns selected row near the player without going below it', () => {
  const option = { offsetTop: 114, getBoundingClientRect: () => ({ height: 36 }) };
  const menu = { hidden: false, style: {}, classList: { contains: () => true }, querySelector: () => option, getBoundingClientRect: () => ({ width: 168, height: 248 }) };
  const trigger = { getBoundingClientRect: () => ({ top: 710, height: 36, right: 366 }) };
  const context = load('utility-loop-playback.js', { cssEscape: String, window: { innerWidth: 390, innerHeight: 844 },
    document: { querySelector: selector => selector === '.global-player' ? { getBoundingClientRect: () => ({ top: 769 }) } : selector.includes('value-button') ? trigger : menu } });
  context.positionUtilityLoopSpeedMenu('test');
  const top = parseFloat(menu.style.top), height = parseFloat(menu.style.maxHeight);
  assert.equal(top + option.offsetTop + 18 - menu.scrollTop, 728);
  assert.ok(top + height <= 761);
});
