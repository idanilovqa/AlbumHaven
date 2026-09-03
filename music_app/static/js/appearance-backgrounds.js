/* Account-owned background preferences. Only saved values reach the document. */
(function (scope) {
  'use strict';
  const keys = ['main_surface_color', 'panel_background_color'];
  const defaults = { main_surface_color: '#111C2C', panel_background_color: '#0E1B2B' };
  const empty = () => ({ main_surface_color: null, panel_background_color: null });
  function normalizeColor(value) {
    if (value === null) return null;
    if (typeof value !== 'string' || value.length !== 7 || !/^#[0-9a-f]{6}$/i.test(value)) {
      throw new TypeError('Enter a color as #RRGGBB, for example #237A68.');
    }
    return value.toUpperCase();
  }
  function normalizePreferences(value) {
    if (!value || !keys.every(key => Object.prototype.hasOwnProperty.call(value, key))) {
      throw new TypeError('Invalid appearance response.');
    }
    return Object.fromEntries(keys.map(key => [key, normalizeColor(value[key])]));
  }
  function colorToRgb(value) {
    const color = normalizeColor(value);
    if (color === null) throw new TypeError('A color is required.');
    return [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16)).join(', ');
  }
  function luminance(color) {
    const channels = colorToRgb(color).split(', ').map(value => Number(value) / 255)
      .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  }
  function contrastRatio(first, second) {
    const a = luminance(first), b = luminance(second);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }
  function applyTheme(value, rootElement) {
    const preference = normalizePreferences(value);
    const style = rootElement.style;
    for (const [key, variable] of [['main_surface_color', '--appearance-main-surface'], ['panel_background_color', '--appearance-panel-background']]) {
      if (preference[key] === null) style.removeProperty(variable);
      else style.setProperty(variable, preference[key]);
    }
    if (preference.panel_background_color === null) style.removeProperty('--appearance-panel-background-rgb');
    else style.setProperty('--appearance-panel-background-rgb', colorToRgb(preference.panel_background_color));
  }
  function clearTheme(rootElement) { applyTheme(empty(), rootElement); }
  function createController({ initial = empty(), request, apply = () => {} }) {
    let saved = normalizePreferences(initial), draft = { ...saved }, errors = {}, inputValues = {};
    let loading = false, saving = false, error = '', loadFailed = false, generation = 0;
    const listeners = new Set();
    const syncInputs = () => { inputValues = Object.fromEntries(keys.map(key => [key, draft[key] || defaults[key]])); };
    syncInputs();
    const getState = () => {
      const dirty = keys.some(key => draft[key] !== saved[key]) || Object.keys(errors).length > 0;
      const warnings = [];
      for (const key of keys) {
        const label = key === 'main_surface_color' ? 'Main surface' : 'App bar and panels';
        const background = draft[key] || defaults[key];
        for (const [labelText, foreground] of [['light text', '#F3F6FA'], ['muted text', '#97A6BB']]) {
          if (contrastRatio(background, foreground) < 4.5) warnings.push(`${labelText} on ${label}`);
        }
      }
      return { saved: { ...saved }, draft: { ...draft }, errors: { ...errors }, inputValues: { ...inputValues },
        loading, saving, dirty, canSave: dirty && !loading && !saving && !loadFailed && !Object.keys(errors).length,
        error, loadFailed, warnings };
    };
    const notify = () => listeners.forEach(listener => listener(getState()));
    const setColor = (key, value) => {
      if (!keys.includes(key)) throw new TypeError('Unknown appearance field.');
      if (loading || saving || loadFailed) return;
      inputValues[key] = value === null ? defaults[key] : String(value);
      try { draft[key] = normalizeColor(value); delete errors[key]; error = ''; }
      catch (failure) { errors[key] = failure.message; }
      notify();
    };
    const cancel = () => {
      if (loading || saving) return;
      draft = { ...saved }; errors = {}; error = ''; syncInputs(); notify();
    };
    const reset = () => {
      if (loading || saving || loadFailed) return;
      draft = empty(); errors = {}; error = ''; syncInputs(); notify();
    };
    const load = async () => {
      if (loading || saving) return false;
      const ownGeneration = ++generation;
      loading = true; error = ''; notify();
      try {
        const preference = normalizePreferences(await request('GET'));
        if (ownGeneration !== generation) return false;
        saved = preference; draft = { ...saved }; errors = {}; loadFailed = false; syncInputs(); apply({ ...saved });
        return true;
      } catch (_failure) {
        if (ownGeneration === generation) { error = 'Backgrounds could not be loaded. Try again.'; loadFailed = true; }
        return false;
      } finally { if (ownGeneration === generation) { loading = false; notify(); } }
    };
    const save = async () => {
      if (!getState().canSave) return false;
      const ownGeneration = ++generation, submitted = { ...draft };
      saving = true; error = ''; notify();
      try {
        const preference = normalizePreferences(await request('PUT', submitted));
        if (ownGeneration !== generation) return false;
        saved = preference; draft = { ...saved }; errors = {}; syncInputs(); apply({ ...saved });
        return true;
      } catch (_failure) {
        if (ownGeneration === generation) error = 'Backgrounds could not be saved. Your changes are kept. Try Save again.';
        return false;
      } finally { if (ownGeneration === generation) { saving = false; notify(); } }
    };
    const clear = (message = '') => {
      ++generation; saved = empty(); draft = empty(); errors = {}; error = typeof message === 'string' ? message : ''; loading = false; saving = false;
      loadFailed = true; syncInputs(); notify();
    };
    return { getState, setColor, cancel, reset, load, save, clear,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
  }
  function colorField(key, label, help) {
    return `<div class="background-color-field"><label for="appearance-${key}-hex">${label}</label>
      <p id="appearance-${key}-help">${help}</p><div class="background-color-inputs">
      <input type="color" data-background-picker="${key}" aria-label="${label} color picker" aria-describedby="appearance-${key}-help">
      <input type="text" id="appearance-${key}-hex" data-background-hex="${key}" maxlength="7" spellcheck="false" autocomplete="off" aria-describedby="appearance-${key}-help appearance-${key}-error"></div>
      <small data-background-mode="${key}"></small><div class="background-field-error" id="appearance-${key}-error" data-background-error="${key}" aria-live="polite"></div></div>`;
  }
  function editorMarkup() {
    return `<section class="appearance-background-editor" aria-labelledby="appearance-background-title">
      <h3 id="appearance-background-title">Backgrounds</h3><p class="background-intro">Choose your colors. Saved backgrounds follow your account.</p>
      <div class="background-fields">${colorField(keys[0], 'Main surface', 'Library content and Settings content area.')}${colorField(keys[1], 'App bar and panels', 'App bar, artist tree, floating panels, and dialogs.')}</div>
      <div class="background-preview-heading">Preview <small>Only this preview changes before Save</small></div>
      <div class="background-preview" data-background-preview aria-label="Background color preview">
        <div class="background-preview-bar"><span aria-hidden="true">♫</span><span class="background-preview-search">Search artist, album, or track</span><span aria-hidden="true">⚙</span></div>
        <div class="background-preview-body"><div class="background-preview-tree"><strong>Artists</strong><span>All artists</span><span>Sample artist</span><span>Another artist</span></div>
        <div class="background-preview-content"><strong>Your library</strong><div class="background-preview-card"><div aria-hidden="true">♫</div><small>Sample album</small><span class="background-preview-stars" aria-label="5 stars">★★★★★</span></div>
        <div class="background-preview-floating">Floating panel<span>View album</span><span>Album details</span></div></div></div><div class="background-preview-player">▶ &nbsp; Nothing is playing</div></div>
      <p class="background-warning" data-background-warning role="status" hidden></p>
      <p class="background-request-error" data-background-request-error role="alert" hidden></p>
      <div class="background-actions"><button class="button button-secondary background-reset" type="button" data-background-reset>Reset backgrounds</button><button class="button button-secondary" type="button" data-background-cancel>Cancel</button><button class="button background-save" type="button" data-background-save>Save</button><button class="button button-secondary" type="button" data-background-retry hidden>Try again</button></div>
      <p class="background-status" data-background-status role="status"></p></section>`;
  }
  function installBrowser(window, document) {
    if (window.AlbumHavenAppearance?.instance) return window.AlbumHavenAppearance.instance;
    const root = document.documentElement;
    let initial = empty(), csrfToken = '', loaded = false, mounted = null, unsubscribe = null, sessionGeneration = 0;
    try { initial = normalizePreferences(JSON.parse(document.getElementById('appearance-bootstrap')?.textContent || '{}')); }
    catch (_failure) { /* Missing or invalid bootstrap never applies untrusted CSS. */ }
    applyTheme(initial, root);
    const clearSession = (message = '') => { ++sessionGeneration; csrfToken = ''; loaded = false; controller.clear(message); clearTheme(root); };
    const request = async (method, payload) => {
      const ownSession = sessionGeneration;
      const headers = { Accept: 'application/json' };
      if (method === 'PUT') { headers['Content-Type'] = 'application/json'; headers['X-Album-Haven-CSRF'] = csrfToken; }
      const response = await originalFetch('/account/appearance', { method, credentials: 'same-origin', cache: 'no-store', headers,
        ...(method === 'PUT' ? { body: JSON.stringify(payload) } : {}) });
      if (ownSession !== sessionGeneration) throw new Error('Session changed.');
      if (response.status === 401 || response.status === 403 || (response.redirected && new URL(response.url, window.location.href).pathname === '/login')) clearSession('Your session changed or expired. Sign in again, then try loading backgrounds again.');
      if (!response.ok || response.redirected) throw new Error('Appearance unavailable.');
      const data = await response.json();
      if (ownSession !== sessionGeneration) throw new Error('Session changed.');
      if (method === 'GET') csrfToken = typeof data.csrf_token === 'string' ? data.csrf_token : '';
      return data;
    };
    const controller = createController({ initial, request, apply: preference => applyTheme(preference, root) });
    const load = async () => { const result = await controller.load(); if (result) loaded = true; return result; };
    const unmount = () => { unsubscribe?.(); unsubscribe = null; mounted = null; };
    const mount = (host) => {
      unmount();
      host.innerHTML = editorMarkup();
      mounted = host.querySelector('.appearance-background-editor');
      const editor = mounted;
      const find = selector => editor.querySelector(selector);
      const sync = state => {
        if (mounted !== editor) return;
        editor.setAttribute('aria-busy', String(state.loading || state.saving));
        const disabled = state.loading || state.saving || state.loadFailed;
        for (const key of keys) {
          const picker = find(`[data-background-picker="${key}"]`), hex = find(`[data-background-hex="${key}"]`);
          picker.value = state.draft[key] || defaults[key];
          if (hex.value !== state.inputValues[key]) hex.value = state.inputValues[key];
          hex.setAttribute('aria-invalid', String(Boolean(state.errors[key])));
          picker.disabled = hex.disabled = disabled;
          find(`[data-background-mode="${key}"]`).textContent = state.draft[key] === null ? 'Theme default' : 'Custom color';
          find(`[data-background-error="${key}"]`).textContent = state.errors[key] || '';
        }
        const preview = find('[data-background-preview]');
        preview.style.setProperty('--preview-main', state.draft.main_surface_color || defaults.main_surface_color);
        preview.style.setProperty('--preview-panels', state.draft.panel_background_color || defaults.panel_background_color);
        preview.style.setProperty('--preview-floating', state.draft.panel_background_color || '#1F2937');
        const warning = find('[data-background-warning]');
        warning.hidden = !state.warnings.length;
        warning.textContent = state.warnings.length ? `Low contrast: ${state.warnings.join('; ')}. Some text may be hard to read. You can still save these colors.` : '';
        const failure = find('[data-background-request-error]');
        failure.hidden = !state.error; failure.textContent = state.error;
        find('[data-background-reset]').disabled = disabled;
        find('[data-background-cancel]').disabled = state.loading || state.saving || !state.dirty;
        find('[data-background-save]').disabled = !state.canSave;
        find('[data-background-save]').textContent = state.saving ? 'Saving…' : 'Save';
        find('[data-background-retry]').hidden = !state.loadFailed;
        find('[data-background-retry]').disabled = state.loading || state.saving;
        find('[data-background-status]').textContent = state.loading ? 'Loading your backgrounds…' : state.saving ? 'Saving backgrounds…'
          : (state.error || state.loadFailed) ? '' : state.dirty ? 'Unsaved changes' : 'Saved to your account';
      };
      editor.addEventListener('input', event => {
        const key = event.target.getAttribute('data-background-picker') || event.target.getAttribute('data-background-hex');
        if (key) controller.setColor(key, event.target.value);
      });
      find('[data-background-reset]').addEventListener('click', () => controller.reset());
      find('[data-background-cancel]').addEventListener('click', () => controller.cancel());
      find('[data-background-save]').addEventListener('click', () => { void controller.save(); });
      find('[data-background-retry]').addEventListener('click', () => { void load(); });
      unsubscribe = controller.subscribe(sync); sync(controller.getState());
      if (!loaded) void load();
      return unmount;
    };
    const allowLeave = (confirm = message => window.confirm(message)) => {
      const state = controller.getState();
      if (state.saving) return false;
      if (!state.dirty) return true;
      if (!confirm('Discard your unsaved background changes?')) return false;
      controller.cancel(); return true;
    };
    // Observe the same-origin auth boundary, including requests outside this editor.
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const response = await originalFetch(input, init);
      let sameOrigin = false;
      try { sameOrigin = new URL(typeof input === 'string' ? input : input.url, window.location.href).origin === window.location.origin; } catch (_failure) {}
      if (sameOrigin && (response.status === 401 || (response.redirected && new URL(response.url, window.location.href).pathname === '/login'))) clearSession();
      return response;
    };
    document.addEventListener('click', event => {
      const link = event.target?.closest?.('a[href]');
      if (!link || link.hasAttribute('download') || (link.target && link.target !== '_self') || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
      if (!allowLeave()) { event.preventDefault(); event.stopImmediatePropagation(); }
    }, true);
    document.addEventListener('submit', event => {
      if (!allowLeave()) { event.preventDefault(); event.stopImmediatePropagation(); return; }
      try { if (new URL(event.target.action, window.location.href).pathname === '/logout') clearSession(); } catch (_failure) {}
    }, true);
    window.addEventListener('beforeunload', event => {
      if (!controller.getState().dirty && !controller.getState().saving) return;
      event.preventDefault(); event.returnValue = '';
    });
    window.addEventListener('pagehide', () => clearSession());
    window.addEventListener('pageshow', event => { if (event.persisted) { clearSession(); void load(); } });
    return { controller, mount, unmount, allowLeave, clearSession, load };
  }
  const api = { normalizeColor, colorToRgb, contrastRatio, applyTheme, clearTheme, createController, installBrowser };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (scope && scope.document) { scope.AlbumHavenAppearance = api; api.instance = installBrowser(scope, scope.document); }
})(typeof window !== 'undefined' ? window : null);
