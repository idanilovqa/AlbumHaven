/* Account-owned appearance. Drafts never recolor the live document. */
(function (scope) {
  'use strict';
  const catalog = typeof module !== 'undefined' && module.exports ? require('./appearance-palettes.js') : scope.AlbumHavenAppearancePalettes;
  const { palettes, resolveAppearance, normalizePlayerOverride } = catalog;
  const keys = ['main_surface_color', 'panel_background_color'];
  const defaults = { main_surface_color: '#111C2C', panel_background_color: '#0E1B2B' };
  const empty = () => ({ main_surface_color: null, panel_background_color: null });
  const canonicalEmpty = () => ({ ...empty(), palette_id: null, panel_index: 0, player_override: null, compact_player_style: 'docked' });
  const isCanonical = value => ['palette_id', 'panel_index', 'player_override'].some(key => Object.hasOwn(value, key));
  const copy = value => ({ ...value, ...(Object.hasOwn(value, 'player_override') ? { player_override: value.player_override ? { ...value.player_override } : null } : {}) });
  function normalizeColor(value) {
    if (value === null) return null;
    if (typeof value !== 'string' || value.length !== 7 || !/^#[0-9a-f]{6}$/i.test(value)) throw new TypeError('Enter a color as #RRGGBB, for example #237A68.');
    return value.toUpperCase();
  }
  function normalizePreferences(value) {
    if (!value || !keys.every(key => Object.hasOwn(value, key))) throw new TypeError('Invalid appearance response.');
    const normalized = Object.fromEntries(keys.map(key => [key, normalizeColor(value[key])]));
    if (!isCanonical(value)) return normalized;
    if (!['palette_id', 'panel_index', 'player_override'].every(key => Object.hasOwn(value, key))) throw new TypeError('Incomplete appearance response.');
    const id = value.palette_id;
    if (id !== null && !palettes.some(palette => palette.id === id)) throw new TypeError('Unknown palette.');
    if (!Number.isInteger(value.panel_index) || value.panel_index < 0 || value.panel_index > (id === null ? 0 : 2)) throw new TypeError('Unknown panel companion.');
    const compactStyle = value.compact_player_style === 'floating' ? 'floating' : 'docked';
    return { ...(id === null ? normalized : empty()), palette_id: id, panel_index: value.panel_index, player_override: normalizePlayerOverride(value.player_override), compact_player_style: compactStyle };
  }
  function normalizeRecentColors(value) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 5) throw new TypeError('Invalid recent waveform colors.');
    const colors = value.map(color => { const normalized = normalizeColor(color); if (normalized === null) throw new TypeError('A recent color is required.'); return normalized; });
    if (new Set(colors).size !== colors.length) throw new TypeError('Duplicate recent waveform colors.');
    return colors;
  }
  function colorToRgb(value) {
    const color = normalizeColor(value);
    if (color === null) throw new TypeError('A color is required.');
    return [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16)).join(', ');
  }
  function luminance(color) {
    const channels = colorToRgb(color).split(', ').map(value => Number(value) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  }
  function contrastRatio(first, second) {
    const a = luminance(first), b = luminance(second);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }
  const surfaceTokens = ['ink', 'muted', 'card', 'control', 'line', 'hover', 'accent', 'stars'];
  const playerTokens = ['player', 'player-ink', 'play', 'play-ink', 'waveform-fill', 'waveform-edge'];
  function applyTheme(value, rootElement) {
    const preference = normalizePreferences(value), effective = resolveAppearance(preference), style = rootElement.style;
    const themed = Boolean(preference.palette_id), playerThemed = themed || Boolean(preference.player_override);
    const main = themed ? effective.main : preference.main_surface_color;
    const panel = themed ? effective.panel : preference.panel_background_color;
    for (const [color, variable] of [[main, '--appearance-main-surface'], [panel, '--appearance-panel-background']]) {
      if (color === null) style.removeProperty(variable); else style.setProperty(variable, color);
    }
    if (panel === null) style.removeProperty('--appearance-panel-background-rgb');
    else style.setProperty('--appearance-panel-background-rgb', colorToRgb(panel));
    for (const token of surfaceTokens) {
      if (themed) style.setProperty('--appearance-' + token, effective.tokens[token]);
      else style.removeProperty('--appearance-' + token);
    }
    for (const token of playerTokens) {
      if (playerThemed) style.setProperty('--appearance-' + token, effective.tokens[token]);
      else style.removeProperty('--appearance-' + token);
    }
    if (themed) {
      rootElement.setAttribute?.('data-appearance-palette', preference.palette_id);
      rootElement.setAttribute?.('data-appearance-mode', effective.mode);
    } else { rootElement.removeAttribute?.('data-appearance-palette'); rootElement.removeAttribute?.('data-appearance-mode'); }
    if (playerThemed) rootElement.setAttribute?.('data-appearance-player', 'custom');
    else rootElement.removeAttribute?.('data-appearance-player');
    rootElement.setAttribute?.('data-compact-player-style', preference.compact_player_style || 'docked');
  }
  // Pin the resolved draft locally, including defaults that would otherwise inherit
  // the document's saved palette. This never applies anything to the live app.
  function applyDraftEditorTheme(value, editor) {
    const effective = resolveAppearance(value);
    editor.style.setProperty('--appearance-main-surface', effective.main);
    editor.style.setProperty('--appearance-panel-background', effective.panel);
    for (const [token, color] of Object.entries(effective.tokens)) editor.style.setProperty('--appearance-' + token, color);
    editor.style.setProperty('--appearance-on-accent', catalog.contrastingInk(effective.tokens.accent));
    editor.setAttribute('data-appearance-mode', effective.mode);
    if (value.palette_id) editor.setAttribute('data-appearance-palette', value.palette_id);
    else editor.removeAttribute('data-appearance-palette');
  }
  function clearTheme(rootElement) { applyTheme(empty(), rootElement); }
  function createController({ initial = empty(), request, apply = () => {} }) {
    let saved = normalizePreferences(initial), draft = copy(saved), errors = {}, inputValues = {};
    let recentColors = normalizeRecentColors(initial.waveform_recent_colors), waveformColorUpdates = [];
    let loading = false, saving = false, error = '', loadFailed = false, generation = 0;
    const listeners = new Set(), busy = () => loading || saving || loadFailed;
    const syncInputs = (preserveErrors = false) => {
      const next = Object.fromEntries(keys.map(key => [key, draft[key] || defaults[key]]));
      const player = resolveAppearance(draft).player;
      for (const field of ['background', 'fill', 'edge']) next['player_' + field] = player[field];
      if (preserveErrors) for (const key of Object.keys(errors)) next[key] = inputValues[key];
      inputValues = next;
    };
    syncInputs();
    const getState = () => {
      const dirty = JSON.stringify(draft) !== JSON.stringify(saved) || Object.keys(errors).length > 0 || waveformColorUpdates.length > 0;
      const effective = resolveAppearance(draft), warnings = [];
      if (!draft.palette_id) for (const key of keys) {
        const label = key === 'main_surface_color' ? 'Main surface' : 'App bar and panels';
        for (const [labelText, foreground] of [['light text', '#F3F6FA'], ['muted text', '#97A6BB']]) {
          if (contrastRatio(draft[key] || defaults[key], foreground) < 4.5) warnings.push(`${labelText} on ${label}`);
        }
      }
      return { saved: copy(saved), draft: copy(draft), errors: { ...errors }, inputValues: { ...inputValues }, effective,
        recentColors: [...recentColors], waveformColorUpdates: [...waveformColorUpdates], loading, saving, dirty, canSave: dirty && !busy() && !Object.keys(errors).length, error, loadFailed, warnings };
    };
    const notify = () => listeners.forEach(listener => listener(getState()));
    const promote = () => {
      if (!isCanonical(saved)) saved = { ...canonicalEmpty(), ...saved };
      if (!isCanonical(draft)) draft = { ...canonicalEmpty(), ...draft };
    };
    const setColor = (key, value) => {
      if (!keys.includes(key)) throw new TypeError('Unknown appearance field.');
      if (busy()) return;
      inputValues[key] = value === null ? defaults[key] : String(value);
      try { draft[key] = normalizeColor(value); if (isCanonical(draft)) { draft.palette_id = null; draft.panel_index = 0; } delete errors[key]; error = ''; }
      catch (failure) { errors[key] = failure.message; }
      notify();
    };
    const setPalette = id => {
      if (id !== null && !palettes.some(palette => palette.id === id)) throw new TypeError('Unknown palette.');
      if (busy()) return;
      promote(); draft = { ...draft, ...empty(), palette_id: id, panel_index: 0 };
      keys.forEach(key => delete errors[key]); error = ''; syncInputs(true); notify();
    };
    const setPanelIndex = index => {
      if (!Number.isInteger(index) || index < 0 || index > (draft.palette_id ? 2 : 0)) throw new TypeError('Unknown panel companion.');
      if (busy()) return;
      promote(); draft.panel_index = index; error = ''; syncInputs(true); notify();
    };
    const setPlayerMode = mode => {
      if (!['palette', 'custom'].includes(mode)) throw new TypeError('Unknown player mode.');
      if (busy()) return;
      promote();
      if (mode === 'custom' && draft.player_override) return;
      draft.player_override = mode === 'custom' ? { ...resolveAppearance(draft).player } : null;
      for (const field of ['background', 'fill', 'edge']) delete errors['player_' + field];
      error = ''; syncInputs(true); notify();
    };
    const setCompactPlayerStyle = style => {
      if (!['docked', 'floating'].includes(style)) throw new TypeError('Unknown compact player style.');
      if (busy()) return;
      promote(); draft.compact_player_style = style; error = ''; notify();
    };
    const rememberColor = color => { waveformColorUpdates = [color, ...waveformColorUpdates.filter(item => item !== color)].slice(0, 5); };
    const setPlayerColor = (field, value, { recordRecent = true } = {}) => {
      if (!['background', 'fill', 'edge'].includes(field)) throw new TypeError('Unknown player color.');
      if (busy()) return;
      promote(); const key = 'player_' + field; inputValues[key] = String(value);
      try {
        const color = normalizeColor(value); if (color === null) throw new TypeError('A player color is required.');
        draft.player_override = { ...(draft.player_override || resolveAppearance(draft).player), [field]: color };
        if (recordRecent && field !== 'background') rememberColor(color);
        delete errors[key]; error = ''; syncInputs(true);
      } catch (failure) { errors[key] = failure.message; }
      notify();
    };
    const restoreWaveformColors = pair => {
      if (!pair || typeof pair !== 'object' || Array.isArray(pair) || Object.keys(pair).length !== 2 || !['fill', 'edge'].every(field => Object.hasOwn(pair, field))) throw new TypeError('Both previous waveform colors are required.');
      const fill = normalizeColor(pair.fill), edge = normalizeColor(pair.edge);
      if (fill === null || edge === null) throw new TypeError('Both previous waveform colors are required.');
      if (busy()) return;
      promote(); draft.player_override = { ...(draft.player_override || resolveAppearance(draft).player), fill, edge };
      rememberColor(fill); rememberColor(edge); delete errors.player_fill; delete errors.player_edge;
      error = ''; syncInputs(true); notify();
    };
    const cancel = () => { if (loading || saving) return; draft = copy(saved); errors = {}; waveformColorUpdates = []; error = ''; syncInputs(); notify(); };
    const reset = () => {
      if (busy()) return;
      draft = isCanonical(draft) ? { ...canonicalEmpty(), player_override: draft.player_override ? { ...draft.player_override } : null } : empty();
      keys.forEach(key => delete errors[key]); error = ''; syncInputs(true); notify();
    };
    const load = async () => {
      if (loading || saving) return false;
      const ownGeneration = ++generation; loading = true; error = ''; notify();
      try {
        const response = await request('GET');
        const preference = normalizePreferences(response), history = normalizeRecentColors(response.waveform_recent_colors);
        if (ownGeneration !== generation) return false;
        saved = preference; draft = copy(saved); recentColors = history; waveformColorUpdates = []; errors = {}; loadFailed = false; syncInputs(); apply(copy(saved)); return true;
      } catch (_failure) {
        if (ownGeneration === generation) { error = 'Backgrounds could not be loaded. Try again.'; loadFailed = true; } return false;
      } finally { if (ownGeneration === generation) { loading = false; notify(); } }
    };
    const save = async () => {
      if (!getState().canSave) return false;
      const ownGeneration = ++generation, submitted = { ...copy(draft), ...(waveformColorUpdates.length ? { waveform_color_updates: [...waveformColorUpdates] } : {}) }; saving = true; error = ''; notify();
      try {
        const response = await request('PUT', submitted);
        const preference = normalizePreferences(response), history = normalizeRecentColors(response.waveform_recent_colors);
        if (ownGeneration !== generation) return false;
        saved = preference; draft = copy(saved); recentColors = history; waveformColorUpdates = []; errors = {}; syncInputs(); apply(copy(saved)); return true;
      } catch (_failure) {
        if (ownGeneration === generation) error = 'Backgrounds could not be saved. Your changes are kept. Try Save again.'; return false;
      } finally { if (ownGeneration === generation) { saving = false; notify(); } }
    };
    const clear = (message = '') => {
      ++generation; saved = isCanonical(saved) ? canonicalEmpty() : empty(); draft = copy(saved); errors = {};
      recentColors = []; waveformColorUpdates = [];
      error = typeof message === 'string' ? message : ''; loading = false; saving = false; loadFailed = true; syncInputs(); notify();
    };
    return { getState, setColor, setPalette, setPanelIndex, setPlayerMode, setCompactPlayerStyle, setPlayerColor, restoreWaveformColors, cancel, reset, load, save, clear,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
  }
  function colorField(field, label) {
    return `<div class="background-color-field"><label for="appearance-player-${field}-hex">${label}</label>
      <div class="background-color-inputs"><input type="color" data-player-picker="${field}" aria-label="${label} color picker">
      <input type="text" id="appearance-player-${field}-hex" data-player-hex="${field}" maxlength="7" spellcheck="false" autocomplete="off" aria-describedby="appearance-player-${field}-error"></div>
      <div class="background-field-error" id="appearance-player-${field}-error" data-player-error="${field}" role="status"></div></div>`;
  }
  function editorMarkup() {
    return `<section class="appearance-background-editor appearance-palette-editor" aria-labelledby="appearance-background-title">
      <div class="background-editor-heading"><div><h3 id="appearance-background-title">Backgrounds</h3><p class="background-intro">Dark, black, and light. Pick a foundation that feels right.</p></div><span>Personal appearance</span></div>
      <div class="background-editor-columns"><div class="background-choices">
      <section aria-labelledby="appearance-palette-label"><h4 id="appearance-palette-label"><span>1</span>Main background</h4><p class="background-help">Choose a palette for your library.</p>
      <div class="background-palette-grid">${palettes.map(palette => `<button type="button" class="background-family" data-background-palette="${palette.id}" aria-label="${palette.name}" aria-pressed="false" title="${palette.desc}"><span class="background-family-swatch" style="background:${palette.main};--swatch-panel:${palette.panels[0][1]}"></span><strong>${palette.name}</strong></button>`).join('')}</div></section>
      <section aria-labelledby="appearance-panel-label"><h4 id="appearance-panel-label"><span>2</span>App bar &amp; panels</h4><p class="background-help" data-background-panel-help></p><div class="background-companions" data-background-companions></div>
      <p class="background-help">App bar, artist tree, menus, floating panels, and dialogs.</p></section></div>
      <div class="background-preview-column"><div class="background-preview-heading">Preview <small>Changes apply after Save</small></div>
      <div class="background-preview" data-background-preview aria-label="Appearance preview"><div class="background-preview-bar"><span aria-hidden="true">♫</span><span class="background-preview-search">Search your library</span><span aria-hidden="true">A</span></div>
      <div class="background-preview-body"><div class="background-preview-tree"><strong>Artists</strong><span>All artists</span><span>Coastal Lines</span><span>Northbound</span><span>Slow Seasons</span></div>
      <div class="background-preview-content"><strong>Your library</strong><div class="background-preview-card"><div aria-hidden="true">♫</div><small>Still Water</small><span class="background-preview-stars" aria-label="5 stars">★★★★★</span></div><div class="background-preview-floating">Album options<span>View album</span><span>Album details</span></div></div></div>
      <div class="background-preview-player"><span class="background-preview-play">▶</span><span>Waveform</span><svg viewBox="0 0 160 28" role="img" aria-label="Waveform color preview"><path d="M0 14 L8 9 L16 6 L24 4 L32 2 L40 9 L48 11 L56 3 L64 10 L72 1 L80 10 L88 6 L96 3 L104 11 L112 5 L120 2 L128 10 L136 9 L144 7 L152 12 L160 14 L152 16 L144 21 L136 19 L128 18 L120 26 L112 23 L104 17 L96 25 L88 22 L80 18 L72 27 L64 18 L56 25 L48 17 L40 19 L32 26 L24 24 L16 22 L8 19 Z"/></svg></div></div>
      <div class="background-pair-summary"><strong data-background-pair-title></strong><p class="background-help" data-background-pair-description></p></div>
      <section class="background-player-section" aria-labelledby="appearance-player-label"><h4 id="appearance-player-label"><span>3</span>Player &amp; waveform</h4><p class="background-help">One color group for your player and waveform.</p>
      <div class="background-player-modes" role="group" aria-label="Player color mode"><button type="button" data-background-player-mode="palette" aria-pressed="true">Match palette</button><button type="button" data-background-player-mode="custom" aria-pressed="false">Custom player colors</button></div>
      <p class="background-help" data-background-player-help></p><div class="background-player-fields" data-background-player-fields hidden>${colorField('background', 'Player background')}<small>Player text and buttons adapt to the background.</small></div>
      <button class="button button-secondary background-editor-link" type="button" data-utility-appearance-key="seekbar">Edit waveform in Seekbar</button><p class="background-field-error" data-background-other-errors hidden></p><div class="background-player-summary" data-background-player-summary></div><p class="background-help">Waveform fill and edge stay with this group. Edit those colors in Seekbar.</p></section>
      <section class="background-player-section compact-player-style-section" aria-labelledby="appearance-compact-player-label"><h4 id="appearance-compact-player-label"><span>4</span>Compact player</h4><p class="background-help">Choose the desktop layout used when the player is collapsed.</p><div class="background-player-modes" role="group" aria-label="Compact player style"><button type="button" data-compact-player-style="docked" aria-pressed="true">Docked</button><button type="button" data-compact-player-style="floating" aria-pressed="false">Floating</button></div></section>
      <p class="background-help">Save applies the palette and all three player colors together. Cancel restores the saved set. Reset backgrounds keeps your custom player group.</p></div></div>
      <p class="background-warning" data-background-warning role="status" hidden></p><p class="background-request-error" data-background-request-error role="alert" hidden></p>
      <div class="background-actions"><button class="button button-secondary background-reset" type="button" data-background-reset>Reset backgrounds</button><button class="button button-secondary" type="button" data-background-cancel>Cancel</button><button class="button background-save" type="button" data-background-save>Save</button><button class="button button-secondary" type="button" data-background-retry hidden>Try again</button></div><p class="background-status" data-background-status role="status"></p></section>`;
  }
  function seekbarMarkup() {
    return `<section class="appearance-background-editor appearance-seekbar-editor" aria-labelledby="appearance-waveform-title">
      <h3 id="appearance-waveform-title">Waveform colors</h3><p class="background-intro">Choose the fill and edge together with your player background.</p>
      <div class="background-player-modes" role="group" aria-label="Player color mode"><button type="button" data-background-player-mode="palette" aria-pressed="true">Match palette</button><button type="button" data-background-player-mode="custom" aria-pressed="false">Custom player colors</button></div>
      <p class="background-help" data-waveform-mode-help></p>
      <div class="waveform-color-fields">${['fill', 'edge'].map(field => `<div>${colorField(field, field === 'fill' ? 'Waveform fill' : 'Waveform edge')}<div class="waveform-recents" data-waveform-recents="${field}" role="group" aria-label="Recent waveform ${field} colors"></div></div>`).join('')}</div>
      <p class="background-help" data-waveform-recents-help></p>
      <div class="waveform-color-preview" data-waveform-preview aria-label="Waveform color preview"><svg viewBox="0 0 300 48" role="img" aria-label="Draft waveform fill and edge"><path d="M0 24 L12 18 L24 8 L36 19 L48 6 L60 15 L72 3 L84 10 L96 19 L108 5 L120 14 L132 8 L144 17 L156 3 L168 12 L180 7 L192 18 L204 9 L216 4 L228 16 L240 10 L252 3 L264 15 L276 18 L288 10 L300 24 L288 38 L276 30 L264 33 L252 45 L240 38 L228 32 L216 44 L204 39 L192 30 L180 41 L168 36 L156 45 L144 31 L132 40 L120 34 L108 43 L96 29 L84 38 L72 45 L60 33 L48 42 L36 29 L24 40 L12 30 Z"/></svg></div>
      <div class="waveform-recovery"><button class="button button-secondary" type="button" data-waveform-restore>Restore previous browser colors</button><p class="background-help">Use the earlier waveform colors stored in this browser. They apply to this account only after Save.</p><p class="background-field-error" data-waveform-recovery-status role="status" hidden></p></div>
      <button class="button button-secondary background-editor-link" type="button" data-utility-appearance-key="backgrounds">Edit player background in Backgrounds</button>
      <p class="background-field-error" data-background-other-errors hidden></p><p class="background-help">Save applies all pending Backgrounds and waveform colors together. Cancel restores your saved colors.</p>
      <p class="background-request-error" data-background-request-error role="alert" hidden></p>
      <div class="background-actions"><button class="button button-secondary" type="button" data-background-cancel>Cancel</button><button class="button background-save" type="button" data-background-save>Save</button><button class="button button-secondary" type="button" data-background-retry hidden>Try again</button></div><p class="background-status" data-background-status role="status"></p></section>`;
  }
  function installBrowser(window, document) {
    if (window.AlbumHavenAppearance?.instance) return window.AlbumHavenAppearance.instance;
    const root = document.documentElement;
    let initial = empty(), csrfToken = '', loaded = false, mounted = null, unsubscribe = null, sessionGeneration = 0;
    try { const bootstrap = JSON.parse(document.getElementById('appearance-bootstrap')?.textContent || '{}'); initial = { ...normalizePreferences(bootstrap), waveform_recent_colors: normalizeRecentColors(bootstrap.waveform_recent_colors) }; }
    catch (_failure) { /* Missing or invalid bootstrap never applies untrusted CSS. */ }
    let savedPlayerColors = null;
    const applySavedTheme = preference => {
      applyTheme(preference, root);
      savedPlayerColors = preference.palette_id || preference.player_override ? resolveAppearance(preference).player : null;
      if (typeof window.CustomEvent === 'function') window.dispatchEvent?.(new window.CustomEvent('album-haven-appearance-change'));
    };
    applySavedTheme(initial);
    const clearSession = (message = '') => { ++sessionGeneration; csrfToken = ''; loaded = false; controller.clear(message); savedPlayerColors = null; clearTheme(root); if (typeof window.CustomEvent === 'function') window.dispatchEvent?.(new window.CustomEvent('album-haven-appearance-change')); };
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
    const controller = createController({ initial, request, apply: applySavedTheme });
    const load = async () => { const result = await controller.load(); if (result) loaded = true; return result; };
    const unmount = () => { unsubscribe?.(); unsubscribe = null; mounted = null; };
    const mount = host => {
      unmount(); host.innerHTML = editorMarkup(); mounted = host.querySelector('.appearance-background-editor');
      const editor = mounted, find = selector => editor.querySelector(selector);
      let drawnPalette;
      const sync = state => {
        if (mounted !== editor) return;
        applyDraftEditorTheme(state.draft, editor);
        const disabled = state.loading || state.saving || state.loadFailed, preference = state.draft, effective = state.effective;
        editor.setAttribute('aria-busy', String(state.loading || state.saving));
        editor.querySelectorAll('button,input').forEach(element => { element.disabled = disabled; });
        editor.querySelectorAll('[data-background-palette]').forEach(button => button.setAttribute('aria-pressed', String(button.getAttribute('data-background-palette') === preference.palette_id)));
        const palette = palettes.find(item => item.id === preference.palette_id);
        const legacy = !palette && (preference.main_surface_color || preference.panel_background_color);
        if (drawnPalette !== (preference.palette_id || null)) {
          find('[data-background-companions]').innerHTML = palette ? palette.panels.map((panel, index) => `<button type="button" class="background-companion" data-background-panel="${index}" aria-label="${panel[0]}" aria-pressed="false"><span style="background:${panel[1]}"></span><span><strong>${panel[0]}</strong><small>${panel[2]}</small></span><i aria-hidden="true"></i></button>`).join('') : '<p class="background-current-colors"></p>';
          drawnPalette = preference.palette_id || null;
        }
        editor.querySelectorAll('[data-background-panel]').forEach(button => { button.disabled = disabled; button.setAttribute('aria-pressed', String(Number(button.getAttribute('data-background-panel')) === preference.panel_index)); });
        if (!palette) find('.background-current-colors').textContent = legacy ? 'Current custom colors are kept until you choose a palette or reset backgrounds.' : 'Theme defaults. Each panel keeps its original background.';
        find('[data-background-panel-help]').textContent = palette ? 'Three companions for ' + palette.name + '.' : 'Choose a palette to see coordinated panel options.';
        const panel = palette?.panels[preference.panel_index];
        find('[data-background-pair-title]').textContent = palette ? palette.name + ' + ' + panel[0] : legacy ? 'Current custom colors' : 'Theme defaults';
        find('[data-background-pair-description]').textContent = panel?.[2] || 'Saved backgrounds remain unchanged until Save.';
        const preview = find('[data-background-preview]');
        preview.style.setProperty('--preview-main', effective.main); preview.style.setProperty('--preview-panels', effective.panel);
        preview.style.setProperty('--preview-floating', !palette && !preference.panel_background_color ? '#1F2937' : effective.panel);
        for (const [token, value] of Object.entries(effective.tokens)) preview.style.setProperty('--preview-' + token, value);
        const custom = Boolean(preference.player_override);
        editor.querySelectorAll('[data-background-player-mode]').forEach(button => button.setAttribute('aria-pressed', String((button.getAttribute('data-background-player-mode') === 'custom') === custom)));
        editor.querySelectorAll('[data-compact-player-style]').forEach(button => button.setAttribute('aria-pressed', String(button.getAttribute('data-compact-player-style') === preference.compact_player_style)));
        find('[data-background-player-fields]').hidden = !custom;
        find('[data-background-player-help]').textContent = custom ? 'Your background, waveform fill and edge stay together when you change palettes.' : 'The palette sets your player background, waveform fill and edge together.';
        for (const field of ['background']) {
          const key = 'player_' + field, picker = find(`[data-player-picker="${field}"]`), hex = find(`[data-player-hex="${field}"]`);
          picker.value = effective.player[field]; if (hex.value !== state.inputValues[key]) hex.value = state.inputValues[key];
          hex.setAttribute('aria-invalid', String(Boolean(state.errors[key]))); find(`[data-player-error="${field}"]`).textContent = state.errors[key] || '';
        }
        const otherErrors = find('[data-background-other-errors]'); otherErrors.hidden = !state.errors.player_fill && !state.errors.player_edge; otherErrors.textContent = 'Fix the waveform color errors in Seekbar before saving.';
        find('[data-background-player-summary]').innerHTML = Object.entries(effective.player).map(([field, color]) => `<span><i style="background:${color}"></i>${({ background: 'Background', fill: 'Fill', edge: 'Edge' })[field]} <b>${color}</b></span>`).join('');
        const warning = find('[data-background-warning]'); warning.hidden = !state.warnings.length;
        warning.textContent = state.warnings.length ? `Low contrast: ${state.warnings.join('; ')}. Some text may be hard to read. You can still save these colors.` : '';
        const failure = find('[data-background-request-error]'); failure.hidden = !state.error; failure.textContent = state.error;
        find('[data-background-cancel]').disabled = state.loading || state.saving || !state.dirty;
        find('[data-background-save]').disabled = !state.canSave; find('[data-background-save]').textContent = state.saving ? 'Saving…' : 'Save';
        find('[data-background-retry]').hidden = !state.loadFailed; find('[data-background-retry]').disabled = state.loading || state.saving;
        find('[data-background-status]').textContent = state.loading ? 'Loading your appearance…' : state.saving ? 'Saving appearance…' : (state.error || state.loadFailed) ? '' : state.dirty ? 'Unsaved appearance changes' : 'Saved to your account';
      };
      editor.addEventListener('input', event => {
        const field = event.target.getAttribute('data-player-picker') || event.target.getAttribute('data-player-hex');
        if (field) controller.setPlayerColor(field, event.target.value, { recordRecent: !event.target.hasAttribute('data-player-picker') });
      });
      editor.addEventListener('click', event => {
        const button = event.target.closest('button'); if (!button || button.disabled) return;
        if (button.hasAttribute('data-background-palette')) controller.setPalette(button.getAttribute('data-background-palette'));
        else if (button.hasAttribute('data-background-panel')) controller.setPanelIndex(Number(button.getAttribute('data-background-panel')));
        else if (button.hasAttribute('data-background-player-mode')) controller.setPlayerMode(button.getAttribute('data-background-player-mode'));
        else if (button.hasAttribute('data-compact-player-style')) controller.setCompactPlayerStyle(button.getAttribute('data-compact-player-style'));

        else if (button.hasAttribute('data-background-reset')) controller.reset();
        else if (button.hasAttribute('data-background-cancel')) controller.cancel();
        else if (button.hasAttribute('data-background-save')) void controller.save();
        else if (button.hasAttribute('data-background-retry')) void load();
      });
      unsubscribe = controller.subscribe(sync); sync(controller.getState()); if (!loaded) void load(); return unmount;
    };
    const mountSeekbar = (host, { getLegacyColors = () => null } = {}) => {
      unmount(); host.innerHTML = seekbarMarkup(); mounted = host.querySelector('.appearance-background-editor');
      const editor = mounted, find = selector => editor.querySelector(selector);
      let recoveryMessage = '';
      const sync = state => {
        if (mounted !== editor) return;
        applyDraftEditorTheme(state.draft, editor);
        const disabled = state.loading || state.saving || state.loadFailed, custom = Boolean(state.draft.player_override);
        editor.setAttribute('aria-busy', String(state.loading || state.saving));
        editor.querySelectorAll('button,input').forEach(element => { element.disabled = disabled; });
        editor.querySelectorAll('[data-background-player-mode]').forEach(button => button.setAttribute('aria-pressed', String((button.getAttribute('data-background-player-mode') === 'custom') === custom)));
        find('[data-waveform-mode-help]').textContent = custom ? 'Custom colors stay together when you change palettes. Match palette resets the player background, fill and edge together.' : 'Your palette sets all three player colors. Choosing a waveform color creates a custom group and keeps the current player background.';
        const history = [...new Set([...state.waveformColorUpdates, ...state.recentColors])].slice(0, 5);
        for (const field of ['fill', 'edge']) {
          const key = 'player_' + field, picker = find(`[data-player-picker="${field}"]`), hex = find(`[data-player-hex="${field}"]`);
          picker.value = state.effective.player[field]; if (hex.value !== state.inputValues[key]) hex.value = state.inputValues[key];
          hex.setAttribute('aria-invalid', String(Boolean(state.errors[key]))); find(`[data-player-error="${field}"]`).textContent = state.errors[key] || '';
          find(`[data-waveform-recents="${field}"]`).innerHTML = history.map(color => `<button class="waveform-recent-swatch" type="button" data-waveform-recent="${color}" data-waveform-field="${field}" style="background:${color}" aria-label="Use ${color} for waveform ${field}" title="${color}" ${disabled ? 'disabled' : ''}></button>`).join('');
        }
        find('[data-waveform-recents-help]').textContent = history.length ? 'Recent colors · last five choices. Choose a swatch below either field.' : 'Your five most recent waveform colors will appear here.';
        const preview = find('[data-waveform-preview]');
        preview.style.setProperty('--preview-player', state.effective.player.background); preview.style.setProperty('--preview-waveform-fill', state.effective.player.fill); preview.style.setProperty('--preview-waveform-edge', state.effective.player.edge);
        const recovery = find('[data-waveform-recovery-status]'); recovery.hidden = !recoveryMessage; recovery.textContent = recoveryMessage;
        const otherErrors = find('[data-background-other-errors]'); otherErrors.hidden = !state.errors.player_background && !state.errors.main_surface_color && !state.errors.panel_background_color; otherErrors.textContent = 'Fix the color errors in Backgrounds before saving.';
        const failure = find('[data-background-request-error]'); failure.hidden = !state.error; failure.textContent = state.error;
        find('[data-background-cancel]').disabled = state.loading || state.saving || !state.dirty;
        find('[data-background-save]').disabled = !state.canSave; find('[data-background-save]').textContent = state.saving ? 'Saving…' : 'Save';
        find('[data-background-retry]').hidden = !state.loadFailed; find('[data-background-retry]').disabled = state.loading || state.saving;
        find('[data-background-status]').textContent = state.loading ? 'Loading your appearance…' : state.saving ? 'Saving appearance…' : (state.error || state.loadFailed) ? '' : state.dirty ? 'Unsaved appearance changes' : 'Saved to your account';
      };
      editor.addEventListener('input', event => {
        const field = event.target.getAttribute('data-player-picker') || event.target.getAttribute('data-player-hex');
        if (field) { recoveryMessage = ''; controller.setPlayerColor(field, event.target.value, { recordRecent: !event.target.hasAttribute('data-player-picker') }); }
      });
      editor.addEventListener('change', event => {
        const field = event.target.getAttribute('data-player-picker');
        if (field) controller.setPlayerColor(field, event.target.value);
      });
      editor.addEventListener('click', event => {
        const button = event.target.closest('button'); if (!button || button.disabled) return;
        if (button.hasAttribute('data-waveform-recent')) { recoveryMessage = ''; controller.setPlayerColor(button.getAttribute('data-waveform-field'), button.getAttribute('data-waveform-recent')); }
        else if (button.hasAttribute('data-background-player-mode')) { recoveryMessage = ''; controller.setPlayerMode(button.getAttribute('data-background-player-mode')); }
        else if (button.hasAttribute('data-waveform-restore')) {
          try { const pair = getLegacyColors(); controller.restoreWaveformColors(pair); recoveryMessage = 'Previous browser colors are in the preview. Save to apply them.'; }
          catch (_failure) { recoveryMessage = 'No valid previous waveform colors were found in this browser. You can choose colors above.'; }
          sync(controller.getState());
        } else if (button.hasAttribute('data-background-cancel')) { recoveryMessage = ''; controller.cancel(); }
        else if (button.hasAttribute('data-background-save')) { recoveryMessage = ''; void controller.save(); }
        else if (button.hasAttribute('data-background-retry')) { recoveryMessage = ''; void load(); }
      });
      unsubscribe = controller.subscribe(sync); sync(controller.getState()); if (!loaded) void load(); return unmount;
    };
    const allowLeave = (confirm = message => window.confirm(message)) => {
      const state = controller.getState();
      if (state.saving) return false;
      if (!state.dirty) return true;
      if (!confirm('Discard your unsaved appearance changes?')) return false;
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
    return { controller, mount, mountSeekbar, unmount, allowLeave, clearSession, load, getSavedPlayerColors: () => savedPlayerColors ? { ...savedPlayerColors } : null };
  }
  const api = { normalizeColor, colorToRgb, contrastRatio, applyTheme, clearTheme, createController, installBrowser, palettes, resolveAppearance, getSavedPlayerColors: () => api.instance?.getSavedPlayerColors() || null };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (scope && scope.document) { scope.AlbumHavenAppearance = api; api.instance = installBrowser(scope, scope.document); }
})(typeof window !== 'undefined' ? window : null);
