const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const sourcePath = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'appearance-backgrounds.js');
const defaults = () => ({ main_surface_color: null, panel_background_color: null });
const custom = () => ({ main_surface_color: '#12ABCD', panel_background_color: '#FE019A' });
const runtime = () => require(sourcePath);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function controller(options = {}) {
  const applied = [];
  const requests = [];
  const editor = runtime().createController({
    initial: defaults(),
    request: async (method, payload) => {
      requests.push({ method, payload });
      return payload || defaults();
    },
    apply: (value) => applied.push(value),
    ...options,
  });
  return { editor, applied, requests };
}

test('color validation accepts the full RGB range and rejects malformed or injected CSS', () => {
  const { normalizeColor, colorToRgb } = runtime();
  assert.equal(normalizeColor(null), null);
  assert.equal(normalizeColor('#000000'), '#000000');
  assert.equal(normalizeColor('#FFFFFF'), '#FFFFFF');
  assert.equal(normalizeColor('#fa019b'), '#FA019B');
  assert.equal(colorToRgb('#123456'), '18, 52, 86');
  for (const invalid of ['', '#FFF', '#12345678', '#123456\n', 'red', ' #123456', '#123456;display:none', 123456]) {
    assert.throws(() => normalizeColor(invalid), TypeError);
  }
});

test('editing a valid color only changes the preview draft until save succeeds', async () => {
  const { editor, applied, requests } = controller();
  editor.setColor('main_surface_color', '#12abcd');
  editor.setColor('panel_background_color', '#fe019a');

  assert.deepEqual(editor.getState().draft, custom());
  assert.deepEqual(editor.getState().saved, defaults());
  assert.equal(editor.getState().dirty, true);
  assert.equal(editor.getState().canSave, true);
  assert.deepEqual(applied, []);
  assert.deepEqual(requests, []);

  assert.equal(await editor.save(), true);
  assert.deepEqual(requests, [{ method: 'PUT', payload: custom() }]);
  assert.deepEqual(applied, [custom()]);
  assert.deepEqual(editor.getState().saved, custom());
  assert.equal(editor.getState().dirty, false);
  assert.equal(editor.getState().canSave, false);
});

test('cancel restores saved colors and reset stays in the draft until explicitly saved', async () => {
  const { editor, applied, requests } = controller({ initial: custom() });
  editor.setColor('main_surface_color', '#000000');
  editor.cancel();
  assert.deepEqual(editor.getState().draft, custom());
  assert.equal(editor.getState().dirty, false);

  editor.reset();
  assert.deepEqual(editor.getState().draft, defaults());
  assert.deepEqual(editor.getState().saved, custom());
  assert.equal(editor.getState().canSave, true);
  assert.deepEqual(applied, []);
  assert.deepEqual(requests, []);

  editor.cancel();
  assert.deepEqual(editor.getState().draft, custom());
  editor.reset();
  assert.equal(await editor.save(), true);
  assert.deepEqual(requests, [{ method: 'PUT', payload: defaults() }]);
  assert.deepEqual(applied, [defaults()]);
});

test('invalid HEX preserves the last valid preview and blocks saving until corrected', async () => {
  const { editor, applied, requests } = controller();
  editor.setColor('main_surface_color', '#A1B2C3');
  editor.setColor('main_surface_color', '#GG0000');

  assert.equal(editor.getState().draft.main_surface_color, '#A1B2C3');
  assert.ok(editor.getState().errors.main_surface_color);
  assert.equal(editor.getState().canSave, false);
  assert.equal(await editor.save(), false);
  assert.deepEqual(requests, []);
  assert.deepEqual(applied, []);

  editor.setColor('main_surface_color', '#f109Bc');
  assert.equal(editor.getState().draft.main_surface_color, '#F109BC');
  assert.ok(!editor.getState().errors.main_surface_color);
  assert.equal(editor.getState().canSave, true);
});

test('black and white contrast extremes are calculated and a warning never blocks saving', async () => {
  assert.equal(runtime().contrastRatio('#FFFFFF', '#FFFFFF'), 1);
  assert.equal(runtime().contrastRatio('#000000', '#FFFFFF'), 21);
  const { editor, requests } = controller();
  editor.setColor('main_surface_color', '#FFFFFF');
  editor.setColor('panel_background_color', '#FFFFFF');

  assert.ok(editor.getState().warnings.length > 0);
  assert.equal(editor.getState().canSave, true);
  assert.equal(await editor.save(), true);
  assert.deepEqual(requests[0].payload, {
    main_surface_color: '#FFFFFF', panel_background_color: '#FFFFFF',
  });
});

test('failed save retains the draft and saved theme, and a retry can persist it', async () => {
  const applied = [];
  let fail = true;
  const { editor } = controller({
    request: async (_method, payload) => {
      if (fail) throw new Error('Appearance temporarily unavailable.');
      return payload;
    },
    apply: (value) => applied.push(value),
  });
  editor.setColor('main_surface_color', '#123456');

  assert.equal(await editor.save(), false);
  assert.ok(editor.getState().error);
  assert.equal(editor.getState().saving, false);
  assert.equal(editor.getState().draft.main_surface_color, '#123456');
  assert.deepEqual(editor.getState().saved, defaults());
  assert.deepEqual(applied, []);

  fail = false;
  assert.equal(await editor.save(), true);
  assert.ok(!editor.getState().error);
  assert.equal(applied.length, 1);
});

test('loading and saving expose busy states and prevent duplicate mutation', async () => {
  const pending = deferred();
  const requests = [];
  const { editor } = controller({ request: (method, payload) => {
    requests.push({ method, payload });
    return pending.promise;
  } });
  editor.setColor('main_surface_color', '#123456');
  const first = editor.save();

  assert.equal(editor.getState().saving, true);
  assert.equal(editor.getState().canSave, false);
  assert.equal(await editor.save(), false);
  assert.equal(requests.length, 1);
  pending.resolve({ main_surface_color: '#123456', panel_background_color: null });
  await first;
  assert.equal(editor.getState().saving, false);

  const loading = deferred();
  const other = controller({ request: () => loading.promise }).editor;
  const load = other.load();
  assert.equal(other.getState().loading, true);
  assert.equal(other.getState().canSave, false);
  loading.resolve(custom());
  assert.equal(await load, true);
  assert.equal(other.getState().loading, false);
  assert.deepEqual(other.getState().saved, custom());
});

test('read failure exposes retry state and successful reload restores the server preference', async () => {
  let fail = true;
  const { editor, applied } = controller({ request: async () => {
    if (fail) throw new Error('Could not load appearance.');
    return { ...custom(), csrf_token: 'session-bound-token' };
  } });

  assert.equal(await editor.load(), false);
  assert.ok(editor.getState().error);
  assert.equal(editor.getState().loading, false);
  assert.deepEqual(applied, []);

  fail = false;
  assert.equal(await editor.load(), true);
  assert.deepEqual(editor.getState().saved, custom());
  assert.deepEqual(editor.getState().draft, custom());
  assert.deepEqual(applied, [custom()]);
  assert.ok(!editor.getState().error);
});

test('theme application and sign-out cleanup only change the dedicated surface overrides', () => {
  const values = new Map([['--panel', 'existing-card-color'], ['--accent', 'existing-accent']]);
  const root = { style: {
    setProperty: (name, value) => values.set(name, value),
    removeProperty: (name) => values.delete(name),
  } };

  runtime().applyTheme(custom(), root);
  assert.equal(values.get('--appearance-main-surface'), '#12ABCD');
  assert.equal(values.get('--appearance-panel-background'), '#FE019A');
  assert.equal(values.get('--appearance-panel-background-rgb'), '254, 1, 154');
  runtime().applyTheme({ ...custom(), panel_background_color: null }, root);
  assert.equal(values.has('--appearance-panel-background'), false);
  assert.equal(values.has('--appearance-panel-background-rgb'), false);
  runtime().clearTheme(root);
  assert.deepEqual([...values], [['--panel', 'existing-card-color'], ['--accent', 'existing-accent']]);
});

function browser(fetch, initial = custom()) {
  const styles = new Map();
  const listeners = new Map();
  const document = {
    documentElement: { style: {
      setProperty: (name, value) => styles.set(name, value),
      removeProperty: (name) => styles.delete(name),
    } },
    getElementById: (id) => id === 'appearance-bootstrap'
      ? { textContent: JSON.stringify({ ...initial, load_error: false }) } : null,
    addEventListener: (name, listener) => listeners.set(`document:${name}`, listener),
  };
  const window = {
    fetch,
    location: { href: 'https://music.test/', origin: 'https://music.test' },
    confirm: () => true,
    addEventListener: (name, listener) => listeners.set(`window:${name}`, listener),
  };
  const instance = runtime().installBrowser(window, document);
  return { instance, window, styles, listeners };
}

function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, redirected: false, json: async () => data };
}

test('appearance save uses its captured fetch and loaded CSRF token after a later session wrapper is installed', async () => {
  const requests = [];
  const { instance, window } = browser(async (url, options) => {
    requests.push({ url, ...options });
    return response(options.method === 'GET'
      ? { ...custom(), csrf_token: 'token-A' } : JSON.parse(options.body));
  });
  assert.equal(await instance.load(), true);

  let wrapperCalls = 0;
  const previousFetch = window.fetch;
  window.fetch = (url, options) => {
    wrapperCalls += 1;
    return previousFetch(url, {
      ...options, headers: { ...options.headers, 'X-Album-Haven-CSRF': 'token-B' },
    });
  };
  instance.controller.setColor('main_surface_color', '#123456');

  assert.equal(await instance.controller.save(), true);
  assert.equal(wrapperCalls, 0);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, '/account/appearance');
  assert.equal(requests[1].method, 'PUT');
  assert.equal(requests[1].headers['X-Album-Haven-CSRF'], 'token-A');
  assert.equal(requests[1].credentials, 'same-origin');
  assert.deepEqual(JSON.parse(requests[1].body), { ...custom(), main_surface_color: '#123456' });
});

test('an appearance 403 clears the old theme and blocks its draft from saving under a later session', async () => {
  const requests = [];
  const { instance, styles } = browser(async (_url, options) => {
    requests.push(options);
    return options.method === 'GET'
      ? response({ ...custom(), csrf_token: 'token-A' })
      : response({ detail: 'CSRF validation failed.' }, 403);
  });
  assert.equal(await instance.load(), true);
  assert.equal(styles.get('--appearance-main-surface'), custom().main_surface_color);
  instance.controller.setColor('main_surface_color', '#123456');

  assert.equal(await instance.controller.save(), false);
  assert.deepEqual(instance.controller.getState().saved, defaults());
  assert.deepEqual(instance.controller.getState().draft, defaults());
  assert.equal(instance.controller.getState().canSave, false);
  assert.equal(instance.controller.getState().loadFailed, true);
  assert.match(instance.controller.getState().error, /session|sign|load|again/i);
  assert.equal(styles.size, 0);

  instance.controller.setColor('main_surface_color', '#ABCDEF');
  assert.equal(await instance.controller.save(), false);
  assert.deepEqual(instance.controller.getState().draft, defaults());
  assert.equal(requests.length, 2);
});

for (const stage of ['response', 'body']) {
  test(`a saved response arriving after session cleanup cannot restore the prior theme (${stage})`, async () => {
    const pending = deferred();
    const entered = deferred();
    const { instance, styles } = browser(async (_url, options) => {
      if (options.method === 'GET') return response({ ...custom(), csrf_token: 'token-A' });
      if (stage === 'response') {
        entered.resolve();
        return pending.promise;
      }
      return { ...response(null), json: () => { entered.resolve(); return pending.promise; } };
    });
    assert.equal(await instance.load(), true);
    instance.controller.setColor('main_surface_color', '#123456');
    const saving = instance.controller.save();
    await entered.promise;

    instance.clearSession();
    const saved = { ...custom(), main_surface_color: '#123456' };
    pending.resolve(stage === 'response' ? response(saved) : saved);

    assert.equal(await saving, false);
    assert.deepEqual(instance.controller.getState().saved, defaults());
    assert.deepEqual(instance.controller.getState().draft, defaults());
    assert.equal(instance.controller.getState().canSave, false);
    assert.equal(styles.size, 0);
  });
}
