(() => {
  // Standalone Settings documents own their app-bar menu; the library runtime attaches its own.
  const accountMenu = document.querySelector('.shell-app-bar [data-account-menu-component]');
  if (accountMenu && !document.getElementById('app-shell') && typeof attachAccountMenu === 'function') attachAccountMenu(accountMenu);
  const ACTIVE_STATES = new Set(['queued', 'running', 'cancel_requested']);

  const configurationLocked = operationState => {
    const value = String(operationState || 'idle');
    return ACTIVE_STATES.has(value) || value === 'canceled';
  };

  const messageTarget = alert => alert?.querySelector?.('.on-page-alert__message') || alert;

  const showAlert = (alert, message = '') => {
    if (!alert) return;
    messageTarget(alert).textContent = message;
    alert.hidden = !message;
  };

  const formatBytes = value => {
    const bytes = Math.max(0, Number(value || 0));
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  };

  async function readJson(response) {
    const data = await response.json();
    if (!response.ok) throw new Error(data?.detail || 'The request could not be completed.');
    return data;
  }

  window.AlbumHavenMountAdminServer = function mountAdminServer(root = document, options = {}) {
    const form = root.querySelector('[data-admin-server]');
    if (!form) return () => {};
    const modes = [...form.querySelectorAll('[data-preview-mode]')];
    const albumFolders = form.querySelector('[data-preview-mode="album_folders"]');
    const custom = form.querySelector('[data-preview-mode="custom"]');
    const pathInput = form.querySelector('[data-preview-path]');
    const save = form.querySelector('[data-preview-save]');
    const cancel = form.querySelector('[data-preview-cancel]');
    const retry = form.querySelector('[data-preview-retry]');
    const status = form.querySelector('[data-preview-status]');
    const error = form.querySelector('[data-preview-error]');
    const counts = form.querySelector('[data-preview-counts]');
    const browse = form.querySelector('[data-path-input-browse]');
    const failure = form.querySelector('[data-preview-failure]');
    const request = options.request || fetch;
    const confirmChange = options.confirm || window.confirm.bind(window);
    const chooseFolder = options.chooseFolder || (settings => window.AlbumHavenPathInput.choose(settings));
    const canBrowse = Boolean(browse?.hasAttribute?.('data-path-input-browsable'));
    const schedule = options.setTimeout || setTimeout;
    const unschedule = options.clearTimeout || clearTimeout;
    let state = null;
    let pollTimer = null;
    let disposed = false;

    const selectedMode = () => custom.checked ? 'custom' : 'album_folders';
    const savedMode = () => String(state?.requested_mode || state?.mode || 'album_folders');
    const savedPath = () => String(state?.requested_root || state?.active_root || '');
    // Save is available only for a valid, unsaved choice: a special path always needs a folder.
    const syncControls = () => {
      const locked = !state || configurationLocked(state.operation_state);
      const special = selectedMode() === 'custom';
      const path = pathInput.value.trim();
      pathInput.disabled = !special || locked;
      if (browse) browse.disabled = !special || locked || !canBrowse;
      const changed = selectedMode() !== savedMode() || (special && path !== savedPath());
      save.disabled = locked || !changed || (special && !path);
    };
    const syncPathControl = () => {
      if (selectedMode() === 'album_folders') pathInput.value = '';
      pathInput.placeholder = String(state?.suggested_path || '');
      syncControls();
    };

    const schedulePoll = () => {
      if (pollTimer !== null) unschedule(pollTimer);
      pollTimer = null;
      if (!disposed && state && ACTIVE_STATES.has(String(state.operation_state || 'idle'))) {
        pollTimer = schedule(load, 2000);
      }
    };

    const render = next => {
      state = next;
      const mode = savedMode();
      albumFolders.checked = mode === 'album_folders';
      custom.checked = mode === 'custom';
      pathInput.value = mode === 'custom' ? savedPath() : '';
      const active = ACTIVE_STATES.has(String(next.operation_state || 'idle'));
      const locked = configurationLocked(next.operation_state);
      modes.forEach(control => { control.disabled = locked; });
      cancel.hidden = !active;
      const canceled = String(next.operation_state || 'idle') === 'canceled';
      retry.hidden = !((Number(next.failed_count || 0) > 0 || canceled) && !active);
      retry.textContent = canceled ? 'Resume move' : 'Retry failed files';
      const inventoryCount = Number(next.inventory_count ?? next.total_count ?? 0);
      const inventoryBytes = Number(next.inventory_bytes ?? next.total_bytes ?? 0);
      const totalCount = Number(next.total_count || 0);
      const movement = totalCount > 0 && (active || canceled || Number(next.failed_count || 0) > 0)
        ? ` · ${Number(next.completed_count || 0)} of ${totalCount} moved · ${Number(next.failed_count || 0)} failed`
        : '';
      counts.textContent = `${inventoryCount} previews · ${formatBytes(inventoryBytes)} stored${movement}`;
      counts.hidden = false;
      const failures = Array.isArray(next.failure_summary) ? next.failure_summary : [];
      const lastFailure = failures.at(-1);
      failure.textContent = lastFailure?.error ? `Last failure: ${lastFailure.error}` : '';
      failure.hidden = !failure.textContent;
      syncPathControl();
      schedulePoll();
    };

    async function load() {
      try {
        const response = await request('/admin/server/preview-storage', { headers: { Accept: 'application/json' } });
        render(await readJson(response));
        showAlert(error);
      } catch (failure) {
        showAlert(error, failure.message);
        schedulePoll();
      }
    }

    const mutate = async (url, body) => {
      showAlert(error);
      const response = await request(url, {
        method: url.endsWith('/preview-storage') ? 'PUT' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Album-Haven-CSRF': String(form.dataset.csrfToken || ''),
        },
        body: JSON.stringify(body),
      });
      const next = await readJson(response);
      render(next);
      return next;
    };

    modes.forEach(control => control.addEventListener('change', syncPathControl));
    pathInput.addEventListener('input', syncControls);
    browse?.addEventListener('click', async event => {
      event.preventDefault?.();
      if (browse.disabled) return;
      try {
        const chosen = await chooseFolder({
          title: 'Choose server folder',
          isCurrent: () => !disposed,
          onError: failure => showAlert(error, failure.message),
        });
        if (!chosen || disposed) return;
        pathInput.value = chosen;
        syncControls();
      } catch (failure) {
        if (!disposed) showAlert(error, failure.message || 'Folder picker unavailable.');
      }
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (save.disabled) return;
      const mode = selectedMode();
      if (!confirmChange('Move generated album previews to the selected location? Covers remain available while the move runs.')) return;
      save.disabled = true;
      try {
        const next = await mutate('/admin/server/preview-storage', {
          mode,
          path: mode === 'custom' ? pathInput.value.trim() : '',
          expected_revision: Number(state.revision),
          confirmed: true,
        });
        showAlert(status, next.unchanged ? 'Preview storage is unchanged.' : 'Preview relocation started.');
      } catch (failure) {
        showAlert(error, failure.message);
        syncControls();
      }
    });
    cancel.addEventListener('click', async () => {
      try {
        await mutate('/admin/server/preview-storage/cancel', {});
        showAlert(status, 'Cancellation requested. The current file will finish safely.');
      } catch (failure) {
        showAlert(error, failure.message);
      }
    });
    retry.addEventListener('click', async () => {
      try {
        await mutate('/admin/server/preview-storage/retry', {});
        showAlert(status, 'Failed preview files were queued again.');
      } catch (failure) {
        showAlert(error, failure.message);
      }
    });

    save.disabled = true;
    void load();
    return () => {
      disposed = true;
      if (pollTimer !== null) unschedule(pollTimer);
    };
  };

})();
