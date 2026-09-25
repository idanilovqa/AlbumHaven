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
    styles, attributes, listeners, children: [], innerHTML: '', value: '',
    appendChild(child) { this.children.push(child); return child; },
    insertAdjacentHTML(_position, markup) { this.innerHTML += markup; },
    style: {
      setProperty: (key, value) => styles.set(key, value),
      removeProperty: key => styles.delete(key),
    },
    setAttribute: (key, value) => attributes.set(key, value),
    getAttribute: key => attributes.get(key) ?? null,
    hasAttribute: key => attributes.has(key),
    removeAttribute: key => attributes.delete(key),
    addEventListener: (name, listener) => listeners.set(name, listener),
    querySelector(selector) {
      if (!children.has(selector)) children.set(selector, element());
      return children.get(selector);
    },
    querySelectorAll: () => [],
    closest() { return this; },
  };
}

async function mounted(method, initial = preference(), saveResponse) {
  const root = element(), host = element();
  const document = {
    documentElement: root, addEventListener() {}, createElement: () => element(),
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
  const editorSelector = { mountAlerts: '.appearance-alerts', mountAlbumPage: '.appearance-album-page' }[method] || '.appearance-background-editor';
  return {
    instance, root, host, editor: host.querySelector(editorSelector),
    preview: host.querySelector('.appearance-background-editor').querySelector(method === 'mount' ? '[data-background-preview]' : '[data-player-live-preview]'),
  };
}

function assertEditorTheme(preview, draft) {
  const effective = api.resolveAppearance(draft);
  assert.equal(preview.styles.get('--appearance-main-surface'), effective.main, 'Preview main must follow its draft');
  assert.equal(preview.styles.get('--appearance-panel-background'), effective.panel, 'Preview panels must follow its draft');
  for (const [token, color] of Object.entries(effective.tokens)) {
    assert.equal(preview.styles.get('--appearance-' + token), color, `Preview ${token} must use the draft palette`);
  }
  assert.equal(preview.getAttribute('data-appearance-mode'), effective.mode);
  assert.equal(preview.getAttribute('data-appearance-palette'), draft.palette_id);
}

function assertSavedEditor(editor) {
  assert.deepEqual([...editor.styles], [], 'The editor inherits the saved app theme without local draft overrides');
  assert.equal(editor.getAttribute('data-appearance-palette'), null);
  assert.equal(editor.getAttribute('data-appearance-mode'), null);
}

for (const method of ['mount', 'mountSeekbar']) {
  const name = method === 'mount' ? 'Backgrounds' : 'Seekbar';

  test(`${name} preview follows draft palettes while the editor inherits the saved app`, async () => {
    const { instance, root, editor, preview } = await mounted(method);
    const savedRoot = [...root.styles];
    assertEditorTheme(preview, preference());
    assertSavedEditor(editor);
    for (const palette_id of ['black', 'paper']) {
      instance.controller.setPalette(palette_id);
      for (const panel_index of [0, 1, 2]) {
        instance.controller.setPanelIndex(panel_index);
        const draft = preference({ palette_id, panel_index });
        assertEditorTheme(preview, draft);
        assertSavedEditor(editor);
        assert.ok(api.contrastRatio(preview.styles.get('--appearance-ink'), preview.styles.get('--appearance-main-surface')) >= 4.5);
        assert.deepEqual([...root.styles], savedRoot, 'Draft editor theme must not recolor the saved app');
        assert.equal(root.getAttribute('data-appearance-palette'), 'steelblue');
      }
    }
  });

  test(`${name} Cancel restores saved preview colors and mode without changing the app`, async () => {
    const saved = preference({ palette_id: 'black', panel_index: 2 });
    const { instance, root, editor, preview } = await mounted(method, saved);
    const savedRoot = [...root.styles];
    instance.controller.setPalette('paper');
    assert.equal(preview.getAttribute('data-appearance-mode'), 'light');
    instance.controller.cancel();
    assertEditorTheme(preview, saved);
    assertSavedEditor(editor);
    assert.equal(preview.getAttribute('data-appearance-mode'), 'dark');
    assert.deepEqual([...root.styles], savedRoot);
  });

  test(`${name} Reset pins default preview tokens and successful Save alone updates the app`, async () => {
    let finishSave;
    const pending = new Promise(resolve => { finishSave = resolve; });
    const saved = preference({ palette_id: 'paper', panel_index: 1 });
    const { instance, root, editor, preview } = await mounted(method, saved, () => pending);
    const savedRoot = [...root.styles];
    instance.controller.reset();
    assertEditorTheme(preview, preference({ palette_id: null }));
    assertSavedEditor(editor);
    assert.deepEqual([...root.styles], savedRoot, 'Default draft must override inherited saved light tokens locally');
    instance.controller.setPalette('black');
    instance.controller.setPanelIndex(2);
    const draft = preference({ palette_id: 'black', panel_index: 2 });
    const saving = instance.controller.save();
    assertEditorTheme(preview, draft);
    assertSavedEditor(editor);
    assert.deepEqual([...root.styles], savedRoot, 'Pending Save cannot apply draft tokens to the app');
    finishSave(draft);
    assert.equal(await saving, true);
    assertEditorTheme(preview, draft);
    assertSavedEditor(editor);
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
for (const replacement of ['theme', 'history']) for (const otherError of [null, 'main_surface_color']) {
  test(`complete player ${replacement} replaces invalid background and retains ${otherError || 'no unrelated error'}`, async () => {
    const style = api.playerThemes[1].style;
    const { instance, host, editor } = await mounted('mount', preference({
      revision: 7, player_style_override: api.playerThemes[0].style, player_recent_sets: [style],
      interaction_overrides: { item_hover: null, item_selected: null, button_hover_background: null, button_pressed: null, item_outline: { source: 'automatic', color: null } },
      selection_accent: { enabled: true, color: '#34CA78' },
    }));
    editor.listeners.get('input')({ target: {
      value: '#BADHEX', getAttribute: key => key === 'data-player-hex' ? 'background' : null,
      hasAttribute: () => false,
    } });
    if (otherError) instance.controller.setColor(otherError, '#ALSONO');
    assert.ok(instance.controller.getState().errors.player_background);
    instance.mountSeekbar(host);
    const attribute = replacement === 'theme' ? 'data-player-theme' : 'data-player-set-index';
    const button = { hasAttribute: key => key === attribute, getAttribute: key => key === attribute ? (replacement === 'theme' ? api.playerThemes[1].id : '0') : null };
    editor.listeners.get('click')({ target: { closest: () => button } });
    const state = instance.controller.getState();
    assert.deepEqual(state.draft.player_style_override, style);
    assert.equal(state.errors.player_background, undefined);
    assert.equal(state.inputValues.player_background, state.effective.player.background);
    assert.deepEqual(Object.keys(state.errors), otherError ? [otherError] : []);
    assert.equal(state.canSave, !otherError);
    if (otherError) assert.equal(state.inputValues[otherError], '#ALSONO');
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

for (const method of ['mount', 'mountSeekbar', 'mountSelectionAccent', 'mountAlerts', 'mountAlbumPage']) {
  test(`${method} disables Cancel for a clean draft and enables it for discardable changes`, async () => {
    const { instance, editor } = await mounted(method);
    const cancel = editor.querySelector('.background-actions').querySelector('[data-background-cancel]');
    assert.equal(instance.controller.getState().dirty, false);
    assert.equal(cancel.disabled, true, 'No changes means there is nothing to discard');
    instance.controller.setPalette('paper');
    assert.equal(cancel.disabled, false, 'A dirty draft remains cancellable');
    instance.controller.cancel();
    assert.equal(instance.controller.getState().dirty, false);
    assert.equal(cancel.disabled, true);
  });
}

test('restoring the saved recent player set leaves a clean disabled Cancel button', async () => {
  const style = api.playerThemes[1].style;
  const initial = preference({ revision: 2, player_style_override: style,
    player_recent_sets: [style], waveform_recent_colors: ['#123456'],
    interaction_overrides: { item_hover: null, item_selected: null, button_hover_background: null,
      button_pressed: null, item_outline: { source: 'automatic', color: null } },
    selection_accent: { enabled: true, color: '#34CA78' } });
  const { instance, editor } = await mounted('mountSeekbar', initial);
  instance.controller.setWaveformColor('fill', '#123456');
  instance.controller.cancel();
  instance.controller.setPlayerStyle(api.playerThemes[0].style);
  instance.controller.restorePlayerSet(instance.controller.getState().playerRecentSets[0]);
  assert.equal(instance.controller.getState().dirty, false);
  assert.equal(editor.querySelector('.background-actions').querySelector('[data-background-cancel]').disabled, true);
});


for (const method of ['mount', 'mountSeekbar', 'mountSelectionAccent', 'mountAlerts', 'mountAlbumPage']) {
  test(method + ' renders request failures through the shared alert and clears recovery state', async () => {
    const { instance, editor } = await mounted(method);
    const notice = editor.querySelector('[data-background-request-error]');
    instance.controller.clear('Unable to save <unsafe> & retry');
    assert.equal(notice.hidden, false);
    assert.match(notice.innerHTML, /data-on-page-alert="error"/);
    assert.match(notice.innerHTML, /Unable to save &lt;unsafe&gt; &amp; retry/);
    assert.doesNotMatch(notice.innerHTML, /<unsafe>/);
    instance.controller.clear();
    assert.equal(notice.hidden, true);
    assert.equal(notice.innerHTML, '');
  });
}
