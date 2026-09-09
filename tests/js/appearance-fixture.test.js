const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const vm = require('node:vm');
const helperPath = path.resolve(__dirname, '../e2e/helpers/appearanceFixture.js');
const load = () => import(pathToFileURL(helperPath).href);
const env = { ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL: 'postgresql://album_haven_migrator_fixture@127.0.0.1/album_haven_ci_fixture' };

for (const row of [null, {
  account_id: 42, client_profile: 'desktop', revision: 17,
  palette_id: 'paper', player_recent_sets: [{ name: 'retained' }],
  waveform_recent_colors: ['#ABCDEF'], extra_future_column: 'preserve every stored column',
}]) {
  test(`appearance fixture restores the complete ${row ? 'existing row' : 'row absence'} in one transaction`, async () => {
    const helper = await load();
    const calls = [];
    const snapshot = await helper.captureAppearanceFixtureSnapshot('fixture-owner', {
      env, platform: 'linux',
      async execFileAsync(_command, args, options) {
        calls.push({ args, options });
        return { stdout: calls.length === 1 ? JSON.stringify({ account_id: 42, row }) : '' };
      },
    });
    await snapshot.restore();
    const sql = calls[1].args.at(-1);
    assert.match(sql, /begin;/i);
    assert.match(sql, /delete from app\.user_appearance_preferences[\s\S]*account_id = 42[\s\S]*client_profile = 'desktop'/i);
    assert.match(sql, /jsonb_populate_recordset\(null::app\.user_appearance_preferences/i);
    assert.match(sql, /commit;/i);
    const encodedRows = /decode\('([A-Za-z0-9+/=]+)', 'base64'\)/.exec(sql)[1];
    assert.deepEqual(JSON.parse(Buffer.from(encodedRows, 'base64')), row ? [row] : []);
    assert.match(calls[0].args.at(-1), /username_normalized/);
    assert.equal(calls.length, 2);
  });
}

test('appearance fixture rejects an unrelated database before invoking a client', async () => {
  const { captureAppearanceFixtureSnapshot } = await load();
  await assert.rejects(captureAppearanceFixtureSnapshot('fixture-owner', {
    env: { ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL: 'postgresql://album_haven_migrator@127.0.0.1/production' },
    async execFileAsync() { assert.fail('must not access an unowned database'); },
  }), /isolated Postgres setup identity/);
});

test('appearance fixture rejects a snapshot for a different account or client profile', async () => {
  const { captureAppearanceFixtureSnapshot } = await load();
  for (const row of [{ account_id: 43, client_profile: 'desktop' }, { account_id: 42, client_profile: 'mobile' }]) {
    await assert.rejects(captureAppearanceFixtureSnapshot('fixture-owner', {
      env, platform: 'linux',
      async execFileAsync() { return { stdout: JSON.stringify({ account_id: 42, row }) }; },
    }), /appearance fixture snapshot/i);
  }
});

test('appearance fixture drains the old owned app before restoring after an assertion failure', async () => {
  const { withRestoredAppearanceFixture } = await load();
  const calls = [];
  const original = new Error('original acceptance assertion');
  let restoreCalls = 0;
  let finishRestart;
  const drain = new Promise((resolve) => { finishRestart = resolve; });
  const running = withRestoredAppearanceFixture({
    username: 'fixture-owner',
    context: { async close() { calls.push('close'); } },
    managedAppLifecycle: { async restart() { calls.push('restart'); await drain; calls.push('drained'); } },
  }, async () => { calls.push('test'); throw original; }, {
    async captureSnapshot(username) {
      assert.equal(username, 'fixture-owner');
      return { async restore() { restoreCalls += 1; calls.push('restore'); } };
    },
  });
  const result = running.catch((error) => error);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(restoreCalls, 0, 'an accepted write may still be completing before the old app exits');
  finishRestart();
  assert.equal(await result, original);
  assert.deepEqual(calls, ['test', 'close', 'restart', 'drained', 'restore']);
});

test('appearance fixture retains assertion evidence and skips restoration when app shutdown is unproven', async () => {
  const { withRestoredAppearanceFixture } = await load();
  const original = new Error('original acceptance assertion');
  const cleanup = new Error('old app shutdown is unproven');
  await assert.rejects(withRestoredAppearanceFixture({
    username: 'fixture-owner',
    context: { async close() {} },
    managedAppLifecycle: { async restart() { throw cleanup; }, async reportFailure() {} },
  }, async () => { throw original; }, {
    async captureSnapshot() { return { async restore() { assert.fail('unsafe restoration'); } }; },
  }), (error) => error instanceof AggregateError && error.errors[0] === original && error.errors[1] === cleanup);
});

function loadAlbumDetailsSpec(withRestoredAppearanceFixture) {
  const fixtures = {}, cases = new Map();
  const register = (title, _options, callback) => cases.set(title, callback);
  register.setTimeout = () => {};
  const context = { test: register, base: { extend(values) { Object.assign(fixtures, values); return register; } },
    expect() {}, PERFORMANCE_AUTH_USERNAME: 'authenticated-fixture', withRestoredAppearanceFixture };
  const filename = path.resolve(__dirname, '../e2e/specs/albumDetailsComponents.functional.spec.js');
  const source = fs.readFileSync(filename, 'utf8').replace(/^import .*;\r?\n/gm, '');
  vm.runInNewContext(source, context, { filename });
  return { fixtures, cases };
}

for (const failure of [false, true]) {
  test(`AlbumDetails owns full appearance restoration after ${failure ? 'failed' : 'successful'} scenario`, async () => {
    const helper = await load();
    const calls = [];
    const initial = { revision: 14, player_recent_sets: [{ kept: true }], album_details_layout: 'stacked_bar', album_playing_row_animation: 'disabled' };
    let stored = structuredClone(initial);
    const original = new Error('original layout assertion');
    const { fixtures } = loadAlbumDetailsSpec((args, use) => helper.withRestoredAppearanceFixture(args, use, {
      async captureSnapshot(username) {
        assert.equal(username, 'authenticated-fixture'); calls.push('snapshot');
        const snapshot = structuredClone(stored);
        return { async restore() { calls.push('restore'); stored = snapshot; } };
      },
    }));
    assert.equal(fixtures.appearanceBaseline?.[1].auto, true, 'both scenarios need an automatic owned snapshot');
    const execution = fixtures.appearanceBaseline[0]({
      context: { async close() { calls.push('context'); } },
      managedAppLifecycle: { async restart() { calls.push('drained'); } },
    }, async () => {
      calls.push('test'); stored = { revision: 25, album_details_layout: 'editorial_canvas', album_playing_row_animation: 'enabled' };
      if (failure) throw original;
    });
    if (failure) await assert.rejects(execution, error => error === original);
    else await execution;
    assert.deepEqual(stored, initial);
    assert.deepEqual(calls, ['snapshot', 'test', 'context', 'drained', 'restore']);
  });
}

test('AlbumDetails playback establishes animation through Appearance before asserting motion', async () => {
  const { cases } = loadAlbumDetailsSpec();
  const callback = [...cases].find(([title]) => title.startsWith('FTC-ALBUM-DETAILS-020'))[1];
  const calls = [], reachedScenario = new Error('the original playback scenario begins');
  await assert.rejects(callback({
    galleryActions: { async goto() {}, async waitForGalleryReady() {} },
    settingsModalAppBarActions: { async openSettings() {}, async closeSettings() {} },
    utilityTabBarActions: { async openTab() {} },
    utilityAppearanceActions: {
      async waitForReady() {}, async openSection() {},
      utilityAppearanceTab: { albumPlayingRowAnimationButton: () => ({ async getAttribute() { return 'false'; } }) },
      async setAlbumPlayingRowAnimation(enabled) { calls.push(['animation', enabled]); },
      async save() { calls.push(['save']); },
    },
    stepLogger: { async step(name, body) {
      if (name === 'Enable persisted playing-row animation for this owned scenario') await body();
      else throw reachedScenario;
    } },
  }), error => error === reachedScenario);
  assert.deepEqual(calls, [['animation', true], ['save']]);
});

test('appearanceControls owns an automatic complete-state fixture tied to its login identity', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../e2e/specs/appearanceControls.spec.js'), 'utf8');
  assert.match(source, /test as base/);
  assert.match(source, /withRestoredAppearanceFixture/);
  assert.match(source, /username: PERFORMANCE_AUTH_USERNAME/);
  assert.match(source, /auto: true/);
});


for (const stage of ['context', 'restart', 'restore', 'report']) {
  test(`appearance fixture reports terminal cleanup failure after ${stage} failure`, async () => {
    const { withRestoredAppearanceFixture } = await load();
    const primary = new Error('original acceptance failure');
    const cleanup = new Error('fixture cleanup did not complete');
    const reporting = new Error('failure acknowledgment unavailable');
    const calls = [];
    await assert.rejects(withRestoredAppearanceFixture({
      username: 'fixture-owner',
      context: { async close() { calls.push('context'); if (stage === 'context') throw cleanup; } },
      managedAppLifecycle: {
        async restart() { calls.push('restart'); if (stage === 'restart') throw cleanup; },
        async reportFailure() { calls.push('terminal-failure'); if (stage === 'report') throw reporting; },
      },
    }, async () => { throw primary; }, {
      async captureSnapshot() { return { async restore() { calls.push('restore'); throw cleanup; } }; },
    }), error => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, stage === 'report' ? [primary, cleanup, reporting] : [primary, cleanup]);
      return true;
    });
    assert.equal(calls.at(-1), 'terminal-failure', 'the controller must stop the invocation before fixture teardown releases another case');
  });
}
