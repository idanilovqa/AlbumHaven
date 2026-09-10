/* Account-owned appearance. Drafts never recolor the live document. */
(function (scope) {
  'use strict';
  const catalog = typeof module !== 'undefined' && module.exports ? require('./appearance-palettes.js') : scope.AlbumHavenAppearancePalettes;
  const ButtonComponent = typeof module !== 'undefined' && module.exports ? require('./button-component.js') : scope.ButtonComponent;
  const { palettes, resolveAppearance, normalizePlayerOverride, nativePlayerStyle, nativePlayerComponents } = catalog;
  const keys = ['main_surface_color', 'panel_background_color'];
  const defaults = { main_surface_color: '#111C2C', panel_background_color: '#0E1B2B' };
  const playerThemes = [
    { id: 'classic-green', name: 'Classic green', description: 'The original layered green player.', style: { surface: { mode: 'gradient', angle: 0, start: '#0A2F24', end: '#0A1422' }, controls: { fill: '#24B86B', border: '#86EFAC' }, waveform: { fill: '#387F68', edge: '#AFD8C2' }, handles: { color: '#AFD8C2' } } },
    { id: 'slate-mint', name: 'Slate mint', description: 'Cool slate with a restrained mint signal.', style: { surface: { mode: 'gradient', angle: 0, start: '#14242A', end: '#0E171B' }, controls: { fill: '#7FB9AA', border: '#C4DDD6' }, waveform: { fill: '#628F84', edge: '#B7D3CB' }, handles: { color: '#B7D3CB' } } },
    { id: 'midnight-blue', name: 'Midnight blue', description: 'Deep blue with a clear cool waveform.', style: { surface: { mode: 'gradient', angle: 0, start: '#111C34', end: '#07101F' }, controls: { fill: '#4F91D8', border: '#A7CAE8' }, waveform: { fill: '#386F9E', edge: '#C3DEF1' }, handles: { color: '#C3DEF1' } } },
    { id: 'graphite-moss', name: 'Graphite moss', description: 'Dark graphite with muted moss details.', style: { surface: { mode: 'gradient', angle: 0, start: '#292B23', end: '#151713' }, controls: { fill: '#9BAA64', border: '#D0D8AA' }, waveform: { fill: '#74884D', edge: '#C4D19A' }, handles: { color: '#C4D19A' } } },
    { id: 'soft-black', name: 'Soft black', description: 'A quiet neutral player with silver detail.', style: { surface: { mode: 'gradient', angle: 0, start: '#171817', end: '#050606' }, controls: { fill: '#BFC4C1', border: '#F0F2F1' }, waveform: { fill: '#8E9691', edge: '#E5E8E6' }, handles: { color: '#E5E8E6' } } },
  ];
  const empty = () => ({ main_surface_color: null, panel_background_color: null });
  const canonicalEmpty = () => ({ ...empty(), palette_id: null, panel_index: 0, player_override: null, compact_player_style: 'docked', album_details_layout: 'classic_bar', album_playing_row_animation: 'enabled', alert_family: 'ember' });
  const isCanonical = value => ['palette_id', 'panel_index', 'player_override'].some(key => Object.hasOwn(value, key));
  const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const isAggregate = value => Boolean(value && ['revision', 'interaction_overrides', 'selection_accent', 'player_style_override', 'player_recent_sets'].some(key => Object.hasOwn(value, key)));
  function normalizeColor(value) {
    if (value === null) return null;
    if (typeof value !== 'string' || value.length !== 7 || !/^#[0-9a-f]{6}$/i.test(value)) throw new TypeError('Enter a color as #RRGGBB, for example #237A68.');
    return value.toUpperCase();
  }
  const playerStyleColorPaths = ['surface.start', 'surface.end', 'controls.fill', 'controls.border', 'waveform.fill', 'waveform.edge', 'handles.color'];
  const playerColorPairs = Object.freeze({
    'controls.fill': Object.freeze({ role: 'waveform.fill', source: '#24B86B', target: '#387F68' }),
    'waveform.fill': Object.freeze({ role: 'controls.fill', source: '#387F68', target: '#24B86B' }),
    'controls.border': Object.freeze({ role: 'waveform.edge', source: '#86EFAC', target: '#AFD8C2' }),
    'waveform.edge': Object.freeze({ role: 'controls.border', source: '#AFD8C2', target: '#86EFAC' }),
  });
  function hexToHsl(value) {
    const color = normalizeColor(value);
    if (color === null) throw new TypeError('A color is required.');
    const [red, green, blue] = [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16) / 255);
    const maximum = Math.max(red, green, blue), minimum = Math.min(red, green, blue);
    const difference = maximum - minimum, lightness = (maximum + minimum) / 2;
    if (difference === 0) return { hue: 0, saturation: 0, lightness };
    let hue;
    if (maximum === red) hue = ((green - blue) / difference) % 6;
    else if (maximum === green) hue = ((blue - red) / difference) + 2;
    else hue = ((red - green) / difference) + 4;
    hue = (hue * 60 + 360) % 360;
    return { hue, saturation: difference / (1 - Math.abs(2 * lightness - 1)), lightness };
  }
  function hslToHex({ hue, saturation, lightness }) {
    const normalizedHue = ((hue % 360) + 360) % 360;
    const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
    const secondary = chroma * (1 - Math.abs((normalizedHue / 60) % 2 - 1));
    const offset = lightness - chroma / 2;
    let channels;
    if (normalizedHue < 60) channels = [chroma, secondary, 0];
    else if (normalizedHue < 120) channels = [secondary, chroma, 0];
    else if (normalizedHue < 180) channels = [0, chroma, secondary];
    else if (normalizedHue < 240) channels = [0, secondary, chroma];
    else if (normalizedHue < 300) channels = [secondary, 0, chroma];
    else channels = [chroma, 0, secondary];
    return '#' + channels.map(channel => Math.round((channel + offset) * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
  }
  function derivePairedPlayerColor(sourceRole, value) {
    const pair = playerColorPairs[sourceRole];
    if (!pair) throw new TypeError('Unknown paired player color.');
    const input = hexToHsl(value), source = hexToHsl(pair.source), target = hexToHsl(pair.target);
    return {
      role: pair.role,
      color: hslToHex({
        hue: input.saturation === 0 ? 0 : input.hue + target.hue - source.hue,
        saturation: input.saturation === 0 ? 0 : Math.min(1, Math.max(0, input.saturation * target.saturation / source.saturation)),
        lightness: Math.min(1, Math.max(0, input.lightness + target.lightness - source.lightness)),
      }),
    };
  }
  function setPairedPlayerStyleColor(style, path, value) {
    const [group, field] = path.split('.');
    if (!style[group] || !Object.hasOwn(style[group], field)) throw new TypeError('Unknown player style color.');
    const color = normalizeColor(value);
    if (color === null) throw new TypeError('A player color is required.');
    const previousEdge = style.waveform.edge;
    style[group][field] = color;
    makePlayerComponentsExplicit(style, group);
    if (path === 'surface.start' && style.surface.mode === 'solid') style.surface.end = color;
    if (playerColorPairs[path]) {
      const paired = derivePairedPlayerColor(path, color);
      const [pairedGroup, pairedField] = paired.role.split('.');
      style[pairedGroup][pairedField] = paired.color;
      makePlayerComponentsExplicit(style, pairedGroup);
      if ((path === 'controls.border' || path === 'waveform.edge') && style.handles.color === previousEdge) {
        style.handles.color = style.waveform.edge;
        makePlayerComponentsExplicit(style, 'handles');
      }
    }
    return style;
  }
  function makePlayerComponentsExplicit(style, ...components) {
    if (Object.hasOwn(style, 'native_components')) style.native_components = style.native_components.filter(component => !components.includes(component));
  }
  const defaultItemOutline = Object.freeze({ source: 'automatic', color: null });
  const interactionColorKeys = ['item_hover', 'item_selected', 'button_hover_background', 'button_pressed'];
  const emptyInteractionOverrides = () => ({
    item_hover: null,
    item_selected: null,
    button_hover_background: null,
    button_pressed: null,
    item_outline: { ...defaultItemOutline },
  });
  const outlineSources = new Set(['automatic', 'theme', 'player', 'custom']);
  function normalizeItemOutline(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join(',') !== 'color,source'
        || !outlineSources.has(value.source)) {
      throw new TypeError('Invalid item outline.');
    }
    const color = normalizeColor(value.color);
    if (value.source === 'custom' && color === null) throw new TypeError('A custom item outline color is required.');
    if (value.source !== 'custom' && color !== null) throw new TypeError('Linked item outline sources cannot store a fixed color.');
    return { source: value.source, color };
  }
  function normalizeInteractionOverrides(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid interaction overrides.');
    const presentKeys = Object.keys(value).sort().join(',');
    const currentKeys = [...interactionColorKeys, 'item_outline'].sort().join(',');
    const legacyKeys = [...interactionColorKeys, 'button_hover_border', 'focus'].sort().join(',');
    if (presentKeys !== currentKeys && presentKeys !== legacyKeys) throw new TypeError('Invalid interaction overrides.');
    const colors = Object.fromEntries(interactionColorKeys.map(key => [key, normalizeColor(value[key])]));
    if (presentKeys === currentKeys) return { ...colors, item_outline: normalizeItemOutline(value.item_outline) };
    const legacyColor = normalizeColor(value.focus) || normalizeColor(value.button_hover_border);
    return {
      ...colors,
      item_outline: legacyColor ? { source: 'custom', color: legacyColor } : { ...defaultItemOutline },
    };
  }
  function resolveInteractionOutline(preference, effective) {
    const outline = preference.interaction_overrides.item_outline;
    if (outline.source === 'custom') return outline.color;
    if (outline.source === 'theme') return effective.tokens.accent;
    const playerBorder = effective.tokens['player-control-border'] || effective.tokens['waveform-edge'] || effective.tokens['player-ink'];
    if (outline.source === 'player') return playerBorder;
    return (preference.player_style_override || preference.player_override) && !nativePlayerComponents(preference).controls ? playerBorder : effective.tokens.accent;
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
    const albumDetailsLayout = value.album_details_layout === undefined ? 'classic_bar' : value.album_details_layout;
    const albumPlayingRowAnimation = value.album_playing_row_animation === undefined ? 'enabled' : value.album_playing_row_animation;
    const alertFamily = value.alert_family === undefined ? 'ember' : value.alert_family;
    if (!['classic_bar', 'stacked_bar', 'editorial_canvas'].includes(albumDetailsLayout)) throw new TypeError('Unknown Album Details layout.');
    if (!['enabled', 'disabled'].includes(albumPlayingRowAnimation)) throw new TypeError('Unknown playing-row animation.');
    if (!['ember', 'signal', 'quiet'].includes(alertFamily)) throw new TypeError('Unknown alert family.');
    const preference = { ...(id === null ? normalized : empty()), palette_id: id, panel_index: value.panel_index, player_override: normalizePlayerOverride(value.player_override), compact_player_style: compactStyle, album_details_layout: albumDetailsLayout, album_playing_row_animation: albumPlayingRowAnimation, alert_family: alertFamily };
    if (!isAggregate(value)) return preference;
    const interaction = value.interaction_overrides;
    const accent = value.selection_accent;
    if (!interaction || typeof interaction !== 'object' || Array.isArray(interaction)) throw new TypeError('Invalid interaction overrides.');
    if (!accent || typeof accent !== 'object' || Array.isArray(accent) || typeof accent.enabled !== 'boolean') throw new TypeError('Invalid selection accent.');
    const aggregate = {
      ...preference,
      interaction_overrides: normalizeInteractionOverrides(interaction),
      selection_accent: { enabled: accent.enabled, color: normalizeColor(accent.color) },
      player_style_override: value.player_style_override == null ? null : normalizePlayerOverride(value.player_style_override),
    };
    if (Object.hasOwn(value, 'waveform_recent_colors')) aggregate.waveform_recent_colors = normalizeRecentColors(value.waveform_recent_colors);
    return aggregate;
  }
  function normalizePlayerSets(value) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 5) throw new TypeError('Invalid recent player sets.');
    const sets = value.map(normalizePlayerOverride);
    if (sets.some(item => !item || !Object.hasOwn(item, 'surface'))) throw new TypeError('Invalid recent player sets.');
    if (new Set(sets.map(item => JSON.stringify(item))).size !== sets.length) throw new TypeError('Duplicate recent player sets.');
    return sets;
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
  const playerTokens = ['player', 'player-surface-start', 'player-surface-end', 'player-surface-angle', 'player-ink', 'play', 'play-ink', 'player-control-border', 'player-handle', 'waveform-fill', 'waveform-edge'];
  function applyTheme(value, rootElement) {
    const preference = normalizePreferences(value), playerPreference = { ...preference, player_override: preference.player_style_override || preference.player_override };
    const effective = resolveAppearance(playerPreference), style = rootElement.style;
    const themed = Boolean(preference.palette_id), playerThemed = themed || Boolean(playerPreference.player_override);
    const native = nativePlayerComponents(preference);
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
    if (themed) {
      style.setProperty('--appearance-primary-button', effective.tokens.control);
      style.setProperty('--appearance-primary-button-ink', effective.tokens.ink);
    } else {
      style.removeProperty('--appearance-primary-button');
      style.removeProperty('--appearance-primary-button-ink');
    }
    const interactions = preference.interaction_overrides || {};
    const interactionTokens = {
      'item-hover': interactions.item_hover,
      'item-selected': interactions.item_selected,
      'item-action-hover-background': interactions.button_hover_background,
      'item-action-pressed': interactions.button_pressed,
    };
    for (const [token, color] of Object.entries(interactionTokens)) {
      if (color) {
        style.setProperty('--appearance-' + token, color);
        rootElement.setAttribute?.('data-appearance-' + token, '');
      } else {
        style.removeProperty('--appearance-' + token);
        rootElement.removeAttribute?.('data-appearance-' + token);
      }
    }
    if (preference.interaction_overrides) style.setProperty('--appearance-interaction-outline', resolveInteractionOutline(preference, effective));
    else style.removeProperty('--appearance-interaction-outline');
    if (preference.selection_accent) {
      style.setProperty('--navigation-tree-selection-accent-width', preference.selection_accent.enabled ? '3px' : '0px');
      style.setProperty('--navigation-tree-selection-accent-color', preference.selection_accent.color);
    } else {
      style.removeProperty('--navigation-tree-selection-accent-width');
      style.removeProperty('--navigation-tree-selection-accent-color');
    }
    for (const token of playerTokens) {
      const component = token.startsWith('waveform-') ? 'waveform' : token === 'player-handle' ? 'handles'
        : ['play', 'play-ink', 'player-control-border'].includes(token) ? 'controls' : 'surface';
      if (playerThemed && !native[component]) style.setProperty('--appearance-' + token, effective.tokens[token]);
      else style.removeProperty('--appearance-' + token);
    }
    for (const component of Object.keys(nativePlayerStyle)) {
      if (native[component]) rootElement.setAttribute?.('data-appearance-native-' + component, '');
      else rootElement.removeAttribute?.('data-appearance-native-' + component);
    }
    if (themed) {
      rootElement.setAttribute?.('data-appearance-palette', preference.palette_id);
      rootElement.setAttribute?.('data-appearance-mode', effective.mode);
    } else { rootElement.removeAttribute?.('data-appearance-palette'); rootElement.removeAttribute?.('data-appearance-mode'); }
    if (playerThemed) rootElement.setAttribute?.('data-appearance-player', 'custom');
    else rootElement.removeAttribute?.('data-appearance-player');
    rootElement.setAttribute?.('data-compact-player-style', preference.compact_player_style || 'docked');
    rootElement.setAttribute?.('data-album-details-layout', preference.album_details_layout || 'classic_bar');
    rootElement.setAttribute?.('data-album-playing-row-animation', preference.album_playing_row_animation || 'enabled');
    rootElement.setAttribute?.('data-alert-family', preference.alert_family || 'ember');
  }
  // Pin the resolved draft locally, including defaults that would otherwise inherit
  // the document's saved palette. This never applies anything to the live app.
  function applyDraftEditorTheme(value, editor) {
    const effective = resolveAppearance({ ...value, player_override: value.player_style_override || value.player_override });
    editor.style.setProperty('--appearance-main-surface', effective.main);
    editor.style.setProperty('--appearance-panel-background', effective.panel);
    for (const [token, color] of Object.entries(effective.tokens)) editor.style.setProperty('--appearance-' + token, color);
    editor.style.setProperty('--appearance-primary-button', effective.tokens.control);
    editor.style.setProperty('--appearance-primary-button-ink', effective.tokens.ink);
    const interactions = value.interaction_overrides || {};
    for (const [token, color] of Object.entries({
      'item-hover': interactions.item_hover,
      'item-selected': interactions.item_selected,
      'item-action-hover-background': interactions.button_hover_background,
      'item-action-pressed': interactions.button_pressed,
    })) {
      // A missing local token inherits the saved override from the document.
      // Resolve the draft fallback here so resets remain isolated to the preview.
      const fallback = ['item-hover', 'item-selected'].includes(token) ? effective.tokens.hover : effective.tokens.control;
      editor.style.setProperty('--appearance-' + token, color || fallback);
    }
    if (value.interaction_overrides) editor.style.setProperty('--appearance-interaction-outline', resolveInteractionOutline(value, effective));
    else editor.style.removeProperty('--appearance-interaction-outline');
    editor.style.setProperty('--appearance-on-accent', catalog.contrastingInk(effective.tokens.accent));
    editor.setAttribute('data-appearance-mode', effective.mode);
    if (value.palette_id) editor.setAttribute('data-appearance-palette', value.palette_id);
    else editor.removeAttribute('data-appearance-palette');
    editor.setAttribute('data-alert-family', value.alert_family || 'ember');
  }
  function clearTheme(rootElement) { applyTheme(empty(), rootElement); }
  function createController({ initial = empty(), request, apply = () => {} }) {
    let aggregate = isAggregate(initial), revision = aggregate && Number.isInteger(initial.revision) ? initial.revision : 0;
    let playerRecentSets = aggregate ? normalizePlayerSets(initial.player_recent_sets) : [], pendingPlayerSet = null, activeSection = 'backgrounds';
    let saved = normalizePreferences(initial), draft = copy(saved), errors = {}, inputValues = {};
    let recentColors = normalizeRecentColors(initial.waveform_recent_colors), waveformColorUpdates = [];
    let loading = false, saving = false, error = '', loadFailed = false, generation = 0;
    const listeners = new Set(), busy = () => loading || saving || loadFailed;
    const syncInputs = (preserveErrors = false) => {
      const next = Object.fromEntries(keys.map(key => [key, draft[key] || defaults[key]]));
      const effective = resolveAppearance({ ...draft, player_override: draft.player_style_override || draft.player_override });
      for (const field of ['background', 'fill', 'edge']) next['player_' + field] = effective.player[field];
      const style = effectivePlayerStyle({ draft, effective });
      for (const path of playerStyleColorPaths) { const [group, field] = path.split('.'); next['player_style_' + path] = style[group][field]; }
      if (preserveErrors) for (const key of Object.keys(errors)) next[key] = inputValues[key];
      inputValues = next;
    };
    syncInputs();
    const getState = () => {
      const dirty = JSON.stringify(draft) !== JSON.stringify(saved) || Object.keys(errors).length > 0 || waveformColorUpdates.length > 0;
      const effective = resolveAppearance({ ...draft, player_override: draft.player_style_override || draft.player_override }), warnings = [];
      if (!draft.palette_id) for (const key of keys) {
        const label = key === 'main_surface_color' ? 'Main surface' : 'App bar and panels';
        for (const [labelText, foreground] of [['light text', '#F3F6FA'], ['muted text', '#97A6BB']]) {
          if (contrastRatio(draft[key] || defaults[key], foreground) < 4.5) warnings.push(`${labelText} on ${label}`);
        }
      }
      const canSave = dirty && !busy() && !Object.keys(errors).length;
      return { saved: copy(saved), draft: copy(draft), revision, activeSection, playerRecentSets: copy(playerRecentSets), errors: { ...errors }, inputValues: { ...inputValues }, effective,
        recentColors: [...recentColors], waveformColorUpdates: [...waveformColorUpdates], loading, saving, dirty, canSave, error, loadFailed, warnings,
        footer: { dirty, canSave, canRetry: dirty && Boolean(error), status: dirty ? 'Unsaved appearance changes' : 'Saved to your account' } };
    };
    const notify = () => listeners.forEach(listener => listener(getState()));
    const clearPlayerStyleErrors = () => { for (const path of playerStyleColorPaths) delete errors['player_style_' + path]; };
    const promote = () => {
      if (!isCanonical(saved)) saved = { ...canonicalEmpty(), ...saved };
      if (!isCanonical(draft)) draft = { ...canonicalEmpty(), ...draft };
    };
    const promoteAggregate = () => {
      promote();
      aggregate = true;
      if (!draft.interaction_overrides) draft.interaction_overrides = emptyInteractionOverrides();
      if (!draft.selection_accent) draft.selection_accent = { ...defaultSelectionAccent };
      if (!Object.hasOwn(draft, 'player_style_override')) draft.player_style_override = null;
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
      const selectedPalette = id === null ? null : palettes.find(palette => palette.id === id);
      if (id !== null && !selectedPalette) throw new TypeError('Unknown palette.');
      if (busy()) return;
      promote(); draft = { ...draft, ...empty(), palette_id: id, panel_index: 0 };
      if (aggregate && selectedPalette) {
        draft.selection_accent = {
          enabled: draft.selection_accent?.enabled !== false,
          color: selectedPalette.selectionAccent,
        };
      }
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
      if (mode === 'palette') clearPlayerStyleErrors();
      if (aggregate) {
        if (mode === 'custom') {
          if (activeSection === 'backgrounds') { activeSection = 'seekbar'; notify(); return; }
          const style = effectivePlayerStyle(getState());
          draft.player_style_override = style; pendingPlayerSet = copy(style);
        } else {
          draft.player_style_override = null; draft.player_override = null; pendingPlayerSet = null;
        }
        for (const field of ['background', 'fill', 'edge']) delete errors['player_' + field];
        error = ''; syncInputs(true); notify(); return;
      }
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
    const setAlbumDetailsLayout = layout => {
      if (!['classic_bar', 'stacked_bar', 'editorial_canvas'].includes(layout)) throw new TypeError('Unknown Album Details layout.');
      if (busy()) return;
      promoteAggregate(); draft.album_details_layout = layout; error = ''; notify();
    };
    const setAlbumPlayingRowAnimation = value => {
      if (!['enabled', 'disabled'].includes(value)) throw new TypeError('Unknown playing-row animation.');
      if (busy()) return;
      promoteAggregate(); draft.album_playing_row_animation = value; error = ''; notify();
    };
    const setAlertFamily = family => {
      if (!['ember', 'signal', 'quiet'].includes(family)) throw new TypeError('Unknown alert family.');
      if (busy()) return;
      promoteAggregate(); draft.alert_family = family; error = ''; notify();
    };
    const rememberColor = color => { waveformColorUpdates = [color, ...waveformColorUpdates.filter(item => item !== color)].slice(0, 5); };
    const setPlayerColor = (field, value, { recordRecent = true } = {}) => {
      if (!['background', 'fill', 'edge'].includes(field)) throw new TypeError('Unknown player color.');
      if (busy()) return;
      promote(); const key = 'player_' + field; inputValues[key] = String(value);
      try {
        const color = normalizeColor(value); if (color === null) throw new TypeError('A player color is required.');
        if (field === 'background' && draft.player_style_override) {
          const style = copy(draft.player_style_override);
          setPairedPlayerStyleColor(style, 'surface.start', color);
          draft.player_style_override = normalizePlayerOverride(style); pendingPlayerSet = copy(draft.player_style_override);
          delete errors['player_style_surface.start'];
        } else draft.player_override = { ...(draft.player_override || resolveAppearance(draft).player), [field]: color };
        if (recordRecent && field !== 'background') rememberColor(color);
        delete errors[key]; error = ''; syncInputs(true);
      } catch (failure) { errors[key] = failure.message; }
      notify();
    };
    const setWaveformColor = (field, value, { recordRecent = true } = {}) => {
      if (!['fill', 'edge'].includes(field)) throw new TypeError('Unknown waveform color.');
      if (!aggregate && !Object.hasOwn(draft, 'player_style_override')) {
        setPlayerColor(field, value, { recordRecent });
        return;
      }
      if (busy()) return;
      promote(); const key = 'player_' + field; inputValues[key] = String(value);
      try {
        const color = normalizeColor(value); if (color === null) throw new TypeError('A waveform color is required.');
        const style = effectivePlayerStyle(getState());
        setPairedPlayerStyleColor(style, `waveform.${field}`, color);
        aggregate = true; draft.player_style_override = normalizePlayerOverride(style); pendingPlayerSet = copy(draft.player_style_override);
        if (recordRecent) rememberColor(color);
        delete errors[key]; error = ''; syncInputs(true);
      } catch (failure) { errors[key] = failure.message; }
      notify();
    };
    const restoreWaveformColors = pair => {
      if (!pair || typeof pair !== 'object' || Array.isArray(pair) || Object.keys(pair).length !== 2 || !['fill', 'edge'].every(field => Object.hasOwn(pair, field))) throw new TypeError('Both previous waveform colors are required.');
      const fill = normalizeColor(pair.fill), edge = normalizeColor(pair.edge);
      if (fill === null || edge === null) throw new TypeError('Both previous waveform colors are required.');
      if (busy()) return;
      promote();
      if (aggregate || Object.hasOwn(draft, 'player_style_override')) {
        const style = effectivePlayerStyle(getState());
        style.waveform = { fill, edge };
        makePlayerComponentsExplicit(style, 'waveform');
        aggregate = true; draft.player_style_override = normalizePlayerOverride(style); pendingPlayerSet = copy(draft.player_style_override);
      } else {
        draft.player_override = { ...(draft.player_override || resolveAppearance(draft).player), fill, edge };
      }
      rememberColor(fill); rememberColor(edge); delete errors.player_fill; delete errors.player_edge;
      error = ''; syncInputs(true); notify();
    };
    const setPlayerStyle = (value, { preserveColorErrors = false } = {}) => {
      if (busy()) return;
      const style = normalizePlayerOverride(value);
      if (!style || !Object.hasOwn(style, 'surface')) throw new TypeError('A complete player style is required.');
      promoteAggregate(); draft.player_style_override = style; pendingPlayerSet = copy(style);
      if (!preserveColorErrors) {
        clearPlayerStyleErrors();
        delete errors.player_background; delete errors.player_fill; delete errors.player_edge;
      }
      else if (style.surface.mode === 'solid') delete errors['player_style_surface.end'];
      error = ''; syncInputs(true); notify();
    };
    const setPlayerStyleColor = (path, value) => {
      if (!playerStyleColorPaths.includes(path)) throw new TypeError('Unknown player style color.');
      if (busy()) return;
      const key = 'player_style_' + path; inputValues[key] = String(value);
      try {
        const style = effectivePlayerStyle(getState());
        setPairedPlayerStyleColor(style, path, value);
        promoteAggregate(); draft.player_style_override = normalizePlayerOverride(style); pendingPlayerSet = copy(draft.player_style_override);
        delete errors[key]; error = ''; syncInputs(true);
      } catch (failure) { errors[key] = failure.message; }
      notify();
    };
    const restorePlayerSet = value => setPlayerStyle(value);
    const setSelectionAccent = value => {
      if (busy()) return;
      if (!value || typeof value !== 'object' || typeof value.enabled !== 'boolean') throw new TypeError('Invalid selection accent.');
      promoteAggregate(); draft.selection_accent = { enabled: value.enabled, color: normalizeColor(value.color) }; error = ''; notify();
    };
    const setInteractionOverrides = value => {
      if (busy()) return;
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid interaction overrides.');
      promoteAggregate(); draft.interaction_overrides = normalizeInteractionOverrides(value); error = ''; notify();
    };
    const setItemOutline = (source, color = null) => {
      if (busy()) return;
      const normalized = normalizeItemOutline({ source, color });
      promoteAggregate();
      draft.interaction_overrides = { ...draft.interaction_overrides, item_outline: normalized };
      error = ''; notify();
    };
    const useThemeInteractions = () => setInteractionOverrides({
      item_hover: null, item_selected: null, button_hover_background: null,
      button_pressed: null, item_outline: { source: 'theme', color: null },
    });
    const setActiveSection = value => {
      if (!['backgrounds', 'seekbar', 'selection-accent', 'alerts', 'album-page'].includes(value)) throw new TypeError('Unknown Appearance section.');
      activeSection = value; notify();
    };
    const cancel = () => { if (loading || saving) return; draft = copy(saved); pendingPlayerSet = null; errors = {}; waveformColorUpdates = []; error = ''; syncInputs(); notify(); };
    const reset = () => {
      if (busy()) return;
      draft = isCanonical(draft) ? { ...canonicalEmpty(), player_override: draft.player_override ? { ...draft.player_override } : null } : empty();
      keys.forEach(key => delete errors[key]); error = ''; syncInputs(true); notify();
    };
    const resetSection = (section = activeSection) => {
      if (busy()) return;
      if (!aggregate) { reset(); return; }
      if (section === 'backgrounds') {
        Object.assign(draft, empty(), { palette_id: null, panel_index: 0 });
      } else if (section === 'seekbar') {
        draft.player_style_override = null; draft.player_override = null; draft.compact_player_style = 'docked'; pendingPlayerSet = null; waveformColorUpdates = [];
        delete errors.player_background; delete errors.player_fill; delete errors.player_edge; clearPlayerStyleErrors();
      } else if (section === 'selection-accent') {
        const paletteAccent = palettes.find(palette => palette.id === draft.palette_id)?.selectionAccent;
        draft.selection_accent = { enabled: true, color: paletteAccent || defaultSelectionAccent.color };
        draft.interaction_overrides = { item_hover: null, item_selected: null, button_hover_background: null, button_pressed: null, item_outline: { ...defaultItemOutline } };
      } else if (section === 'album-page') {
        draft.album_details_layout = 'classic_bar';
        draft.album_playing_row_animation = 'enabled';
      } else if (section === 'alerts') {
        draft.alert_family = 'ember';
      }
      else throw new TypeError('Unknown Appearance section.');
      error = ''; syncInputs(true); notify();
    };
    const load = async () => {
      if (loading || saving) return false;
      const ownGeneration = ++generation; loading = true; error = ''; notify();
      try {
        const response = await request('GET');
        const preference = normalizePreferences(response), history = normalizeRecentColors(response.waveform_recent_colors);
        if (ownGeneration !== generation) return false;
        aggregate = isAggregate(response); revision = aggregate && Number.isInteger(response.revision) ? response.revision : revision;
        playerRecentSets = aggregate ? normalizePlayerSets(response.player_recent_sets) : [];
        saved = preference; draft = copy(saved); pendingPlayerSet = null; recentColors = history; waveformColorUpdates = []; errors = {}; loadFailed = false; syncInputs(); apply(copy(saved)); return true;
      } catch (_failure) {
        if (ownGeneration === generation) { error = 'Backgrounds could not be loaded. Try again.'; loadFailed = true; } return false;
      } finally { if (ownGeneration === generation) { loading = false; notify(); } }
    };
    const save = async () => {
      if (!getState().canSave) return false;
      const ownGeneration = ++generation, submitted = aggregate
        ? {
          ...copy(draft),
          expected_revision: revision,
          applied_player_set: copy(pendingPlayerSet),
          ...(waveformColorUpdates.length ? { waveform_color_updates: [...waveformColorUpdates] } : {}),
        }
        : { ...copy(draft), ...(waveformColorUpdates.length ? { waveform_color_updates: [...waveformColorUpdates] } : {}) };
      saving = true; error = ''; notify();
      try {
        const response = await request('PUT', submitted);
        const preference = normalizePreferences(response), history = normalizeRecentColors(response.waveform_recent_colors);
        if (ownGeneration !== generation) return false;
        if (aggregate) { revision = response.revision; playerRecentSets = normalizePlayerSets(response.player_recent_sets); }
        saved = preference; draft = copy(saved); pendingPlayerSet = null; recentColors = history; waveformColorUpdates = []; errors = {}; syncInputs(); apply(copy(saved)); return true;
      } catch (failure) {
        if (ownGeneration === generation) {
          if (failure?.status === 409 && Number.isInteger(failure?.data?.appearance?.revision)) {
            const response = failure.data.appearance;
            let current;
            try {
              if (!isCanonical(response) || response.revision < 0) throw new TypeError('Incomplete appearance conflict.');
              current = { preference: normalizePreferences(response),
                playerSets: normalizePlayerSets(response.player_recent_sets),
                history: normalizeRecentColors(response.waveform_recent_colors) };
            } catch (_invalidConflict) {
              error = 'Appearance changed elsewhere, but the current settings could not be read. Your draft is kept; reload and try again.';
              return false;
            }
            // Cancel must restore this confirmed baseline. Keep the entire local
            // draft and pending color events available for an explicit retry.
            saved = current.preference; revision = response.revision;
            playerRecentSets = current.playerSets; recentColors = current.history;
            apply(copy(saved));
          }
          error = failure?.status === 409 ? 'Appearance changed elsewhere. Your draft is kept; review it and try Save again.' : 'Backgrounds could not be saved. Your changes are kept. Try Save again.';
        }
        return false;
      } finally { if (ownGeneration === generation) { saving = false; notify(); } }
    };
    const clear = (message = '') => {
      ++generation; saved = isCanonical(saved) ? canonicalEmpty() : empty(); draft = copy(saved); errors = {};
      recentColors = []; waveformColorUpdates = []; playerRecentSets = []; pendingPlayerSet = null; revision = 0;
      error = typeof message === 'string' ? message : ''; loading = false; saving = false; loadFailed = true; syncInputs(); notify();
    };
    return { getState, setColor, setPalette, setPanelIndex, setPlayerMode, setCompactPlayerStyle, setAlbumDetailsLayout, setAlbumPlayingRowAnimation, setAlertFamily, setPlayerColor, setWaveformColor, restoreWaveformColors,
      setPlayerStyle, setPlayerStyleColor, restorePlayerSet, setSelectionAccent, setInteractionOverrides, setItemOutline, useThemeInteractions, setActiveSection, cancel, reset, resetSection, load, save, clear,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
  }
  function colorField(field, label) {
    return `<div class="background-color-field"><label for="appearance-player-${field}-hex">${label}</label>
      <div class="background-color-inputs"><input type="color" data-player-picker="${field}" aria-label="${label} color picker">
      <input type="text" id="appearance-player-${field}-hex" data-player-hex="${field}" maxlength="7" spellcheck="false" autocomplete="off" aria-describedby="appearance-player-${field}-error"></div>
      <div class="background-field-error" id="appearance-player-${field}-error" data-player-error="${field}" role="status"></div></div>`;
  }
  const previewAlertIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.3 3.8 2.4 17.5A2 2 0 0 0 4.1 20h15.8a2 2 0 0 0 1.7-2.5L13.7 3.8a2 2 0 0 0-3.4 0Z"></path><path d="M12 9v4"></path><path d="M12 16.5h.01"></path></svg>';
  const previewInfoIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 10.5v6"></path><path d="M12 7.5h.01"></path></svg>';
  const previewPencilIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 20 4.5-1 10-10-3.5-3.5-10 10L4 20Z"></path><path d="m13.8 6.7 3.5 3.5"></path></svg>';
  const previewFolderIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7.5h7l2-2h9v14H3Z"></path></svg>';
  const previewCloseIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"></path></svg>';
  function previewOnPageAlertMarkup() {
    return `<section class="on-page-alert on-page-alert--error appearance-alert-preview__page" role="presentation"><span class="on-page-alert__icon" data-alert-preview-icon>${previewAlertIcon}</span><div class="on-page-alert__content"><strong class="on-page-alert__title" data-alert-preview-title>Album details unavailable</strong><p class="on-page-alert__message" data-alert-preview-copy>This album cannot be found under the current libraries. Its library entry is still saved.</p><div class="on-page-alert__actions"><button class="ui-button ui-button--primary" type="button" tabindex="-1">Remove from library</button><button class="ui-button ui-button--secondary" type="button" tabindex="-1">Keep as missing</button></div></div></section>`;
  }
  function alertsMarkup() {
    const families = [
      ['ember', 'Ember', 'Pressed, focused, unmistakable'],
      ['signal', 'Signal', 'Clear color with a cooler surface'],
      ['quiet', 'Quiet', 'Low-glare cues for long sessions'],
    ];
    return `<section class="appearance-background-editor appearance-alerts" aria-labelledby="appearance-alerts-title"><div class="appearance-section-heading"><div><h3 id="appearance-alerts-title">Alerts</h3><p class="background-intro">Choose one coordinated treatment for errors, warnings, and information.</p></div><span>Draft preview</span></div><section class="appearance-alerts__families" aria-labelledby="appearance-alert-family-title"><div class="appearance-subsection-heading"><div><h4 id="appearance-alert-family-title">Alert family</h4><p class="background-help">Every family preserves severity meaning and readable contrast.</p></div><small>3 curated families</small></div><div class="appearance-alert-family-grid">${families.map(([value, label, description]) => `<button class="appearance-alert-family-card" type="button" data-alert-family="${value}" aria-pressed="false"><span><strong>${label}</strong><small>${description}</small></span><i aria-hidden="true">✓</i><span class="appearance-alert-family-card__chord"><b>Error</b><b>Warning</b><b>Info</b></span></button>`).join('')}</div></section><section class="appearance-live-preview appearance-alert-live-preview" data-alert-live-preview><div class="appearance-preview-heading"><div><h4>Live preview</h4><p class="background-help">See the selected family at page and artbox scale.</p></div><div class="appearance-segmented" role="group" aria-label="Preview severity"><button type="button" data-alert-preview-severity="error" aria-pressed="true">Error</button><button type="button" data-alert-preview-severity="warning" aria-pressed="false">Warning</button><button type="button" data-alert-preview-severity="info" aria-pressed="false">Info</button></div></div><div class="appearance-alert-preview-grid">${previewOnPageAlertMarkup()}<div class="appearance-alert-preview__small"><div><strong>Artbox action</strong><small>Compact and expanded</small></div><div class="appearance-alert-preview__small-pair"><span class="small-alert small-alert--error" data-alert-preview-small-compact><span class="small-alert__icon" data-small-alert-preview-icon>${previewAlertIcon}</span></span><span class="small-alert small-alert--error appearance-alert-preview__small-expanded" data-alert-preview-small-expanded><span class="small-alert__icon" data-small-alert-preview-icon>${previewAlertIcon}</span><span class="small-alert__text" data-alert-preview-small-label>Album not found</span></span></div></div></div></section><p class="background-request-error" data-background-request-error role="alert" hidden></p><div class="background-actions"></div></section>`;
  }
  function albumPreviewTableMarkup() {
    const tracks = [['1', 'Mystery Train', '6:53'], ['2', 'My New World', '16:20'], ['3', 'We All Need Some Light', '5:45'], ['4', 'Duel With The Devil', '26:43']];
    return `<div class="appearance-album-preview__table"><div class="appearance-album-preview__table-head"><span></span><b>#</b><strong>Track</strong><em>Length</em></div>${tracks.map(([number, title, length], index) => `<div class="appearance-album-preview__track${index === 0 ? ' is-playing' : ''}"><button type="button" tabindex="-1" aria-label="Play ${title}">▶</button><b>${number}</b><strong>${title}</strong><em>${length}</em></div>`).join('')}<div class="appearance-album-preview__total"><strong>Total Length: 1h 17m 13s</strong></div></div>`;
  }
  function albumPageMarkup() {
    const layouts = [
      ['classic_bar', 'Classic Bar', 'Album information stays in the app bar.'],
      ['stacked_bar', 'Stacked Bar', 'Identity and metadata use two header lines.'],
      ['editorial_canvas', 'Editorial Canvas', 'Art and large album identity lead the page.'],
    ];
    return `<section class="appearance-background-editor appearance-album-page" aria-labelledby="appearance-album-page-title"><div class="appearance-section-heading"><div><h3 id="appearance-album-page-title">Album page</h3><p class="background-intro">Choose the Album Details composition and current-track motion.</p></div><span>Draft preview</span></div><div class="appearance-album-page__workspace"><section class="appearance-album-page__controls" aria-labelledby="appearance-album-layout-title"><div class="appearance-subsection-heading"><div><h4 id="appearance-album-layout-title">Album Details layout</h4><p class="background-help">Choose how the header, art, and album information are arranged.</p></div></div><div class="appearance-album-layout-grid">${layouts.map(([value, label, description]) => `<button class="appearance-album-layout-card" type="button" data-album-details-layout="${value}" aria-pressed="false"><span class="appearance-album-layout-card__diagram appearance-album-layout-card__diagram--${value}" aria-hidden="true"><i></i><b></b><em></em><u></u></span><strong>${label}</strong><small>${description}</small></button>`).join('')}</div><div class="appearance-album-motion"><div><strong>Currently playing animation</strong><p class="background-help">Use perimeter motion on the active track. Reduced motion keeps a static accent outline.</p></div><div class="appearance-segmented" role="group" aria-label="Currently playing animation"><button type="button" data-album-playing-row-animation="enabled" aria-pressed="false">On</button><button type="button" data-album-playing-row-animation="disabled" aria-pressed="false">Off</button></div></div></section><section class="appearance-live-preview appearance-album-page__preview"><div class="appearance-preview-heading"><div><h4>Live preview</h4><p class="background-help">The state switch previews behavior; it is not saved.</p></div><div class="appearance-segmented" role="group" aria-label="Album preview state"><button type="button" data-album-preview-state="present" aria-pressed="true">Present</button><button type="button" data-album-preview-state="missing" aria-pressed="false">Missing</button></div></div><div class="appearance-album-preview" data-album-page-live-preview data-layout="classic_bar" data-preview-state="present"><header class="appearance-album-preview__bar"><div class="appearance-album-preview__identity"><strong><span>Transatlantic</span><i>•</i><span>SMPTe - The Roine Stolt Mixes</span><i>•</i><span>2003</span></strong><small><span>2003</span><i>•</i><span>ALBUM</span></small></div><span class="appearance-album-preview__type">ALBUM</span><div class="appearance-album-preview__actions"><button type="button" data-album-preview-file-action aria-label="Edit tags">${previewPencilIcon}</button><button type="button" data-album-preview-file-action aria-label="Open folder">${previewFolderIcon}</button><button type="button" aria-label="Close">${previewCloseIcon}</button></div></header><div class="appearance-album-preview__body"><div class="appearance-album-preview__art" aria-label="Missing album artwork"><span></span></div><div class="appearance-album-preview__content"><div class="appearance-album-preview__editorial-copy"><h5>SMPTe - The Roine Stolt Mixes</h5><p>Transatlantic <i>•</i> 2003 <i>•</i> ALBUM</p></div><div data-album-preview-present>${albumPreviewTableMarkup()}</div><div data-album-preview-missing hidden>${previewOnPageAlertMarkup()}</div></div></div></div></section></div><p class="background-request-error" data-background-request-error role="alert" hidden></p><div class="background-actions"></div></section>`;
  }
  const defaultSelectionAccent = { enabled: true, color: '#34CA78' };
  const mutedInteractionColors = ['#35506B', '#526B8B', '#4F665D', '#737548', '#785568', '#855F4F', '#666B72'];
  const brightAccentColors = ['#22D3EE', '#3B82F6', '#8B5CF6', '#EC4899', '#EF4444', '#F97316', '#FACC15', '#22C55E'];
  const selectionAccentColors = [...new Set([defaultSelectionAccent.color, ...palettes.map(palette => palette.selectionAccent), ...mutedInteractionColors, ...brightAccentColors])];
  const interactionRoles = ['item_hover', 'item_selected', 'button_hover_background', 'item_outline', 'button_pressed'];
  const interactionColorFamilies = [
    ['blue', 'Blue', ['#31465D', '#3F5F7E', '#27384B', '#86B7EF', '#203246']],
    ['steel', 'Steel', ['#43545E', '#526B72', '#34434A', '#91B7C4', '#29373D']],
    ['green', 'Green', ['#3A524A', '#4F665D', '#2F443C', '#86B6A1', '#25382F']],
    ['olive', 'Olive', ['#55583A', '#737548', '#41452D', '#AAAC70', '#353823']],
    ['plum', 'Plum', ['#5B3D4E', '#785568', '#462F3C', '#B98AA3', '#38242F']],
    ['clay', 'Clay', ['#60463C', '#855F4F', '#4A352E', '#C7937D', '#3B2924']],
    ['neutral', 'Neutral', ['#4B5057', '#666B72', '#393D43', '#A1A8B0', '#2D3136']],
  ].map(([id, label, colors]) => ({ id, label, colors: Object.fromEntries(interactionRoles.map((role, index) => [role, colors[index]])) }));
  function interactionControlsMarkup() {
    const rows = [['item_hover', 'Navigation hover'], ['item_selected', 'Navigation selected'], ['button_hover_background', 'Item hover background'], ['item_outline', 'Item hover &amp; keyboard focus outline'], ['button_pressed', 'Item pressed']];
    return `<section class="appearance-interactions" aria-labelledby="appearance-interactions-title"><h4 id="appearance-interactions-title"><span>2</span>Hover &amp; interaction states</h4><p class="background-help">Each column is a coordinated color family. Override only the states you want.</p>${rows.map(([key, label]) => `<div class="appearance-interaction-row"><strong>${label}</strong><div class="appearance-interaction-options"><div class="appearance-muted-spectrum">${interactionColorFamilies.map(family => { const color = family.colors[key]; return key === 'item_outline' ? `<button type="button" data-item-outline-color data-color="${color}" data-color-family="${family.id}" style="--swatch:${color}" aria-label="Use ${family.label} ${color} for ${label}"></button>` : `<button type="button" data-interaction-color="${key}" data-color="${color}" data-color-family="${family.id}" style="--swatch:${color}" aria-label="Use ${family.label} ${color} for ${label}"></button>`; }).join('')}</div>${key === 'item_outline' ? '<button class="button button-secondary appearance-outline-source" type="button" data-item-outline-source="player" aria-pressed="false">Use player colors</button>' : ''}</div></div>`).join('')}</section>`;
  }
  function playerStyleField(path, label) {
    const id = 'player-style-' + path.replace('.', '-');
    return `<label class="player-style-field">${label}<span><input type="color" data-player-style-color="${path}"><input type="text" maxlength="7" data-player-style-hex="${path}" spellcheck="false" aria-describedby="${id}-error"></span><small class="background-field-error" id="${id}-error" data-player-style-error="${path}" role="status"></small></label>`;
  }
  function effectivePlayerStyle(state) {
    if (!state.draft.player_style_override && !state.draft.player_override && !state.draft.palette_id) return { ...copy(nativePlayerStyle), native_components: ['surface', 'controls', 'waveform', 'handles'] };
    return copy(state.draft.player_style_override) || {
      surface: { mode: 'gradient', angle: 0, start: state.effective.player.background, end: state.effective.player.background },
      controls: { fill: state.effective.tokens.play, border: state.effective.player.edge },
      waveform: { fill: state.effective.player.fill, edge: state.effective.player.edge },
      handles: { color: state.effective.player.edge },
    };
  }
  function setPlayerStylePath(controller, path, value) {
    controller.setPlayerStyleColor(path, value);
  }
  function editorMarkup() {
    const previewCancel = ButtonComponent.renderButton({ label: 'Cancel', variant: 'secondary', size: 'small', quiet: true, attributes: { 'data-background-preview-cancel': true, 'aria-describedby': 'appearance-button-preview-help' } });
    const previewSave = ButtonComponent.renderButton({ label: 'Save', variant: 'primary', size: 'small', attributes: { 'data-background-preview-save': true, 'aria-describedby': 'appearance-button-preview-help' } });
    return `<section class="appearance-background-editor appearance-palette-editor" aria-labelledby="appearance-background-title">
      <div class="background-editor-heading"><div><h3 id="appearance-background-title">Main elements</h3><p class="background-intro">Dark, black, and light. Pick a foundation that feels right.</p></div><span>Personal appearance</span></div>
      <div class="background-editor-columns"><div class="background-choices">
      <section aria-labelledby="appearance-palette-label"><h4 id="appearance-palette-label"><span>1</span>Main background</h4><p class="background-help">Choose a palette for your library.</p>
      <div class="background-palette-grid">${palettes.map(palette => `<button type="button" class="background-family" data-background-palette="${palette.id}" aria-label="${palette.name}" aria-pressed="false" title="${palette.desc}"><span class="background-family-swatch" style="background:${palette.main};--swatch-panel:${palette.panels[0][1]}"></span><strong>${palette.name}</strong></button>`).join('')}</div></section>
      <section aria-labelledby="appearance-panel-label"><h4 id="appearance-panel-label"><span>2</span>App bar &amp; panels</h4><p class="background-help" data-background-panel-help></p><div class="background-companions" data-background-companions></div>
      <p class="background-help">App bar, artist tree, menus, floating panels, and dialogs.</p></section>
      <section class="background-player-section" aria-labelledby="appearance-player-label"><h4 id="appearance-player-label"><span>3</span>Player &amp; waveform</h4><p class="background-help">One color group for your player and waveform.</p>
      <div class="background-player-modes" role="group" aria-label="Player color mode"><button type="button" data-background-player-mode="palette" aria-pressed="true">Match player</button><button type="button" data-background-player-mode="custom" data-utility-appearance-key="seekbar" aria-pressed="false">Customize</button></div>
      <p class="background-help" data-background-player-help></p><div class="background-player-fields" data-background-player-fields hidden>${colorField('background', 'Player background')}<small>Player text and buttons adapt to the background.</small></div>
      <button class="button button-secondary background-editor-link" type="button" data-utility-appearance-key="seekbar">Edit waveform in Seekbar</button><p class="background-field-error" data-background-other-errors hidden></p><div class="background-player-summary" data-background-player-summary></div><p class="background-help">Waveform fill and edge stay with this group. Edit those colors in Seekbar.</p></section>
      <p class="background-help">Player overrides are edited in Player &amp; Seekbar and remain visible in this preview.</p>
      <p class="background-help">Save applies every pending Appearance change. Cancel restores the saved set.</p></div>
      <aside class="background-preview-column"><div class="background-preview-heading">Preview <small>Changes apply after Save</small></div>
      <div class="background-preview" data-background-preview aria-label="Appearance preview"><div class="background-preview-bar"><span aria-hidden="true">♫</span><span class="background-preview-search">Search your library</span><span aria-hidden="true">A</span></div>
      <div class="background-preview-body"><div class="background-preview-tree"><strong>Artists</strong><span>All artists</span><span>Coastal Lines</span><span>Northbound</span><span>Slow Seasons</span></div>
      <div class="background-preview-content"><strong>Your library</strong><div class="background-preview-card"><div aria-hidden="true">♫</div><small>Still Water</small><span class="background-preview-stars" aria-label="5 stars">★★★★★</span></div><div class="background-preview-floating">Album options<span>View album</span><span>Album details</span></div></div></div>
      <div class="background-preview-player"><span class="background-preview-play">▶</span><span>Waveform</span><svg viewBox="0 0 160 28" role="img" aria-label="Waveform color preview"><path d="M0 14 L8 9 L16 6 L24 4 L32 2 L40 9 L48 11 L56 3 L64 10 L72 1 L80 10 L88 6 L96 3 L104 11 L112 5 L120 2 L128 10 L136 9 L144 7 L152 12 L160 14 L152 16 L144 21 L136 19 L128 18 L120 26 L112 23 L104 17 L96 25 L88 22 L80 18 L72 27 L64 18 L56 25 L48 17 L40 19 L32 26 L24 24 L16 22 L8 19 Z"/></svg></div>
      <div class="background-preview-actions" role="group" aria-labelledby="appearance-button-preview-label" aria-describedby="appearance-button-preview-help"><span><strong id="appearance-button-preview-label">Buttons</strong><small id="appearance-button-preview-help">Hover, press, or use Tab to preview interactions.</small></span><div>${previewCancel}${previewSave}</div></div></div>
      <div class="background-pair-summary"><strong data-background-pair-title></strong><p class="background-help" data-background-pair-description></p></div></aside></div>
      <p class="background-warning" data-background-warning role="status" hidden></p><p class="background-request-error" data-background-request-error role="alert" hidden></p>
      <div class="background-actions"><button class="button button-secondary background-reset" type="button" data-background-reset>Reset backgrounds</button><button class="button button-secondary" type="button" data-background-cancel>Cancel</button><button class="button background-save" type="button" data-background-save>Save</button><button class="button button-secondary" type="button" data-background-retry hidden>Try again</button></div><p class="background-status" data-background-status role="status"></p></section>`;
  }
  function seekbarMarkup(seekbarMode = 'default') {
    const waveformSelected = seekbarMode === 'waveform';
    return `<section class="appearance-background-editor appearance-seekbar-editor" aria-labelledby="appearance-waveform-title">
      <h3 id="appearance-waveform-title">Player &amp; Seekbar</h3><p class="background-intro">Adjust relative colors without changing the real stereo waveform, loop selection, or handle behavior.</p>
      <div class="player-preview-dock"><div class="player-live-preview" data-player-live-preview aria-label="Player color preview">
        <div class="player-preview-cover" data-player-preview-cover aria-hidden="true">♫</div>
        <div class="player-preview-transport" aria-hidden="true"><span>▶</span><small>✂</small></div>
        <div class="player-preview-main"><div class="player-preview-meta"><span><strong data-player-preview-title>Still Water</strong><span data-player-preview-album> / Coastal Lines</span></span><time data-player-preview-time>1:42 / 4:12</time></div>
          ${waveformSelected ? `<svg class="player-preview-waveform" viewBox="0 0 600 42" preserveAspectRatio="none" role="img" aria-label="Stereo waveform using the selected colors">
            <g class="player-preview-unplayed"><path class="player-preview-channel is-left" d="M0 10 L20 8 L40 5 L60 9 L80 3 L100 7 L120 4 L140 8 L160 2 L180 6 L200 4 L220 9 L240 5 L260 7 L280 3 L300 8 L320 4 L340 6 L360 2 L380 7 L400 5 L420 9 L440 4 L460 6 L480 3 L500 8 L520 5 L540 7 L560 4 L580 8 L600 10 L580 12 L560 16 L540 13 L520 15 L500 12 L480 17 L460 14 L440 16 L420 11 L400 15 L380 13 L360 18 L340 14 L320 16 L300 12 L280 17 L260 13 L240 15 L220 11 L200 16 L180 14 L160 18 L140 12 L120 16 L100 13 L80 17 L60 11 L40 15 L20 12 Z"/><path class="player-preview-channel is-right" d="M0 31 L20 28 L40 25 L60 30 L80 24 L100 27 L120 23 L140 29 L160 25 L180 22 L200 28 L220 24 L240 30 L260 26 L280 23 L300 28 L320 25 L340 21 L360 27 L380 24 L400 29 L420 23 L440 26 L460 22 L480 28 L500 24 L520 30 L540 25 L560 27 L580 24 L600 31 L580 34 L560 36 L540 33 L520 38 L500 34 L480 37 L460 32 L440 36 L420 33 L400 39 L380 35 L360 37 L340 31 L320 36 L300 34 L280 39 L260 35 L240 37 L220 32 L200 38 L180 34 L160 37 L140 33 L120 39 L100 35 L80 38 L60 32 L40 37 L20 34 Z"/></g>
            <g class="player-preview-played"><path class="player-preview-channel is-left" d="M0 10 L20 8 L40 5 L60 9 L80 3 L100 7 L120 4 L140 8 L160 2 L180 6 L200 4 L220 9 L240 5 L260 7 L280 3 L300 8 L320 4 L340 6 L360 2 L380 7 L400 5 L420 9 L440 4 L460 6 L480 3 L500 8 L520 5 L540 7 L560 4 L580 8 L600 10 L580 12 L560 16 L540 13 L520 15 L500 12 L480 17 L460 14 L440 16 L420 11 L400 15 L380 13 L360 18 L340 14 L320 16 L300 12 L280 17 L260 13 L240 15 L220 11 L200 16 L180 14 L160 18 L140 12 L120 16 L100 13 L80 17 L60 11 L40 15 L20 12 Z"/><path class="player-preview-channel is-right" d="M0 31 L20 28 L40 25 L60 30 L80 24 L100 27 L120 23 L140 29 L160 25 L180 22 L200 28 L220 24 L240 30 L260 26 L280 23 L300 28 L320 25 L340 21 L360 27 L380 24 L400 29 L420 23 L440 26 L460 22 L480 28 L500 24 L520 30 L540 25 L560 27 L580 24 L600 31 L580 34 L560 36 L540 33 L520 38 L500 34 L480 37 L460 32 L440 36 L420 33 L400 39 L380 35 L360 37 L340 31 L320 36 L300 34 L280 39 L260 35 L240 37 L220 32 L200 38 L180 34 L160 37 L140 33 L120 39 L100 35 L80 38 L60 32 L40 37 L20 34 Z"/></g><line class="player-preview-playhead" x1="246" x2="246" y1="0" y2="42"/><circle class="player-preview-playhead-dot" cx="246" cy="21" r="2.5"/><g class="player-preview-loop-handles" aria-hidden="true"><line x1="145" x2="145" y1="0" y2="42"/><line x1="475" x2="475" y1="0" y2="42"/></g>
          </svg>` : `<div class="player-preview-seekbar" aria-label="Default seekbar preview"><span></span></div>`}
        </div>
      </div>
      <section class="player-seekbar-mode" aria-labelledby="appearance-seekbar-style-label"><h4 id="appearance-seekbar-style-label">Seekbar style</h4><p class="background-help">Choose the player seekbar style. Display mode applies immediately in this browser.</p><div class="appearance-section player-seekbar-options"><label class="appearance-option"><input type="radio" name="seekbar-mode" value="default" ${waveformSelected ? '' : 'checked'} data-appearance-seekbar-mode="default"><span>Default seekbar</span></label><label class="appearance-option"><input type="radio" name="seekbar-mode" value="waveform" ${waveformSelected ? 'checked' : ''} data-appearance-seekbar-mode="waveform"><span>Waveform seekbar</span></label></div></section></div>
      <div class="player-editor-workspace">
        <div class="player-editor-controls">
          <section class="player-theme-suggestions" aria-labelledby="appearance-player-themes-label"><h4 id="appearance-player-themes-label">Player themes</h4><p class="background-help">Choose a complete starting style, then adjust any individual color below.</p><div class="player-theme-grid">${playerThemes.map(theme => `<button type="button" class="player-theme-card" data-player-theme="${theme.id}" aria-pressed="false" title="${theme.description}" style="--theme-surface-start:${theme.style.surface.start};--theme-surface-end:${theme.style.surface.end};--theme-surface-angle:${theme.style.surface.angle}deg;--theme-control:${theme.style.controls.fill};--theme-wave-fill:${theme.style.waveform.fill};--theme-wave-edge:${theme.style.waveform.edge}"><span class="player-theme-swatch"><i></i><b></b></span><strong>${theme.name}</strong></button>`).join('')}</div></section>
          <div class="player-color-source"><span><strong>Color source</strong><small data-waveform-mode-help></small></span><div class="background-player-modes" role="group" aria-label="Player color mode"><button type="button" data-background-player-mode="palette" aria-pressed="true">Match palette</button><button type="button" data-background-player-mode="custom" aria-pressed="false">Custom player colors</button></div></div>
          <div class="appearance-player-tabs" role="tablist" aria-label="Player appearance controls"><button type="button" data-player-tab-group="player" data-player-tab="surface" aria-selected="true">Surface</button><button type="button" data-player-tab-group="player" data-player-tab="controls" aria-selected="false">Controls</button></div>
          <div class="player-style-grid">
            <section data-player-panel-group="player" data-player-panel="surface"><h4>Surface background</h4><p class="background-help">Set the player background behind its controls and waveform.</p><div class="player-surface-mode"><button type="button" data-player-surface-mode="gradient">Layered gradient</button><button type="button" data-player-surface-mode="solid">Solid</button></div>${playerStyleField('surface.start', 'Start')}${playerStyleField('surface.end', 'End')}<label class="player-angle-field">Angle <input type="range" min="0" max="360" data-player-style-angle><output data-player-angle-output>0°</output></label></section>
            <section data-player-panel-group="player" data-player-panel="controls" hidden><h4>Player controls</h4><p class="background-help">Set the play button and control outlines.</p>${playerStyleField('controls.fill', 'Control fill')}${playerStyleField('controls.border', 'Control border')}</section>
          </div>
          ${waveformSelected ? `<section class="player-waveform-settings" aria-labelledby="appearance-waveform-settings-label"><h4 id="appearance-waveform-settings-label">Waveform seekbar</h4><p class="background-help">Customize the waveform colors used by the seekbar. Loop selection and seek behavior stay unchanged.</p><div class="appearance-player-tabs" role="tablist" aria-label="Waveform seekbar controls"><button type="button" data-player-tab-group="waveform" data-player-tab="waveform" aria-selected="true">Waveform</button><button type="button" data-player-tab-group="waveform" data-player-tab="handles" aria-selected="false">Edges &amp; handles</button></div><div class="player-style-grid"><section data-player-panel-group="waveform" data-player-panel="waveform"><h4>Waveform</h4><p class="background-help">Set both stereo channels. The real waveform shape and playback state stay unchanged.</p><div class="waveform-color-fields">${['fill', 'edge'].map(field => `<div>${colorField(field, field === 'fill' ? 'Waveform fill' : 'Waveform edge')}<div class="waveform-recents" data-waveform-recents="${field}" role="group" aria-label="Recent waveform ${field} colors"></div></div>`).join('')}</div><p class="background-help" data-waveform-recents-help></p></section><section data-player-panel-group="waveform" data-player-panel="handles" hidden><h4>Edges &amp; handles</h4><p class="background-help">Set the waveform edge and thin loop-handle color. Handle size and selection behavior stay unchanged.</p>${playerStyleField('handles.color', 'Handle color')}</section></div><div class="waveform-recovery"><button class="button button-secondary" type="button" data-waveform-restore>Restore previous browser colors</button><p class="background-help">Use the earlier waveform colors stored in this browser. They apply to this account only after Save.</p><p class="background-field-error" data-waveform-recovery-status role="status" hidden></p></div></section>` : ''}
        </div>
        <aside class="player-set-history"><strong>Recent sets</strong><p class="background-help">Choose one of your five latest saved player configurations to restore.</p><div data-player-set-history></div></aside>
      </div>
      <section class="compact-player-style-section player-compact-setting" aria-labelledby="appearance-compact-player-label"><h4 id="appearance-compact-player-label">Compact player</h4><p class="background-help">Choose the desktop layout used when the player is collapsed.</p><div class="background-player-modes" role="group" aria-label="Compact player style"><button type="button" data-compact-player-style="docked" aria-pressed="true">Docked</button><button type="button" data-compact-player-style="floating" aria-pressed="false">Floating</button></div></section>
      <button class="button button-secondary background-editor-link" type="button" data-utility-appearance-key="backgrounds">Back to Main elements</button>
      <p class="background-field-error" data-background-other-errors hidden></p><p class="background-help">Save applies all pending Backgrounds and waveform colors together. Cancel restores your saved colors.</p>
      <p class="background-request-error" data-background-request-error role="alert" hidden></p>
      <div class="background-actions"><button class="button button-secondary" type="button" data-background-cancel>Cancel</button><button class="button background-save" type="button" data-background-save>Save</button><button class="button button-secondary" type="button" data-background-retry hidden>Try again</button></div><p class="background-status" data-background-status role="status"></p></section>`;
  }
  function selectionAccentMarkup() {
    return `<section class="appearance-background-editor selection-accent-editor" aria-labelledby="appearance-selection-title"><h3 id="appearance-selection-title">Selection &amp; Hover</h3><p class="background-intro">Control selection, hover, pressed, and keyboard-focus colors for navigation, lists, and buttons.</p><div class="selection-hover-workspace"><div class="selection-hover-controls"><section class="selection-accent-section" aria-labelledby="selection-accent-color-title"><h4 id="selection-accent-color-title"><span>1</span>Selection accent</h4><label class="selection-accent-toggle"><input type="checkbox" data-aggregate-accent-enabled>Show selection accent</label><div class="appearance-muted-spectrum appearance-accent-spectrum">${selectionAccentColors.map(color => `<button type="button" data-aggregate-accent-color="${color}" style="--swatch:${color}" aria-label="Use selection accent ${color}"></button>`).join('')}<label class="appearance-spectrum-picker" aria-label="Choose any selection accent color"><input type="color" value="${defaultSelectionAccent.color}" data-aggregate-accent-custom aria-label="Choose any selection accent color"></label></div></section>${interactionControlsMarkup()}</div><aside class="selection-hover-preview" aria-labelledby="selection-hover-preview-title"><div class="selection-hover-preview-heading"><strong id="selection-hover-preview-title">Preview</strong><small>Updates immediately</small></div><div class="selection-preview-stack"><div class="selection-preview-example is-navigation-hover" data-preview-state="navigation-hover"><strong>Navigation hover</strong><small>Artist item</small></div><div class="selection-preview-example is-navigation-selected" data-preview-state="navigation-selected"><strong>Navigation selected</strong><small>Selected artist</small></div><div class="selection-preview-example is-item-hover-background" data-preview-state="item-hover-background"><strong>Item hover background</strong><small>Actionable item</small></div><div class="selection-preview-example is-item-outline" data-preview-state="item-outline"><strong>Item hover &amp; keyboard focus outline</strong><small>Actionable item</small></div><div class="selection-preview-example is-item-pressed" data-preview-state="item-pressed"><strong>Item pressed</strong><small>Pressed action</small></div></div></aside></div><div class="selection-hover-revert"><button class="button button-secondary" type="button" data-interaction-use-theme>Use theme</button></div><p class="background-request-error" data-background-request-error role="alert" hidden></p><div class="background-actions"><button class="button button-secondary background-reset" type="button" data-selection-reset>Reset Selection &amp; Hover</button><button class="button button-secondary" type="button" data-background-cancel>Cancel</button><button class="button background-save" type="button" data-background-save>Save</button></div><p class="background-status" data-background-status role="status"></p></section>`;
  }
  function installBrowser(window, document) {
    if (window.AlbumHavenAppearance?.instance) return window.AlbumHavenAppearance.instance;
    const root = document.documentElement;
    let initial = empty(), csrfToken = '', loaded = false, mounted = null, unsubscribe = null, sessionGeneration = 0;
    let activePlayerTab = 'surface', activeWaveformTab = 'waveform';
    try {
      const bootstrap = JSON.parse(document.getElementById('appearance-bootstrap')?.textContent || '{}');
      const preference = normalizePreferences(bootstrap);
      initial = {
        ...preference,
        waveform_recent_colors: normalizeRecentColors(bootstrap.waveform_recent_colors),
        revision: Number.isInteger(bootstrap.revision) ? bootstrap.revision : 0,
        interaction_overrides: preference.interaction_overrides || { item_hover: null, item_selected: null, button_hover_background: null, button_pressed: null, item_outline: { ...defaultItemOutline } },
        selection_accent: preference.selection_accent || copy(defaultSelectionAccent),
        player_style_override: preference.player_style_override || null,
        player_recent_sets: normalizePlayerSets(bootstrap.player_recent_sets),
      };
    }
    catch (_failure) { /* Missing or invalid bootstrap never applies untrusted CSS. */ }
    let savedPlayerColors = null;
    const applySavedTheme = preference => {
      applyTheme(preference, root);
      savedPlayerColors = !nativePlayerComponents(preference).waveform && (preference.palette_id || preference.player_override || preference.player_style_override) ? resolveAppearance({ ...preference, player_override: preference.player_style_override || preference.player_override }).player : null;
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
      if (!response.ok || response.redirected) {
        let failureData = null;
        try { failureData = await response.json(); } catch (_error) {}
        const failure = new Error('Appearance unavailable.'); failure.status = response.status; failure.data = failureData; throw failure;
      }
      const data = await response.json();
      if (ownSession !== sessionGeneration) throw new Error('Session changed.');
      if (method === 'GET') csrfToken = typeof data.csrf_token === 'string' ? data.csrf_token : '';
      return data;
    };
    const controller = createController({ initial, request, apply: applySavedTheme });
    const load = async () => { const result = await controller.load(); if (result) loaded = true; return result; };
    let footerDispose = null, mountedFooter = null, restoreFooterTheme = null;
    const mountSharedFooter = (localHost, options) => {
      footerDispose?.(); footerDispose = null;
      const dialogHost = document.getElementById?.('utility-modal-footer');
      mountedFooter = window.EditorPage?.mountFooter && dialogHost ? dialogHost : localHost;
      if (mountedFooter === dialogHost) {
        const previousTheme = ['style', 'data-appearance-mode', 'data-appearance-palette', 'data-alert-family']
          .map(name => [name, dialogHost.getAttribute(name)]);
        restoreFooterTheme = () => previousTheme.forEach(([name, value]) => {
          if (value === null) dialogHost.removeAttribute(name);
          else dialogHost.setAttribute(name, value);
        });
        localHost.hidden = true; dialogHost.hidden = false;
      }
      footerDispose = window.EditorPage?.mountFooter?.(mountedFooter, { status: 'Saved to your account', ...options }) || null;
      return mountedFooter;
    };
    const unmount = () => {
      unsubscribe?.(); unsubscribe = null; footerDispose?.(); footerDispose = null; mounted = null;
      restoreFooterTheme?.(); restoreFooterTheme = null;
      if (mountedFooter?.id === 'utility-modal-footer') { mountedFooter.innerHTML = ''; mountedFooter.hidden = true; }
      mountedFooter = null;
    };
    const mount = host => {
      unmount(); host.innerHTML = editorMarkup(); mounted = host.querySelector('.appearance-background-editor');
      controller.setActiveSection('backgrounds');
      const editor = mounted, find = selector => editor.querySelector(selector);
      const footerHost = mountSharedFooter(find('.background-actions'), { resetLabel: 'Reset Main elements', onReset: () => controller.resetSection('backgrounds'), onRetry: () => void load(), primary: { label: 'Save', action: () => void controller.save() }, secondary: { label: 'Cancel', action: () => controller.cancel() } });
      const footerFind = selector => footerHost.querySelector(selector);
      find('.background-status').hidden = true;
      let drawnPalette;
      const sync = state => {
        if (mounted !== editor) return;
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
        applyDraftEditorTheme(state.saved, editor);
        applyDraftEditorTheme(state.saved, footerHost);
        const preview = find('[data-background-preview]');
        applyDraftEditorTheme(state.draft, preview);
        preview.style.setProperty('--preview-main', effective.main); preview.style.setProperty('--preview-panels', effective.panel);
        preview.style.setProperty('--preview-floating', !palette && !preference.panel_background_color ? '#1F2937' : effective.panel);
        for (const [token, value] of Object.entries(effective.tokens)) preview.style.setProperty('--preview-' + token, value);
        const custom = Boolean(preference.player_style_override || preference.player_override);
        editor.querySelectorAll('[data-background-player-mode]').forEach(button => button.setAttribute('aria-pressed', String((button.getAttribute('data-background-player-mode') === 'custom') === custom)));
        find('[data-background-player-fields]').hidden = !custom;
        find('[data-background-player-help]').textContent = custom ? 'Your background, waveform fill and edge stay together when you change palettes.' : 'The palette sets your player background, waveform fill and edge together.';
        for (const field of ['background']) {
          const key = 'player_' + field, picker = find(`[data-player-picker="${field}"]`), hex = find(`[data-player-hex="${field}"]`);
          picker.value = effective.player[field]; if (hex.value !== state.inputValues[key]) hex.value = state.inputValues[key];
          hex.setAttribute('aria-invalid', String(Boolean(state.errors[key]))); find(`[data-player-error="${field}"]`).textContent = state.errors[key] || '';
        }
        const otherErrors = find('[data-background-other-errors]'); otherErrors.hidden = !state.errors.player_fill && !state.errors.player_edge; otherErrors.textContent = 'Fix the waveform color errors in Seekbar before saving.';
        find('[data-background-player-summary]').innerHTML = ['background', 'fill', 'edge'].map(field => { const color = effective.player[field]; return `<span><i style="background:${color}"></i>${({ background: 'Background', fill: 'Fill', edge: 'Edge' })[field]} <b>${color}</b></span>`; }).join('');
        const warning = find('[data-background-warning]'); warning.hidden = !state.warnings.length;
        warning.textContent = state.warnings.length ? `Low contrast: ${state.warnings.join('; ')}. Some text may be hard to read. You can still save these colors.` : '';
        const failure = find('[data-background-request-error]'); failure.hidden = !state.error; failure.textContent = state.error;
        footerFind('[data-background-reset]').disabled = disabled;
        footerFind('[data-background-cancel]').disabled = state.loading || state.saving || !state.dirty;
        footerFind('[data-background-save]').disabled = !state.canSave; footerFind('[data-background-save]').textContent = state.saving ? 'Saving…' : 'Save';
        footerFind('[data-background-retry]').hidden = !state.loadFailed; footerFind('[data-background-retry]').disabled = state.loading || state.saving;
        footerFind('.editor-footer-status').textContent = state.loading ? 'Loading your appearance…' : state.saving ? 'Saving appearance…' : (state.error || state.loadFailed) ? '' : state.dirty ? 'Unsaved appearance changes' : 'Saved to your account';
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
        else if (button.hasAttribute('data-background-reset')) controller.resetSection('backgrounds');
        else if (button.hasAttribute('data-background-cancel')) controller.cancel();
        else if (button.hasAttribute('data-background-save')) void controller.save();
        else if (button.hasAttribute('data-background-retry')) void load();
      });
      unsubscribe = controller.subscribe(sync); sync(controller.getState()); if (!loaded) void load(); return unmount;
    };
    const mountAlerts = host => {
      unmount(); host.innerHTML = alertsMarkup(); mounted = host.querySelector('.appearance-alerts');
      controller.setActiveSection('alerts');
      const editor = mounted, find = selector => editor.querySelector(selector);
      let previewSeverity = 'error';
      const footerHost = mountSharedFooter(find('.background-actions'), {
        resetLabel: 'Reset Alerts',
        onReset: () => controller.resetSection('alerts'),
        onRetry: () => void load(),
        primary: { label: 'Save', action: () => void controller.save() },
        secondary: { label: 'Cancel', action: () => controller.cancel() },
      });
      const previewCopy = {
        error: ['Album details unavailable', 'This album cannot be found under the current libraries. Its library entry is still saved.', 'Album not found'],
        warning: ['Library scan needs attention', 'Some folders could not be checked. Existing album information is unchanged.', 'Scan incomplete'],
        info: ['Library update available', 'New albums were found and are ready to be added to this library.', 'Albums found'],
      };
      const sync = state => {
        if (mounted !== editor) return;
        const disabled = state.loading || state.saving || state.loadFailed;
        editor.setAttribute('aria-busy', String(state.loading || state.saving));
        editor.querySelectorAll('button').forEach(button => { button.disabled = disabled; });
        editor.querySelectorAll('.appearance-alert-family-card').forEach(button => button.setAttribute('aria-pressed', String(button.getAttribute('data-alert-family') === state.draft.alert_family)));
        editor.querySelectorAll('[data-alert-preview-severity]').forEach(button => button.setAttribute('aria-pressed', String(button.getAttribute('data-alert-preview-severity') === previewSeverity)));
        applyDraftEditorTheme(state.saved, editor);
        applyDraftEditorTheme(state.saved, footerHost);
        const preview = find('[data-alert-live-preview]');
        applyDraftEditorTheme(state.draft, preview);
        preview.setAttribute('data-alert-family', state.draft.alert_family || 'ember');
        preview.setAttribute('data-alert-preview-active-severity', previewSeverity);
        const pageAlert = find('.appearance-alert-preview__page');
        pageAlert.className = `on-page-alert on-page-alert--${previewSeverity} appearance-alert-preview__page`;
        editor.querySelectorAll('.small-alert').forEach(alert => { alert.classList.remove('small-alert--error', 'small-alert--warning', 'small-alert--info'); alert.classList.add(`small-alert--${previewSeverity}`); });
        const icon = previewSeverity === 'info' ? previewInfoIcon : previewAlertIcon;
        find('[data-alert-preview-icon]').innerHTML = icon;
        editor.querySelectorAll('[data-small-alert-preview-icon]').forEach(host => { host.innerHTML = icon; });
        find('[data-alert-preview-title]').textContent = previewCopy[previewSeverity][0];
        find('[data-alert-preview-copy]').textContent = previewCopy[previewSeverity][1];
        find('[data-alert-preview-small-label]').textContent = previewCopy[previewSeverity][2];
        const failure = find('[data-background-request-error]'); failure.hidden = !state.error; failure.textContent = state.error;
        const findFooter = selector => footerHost.querySelector(selector);
        findFooter('[data-background-reset]').disabled = disabled;
        findFooter('[data-background-cancel]').disabled = state.loading || state.saving || !state.dirty;
        const saveButton = findFooter('[data-background-save]'); saveButton.disabled = !state.canSave; (saveButton.querySelector('.ui-button__content') || saveButton).textContent = state.saving ? 'Saving…' : 'Save';
        findFooter('[data-background-retry]').hidden = !state.loadFailed;
        findFooter('.editor-footer-status').textContent = state.loading ? 'Loading your appearance…' : state.saving ? 'Saving appearance…' : state.dirty ? 'Unsaved appearance changes' : 'Saved to your account';
      };
      editor.addEventListener('click', event => {
        const button = event.target.closest('button'); if (!button || button.disabled) return;
        if (button.classList.contains('appearance-alert-family-card')) controller.setAlertFamily(button.getAttribute('data-alert-family'));
        else if (button.hasAttribute('data-alert-preview-severity')) { previewSeverity = button.getAttribute('data-alert-preview-severity'); sync(controller.getState()); }
      });
      unsubscribe = controller.subscribe(sync); sync(controller.getState()); if (!loaded) void load(); return unmount;
    };
    const mountAlbumPage = host => {
      unmount(); host.innerHTML = albumPageMarkup(); mounted = host.querySelector('.appearance-album-page');
      controller.setActiveSection('album-page');
      const editor = mounted;
      let previewState = 'present';
      const footerHost = mountSharedFooter(editor.querySelector('.background-actions'), {
        resetLabel: 'Reset Album page',
        onReset: () => controller.resetSection('album-page'),
        onRetry: () => void load(),
        primary: { label: 'Save', action: () => void controller.save() },
        secondary: { label: 'Cancel', action: () => controller.cancel() },
      });
      const sync = state => {
        if (mounted !== editor) return;
        const disabled = state.loading || state.saving || state.loadFailed;
        editor.setAttribute('aria-busy', String(state.loading || state.saving));
        editor.querySelectorAll('button').forEach(button => { button.disabled = disabled; });
        editor.querySelectorAll('[data-album-details-layout]').forEach(button => button.setAttribute('aria-pressed', String(button.getAttribute('data-album-details-layout') === state.draft.album_details_layout)));
        editor.querySelectorAll('[data-album-playing-row-animation]').forEach(button => button.setAttribute('aria-pressed', String(button.getAttribute('data-album-playing-row-animation') === state.draft.album_playing_row_animation)));
        editor.querySelectorAll('[data-album-preview-state]').forEach(button => button.setAttribute('aria-pressed', String(button.getAttribute('data-album-preview-state') === previewState)));
        applyDraftEditorTheme(state.saved, editor);
        applyDraftEditorTheme(state.saved, footerHost);
        const preview = editor.querySelector('[data-album-page-live-preview]');
        applyDraftEditorTheme(state.draft, preview);
        preview.setAttribute('data-layout', state.draft.album_details_layout || 'classic_bar');
        preview.setAttribute('data-preview-state', previewState);
        editor.querySelector('[data-album-preview-present]').hidden = previewState !== 'present';
        editor.querySelector('[data-album-preview-missing]').hidden = previewState !== 'missing';
        editor.querySelectorAll('[data-album-preview-file-action]').forEach(button => { button.disabled = disabled || previewState === 'missing'; });
        preview.setAttribute('data-album-playing-row-animation', state.draft.album_playing_row_animation || 'enabled');
        const failure = editor.querySelector('[data-background-request-error]'); failure.hidden = !state.error; failure.textContent = state.error;
        const findFooter = selector => footerHost.querySelector(selector);
        findFooter('[data-background-reset]').disabled = disabled;
        findFooter('[data-background-cancel]').disabled = state.loading || state.saving || !state.dirty;
        const saveButton = findFooter('[data-background-save]'); saveButton.disabled = !state.canSave; (saveButton.querySelector('.ui-button__content') || saveButton).textContent = state.saving ? 'Saving…' : 'Save';
        findFooter('[data-background-retry]').hidden = !state.loadFailed;
        findFooter('.editor-footer-status').textContent = state.loading ? 'Loading your appearance…' : state.saving ? 'Saving appearance…' : state.dirty ? 'Unsaved appearance changes' : 'Saved to your account';
      };
      editor.addEventListener('click', event => {
        const button = event.target.closest('button'); if (!button || button.disabled) return;
        if (button.hasAttribute('data-album-details-layout')) controller.setAlbumDetailsLayout(button.getAttribute('data-album-details-layout'));
        else if (button.hasAttribute('data-album-playing-row-animation')) controller.setAlbumPlayingRowAnimation(button.getAttribute('data-album-playing-row-animation'));
        else if (button.hasAttribute('data-album-preview-state')) { previewState = button.getAttribute('data-album-preview-state'); sync(controller.getState()); }
      });
      unsubscribe = controller.subscribe(sync); sync(controller.getState()); if (!loaded) void load(); return unmount;
    };
    const mountSelectionAccent = host => {
      unmount(); host.innerHTML = selectionAccentMarkup(); mounted = host.querySelector('.appearance-background-editor');
      controller.setActiveSection('selection-accent');
      const editor = mounted, find = selector => editor.querySelector(selector);
      const footerHost = mountSharedFooter(find('.background-actions'), { resetLabel: 'Reset Selection & Hover', onReset: () => controller.resetSection('selection-accent'), onRetry: () => void load(), primary: { label: 'Save', action: () => void controller.save() }, secondary: { label: 'Cancel', action: () => controller.cancel() } });
      const footerFind = selector => footerHost.querySelector(selector);
      find('.background-status').hidden = true;
      const sync = state => {
        if (mounted !== editor) return;
        const disabled = state.loading || state.saving || state.loadFailed;
        editor.setAttribute('aria-busy', String(state.loading || state.saving));
        editor.querySelectorAll('button,input').forEach(element => { element.disabled = disabled; });
        const accent = state.draft.selection_accent || defaultSelectionAccent;
        find('[data-aggregate-accent-enabled]').checked = accent.enabled;
        editor.querySelectorAll('[data-aggregate-accent-color]').forEach(button => button.setAttribute('aria-pressed', String(button.getAttribute('data-aggregate-accent-color') === accent.color)));
        const customAccent = find('[data-aggregate-accent-custom]');
        customAccent.value = accent.color;
        customAccent.closest('.appearance-spectrum-picker').setAttribute('data-selected', String(!selectionAccentColors.includes(accent.color)));
        editor.querySelectorAll('[data-interaction-color]').forEach(button => {
          const key = button.getAttribute('data-interaction-color');
          button.setAttribute('aria-pressed', String(state.draft.interaction_overrides?.[key] === button.getAttribute('data-color')));
        });
        const outline = state.draft.interaction_overrides?.item_outline || defaultItemOutline;
        editor.querySelectorAll('[data-item-outline-color]').forEach(button => button.setAttribute('aria-pressed', String(outline.source === 'custom' && outline.color === button.getAttribute('data-color'))));
        find('[data-item-outline-source="player"]').setAttribute('aria-pressed', String(outline.source === 'player'));
        applyDraftEditorTheme(state.saved, editor);
        applyDraftEditorTheme(state.saved, footerHost);
        const preview = find('.selection-hover-preview');
        applyDraftEditorTheme(state.draft, preview);
        preview.style.setProperty('--navigation-tree-selection-accent-color', accent.color);
        preview.style.setProperty('--navigation-tree-selection-accent-width', accent.enabled ? '3px' : '0px');
        const failure = find('[data-background-request-error]'); failure.hidden = !state.error; failure.textContent = state.error;
        footerFind('[data-background-reset]').disabled = disabled;
        footerFind('[data-background-cancel]').disabled = state.loading || state.saving || !state.dirty;
        footerFind('[data-background-save]').disabled = !state.canSave;
        footerFind('[data-background-retry]').hidden = !state.loadFailed; footerFind('[data-background-retry]').disabled = state.loading || state.saving;
        footerFind('.editor-footer-status').textContent = state.loading ? 'Loading your appearance…' : state.saving ? 'Saving appearance…' : (state.error || state.loadFailed) ? '' : state.dirty ? 'Unsaved appearance changes' : 'Saved to your account';
      };
      editor.addEventListener('change', event => {
        if (!event.target.hasAttribute('data-aggregate-accent-enabled')) return;
        const current = controller.getState().draft.selection_accent;
        const color = current?.color || find('[data-aggregate-accent-custom]').value;
        controller.setSelectionAccent({ enabled: event.target.checked, color });
      });
      editor.addEventListener('input', event => { if (event.target.hasAttribute('data-aggregate-accent-custom')) controller.setSelectionAccent({ enabled: true, color: event.target.value }); });
      editor.addEventListener('click', event => {
        const button = event.target.closest('button'); if (!button || button.disabled) return;
        if (button.hasAttribute('data-aggregate-accent-color')) controller.setSelectionAccent({ enabled: true, color: button.getAttribute('data-aggregate-accent-color') });
        else if (button.hasAttribute('data-interaction-color')) controller.setInteractionOverrides({ ...(controller.getState().draft.interaction_overrides || {}), [button.getAttribute('data-interaction-color')]: button.getAttribute('data-color') });
        else if (button.hasAttribute('data-item-outline-color')) controller.setItemOutline('custom', button.getAttribute('data-color'));
        else if (button.getAttribute('data-item-outline-source') === 'player') controller.setItemOutline('player');
        else if (button.hasAttribute('data-interaction-use-theme')) controller.useThemeInteractions();
        else if (button.hasAttribute('data-selection-reset')) controller.resetSection('selection-accent');
        else if (button.hasAttribute('data-background-cancel')) controller.cancel();
        else if (button.hasAttribute('data-background-save')) void controller.save();
      });
      unsubscribe = controller.subscribe(sync); sync(controller.getState()); if (!loaded) void load(); return unmount;
    };
    const mountSeekbar = (host, { getLegacyColors = () => null, getSeekbarMode = () => 'default' } = {}) => {
      const waveformSelected = getSeekbarMode() === 'waveform';
      unmount(); host.innerHTML = seekbarMarkup(waveformSelected ? 'waveform' : 'default'); mounted = host.querySelector('.appearance-background-editor');
      controller.setActiveSection('seekbar');
      const editor = mounted, find = selector => editor.querySelector(selector);
      let recoveryMessage = '';
      if (!find(`[data-player-tab-group="player"][data-player-tab="${activePlayerTab}"]`)) activePlayerTab = 'surface';
      if (!find(`[data-player-tab-group="waveform"][data-player-tab="${activeWaveformTab}"]`)) activeWaveformTab = 'waveform';
      const resetSeekbar = () => { recoveryMessage = ''; controller.resetSection('seekbar'); };
      const cancelAppearance = () => { recoveryMessage = ''; controller.cancel(); };
      const saveAppearance = () => { recoveryMessage = ''; void controller.save(); };
      const retryAppearance = () => { recoveryMessage = ''; void load(); };
      const footerHost = mountSharedFooter(find('.background-actions'), { resetLabel: 'Reset Player & Seekbar', onReset: resetSeekbar, onRetry: retryAppearance, primary: { label: 'Save', action: saveAppearance }, secondary: { label: 'Cancel', action: cancelAppearance } });
      const footerFind = selector => footerHost.querySelector(selector);
      find('.background-status').hidden = true;
      const sync = state => {
        if (mounted !== editor) return;
        const disabled = state.loading || state.saving || state.loadFailed, custom = Boolean(state.draft.player_style_override || state.draft.player_override);
        editor.setAttribute('aria-busy', String(state.loading || state.saving));
        editor.querySelectorAll('button,input').forEach(element => { element.disabled = disabled; });
        editor.querySelectorAll('[data-background-player-mode]').forEach(button => button.setAttribute('aria-pressed', String((button.getAttribute('data-background-player-mode') === 'custom') === custom)));
        find('[data-waveform-mode-help]').textContent = waveformSelected
          ? (custom ? 'Custom colors stay together when you change palettes. Match palette resets the complete player color group.' : 'Your palette sets the complete player color group. Changing any field creates a custom group.')
          : (custom ? 'Custom surface and control colors stay active. Saved waveform colors remain available if you switch to Waveform seekbar.' : 'Your palette sets the player surface and controls. Waveform colors remain saved for Waveform seekbar.');
        const history = [...new Set([...state.waveformColorUpdates, ...state.recentColors])].slice(0, 5);
        if (waveformSelected) {
          for (const field of ['fill', 'edge']) {
            const key = 'player_' + field, picker = find(`[data-player-picker="${field}"]`), hex = find(`[data-player-hex="${field}"]`);
            picker.value = state.effective.player[field]; if (hex.value !== state.inputValues[key]) hex.value = state.inputValues[key];
            hex.setAttribute('aria-invalid', String(Boolean(state.errors[key]))); find(`[data-player-error="${field}"]`).textContent = state.errors[key] || '';
            find(`[data-waveform-recents="${field}"]`).innerHTML = history.map(color => `<button class="waveform-recent-swatch" type="button" data-waveform-recent="${color}" data-waveform-field="${field}" style="background:${color}" aria-label="Use ${color} for waveform ${field}" title="${color}" ${disabled ? 'disabled' : ''}></button>`).join('');
          }
          find('[data-waveform-recents-help]').textContent = history.length ? 'Recent colors · last five choices. Choose a swatch below either field.' : 'Your five most recent waveform colors will appear here.';
        }
        const style = effectivePlayerStyle(state);
        applyDraftEditorTheme(state.saved, editor);
        applyDraftEditorTheme(state.saved, footerHost);
        const preview = find('[data-player-live-preview]');
        applyDraftEditorTheme(state.draft, preview);
        preview.style.setProperty('--preview-player-start', style.surface.start); preview.style.setProperty('--preview-player-end', style.surface.mode === 'solid' ? style.surface.start : style.surface.end); preview.style.setProperty('--preview-player-angle', `${style.surface.angle}deg`);
        preview.style.setProperty('--preview-control-fill', style.controls.fill); preview.style.setProperty('--preview-control-border', style.controls.border);
        preview.style.setProperty('--preview-waveform-fill', style.waveform.fill); preview.style.setProperty('--preview-waveform-edge', style.waveform.edge);
        preview.style.setProperty('--preview-handle-color', style.handles.color); preview.setAttribute('data-show-handles', String(waveformSelected && activeWaveformTab === 'handles'));
        const liveTitle = document.getElementById?.('player-title')?.textContent?.trim();
        const liveAlbum = document.getElementById?.('player-album-link')?.textContent?.trim();
        const liveTime = document.getElementById?.('player-time')?.textContent?.trim();
        if (liveTitle) find('[data-player-preview-title]').textContent = liveTitle;
        if (liveAlbum) find('[data-player-preview-album]').textContent = ` / ${liveAlbum}`;
        if (liveTime) find('[data-player-preview-time]').textContent = liveTime;
        const liveCover = document.getElementById?.('player-cover-button');
        if (liveCover?.style?.backgroundImage) find('[data-player-preview-cover]').style.backgroundImage = liveCover.style.backgroundImage;
        editor.querySelectorAll('[data-player-style-color],[data-player-style-hex]').forEach(input => {
          const path = input.getAttribute('data-player-style-color') || input.getAttribute('data-player-style-hex');
          const [group, field] = path.split('.'), key = 'player_style_' + path;
          const hexInput = Boolean(input.getAttribute('data-player-style-hex'));
          const value = hexInput ? state.inputValues[key] : style[group][field];
          if (input.value !== value) input.value = value;
          if (hexInput) input.setAttribute('aria-invalid', String(Boolean(state.errors[key])));
          const error = find(`[data-player-style-error="${path}"]`); if (error) error.textContent = state.errors[key] || '';
          input.disabled = disabled || (group === 'surface' && field === 'end' && style.surface.mode === 'solid');
        });
        const angle = find('[data-player-style-angle]'); if (angle) angle.value = String(style.surface.angle);
        const angleOutput = find('[data-player-angle-output]'); if (angleOutput) angleOutput.textContent = `${style.surface.angle}°`;
        editor.querySelectorAll('[data-player-surface-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.getAttribute('data-player-surface-mode') === (style.surface.mode === 'solid' ? 'solid' : 'gradient'))));
        editor.querySelectorAll('[data-player-theme]').forEach(button => { const theme = playerThemes.find(item => item.id === button.getAttribute('data-player-theme')); button.setAttribute('aria-pressed', String(Boolean(theme) && JSON.stringify(theme.style) === JSON.stringify(style))); });
        editor.querySelectorAll('[data-compact-player-style]').forEach(button => button.setAttribute('aria-pressed', String(button.getAttribute('data-compact-player-style') === state.draft.compact_player_style)));
        editor.querySelectorAll('[data-player-tab-group="player"]').forEach(button => button.setAttribute('aria-selected', String(button.getAttribute('data-player-tab') === activePlayerTab)));
        editor.querySelectorAll('[data-player-panel-group="player"][data-player-panel]').forEach(panel => { panel.hidden = panel.getAttribute('data-player-panel') !== activePlayerTab; });
        editor.querySelectorAll('[data-player-tab-group="waveform"]').forEach(button => button.setAttribute('aria-selected', String(button.getAttribute('data-player-tab') === activeWaveformTab)));
        editor.querySelectorAll('[data-player-panel-group="waveform"][data-player-panel]').forEach(panel => { panel.hidden = panel.getAttribute('data-player-panel') !== activeWaveformTab; });
        const historyHost = find('[data-player-set-history]');
        if (historyHost) historyHost.innerHTML = state.playerRecentSets.map((set, index) => `<button type="button" class="player-history-set" data-player-set-index="${index}" aria-label="Restore ${index === 0 ? 'latest set' : `previous set ${index + 1}`}"><span class="player-history-preview" style="--history-surface-start:${set.surface.start};--history-surface-end:${set.surface.end};--history-surface-angle:${set.surface.angle}deg;--history-wave-fill:${set.waveform.fill};--history-wave-edge:${set.waveform.edge}"><i></i></span><span class="player-history-copy"><strong>${index === 0 ? 'Latest set' : `Previous set ${index + 1}`}</strong><small>${set.waveform.fill} · ${set.waveform.edge}</small></span><span class="player-history-restore" aria-hidden="true">↶</span></button>`).join('') || '<p class="background-help">Your applied sets will appear here after Save.</p>';
        const recovery = find('[data-waveform-recovery-status]'); if (recovery) { recovery.hidden = !recoveryMessage; recovery.textContent = recoveryMessage; }
        const otherErrors = find('[data-background-other-errors]');
        const backgroundErrors = state.errors.player_background || state.errors.main_surface_color || state.errors.panel_background_color;
        const hiddenWaveformErrors = !waveformSelected && (state.errors.player_fill || state.errors.player_edge || state.errors['player_style_handles.color']);
        otherErrors.hidden = !backgroundErrors && !hiddenWaveformErrors;
        otherErrors.textContent = [
          backgroundErrors ? 'Fix the color errors in Backgrounds before saving.' : '',
          hiddenWaveformErrors ? 'Select Waveform seekbar above to correct its color errors before saving. Your entered values are retained.' : '',
        ].filter(Boolean).join(' ');
        const failure = find('[data-background-request-error]'); failure.hidden = !state.error; failure.textContent = state.error;
        footerFind('[data-background-reset]').disabled = disabled;
        footerFind('[data-background-cancel]').disabled = state.loading || state.saving || !state.dirty;
        const saveButton = footerFind('[data-background-save]'); saveButton.disabled = !state.canSave; (saveButton.querySelector('.ui-button__content') || saveButton).textContent = state.saving ? 'Saving…' : 'Save';
        footerFind('[data-background-retry]').hidden = !state.loadFailed; footerFind('[data-background-retry]').disabled = state.loading || state.saving;
        footerFind('.editor-footer-status').textContent = state.loading ? 'Loading your appearance…' : state.saving ? 'Saving appearance…' : (state.error || state.loadFailed) ? '' : state.dirty ? 'Unsaved appearance changes' : 'Saved to your account';
      };
      editor.addEventListener('input', event => {
        const stylePath = event.target.getAttribute('data-player-style-color') || event.target.getAttribute('data-player-style-hex');
        if (stylePath) { controller.setPlayerStyleColor(stylePath, event.target.value); return; }
        if (event.target.hasAttribute('data-player-style-angle')) { const style = effectivePlayerStyle(controller.getState()); style.surface.angle = Number(event.target.value); makePlayerComponentsExplicit(style, 'surface'); controller.setPlayerStyle(style, { preserveColorErrors: true }); return; }
        const field = event.target.getAttribute('data-player-picker') || event.target.getAttribute('data-player-hex');
        if (field) {
          recoveryMessage = '';
          controller.setWaveformColor(field, event.target.value, { recordRecent: !event.target.hasAttribute('data-player-picker') });
        }
      });
      editor.addEventListener('change', event => {
        const field = event.target.getAttribute('data-player-picker');
        if (field) controller.setWaveformColor(field, event.target.value);
      });
      editor.addEventListener('click', event => {
        const button = event.target.closest('button'); if (!button || button.disabled) return;
        if (button.hasAttribute('data-player-tab')) {
          if (button.getAttribute('data-player-tab-group') === 'waveform') activeWaveformTab = button.getAttribute('data-player-tab');
          else activePlayerTab = button.getAttribute('data-player-tab');
          sync(controller.getState());
        }
        else if (button.hasAttribute('data-waveform-recent')) { recoveryMessage = ''; controller.setWaveformColor(button.getAttribute('data-waveform-field'), button.getAttribute('data-waveform-recent')); }
        else if (button.hasAttribute('data-player-set-index')) controller.restorePlayerSet(controller.getState().playerRecentSets[Number(button.getAttribute('data-player-set-index'))]);
        else if (button.hasAttribute('data-player-theme')) { const theme = playerThemes.find(item => item.id === button.getAttribute('data-player-theme')); if (theme) controller.setPlayerStyle(theme.style); }
            else if (button.hasAttribute('data-player-surface-mode')) { const style = effectivePlayerStyle(controller.getState()); style.surface.mode = button.getAttribute('data-player-surface-mode'); if (style.surface.mode === 'solid') style.surface.end = style.surface.start; makePlayerComponentsExplicit(style, 'surface'); controller.setPlayerStyle(style, { preserveColorErrors: true }); }
            else if (button.hasAttribute('data-compact-player-style')) controller.setCompactPlayerStyle(button.getAttribute('data-compact-player-style'));
        else if (button.hasAttribute('data-background-player-mode')) { recoveryMessage = ''; controller.setPlayerMode(button.getAttribute('data-background-player-mode')); }
        else if (button.hasAttribute('data-waveform-restore')) {
          try { const pair = getLegacyColors(); controller.restoreWaveformColors(pair); recoveryMessage = 'Previous browser colors restored. Save to apply them.'; }
          catch (_failure) { recoveryMessage = 'No valid previous waveform colors were found in this browser. You can choose colors above.'; }
          sync(controller.getState());
        } else if (button.hasAttribute('data-background-cancel')) cancelAppearance();
        else if (button.hasAttribute('data-background-save')) saveAppearance();
        else if (button.hasAttribute('data-background-retry')) retryAppearance();
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
    return { controller, mount, mountSeekbar, mountSelectionAccent, mountAlerts, mountAlbumPage, unmount, allowLeave, clearSession, load, getSavedPlayerColors: () => savedPlayerColors ? { ...savedPlayerColors } : null };
  }
  const api = { normalizeColor, normalizeInteractionOverrides, resolveInteractionOutline, derivePairedPlayerColor, setPlayerStylePath, colorToRgb, contrastRatio, applyTheme, clearTheme, createController, installBrowser, palettes, playerThemes, editorMarkup, seekbarMarkup, selectionAccentMarkup, alertsMarkup, albumPageMarkup, resolveAppearance, selectionAccentColors, brightAccentColors, interactionColorFamilies, interactionControlsMarkup, getSavedPlayerColors: () => api.instance?.getSavedPlayerColors() || null };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (scope && scope.document) { scope.AlbumHavenAppearance = api; api.instance = installBrowser(scope, scope.document); }
})(typeof window !== 'undefined' ? window : null);
