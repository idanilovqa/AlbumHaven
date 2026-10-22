(() => {
  const ACTIVE_STATES = new Set(['queued', 'running', 'cancel_requested']);

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
    const progress = form.querySelector('[data-preview-progress]');
    const counts = form.querySelector('[data-preview-counts]');
    const location = form.querySelector('[data-preview-location]');
    const failure = form.querySelector('[data-preview-failure]');
    const request = options.request || fetch;
    const confirmChange = options.confirm || window.confirm.bind(window);
    const schedule = options.setTimeout || setTimeout;
    const unschedule = options.clearTimeout || clearTimeout;
    let state = null;
    let pollTimer = null;
    let disposed = false;

    const selectedMode = () => custom.checked ? 'custom' : 'album_folders';
    const syncPathControl = () => {
      const active = state && ACTIVE_STATES.has(String(state.operation_state || 'idle'));
      const unresolved = active || Boolean(state?.requested_mode);
      pathInput.disabled = selectedMode() !== 'custom' || unresolved;
      pathInput.required = selectedMode() === 'custom';
      if (selectedMode() === 'album_folders') {
        pathInput.value = '';
      } else if (!pathInput.value) {
        pathInput.value = String(state?.suggested_path || '');
      }
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
      const mode = String(next.requested_mode || next.mode || 'album_folders');
      albumFolders.checked = mode === 'album_folders';
      custom.checked = mode === 'custom';
      pathInput.value = String(next.requested_root || next.active_root || '');
      const active = ACTIVE_STATES.has(String(next.operation_state || 'idle'));
      const unresolved = active || Boolean(next.requested_mode);
      modes.forEach(control => { control.disabled = unresolved; });
      save.disabled = unresolved;
      cancel.hidden = !active;
      const canceled = String(next.operation_state || 'idle') === 'canceled';
      retry.hidden = !((Number(next.failed_count || 0) > 0 || canceled) && !active);
      retry.textContent = canceled ? 'Resume move' : 'Retry failed files';
      progress.max = Math.max(1, Number(next.total_count || 0));
      progress.value = Math.min(progress.max, Number(next.completed_count || 0));
      counts.textContent = `${Number(next.completed_count || 0)} of ${Number(next.total_count || 0)} previews moved · ${formatBytes(next.total_bytes)} estimated · ${Number(next.failed_count || 0)} failed`;
      const failures = Array.isArray(next.failure_summary) ? next.failure_summary : [];
      const lastFailure = failures.at(-1);
      failure.textContent = lastFailure?.error ? `Last failure: ${lastFailure.error}` : '';
      failure.hidden = !failure.textContent;
      location.textContent = mode === 'custom'
        ? String(next.active_root || next.requested_root || 'Special server path')
        : 'Album folders';
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
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const mode = selectedMode();
      if (mode === 'custom' && !pathInput.value.trim()) {
        showAlert(error, 'Enter a path on the Album Haven server.');
        pathInput.focus?.();
        return;
      }
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
        save.disabled = false;
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
