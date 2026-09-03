/* Account-owned selection accent. Unsaved colors affect only the editor preview. */
(() => {
  'use strict';
  if (window.AlbumHavenSelectionAccent) return;
  const endpoint = '/api/account/appearance/selection-accent';
  const defaults = () => ({ enabled: true, color: '#34ca78' });
  const normalize = value => {
    if (!value || Object.keys(value).some(key => !['enabled', 'color'].includes(key)) || typeof value.enabled !== 'boolean' || typeof value.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(value.color)) throw new Error('Enter a six-digit hex color, such as #34ca78.');
    return { enabled: value.enabled, color: value.color.toLowerCase() };
  };
  function create({ fetch, apply = () => {}, getCsrfToken = () => '' }) {
    let saved = null, draft = defaults(), loaded = false, loading = false, saving = false, error = '', loadPromise = null, invalidDraft = false;
    const listeners = new Set();
    const getState = () => ({ saved: saved ? { ...saved } : null, draft: { ...draft }, loaded, loading, saving, error });
    const notify = () => listeners.forEach(listener => listener(getState()));
    const payload = data => {
      if (!data || !Object.prototype.hasOwnProperty.call(data, 'selection_accent')) throw new Error('Invalid preference response.');
      return data.selection_accent === null ? null : normalize(data.selection_accent);
    };
    const load = () => {
      if (loaded) return Promise.resolve(getState());
      if (loadPromise) return loadPromise;
      loading = true; error = ''; notify();
      loadPromise = (async () => {
        try {
          const response = await fetch(endpoint, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
          if (!response.ok) throw new Error('Selection accent could not be loaded. Please try again.');
          saved = payload(await response.json()); draft = saved ? { ...saved } : defaults(); loaded = true; apply(saved ? { ...saved } : null);
        } catch (failure) { error = 'Selection accent could not be loaded. Please try again.'; }
        finally { loading = false; loadPromise = null; notify(); }
        return getState();
      })();
      return loadPromise;
    };
    const setDraft = patch => {
      if (saving || !loaded) return getState();
      try { draft = normalize({ ...draft, ...patch }); error = ''; invalidDraft = false; }
      catch (failure) { error = failure.message; invalidDraft = true; }
      notify(); return getState();
    };
    const cancel = () => {
      if (saving) return getState();
      draft = saved ? { ...saved } : defaults(); error = ''; invalidDraft = false; notify(); return getState();
    };
    const save = async () => {
      if (!loaded || saving || invalidDraft) return false;
      const submitted = { ...draft };
      saving = true; error = ''; notify();
      try {
        const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
        const csrf = getCsrfToken(); if (csrf) headers['X-Album-Haven-CSRF'] = csrf;
        const response = await fetch(endpoint, { method: 'PUT', credentials: 'same-origin', cache: 'no-store', headers, body: JSON.stringify(submitted) });
        if (!response.ok) throw new Error('Save failed');
        const preference = payload(await response.json());
        if (!preference) throw new Error('Missing saved preference');
        saved = preference; draft = { ...saved }; apply({ ...saved }); return true;
      } catch (failure) { error = 'Selection accent could not be saved. Your changes are kept; please try again.'; return false; }
      finally { saving = false; notify(); }
    };
    return { load, setDraft, cancel, save, getState, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
  }
  const apply = preference => {
    const style = document.documentElement.style;
    if (preference === null) {
      style.removeProperty('--navigation-tree-selection-accent-width');
      style.removeProperty('--navigation-tree-selection-accent-color');
    } else {
      style.setProperty('--navigation-tree-selection-accent-width', preference.enabled ? '3px' : '0px');
      style.setProperty('--navigation-tree-selection-accent-color', preference.color);
    }
  };
  const getCsrfToken = () => {
    const cookie = String(document.cookie || '').split(';').find(part => part.trim().startsWith('__Host-album_haven_csrf='));
    if (cookie) { try { return decodeURIComponent(cookie.trim().slice('__Host-album_haven_csrf='.length)); } catch {} }
    return document.querySelector('[name="csrf_token"]')?.value || '';
  };

  let disposeEditor = null;
  let mountedEditor = null;
  function unmount() {
    mountedEditor = null;
    if (disposeEditor) { const dispose = disposeEditor; disposeEditor = null; dispose(); }
  }
  function mount(container, controller = window.AlbumHavenSelectionAccent.instance) {
    if (mountedEditor && mountedEditor.container === container && mountedEditor.controller === controller
      && container.querySelector('.selection-accent-editor') === mountedEditor.editor) {
      return mountedEditor.release;
    }
    unmount();
    if (!container || !controller) return () => {};
    const item = window.NavigationTree.renderItem;
    container.innerHTML = '<section class="selection-accent-editor" aria-labelledby="selection-accent-heading">' +
      '<h3 class="utility-rule-title" id="selection-accent-heading">Selection accent</h3>' +
      '<p class="utility-rule-description">Add a thin color strip to the selected item in Artists and Settings navigation.</p>' +
      '<label class="selection-accent-toggle"><input type="checkbox" data-selection-accent-enabled>Show selection accent</label>' +
      '<div class="selection-accent-colors"><label>Accent color<input type="color" value="#34ca78" data-selection-accent-color></label>' +
      '<label>Hex color<input type="text" value="#34ca78" maxlength="7" spellcheck="false" autocomplete="off" data-selection-accent-hex aria-describedby="selection-accent-error"></label></div>' +
      '<p class="selection-accent-error" id="selection-accent-error" role="alert"></p>' +
      '<div class="selection-accent-previews"><nav class="navigation-tree selection-accent-preview" aria-label="Artists preview"><h4>Artists</h4>' +
      item({label:'All artists',count:128,key:'all',href:'#'}) +
      item({label:'Amber Coast',count:6,key:'amber',href:'#',selected:true}) +
      item({label:'Blue Orchard',count:4,key:'blue',href:'#'}) +
      item({label:'Quiet Atlas',count:8,key:'quiet',href:'#'}) +
      '</nav><nav class="navigation-tree selection-accent-preview" aria-label="Settings preview"><h4>Settings</h4>' +
      item({label:'Users',key:'users',href:'#',icon:'♙',variant:'settings',selected:true}) +
      item({label:'My account',key:'account',href:'#',icon:'◇',variant:'settings'}) +
      item({label:'Sign Out',key:'sign-out',icon:'↪',variant:'settings',action:true}) +
      '</nav></div><p class="selection-accent-help">The selected background remains visible when the accent is off.</p>' +
      '<div class="selection-accent-actions"><span role="status" data-selection-accent-status></span>' +
      '<button class="button" type="button" data-selection-accent-retry hidden>Try again</button>' +
      '<button class="button" type="button" data-selection-accent-cancel>Cancel</button>' +
      '<button class="button" type="button" data-selection-accent-save>Save</button></div></section>';
    const editor = container.querySelector('.selection-accent-editor');
    const enabled = editor.querySelector('[data-selection-accent-enabled]');
    const color = editor.querySelector('[data-selection-accent-color]');
    const hex = editor.querySelector('[data-selection-accent-hex]');
    const save = editor.querySelector('[data-selection-accent-save]');
    const cancel = editor.querySelector('[data-selection-accent-cancel]');
    const retry = editor.querySelector('[data-selection-accent-retry]');
    const status = editor.querySelector('[data-selection-accent-status]');
    let statusMessage = '';
    const sync = state => {
      const busy = state.loading || state.saving || !state.loaded;
      enabled.checked = state.draft.enabled; enabled.disabled = busy;
      color.value = state.draft.color;
      if (document.activeElement !== hex || !state.draft.enabled) hex.value = state.draft.color;
      color.disabled = hex.disabled = busy || !state.draft.enabled;
      editor.querySelector('.selection-accent-colors').classList.toggle('is-disabled', color.disabled);
      const invalid = state.error.startsWith('Enter a six-digit');
      hex.setAttribute('aria-invalid', String(invalid));
      save.disabled = busy || invalid;
      cancel.disabled = state.saving;
      retry.hidden = state.loaded || state.loading;
      editor.querySelector('.selection-accent-error').textContent = state.error;
      editor.querySelectorAll('.selection-accent-preview').forEach(preview => {
        preview.style.setProperty('--navigation-tree-selection-accent-width', state.draft.enabled ? '3px' : '0px');
        preview.style.setProperty('--navigation-tree-selection-accent-color', state.draft.color);
      });
      status.textContent = state.loading ? 'Loading selection accent…' : state.saving ? 'Saving…' : statusMessage;
    };
    const onInput = event => {
      if (event.target === color) {
        hex.value = color.value; statusMessage = 'Unsaved preview'; controller.setDraft({ color: color.value });
      } else if (event.target === hex) {
        statusMessage = 'Unsaved preview'; controller.setDraft({ color: hex.value });
      }
    };
    const onChange = event => {
      if (event.target === enabled) {
        statusMessage = 'Unsaved preview'; controller.setDraft({ enabled: enabled.checked });
      }
    };
    const onClick = async event => {
      const previewItem = event.target.closest('[data-navigation-tree-item]');
      if (previewItem) {
        event.preventDefault();
        if (previewItem.tagName === 'BUTTON') { statusMessage = 'Preview only · no account action performed'; sync(controller.getState()); return; }
        window.NavigationTree.setSelection(previewItem.closest('.selection-accent-preview'), previewItem.getAttribute('data-navigation-tree-key'));
      } else if (event.target.closest('[data-selection-accent-save]')) {
        statusMessage = '';
        const saved = await controller.save();
        if (saved && editor.isConnected) { statusMessage = 'Selection accent saved'; sync(controller.getState()); }
      } else if (event.target.closest('[data-selection-accent-cancel]')) {
        statusMessage = 'Changes canceled'; controller.cancel();
      } else if (event.target.closest('[data-selection-accent-retry]')) {
        statusMessage = ''; void controller.load();
      }
    };
    editor.addEventListener('input', onInput);
    editor.addEventListener('change', onChange);
    editor.addEventListener('click', onClick);
    const unsubscribe = controller.subscribe(sync);
    sync(controller.getState());
    void controller.load();
    const cleanup = () => {
      unsubscribe();
      editor.removeEventListener('input', onInput);
      editor.removeEventListener('change', onChange);
      editor.removeEventListener('click', onClick);
      controller.cancel();
    };
    disposeEditor = cleanup;
    const release = () => { if (disposeEditor === cleanup) unmount(); };
    mountedEditor = { container, controller, editor, release };
    return release;
  }

  window.AlbumHavenSelectionAccent = { create, mount, unmount };
  if (typeof document !== 'undefined' && document.documentElement && typeof window.fetch === 'function') {
    const instance = create({ fetch: (...args) => window.fetch(...args), apply, getCsrfToken });
    window.AlbumHavenSelectionAccent.instance = instance;
    void instance.load();
  }
})();
