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
  return { instance, root, host, preview: editor.querySelector(previewSelector) };
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
