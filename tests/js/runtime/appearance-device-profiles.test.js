const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../../../music_app/static/js/appearance-device-profiles.js'), 'utf8');

function load() {
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.window.AlbumHavenAppearanceProfiles;
}

const plain = (value) => JSON.parse(JSON.stringify(value));
const base = {
  main: { palette_id: 'black' },
  player: { compact_player_style: 'docked' },
  interaction: { action_button_outlines: true },
  alerts: { alert_family: 'ember' },
  album: { album_details_layout: 'classic_bar' },
};

test('new Mobile and TV sections follow Web/Desktop independently by default', () => {
  const profiles = load().normalize({}, base);
  assert.equal(profiles.web_desktop.sections.main.mode, 'custom');
  for (const profile of ['mobile', 'tv']) {
    for (const section of ['main', 'player', 'interaction', 'alerts', 'album']) {
      assert.equal(profiles[profile].sections[section].mode, 'follow');
    }
  }
  assert.deepEqual(plain(load().resolveSection(profiles, 'mobile', 'main')), base.main);
});

test('first Customize copies the latest Web/Desktop values', () => {
  const api = load();
  const profiles = api.normalize({}, base);
  profiles.web_desktop.sections.alerts.values = { alert_family: 'signal' };
  const customized = api.setMode(profiles, 'mobile', 'alerts', 'custom');
  assert.deepEqual(plain(customized.mobile.sections.alerts.values), { alert_family: 'signal' });
});

test('custom values remain dormant while following and return when Customize is restored', () => {
  const profiles = load().normalize({
    mobile: { sections: { alerts: { mode: 'custom', values: { alert_family: 'quiet' } } } },
  }, base);
  const following = load().setMode(profiles, 'mobile', 'alerts', 'follow');
  assert.deepEqual(plain(load().resolveSection(following, 'mobile', 'alerts')), base.alerts);
  assert.deepEqual(plain(following.mobile.sections.alerts.values), { alert_family: 'quiet' });
  const restored = load().setMode(following, 'mobile', 'alerts', 'custom');
  assert.deepEqual(plain(load().resolveSection(restored, 'mobile', 'alerts')), { alert_family: 'quiet' });
});

test('later base changes flow only into following sections', () => {
  const profiles = load().normalize({
    tv: { sections: { interaction: { mode: 'custom', values: { action_button_outlines: false } } } },
  }, base);
  profiles.web_desktop.sections.interaction.values.action_button_outlines = false;
  profiles.web_desktop.sections.alerts.values.alert_family = 'signal';
  assert.deepEqual(plain(load().resolveSection(profiles, 'mobile', 'alerts')), { alert_family: 'signal' });
  assert.deepEqual(plain(load().resolveSection(profiles, 'tv', 'interaction')), { action_button_outlines: false });
});
