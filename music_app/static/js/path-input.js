/* Shared server-path field: one input plus a folder-browse action, used by Library and Server settings. */
(function (scope) {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

  function render(options = {}) {
    const buttons = scope.ButtonComponent;
    const inputAttributes = Object.entries(options.inputAttributes || {})
      .filter(([name, value]) => /^(?:id|data-[a-z0-9-]+)$/.test(name) && value !== false && value != null)
      .map(([name, value]) => (value === true ? ` ${name}` : ` ${name}="${escape(value)}"`))
      .join('');
    const browse = buttons.renderActionButton({
      icon: 'folder',
      ariaLabel: options.browseLabel || 'Choose folder',
      title: options.browseLabel || 'Choose folder',
      disabled: Boolean(options.disabled || !options.canBrowse),
      // Browse permission is explicit so hosts can toggle the button without losing it.
      attributes: { 'data-path-input-browse': true, 'data-path-input-browsable': Boolean(options.canBrowse), ...(options.browseAttributes || {}) },
    });
    return `<div class="ui-path-input ui-input-action${options.className ? ` ${escape(options.className)}` : ''}"><input type="text" autocomplete="off" value="${escape(options.value || '')}" aria-label="${escape(options.ariaLabel || 'Server path')}" placeholder="${escape(options.placeholder || '')}"${options.disabled ? ' disabled' : ''}${inputAttributes}>${browse}${options.trailingHtml || ''}</div>`;
  }

  /* Browses server-side folders inside the configured bounds and resolves to the chosen path or null. */
  async function choose(options = {}) {
    const showDialog = options.showDialog || scope.showAppFormDialog;
    const request = options.request || scope.fetch?.bind(scope);
    if (typeof showDialog !== 'function' || typeof request !== 'function') throw new Error('Folder picker unavailable.');
    const read = async path => {
      const response = await request(`/library-settings/browse?path=${encodeURIComponent(path)}`, { headers: { Accept: 'application/json' } });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || data.detail || 'Unable to browse folders.');
      return data;
    };
    const buttons = scope.ButtonComponent;
    const renderListing = data => `<p>${escape(data.path || 'Choose a configured location')}</p><div class="settings-folder-list">${data.parent_path ? buttons.renderButton({ label: 'Parent folder', attributes: { 'data-folder-path': data.parent_path } }) : ''}${(data.entries || []).map(entry => buttons.renderButton({ label: entry.name, attributes: { 'data-folder-path': entry.path } })).join('')}</div>`;
    const initial = await read('');
    if (options.isCurrent && !options.isCurrent()) return null;
    let selected = '';
    let disposed = false;
    let generation = 0;
    let navigating = false;
    let cleanup = () => {};
    return showDialog({
      title: options.title || 'Choose folder',
      contentHtml: renderListing(initial),
      submitLabel: 'Choose folder',
      submitEnabled: false,
      onMount: (content, dialog) => {
        const sync = () => {
          content.setAttribute?.('aria-busy', String(navigating));
          dialog?.setSubmitEnabled(Boolean(selected) && !navigating);
        };
        const navigate = async event => {
          const button = event.target.closest('[data-folder-path]');
          if (!button) return;
          event.preventDefault();
          const requestGeneration = ++generation;
          selected = '';
          navigating = true;
          sync();
          try {
            const data = await read(button.getAttribute('data-folder-path'));
            if (disposed || requestGeneration !== generation) return;
            selected = String(data.path || '');
            content.innerHTML = renderListing(data);
          } catch (error) {
            if (!disposed && requestGeneration === generation) options.onError?.(error);
          } finally {
            if (!disposed && requestGeneration === generation) {
              navigating = false;
              sync();
            }
          }
        };
        content.addEventListener('click', navigate);
        cleanup = () => content.removeEventListener('click', navigate);
      },
      onClose: () => { disposed = true; cleanup(); },
      onSubmit: () => {
        if (navigating) throw new Error('Wait for the folder to finish loading.');
        if (!selected) throw new Error('Choose a folder first.');
        return selected;
      },
    });
  }

  const api = { render, choose };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (scope) scope.AlbumHavenPathInput = api;
})(typeof window !== 'undefined' ? window : globalThis);
