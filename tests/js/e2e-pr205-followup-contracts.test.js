const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadActions(file, className, supplied = {}) {
  const context = {
    assert: { ...assert, deepEqual: (actual, expected) => assert.deepEqual(
      JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)),
    ) },
    ...supplied,
  };
  const source = fs.readFileSync(path.resolve(__dirname, '../e2e/actions', file), 'utf8')
    .replace(/^import[\s\S]*?;\r?\n/gm, '').replace('export class ', 'class ');
  vm.runInNewContext(source + `;globalThis.Actions = ${className};`, context);
  return context.Actions;
}

for (const selection of ['album', 'album-and-independent-file', 'file-only']) {
  test(`exclusion confirmation preserves labels and verifies the canonical ${selection} request`, async () => {
    const albumKey = 'fixture::album';
    const reason = 'Undecoded characters';
    const albumRow = { row_key: 'album::encoding', album_key: albumKey, reason, display_reason: reason };
    const rows = Array.from({ length: 18 }, (_, index) => ({
      path: `fixture/track-${index + 1}.mp3`, filename: `track-${index + 1}.mp3`,
      ignorable_reasons: [{ row_key: `file-${index + 1}::encoding`, reason }],
    }));
    rows[0].ignorable_reasons.push({ row_key: 'file-1::title', reason: 'Missing title' });
    const albumSelected = selection !== 'file-only';
    const independentSelected = selection === 'album-and-independent-file';
    const selected = albumSelected
      ? [{ scope: 'album', canonicalReason: reason }, ...rows.map(row => ({ scope: 'file', key: row.ignorable_reasons[0].row_key }))]
      : [{ scope: 'file', key: 'file-1::encoding' }];
    if (independentSelected) selected.push({ scope: 'file', key: 'file-1::title' });
    const confirmationTargets = [
      ...(albumSelected ? [`Album — ${reason}`] : []),
      ...rows.flatMap((row, index) => [
        ...(albumSelected || index === 0 ? [`${row.filename} — ${reason}`] : []),
        ...(independentSelected && index === 0 ? [`${row.filename} — Missing title`] : []),
      ]),
    ];
    const confirmation = `Create an exclusion rule for ${confirmationTargets.join('; ')}? These problems will be hidden. You can revert this rule in Rules.`;
    const events = [];
    const Actions = loadActions('utilityProblematicFilesActions.js', 'UtilityProblematicFilesActions', {
      authenticatedPageGet: async (_page, url) => {
        assert.equal(url, '/utilities/problematic-files/detail?album_key=' + encodeURIComponent(albumKey));
        return { ok: () => true, json: async () => ({ key: albumKey, name: 'Album', album_problem_rows: [albumRow], track_problem_rows: rows }) };
      },
    });
    const actions = new Actions({
      page: {}, activeListItem: { getAttribute: async () => albumKey },
      excludeProblemButton: { click: async () => events.push('open-native-confirmation') },
      exclusionConfirmDialog: {}, waitForVisible: async () => events.push('confirmation-visible'),
      exclusionConfirmText: { textContent: async () => confirmation },
    });
    actions.readSelectedProblemInstances = async () => selected;
    assert.equal(await actions.openExclusionConfirmation(), confirmation);
    const expected = [
      ...(albumSelected ? [{ row_key: albumRow.row_key, scope: 'album', album_key: albumKey }] : [{ row_key: 'file-1::encoding', scope: 'file', path: rows[0].path }]),
      ...(independentSelected ? [{ row_key: 'file-1::title', scope: 'file', path: rows[0].path }] : []),
    ];
    actions.verifyExclusionRequest({ postDataJSON: () => ({ items: expected }) });
    assert.deepEqual(events, ['open-native-confirmation', 'confirmation-visible']);
    assert.throws(() => actions.verifyExclusionRequest({ postDataJSON: () => ({ items: [] }) }));
    if (albumSelected) {
      assert.throws(() => actions.verifyExclusionRequest({ postDataJSON: () => ({ items: [...expected,
        { row_key: 'file-1::encoding', scope: 'file', path: rows[0].path }] }) }));
    }
  });
}

for (const method of ['pressSpaceBeforeLoopOwnership', 'pressNeutralSpaceForOwnedLoop',
  'pressNeutralSpaceAfterGlobalReclaim', 'pressSpaceAfterLoopOwnershipReset']) {
  test(`${method} sends real Space to the neutral body, never the native navigation button`, async () => {
    const events = [];
    const title = { click: async () => events.push('click-neutral-heading') };
    let focused = false;
    const neutral = {
      focus: async () => { focused = true; events.push('focus-neutral-body'); },
      press: async key => { assert.equal(focused, true); assert.equal(key, 'Space'); events.push('native-space'); },
    };
    const Actions = loadActions('utilityLoopsActions.js', 'UtilityLoopsActions', {
      expect: element => ({
        toHaveText: async value => { assert.equal(element, title); assert.equal(value, 'Track'); events.push('verify-group-title'); },
        toBeFocused: async () => { assert.equal(element, neutral); assert.equal(focused, true); events.push('check-retained-focus'); },
      }),
    });
    const actions = new Actions({
      loopTree: { groupButtonByTitle() { assert.fail('The native group button is not a neutral Space target.'); } },
      loopEntryCard: { detailTitle: title }, neutralKeyboardTarget: neutral,
    });
    const expected = { paused: true };
    const options = { afterSpace: async () => events.push('verify-global-playback') };
    actions.waitForLoopPlaybackState = async (id, state) => {
      assert.equal(id, 'loop-id'); assert.equal(state, expected); events.push('verify-owned-loop'); return state;
    };
    const arguments_ = method === 'pressNeutralSpaceForOwnedLoop' || method === 'pressNeutralSpaceAfterGlobalReclaim'
      ? ['Track', 'loop-id', expected, options] : ['Track', options];
    await actions[method](...arguments_);
    assert.deepEqual(events.slice(0, 5), ['verify-group-title', 'click-neutral-heading', 'focus-neutral-body', 'check-retained-focus', 'native-space']);
    assert.equal(events.at(-1), 'check-retained-focus');
    if (method !== 'pressNeutralSpaceForOwnedLoop') assert.ok(events.includes('verify-global-playback'));
    if (arguments_.length === 4) assert.ok(events.includes('verify-owned-loop'));
  });
}
