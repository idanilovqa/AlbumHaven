const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const moduleUrl = pathToFileURL(path.resolve(__dirname, '../e2e/helpers/appearancePreferenceIsolation.js')).href;

test('Appearance isolation retains secure loopback sessions and excludes another host cookie', async () => {
  const { createAppearancePreferenceIsolation } = await import(moduleUrl);
  let otherSession = 'unrelated';
  const page = {
    url: () => 'http://127.0.0.1:5001/',
    context: () => ({ cookies: async (...args) => args.length ? [] : [
      { name: '__Host-album_haven_session', value: otherSession, domain: 'another.example', path: '/', secure: true },
      { name: '__Host-album_haven_session', value: 'owned', domain: '127.0.0.1', path: '/', secure: true },
    ] }),
    request: { get: async () => ({ ok: () => true, json: async () => ({ revision: 1, csrf_token: 'token' }) }) },
    on() {}, off() {},
  };
  const isolation = createAppearancePreferenceIsolation(page);
  await isolation.capture();
  otherSession = 'changed-unrelated';
  await isolation.restore();
});

test('Appearance cleanup restores only test-changed values using the current revision', async () => {
  const { buildAppearanceRestorePayload } = await import(moduleUrl);
  const original = { palette_id: 'navy', album_details_layout: 'classic_bar' };
  const owned = { ...original, palette_id: 'harbor-mint', revision: 2 };
  const current = { ...owned, album_details_layout: 'stacked_bar', revision: 3, csrf_token: 'fresh-token' };
  const payload = buildAppearanceRestorePayload(original, owned, current);
  assert.equal(payload.palette_id, 'navy');
  assert.equal(payload.album_details_layout, 'stacked_bar');
  assert.equal(payload.expected_revision, 3);
  assert.equal(Object.hasOwn(payload, 'csrf_token'), false);
});

test('Appearance cleanup is a no-op without a test-owned saved change', async () => {
  const { buildAppearanceRestorePayload } = await import(moduleUrl);
  const original = { palette_id: 'navy' };
  assert.equal(buildAppearanceRestorePayload(original, original, { ...original, revision: 4, csrf_token: 'token' }), null);
});

test('Appearance cleanup excludes server-owned player history from writable preferences', async () => {
  const { buildAppearanceRestorePayload } = await import(moduleUrl);
  const original = { palette_id: null, player_recent_sets: [] };
  const owned = { ...original, palette_id: 'harbor-mint' };
  const current = { ...owned, revision: 3, csrf_token: 'fresh-token' };
  const payload = buildAppearanceRestorePayload(original, owned, current);
  assert.equal(payload.palette_id, null);
  assert.equal(Object.hasOwn(payload, 'player_recent_sets'), false);
  assert.equal(payload.expected_revision, 3);
});

test('Appearance cleanup rejects overlapping later changes and missing CAS or CSRF', async () => {
  const { buildAppearanceRestorePayload } = await import(moduleUrl);
  const original = { palette_id: 'navy' }, owned = { palette_id: 'harbor-mint' };
  assert.throws(() => buildAppearanceRestorePayload(original, owned, { palette_id: 'paper', revision: 3, csrf_token: 'token' }), /outside this test/);
  assert.throws(() => buildAppearanceRestorePayload(original, owned, { ...owned, csrf_token: 'token' }), /revision and CSRF/);
  assert.throws(() => buildAppearanceRestorePayload(original, owned, { ...owned, revision: 3 }), /revision and CSRF/);
});

test('Appearance cleanup refuses a changed authenticated session without a PUT', async () => {
  const { createAppearancePreferenceIsolation } = await import(moduleUrl);
  let session = 'original';
  let puts = 0;
  const page = {
    url: () => 'http://127.0.0.1:5001/',
    context: () => ({ cookies: async () => [{ name: '__Host-album_haven_session', value: session, domain: '127.0.0.1', path: '/' }] }),
    request: { get: async () => ({ ok: () => true, json: async () => ({ revision: 0, csrf_token: 'token' }) }), put: async () => { puts += 1; } },
    on() {}, off() {},
  };
  const isolation = createAppearancePreferenceIsolation(page);
  await isolation.capture();
  session = 'another-account';
  await assert.rejects(isolation.restore(), /account\/session changed/);
  assert.equal(puts, 0);
});

test('Appearance cleanup sends fresh CSRF and revision and verifies the restored server result', async () => {
  const { createAppearancePreferenceIsolation } = await import(moduleUrl);
  const original = { palette_id: 'navy', revision: 1, csrf_token: 'old-token', waveform_recent_colors: ['#111111'] };
  const saved = { ...original, palette_id: 'harbor-mint', revision: 2, waveform_recent_colors: ['#222222', '#111111'] };
  const current = { ...saved, album_details_layout: 'stacked_bar', revision: 3, csrf_token: 'fresh-token', waveform_recent_colors: ['#333333', '#222222', '#111111'] };
  let reads = 0, observe, sent;
  const page = {
    url: () => 'http://127.0.0.1:5001/',
    context: () => ({ cookies: async () => [{ name: '__Host-album_haven_session', value: 'owned-session', domain: '127.0.0.1', path: '/' }] }),
    request: {
      get: async () => ({ ok: () => true, json: async () => (++reads === 1 ? original : current) }),
      put: async (url, options) => {
        sent = { url, ...options };
        return { ok: () => true, json: async () => ({ ...options.data, waveform_recent_colors: current.waveform_recent_colors, revision: 4 }) };
      },
    },
    on(_event, listener) { observe = listener; }, off() {},
  };
  const isolation = createAppearancePreferenceIsolation(page);
  await isolation.capture();
  observe({ request: () => ({ method: () => 'PUT' }), url: () => `${page.url()}account/appearance`, ok: () => true, json: async () => saved });
  await isolation.restore();
  assert.equal(sent.url, 'http://127.0.0.1:5001/account/appearance');
  assert.equal(sent.headers['X-Album-Haven-CSRF'], 'fresh-token');
  assert.equal(sent.headers.Origin, 'http://127.0.0.1:5001');
  assert.equal(sent.headers.Cookie, '__Host-album_haven_session=owned-session');
  assert.equal(sent.data.expected_revision, 3);
  assert.equal(sent.data.palette_id, 'navy');
  assert.equal(sent.data.album_details_layout, 'stacked_bar');
  assert.equal(Object.hasOwn(sent.data, 'waveform_recent_colors'), false);
  assert.equal(Object.hasOwn(sent.data, 'waveform_color_updates'), false);
  assert.deepEqual(current.waveform_recent_colors, ['#333333', '#222222', '#111111']);
});


test('Appearance cleanup restores every writable field without overwriting account color history', async () => {
  const { buildAppearanceRestorePayload } = await import(moduleUrl);
  const fields = ['main_surface_color', 'panel_background_color', 'palette_id', 'panel_index',
    'player_override', 'compact_player_style', 'docked_compact_player_behavior',
    'docked_compact_player_regular_style', 'compact_player_motion', 'floating_player_edge',
    'album_details_layout', 'album_playing_row_animation', 'alert_family', 'interaction_overrides',
    'selection_accent', 'player_style_override', 'loop_control_style', 'action_button_outlines', 'device_profiles'];
  const original = Object.fromEntries(fields.map(field => [field, `original-${field}`]));
  const owned = Object.fromEntries(fields.map(field => [field, `saved-${field}`]));
  original.waveform_recent_colors = ['#111111'];
  owned.waveform_recent_colors = ['#222222', '#111111'];
  const current = { ...owned, waveform_recent_colors: ['#333333', '#222222', '#111111'], revision: 9, csrf_token: 'fresh' };
  const snapshot = JSON.stringify(current);
  const payload = buildAppearanceRestorePayload(original, owned, current);
  assert.deepEqual(Object.keys(payload).sort(), [...fields, 'expected_revision'].sort());
  for (const field of fields) assert.deepEqual(payload[field], original[field], field);
  assert.equal(payload.expected_revision, 9);
  assert.equal(Object.hasOwn(payload, 'waveform_recent_colors'), false);
  assert.equal(Object.hasOwn(payload, 'waveform_color_updates'), false);
  assert.equal(JSON.stringify(current), snapshot);
  assert.equal(buildAppearanceRestorePayload(
    { ...owned, waveform_recent_colors: ['#111111'] }, owned, current,
  ), null);
});

test('Appearance cleanup excludes server-owned waveform recent colors', async () => {
  const { buildAppearanceRestorePayload } = await import(moduleUrl);
  const original = {
    palette_id: 'navy',
    waveform_recent_colors: ['#112233'],
  };
  const owned = {
    ...original,
    palette_id: 'harbor-mint',
    waveform_recent_colors: ['#445566', '#112233'],
  };
  const payload = buildAppearanceRestorePayload(original, owned, {
    ...owned,
    revision: 3,
    csrf_token: 'fresh-token',
  });

  assert.equal(payload.palette_id, 'navy');
  assert.equal(Object.hasOwn(payload, 'waveform_recent_colors'), false);
});
