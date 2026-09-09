const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../../../music_app/static/js/appearance-backgrounds.js');

const preference = (changes = {}) => ({
  main_surface_color: null, panel_background_color: null,
  palette_id: 'steelblue', panel_index: 0, player_override: null, ...changes,
});

function element() {
  const styles = new Map(), attributes = new Map(), children = new Map(), listeners = new Map();
  return {
    styles, attributes, listeners, innerHTML: '', value: '',
    style: {
      setProperty: (key, value) => styles.set(key, value),
      removeProperty: key => styles.delete(key),
    },
    setAttribute: (key, value) => attributes.set(key, value),
    getAttribute: key => attributes.get(key) ?? null,
    removeAttribute: key => attributes.delete(key),
    addEventListener: (name, listener) => listeners.set(name, listener),
    querySelector(selector) {
      if (!children.has(selector)) children.set(selector, element());
      return children.get(selector);
    },
    querySelectorAll: () => [],
  };
}

async function mounted(method, initial = preference(), saveResponse) {
  const root = element(), host = element();
  const document = {
    documentElement: root, addEventListener() {},
    getElementById: id => id === 'appearance-bootstrap' ? { textContent: JSON.stringify(initial) } : null,
  };
  const window = {
    location: { href: 'https://music.test/', origin: 'https://music.test' },
    addEventListener() {}, confirm: () => true,
    fetch: async (_url, options) => {
      const data = options.method === 'GET'
        ? { ...initial, csrf_token: 'owned-test-session' }
        : await (saveResponse ? saveResponse(JSON.parse(options.body)) : JSON.parse(options.body));
      return { ok: true, status: 200, redirected: false, json: async () => data };
    },
  };
  const instance = api.installBrowser(window, document);
  assert.equal(await instance.load(), true);
  instance[method](host);
  assert.match(host.innerHTML, /class="appearance-background-editor /);
  const editor = host.querySelector('.appearance-background-editor');
  const previewSelector = method === 'mount' ? '[data-background-preview]' : '[data-player-live-preview]';
  return { instance, root, host, editor, preview: editor.querySelector(previewSelector) };
}

function assertPreviewTheme(preview, draft) {
  const effective = api.resolveAppearance(draft);
  assert.equal(preview.styles.get('--appearance-main-surface'), effective.main, 'Preview main must follow its draft');
  assert.equal(preview.styles.get('--appearance-panel-background'), effective.panel, 'Preview panels must follow its draft');
  for (const [token, color] of Object.entries(effective.tokens)) {
    assert.equal(preview.styles.get('--appearance-' + token), color, `Preview ${token} must use the draft palette`);
  }
  assert.equal(preview.getAttribute('data-appearance-mode'), effective.mode);
  assert.equal(preview.getAttribute('data-appearance-palette'), draft.palette_id);
}

for (const method of ['mount', 'mountSeekbar']) {
  const name = method === 'mount' ? 'Backgrounds' : 'Seekbar';

  test(`${name} editor follows black and light draft palettes and panel companions`, async () => {
    const { instance, root, preview } = await mounted(method);
    const savedRoot = [...root.styles];
    assertPreviewTheme(preview, preference());
    for (const palette_id of ['black', 'paper']) {
      instance.controller.setPalette(palette_id);
      for (const panel_index of [0, 1, 2]) {
        instance.controller.setPanelIndex(panel_index);
        const draft = preference({ palette_id, panel_index });
        assertPreviewTheme(preview, draft);
        assert.ok(api.contrastRatio(preview.styles.get('--appearance-ink'), preview.styles.get('--appearance-main-surface')) >= 4.5);
        assert.deepEqual([...root.styles], savedRoot, 'Draft editor theme must not recolor the saved app');
        assert.equal(root.getAttribute('data-appearance-palette'), 'steelblue');
      }
    }
  });

  test(`${name} Cancel restores saved editor colors and mode without changing the app`, async () => {
    const saved = preference({ palette_id: 'black', panel_index: 2 });
    const { instance, root, preview } = await mounted(method, saved);
    const savedRoot = [...root.styles];
    instance.controller.setPalette('paper');
    assert.equal(preview.getAttribute('data-appearance-mode'), 'light');
    instance.controller.cancel();
    assertPreviewTheme(preview, saved);
    assert.equal(preview.getAttribute('data-appearance-mode'), 'dark');
    assert.deepEqual([...root.styles], savedRoot);
  });

  test(`${name} Reset pins default editor tokens and successful Save alone updates the app`, async () => {
    let finishSave;
    const pending = new Promise(resolve => { finishSave = resolve; });
    const saved = preference({ palette_id: 'paper', panel_index: 1 });
    const { instance, root, preview } = await mounted(method, saved, () => pending);
    const savedRoot = [...root.styles];
    instance.controller.reset();
    assertPreviewTheme(preview, preference({ palette_id: null }));
    assert.deepEqual([...root.styles], savedRoot, 'Default draft must override inherited saved light tokens locally');
    instance.controller.setPalette('black');
    instance.controller.setPanelIndex(2);
    const draft = preference({ palette_id: 'black', panel_index: 2 });
    const saving = instance.controller.save();
    assertPreviewTheme(preview, draft);
    assert.deepEqual([...root.styles], savedRoot, 'Pending Save cannot apply draft tokens to the app');
    finishSave(draft);
    assert.equal(await saving, true);
    assertPreviewTheme(preview, draft);
    assert.equal(root.styles.get('--appearance-main-surface'), api.resolveAppearance(draft).main);
    assert.equal(root.styles.get('--appearance-panel-background'), api.resolveAppearance(draft).panel);
    assert.equal(root.getAttribute('data-appearance-palette'), 'black');
  });
}


for (const stylePath of ['surface.start', 'controls.fill', 'handles.color']) {
  test(`mounted structured HEX ${stylePath} retains invalid text and prevents saving until corrected`, async () => {
    let saves = 0;
    const { instance, editor } = await mounted('mountSeekbar', preference(), () => { saves += 1; return preference(); });
    const input = element();
    input.setAttribute('data-player-style-hex', stylePath);
    input.value = '#BADHEX';
    editor.listeners.get('input')({ target: input });
    assert.equal(instance.controller.getState().dirty, true);
    assert.equal(instance.controller.getState().canSave, false);
    assert.ok(Object.values(instance.controller.getState().inputValues).includes('#BADHEX'));
    assert.ok(Object.keys(instance.controller.getState().errors).length > 0);
    assert.equal(instance.allowLeave(() => false), false);
    instance.controller.setPalette('paper');
    editor.listeners.get('input')({ target: { value: '45', getAttribute: () => null, hasAttribute: name => name === 'data-player-style-angle' } });
    assert.ok(Object.keys(instance.controller.getState().errors).length > 0, 'valid angle changes must retain invalid color input');
    assert.equal(await instance.controller.save(), false);
    assert.equal(saves, 0);
    input.value = '#345678';
    editor.listeners.get('input')({ target: input });
    assert.deepEqual(instance.controller.getState().errors, {});
    assert.equal(instance.controller.getState().canSave, true);
    instance.controller.cancel();
    assert.equal(instance.controller.getState().dirty, false);
    assert.equal(Object.values(instance.controller.getState().inputValues).includes('#BADHEX'), false);
  });
}

for (const otherInvalid of [null, 'surface.start', 'controls.fill']) {
  test(`Solid replaces invalid gradient End while retaining ${otherInvalid || 'no other'} errors`, async () => {
    const { instance, editor } = await mounted('mountSeekbar');
    for (const stylePath of ['surface.end', ...(otherInvalid ? [otherInvalid] : [])]) {
      const input = element();
      input.setAttribute('data-player-style-hex', stylePath);
      input.value = '#BADHEX';
      editor.listeners.get('input')({ target: input });
    }
    assert.equal(instance.controller.getState().canSave, false);
    const modeButton = {
      hasAttribute: name => name === 'data-player-surface-mode',
      getAttribute: name => name === 'data-player-surface-mode' ? 'solid' : null,
    };
    editor.listeners.get('click')({ target: { closest: () => modeButton } });
    const state = instance.controller.getState();
    assert.equal(state.draft.player_style_override.surface.mode, 'solid');
    assert.equal(state.draft.player_style_override.surface.end, state.draft.player_style_override.surface.start);
    assert.equal(state.errors['player_style_surface.end'], undefined);
    assert.equal(state.inputValues['player_style_surface.end'], state.draft.player_style_override.surface.start);
    assert.deepEqual(Object.keys(state.errors), otherInvalid ? ['player_style_' + otherInvalid] : []);
    assert.equal(state.canSave, otherInvalid === null);
    if (otherInvalid) assert.equal(state.inputValues['player_style_' + otherInvalid], '#BADHEX');
  });
}
for (const field of ['fill', 'edge']) for (const replacement of ['theme', 'history']) {
  test(`complete player ${replacement} replaces invalid waveform ${field}`, async () => {
    const style = api.playerThemes[0].style;
    const { instance, editor } = await mounted('mountSeekbar', preference({ revision: 7, interaction_overrides: { item_hover: null, item_selected: null, button_hover_background: null, button_pressed: null, item_outline: { source: 'automatic', color: null } }, selection_accent: { enabled: true, color: '#34CA78' }, player_recent_sets: [style] }));
    instance.controller.setWaveformColor(field, '#BADHEX');
    assert.equal(instance.controller.getState().canSave, false);
    const attribute = replacement === 'theme' ? 'data-player-theme' : 'data-player-set-index';
    const value = replacement === 'theme' ? api.playerThemes[0].id : '0';
    const button = { hasAttribute: name => name === attribute, getAttribute: name => name === attribute ? value : null };
    editor.listeners.get('click')({ target: { closest: () => button } });
    const state = instance.controller.getState();
    assert.deepEqual(state.draft.player_style_override.waveform, style.waveform);
    assert.equal(state.errors['player_' + field], undefined);
    assert.equal(state.inputValues['player_' + field], style.waveform[field]);
    assert.equal(state.canSave, true);
  });
}