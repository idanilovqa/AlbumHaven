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

  // Refusals read as sentences, never as a silent no-op (owner, 11-10).
  const REFUSALS = {
    'CSRF validation failed.': 'Your session changed. Reload the page and try again.',
    'Action not permitted.': 'Preview storage can be changed only by the server owner on a computer.',
  };

  async function readJson(response) {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(REFUSALS[data?.detail] || data?.detail || 'The request could not be completed.');
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
    // Owner (11-09): the move is confirmed in the app's own dialog, never the browser's confirm().
    const confirmChange = options.confirm || (message => showAppFormDialog({
      title: 'Move album previews',
      description: message,
      submitLabel: 'Move previews',
      onSubmit: () => true,
    }).then(Boolean));
    const chooseFolder = options.chooseFolder || (settings => window.AlbumHavenPathInput.choose(settings));
    const canBrowse = Boolean(browse?.hasAttribute?.('data-path-input-browsable'));
    const setButtonDisabled = (button, disabled) => window.ButtonComponent.setDisabled(button, disabled);
    const schedule = options.setTimeout || setTimeout;
    const unschedule = options.clearTimeout || clearTimeout;
    let state = null;
    let wasActive = false;
    let pollTimer = null;
    let disposed = false;

    const selectedMode = () => custom.checked ? 'custom' : 'album_folders';
    // Owner (11-10): the choice shows where previews live now; a requested folder becomes the choice only once the
    // move has switched to it.
    const savedMode = () => String(state?.mode || 'album_folders');
    const savedPath = () => String(state?.active_root || '');
    // Save is available only for a valid, unsaved choice: a special path always needs a folder.
    const syncControls = () => {
      const locked = !state || configurationLocked(state.operation_state);
      const special = selectedMode() === 'custom';
      const path = pathInput.value.trim();
      pathInput.disabled = !special || locked;
      // The buttons render disabled with aria-disabled; the shared Button keeps both in step (UI-7).
      if (browse) setButtonDisabled(browse, !special || locked || !canBrowse);
      const changed = selectedMode() !== savedMode() || (special && path !== savedPath());
      setButtonDisabled(save, locked || !changed || (special && !path));
    };
    const syncPathControl = () => {
      // Owner (11-09, UI-8): the proposed folder is the field's value, ready to save or edit.
      if (selectedMode() === 'album_folders') pathInput.value = '';
      else if (!pathInput.value.trim()) pathInput.value = String(state?.suggested_path || '');
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
      // UI-8 (owner, 11-09): the summary separates previews moved with a fresh checksum and previews left to be
      // regenerated from real failures; it stays after the move finishes.
      const regenerateLater = Number(next.regenerate_later_count || 0);
      const rechecked = Number(next.rechecked_count || 0);
      const movement = totalCount > 0 && String(next.operation_state || 'idle') !== 'idle'
        ? [` · ${Number(next.completed_count || 0) - regenerateLater} of ${totalCount} moved`,
          rechecked ? ` · ${rechecked} re-checked` : '',
          regenerateLater ? ` · ${regenerateLater} to be regenerated` : '',
          ` · ${Number(next.failed_count || 0)} failed`].join('')
        : '';
      // Owner (11-09): the move cleans the album folders' leftover .album-haven folders and says what it left.
      const cleanup = next.cache_cleanup || {};
      const cleaned = [
        Number(cleanup.cleaned_count || 0) ? ` · cleaned up ${Number(cleanup.cleaned_count)} cache folders` : '',
        Number(cleanup.kept_count || 0) ? ` · ${Number(cleanup.kept_count)} kept (they hold other files)` : '',
        Number(cleanup.left_count || 0) ? ` · ${Number(cleanup.left_count)} left for later (drive unavailable)` : '',
      ].join('');
      counts.textContent = `${inventoryCount} previews · ${formatBytes(inventoryBytes)} stored${movement}${cleaned}`;
      // Owner (11-10): an unfinished move says so plainly instead of looking like the new folder is in use.
      const destination = next.requested_mode === 'custom' ? String(next.requested_root || 'the special path') : 'album folders';
      const failedCount = Number(next.failed_count || 0);
      // Owner (11-10): a move or retry shows live progress and ends with a readable result.
      const operationState = String(next.operation_state || 'idle');
      const done = Number(next.completed_count || 0) + failedCount;
      if (active) {
        showAlert(status, `Moving to ${destination}: ${done} of ${totalCount} files done…`);
      } else if (next.requested_mode) {
        showAlert(status, canceled
          ? `Moving to ${destination} was canceled. Previews stay where they are until the move is resumed.`
          : `Moving to ${destination}: ${failedCount} ${failedCount === 1 ? 'file' : 'files'} failed. The switch happens after they're retried.`);
      } else if (wasActive && operationState === 'completed') {
        const where = next.mode === 'custom' ? String(next.active_root || 'the special path') : 'album folders';
        showAlert(status, [`Done: switched to ${where}.`,
          regenerateLater ? ` ${regenerateLater} set to be rebuilt.` : '',
          rechecked ? ` ${rechecked} re-checked.` : ''].join(''));
      }
      wasActive = active;
      window.ButtonComponent.setBusy(retry, false);
      window.ButtonComponent.setBusy(cancel, false);
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
      if (!(await confirmChange('Move generated album previews to the selected location? Covers stay available while the move runs.'))) return;
      setButtonDisabled(save, true);
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
      if (retry.disabled) return;
      // Owner (11-10): "I clicked Retry failed files - but saw no reaction". The click shows at once.
      const failedCount = Number(state?.failed_count || 0);
      window.ButtonComponent.setBusy(retry, true);
      showAlert(status, failedCount
        ? `Retrying ${failedCount} ${failedCount === 1 ? 'file' : 'files'}…`
        : 'Resuming the move…');
      try {
        wasActive = true;
        await mutate('/admin/server/preview-storage/retry', {});
      } catch (failure) {
        window.ButtonComponent.setBusy(retry, false);
        showAlert(status);
        showAlert(error, failure.message);
      }
    });

    setButtonDisabled(save, true);
    void load();
    return () => {
      disposed = true;
      if (pollTimer !== null) unschedule(pollTimer);
    };
  };

})();
