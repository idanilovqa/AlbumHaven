import { authenticatedPageGet, authenticatedPagePut } from './authenticatedPageRequest.js';

const FIELDS = ['main_surface_color', 'panel_background_color', 'palette_id', 'panel_index',
 'player_override', 'waveform_recent_colors', 'compact_player_style',
  'docked_compact_player_behavior', 'docked_compact_player_regular_style', 'compact_player_motion', 'floating_player_edge',
 'album_details_layout', 'album_playing_row_animation', 'alert_family',
 'interaction_overrides', 'selection_accent', 'player_style_override',
 'loop_control_style', 'action_button_outlines', 'device_profiles'];
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export function buildAppearanceRestorePayload(original, owned, current) {
  if (!Number.isInteger(current.revision) || !current.csrf_token) throw new Error('Appearance restoration requires current revision and CSRF.');
  let changed = false;
  const payload = Object.fromEntries(FIELDS.map(field => [field, current[field]]));
  for (const field of FIELDS) {
    if (equal(original[field], owned[field])) continue;
    if (!equal(current[field], owned[field])) throw new Error(`Appearance ${field} changed outside this test; refusing restoration.`);
    payload[field] = original[field];
    changed = true;
  }
  return changed ? { ...payload, expected_revision: current.revision } : null;
}

export function createAppearancePreferenceIsolation(page) {
  let original = null, owned = null, session = null, readError = null;
  const reads = new Set();
  const sessionKey = async () => {
    const { origin, hostname } = new URL(page.url());
    const cookies = await page.context().cookies();
    const cookie = cookies.find(item => item.name === '__Host-album_haven_session'
      && String(item.domain || '').toLowerCase() === hostname.toLowerCase()
      && item.path === '/');
    if (!cookie) throw new Error('Appearance isolation requires an authenticated test account.');
    return `${origin}\n${cookie.value}`;
  };
  const read = async () => {
    const response = await authenticatedPageGet(page, '/account/appearance');
    if (!response.ok()) throw new Error(`Appearance capture failed: HTTP ${response.status()}.`);
    return response.json();
  };
  const observe = response => {
    if (response.request().method() !== 'PUT' || new URL(response.url()).pathname !== '/account/appearance' || !response.ok()) return;
    const pending = response.json().then(value => {
      if (Number(value.revision) >= Number(owned.revision)) owned = value;
    }).catch(error => { readError = error; }).finally(() => reads.delete(pending));
    reads.add(pending);
  };
  return {
    async capture() {
      if (original) throw new Error('Appearance preferences already captured.');
      session = await sessionKey();
      original = await read();
      owned = original;
      page.on('response', observe);
    },
    async restore() {
      page.off('response', observe);
      await Promise.all(reads);
      if (readError) throw readError;
      if (!original) return;
      if (await sessionKey() !== session) throw new Error('Appearance test account/session changed; refusing restoration.');
      const current = await read();
      const payload = buildAppearanceRestorePayload(original, owned, current);
      if (!payload) return;
      const response = await authenticatedPagePut(page, '/account/appearance', {
        data: payload, headers: {
          'X-Album-Haven-CSRF': current.csrf_token,
          Origin: new URL(page.url()).origin,
        },
      });
      if (!response.ok()) throw new Error(`Appearance restoration failed: HTTP ${response.status()}.`);
      const restored = await response.json();
      for (const field of FIELDS) if (!equal(restored[field], payload[field])) throw new Error(`Appearance ${field} restoration did not persist.`);
    },
  };
}
