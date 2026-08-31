(() => {
  'use strict';

  document.querySelectorAll('[data-password-toggle]').forEach((button) => {
    button.addEventListener('click', () => {
      const input = document.getElementById(button.dataset.passwordToggle || '');
      if (!input) return;
      const reveal = input.type === 'password';
      input.type = reveal ? 'text' : 'password';
      button.textContent = reveal ? 'Hide' : 'Show';
      button.setAttribute('aria-pressed', String(reveal));
      input.focus();
    });
  });

  const form = document.querySelector('[data-admin-account-form]');
  if (!form) return;
  const error = form.parentElement?.querySelector('[data-admin-form-error]');
  const submit = form.querySelector('button[type="submit"]');
  const reauthPanel = form.querySelector('[data-reauth-panel]');
  const reauthPassword = form.querySelector('[data-reauth-password]');
  let pendingRetry = null;

  const showError = (message) => {
    if (!error) return;
    error.hidden = false;
    error.textContent = message || 'Account management is temporarily unavailable.';
  };

  const requestJson = async (url, method, payload, csrfToken) => {
    const response = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-Album-Haven-CSRF': csrfToken,
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.detail || 'Account management is temporarily unavailable.');
    }
    return response;
  };

  const requireReauthentication = (retry) => {
    if (!reauthPanel || !reauthPassword) {
      showError('Recent authentication is required. Sign in again and retry.');
      return;
    }
    pendingRetry = retry;
    reauthPanel.hidden = false;
    reauthPassword.value = '';
    reauthPassword.focus();
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }
    const data = new FormData(form);
    if (submit) submit.disabled = true;
    if (error) error.hidden = true;
    try {
      const csrfToken = String(data.get('csrf_token') || '');
      if (form.dataset.mode === 'create') {
        await requestJson('/admin/accounts', 'POST', {
          username: String(data.get('username') || ''),
          contact_email: String(data.get('contact_email') || ''),
          password: String(data.get('password') || ''),
          capability_keys: data.getAll('capability_keys').map(String),
        }, csrfToken);
        window.location.assign('/admin/members?created=1');
        return;
      }
      const accountId = String(data.get('account_id') || '');
      const isActive = data.get('is_active') === 'on';
      const hasAccess = data.get('current_library_access') === 'on';
      const confirmDisable = form.dataset.initialActive === 'true' && !isActive;
      const confirmRemoveAccess = form.dataset.initialLibraryAccess === 'true' && !hasAccess;
      if (confirmDisable && !window.confirm('Disable this account and revoke all active sessions?')) {
        if (submit) submit.disabled = false;
        return;
      }
      if (confirmRemoveAccess && !window.confirm('Remove this user from the current library?')) {
        if (submit) submit.disabled = false;
        return;
      }
      await requestJson(`/admin/accounts/${encodeURIComponent(accountId)}`, 'PATCH', {
        is_active: isActive,
        current_library_access: hasAccess,
        capability_keys: data.getAll('capability_keys').map(String),
        confirm_disable: confirmDisable,
        confirm_remove_access: confirmRemoveAccess,
      }, csrfToken);
      window.location.assign('/admin/members');
    } catch (requestError) {
      if (requestError.message === 'Recent authentication is required.') {
        requireReauthentication(() => form.requestSubmit());
        if (submit) submit.disabled = false;
        return;
      }
      showError(requestError.message);
      if (submit) submit.disabled = false;
    }
  });

  form.querySelectorAll?.('[data-admin-action]')?.forEach((button) => {
    button.addEventListener('click', async () => {
      const action = button.dataset.adminAction;
      if (action === 'toggle-active') {
        const checkbox = form.querySelector('[name="is_active"]');
        if (checkbox) checkbox.checked = !checkbox.checked;
        form.requestSubmit();
        return;
      }
      if (action === 'reset') {
        showError('Password-reset delivery will be available after mail actions are configured.');
        return;
      }
      if (action !== 'revoke' || !window.confirm('Revoke every active session for this user?')) return;
      const data = new FormData(form);
      const accountId = String(data.get('account_id') || '');
      button.disabled = true;
      try {
        await requestJson(
          `/admin/accounts/${encodeURIComponent(accountId)}/sessions/revoke`,
          'POST',
          { confirmed: true },
          String(data.get('csrf_token') || ''),
        );
        window.location.assign(`/admin/accounts/${encodeURIComponent(accountId)}`);
      } catch (requestError) {
        if (requestError.message === 'Recent authentication is required.') {
          requireReauthentication(() => button.click());
          button.disabled = false;
          return;
        }
        showError(requestError.message);
        button.disabled = false;
      }
    });
  });

  form.querySelector('[data-reauth-cancel]')?.addEventListener('click', () => {
    pendingRetry = null;
    if (reauthPassword) reauthPassword.value = '';
    if (reauthPanel) reauthPanel.hidden = true;
  });

  form.querySelector('[data-reauth-submit]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const password = reauthPassword?.value || '';
    if (!password) {
      reauthPassword?.focus();
      return;
    }
    const data = new FormData(form);
    button.disabled = true;
    try {
      await requestJson(
        '/admin/reauthenticate',
        'POST',
        { password },
        String(data.get('csrf_token') || ''),
      );
      reauthPassword.value = '';
      reauthPanel.hidden = true;
      const retry = pendingRetry;
      pendingRetry = null;
      retry?.();
    } catch (requestError) {
      showError(requestError.message);
    } finally {
      button.disabled = false;
    }
  });
})();
