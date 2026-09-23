const test = require('node:test');
const assert = require('node:assert/strict');
const appearance = require('../../../music_app/static/js/appearance-backgrounds.js');

function initial(style = 'capsule') {
  return {
    main_surface_color: null, panel_background_color: null,
    palette_id: null, panel_index: 0, player_override: null,
    compact_player_style: 'docked', album_details_layout: 'classic_bar',
    album_playing_row_animation: 'enabled', alert_family: 'ember',
    loop_control_style: style, revision: 7, waveform_recent_colors: [],
    interaction_overrides: {
      item_hover: null, item_selected: null, button_hover_background: null,
      button_pressed: null, item_outline: { source: 'automatic', color: null },
    },
    selection_accent: { enabled: true, color: '#34CA78' },
    player_style_override: null, player_recent_sets: [],
  };
}

function setup(style = 'capsule', allowed = true) {
  const requests = [], applied = [];
  const editor = appearance.createController({
    initial: initial(style), loopCreateAllowed: allowed,
    request: async (method, payload) => {
      requests.push({ method, payload });
      return { ...payload, revision: 8, player_recent_sets: [] };
    },
    apply: value => applied.push(value),
  });
  return { editor, requests, applied };
}

test('style changes remain staged until the existing aggregate save succeeds', async () => {
  const { editor, requests, applied } = setup();
  editor.setLoopControlStyle('companion');
  assert.equal(editor.getState().draft.loop_control_style, 'companion');
  assert.equal(editor.getState().saved.loop_control_style, 'capsule');
  assert.deepEqual(applied, []);
  assert.equal(await editor.save(), true);
  assert.equal(requests[0].payload.loop_control_style, 'companion');
  assert.equal(requests[0].payload.expected_revision, 7);
  assert.equal(applied[0].loop_control_style, 'companion');
});

test('Cancel and section Reset preserve the existing staged workflow', () => {
  const { editor, requests } = setup('companion');
  editor.setLoopControlStyle('capsule');
  editor.cancel();
  assert.equal(editor.getState().draft.loop_control_style, 'companion');
  editor.resetSection('seekbar');
  assert.equal(editor.getState().draft.loop_control_style, 'capsule');
  assert.equal(editor.getState().saved.loop_control_style, 'companion');
  assert.deepEqual(requests, []);
});

test('missing loop capability cannot change style or reset it through an unrelated edit', async () => {
  const { editor, requests } = setup('companion', false);
  editor.setLoopControlStyle('capsule');
  assert.equal(editor.getState().draft.loop_control_style, 'companion');
  editor.resetSection('seekbar');
  assert.equal(editor.getState().draft.loop_control_style, 'companion');
  editor.setColor('main_surface_color', '#102030');
  assert.equal(await editor.save(), true);
  assert.equal(requests[0].payload.loop_control_style, 'companion');
  assert.equal(requests[0].payload.main_surface_color, '#102030');
});

test('invalid style values never become an actionable draft', () => {
  const { editor } = setup();
  for (const value of ['A', 'B', '', null, true, 'unknown']) {
    assert.throws(() => editor.setLoopControlStyle(value), TypeError);
    assert.equal(editor.getState().draft.loop_control_style, 'capsule');
  }
});

test('background reset does not reset a saved loop preference', () => {
  const { editor } = setup('companion', false);
  editor.reset();
  assert.equal(editor.getState().draft.loop_control_style, 'companion');
});

test('saving Harbor Mint preserves the saved companion style through a fresh controller load', async () => {
  const { editor, requests } = setup('companion');
  editor.setPalette('harbor-mint');
  assert.equal(editor.getState().draft.loop_control_style, 'companion');
  assert.equal(await editor.save(), true);
  assert.equal(requests[0].payload.loop_control_style, 'companion');
  const reloaded = appearance.createController({ initial: editor.getState().saved });
  assert.equal(reloaded.getState().saved.palette_id, 'harbor-mint');
  assert.equal(reloaded.getState().saved.loop_control_style, 'companion');
});

test('a live capability predicate is checked before every style mutation', () => {
  let allowed = true;
  const { editor } = setup('capsule', () => allowed);
  editor.setLoopControlStyle('companion');
  editor.cancel();
  allowed = false;
  editor.setLoopControlStyle('companion');
  assert.equal(editor.getState().draft.loop_control_style, 'capsule');
});

test('capability loss removes only the pending style change before saving unrelated edits',async()=>{
  let allowed=true;const {editor,requests}=setup('capsule',()=>allowed);
  editor.setLoopControlStyle('companion');editor.setColor('main_surface_color','#102030');
  allowed=false;
  assert.equal(await editor.save(),true);
  assert.equal(requests[0].payload.loop_control_style,'capsule');
  assert.equal(requests[0].payload.main_surface_color,'#102030');
});

test('approved selector follows Compact player and is absent without the effective capability',()=>{
  const denied=appearance.seekbarMarkup('default',{loopCreateAllowed:false});
  assert.doesNotMatch(denied,/data-loop-control-style-choice/);
  const allowed=appearance.seekbarMarkup('default',{loopCreateAllowed:true});
  assert.match(allowed,/data-loop-control-style-choice="capsule"/);
  assert.match(allowed,/data-loop-control-style-choice="companion"/);
  assert.ok(allowed.indexOf('Loop controls')>allowed.indexOf('Compact player'));
});
