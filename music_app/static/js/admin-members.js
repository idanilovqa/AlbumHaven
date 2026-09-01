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

  const roster = document.querySelector('[data-admin-roster]');
  const rosterStatus = roster?.querySelector('[data-admin-roster-status]');
  const rosterError = roster?.querySelector('[data-admin-roster-error]');
  const fallback = roster?.querySelector('[data-invitation-copy-fallback]');
  const fallbackValue = roster?.querySelector('[data-invitation-copy-value]');
  const rosterReauthPanel = roster?.querySelector('[data-roster-reauth-panel]');
  const rosterReauthPassword = roster?.querySelector('[data-roster-reauth-password]');
  let rosterRetry = null;

  const announceRoster = (message) => {
    if (!rosterStatus) return;
    rosterStatus.textContent = message;
    rosterStatus.hidden = false;
  };

  const showRosterError = (message) => {
    if (!rosterError) return;
    rosterError.textContent = message;
    rosterError.hidden = false;
  };

  const clearInvitationFallback = () => {
    if (fallbackValue) fallbackValue.value = '';
    if (fallback) fallback.hidden = true;
  };

  const showInvitationFallback = (url) => {
    if (!fallback || !fallbackValue) return;
    fallbackValue.value = url;
    fallback.hidden = false;
    fallbackValue.focus();
    fallbackValue.select();
  };

  const rosterRequest = (url, payload = {}) => fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'X-Album-Haven-CSRF': roster?.dataset.csrfToken || '',
    },
    body: JSON.stringify(payload),
  });

  const reauthenticateRosterThen = (retry) => {
    rosterRetry = retry;
    if (rosterReauthPanel) rosterReauthPanel.hidden = false;
    if (rosterReauthPassword) {
      rosterReauthPassword.value = '';
      rosterReauthPassword.focus();
    }
  };

  const closeMenu = (trigger, menu) => {
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  };

  for (const trigger of document.querySelectorAll('[data-member-menu-trigger]')) {
    const accountId = trigger.dataset.memberMenuTrigger;
    if (!accountId) continue;
    const menu = document.querySelector(`[data-member-menu="${accountId}"]`);
    if (!menu) continue;
    trigger.addEventListener('click', () => {
      const opening = menu.hidden;
      menu.hidden = !opening;
      trigger.setAttribute('aria-expanded', String(opening));
      if (opening) menu.querySelector('[role="menuitem"]')?.focus();
    });
    menu.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeMenu(trigger, menu);
        trigger.focus();
      }
    });
    menu.addEventListener('focusout', (event) => {
      if (!menu.contains(event.relatedTarget) && event.relatedTarget !== trigger) {
        closeMenu(trigger, menu);
      }
    });
  }

  document.addEventListener?.('pointerdown', (event) => {
    for (const menu of document.querySelectorAll('[data-member-menu]:not([hidden])')) {
      const accountId = menu.dataset.memberMenu;
      const trigger = document.querySelector(
        `[data-member-menu-trigger="${accountId}"]`,
      );
      if (
        trigger
        && !menu.contains(event.target)
        && !trigger.contains(event.target)
      ) closeMenu(trigger, menu);
    }
  });

  const copyInvitation = async (accountId, allowReauthentication = true) => {
    const response = await rosterRequest(
      `/admin/accounts/${encodeURIComponent(accountId)}/invitation/copy`,
    );
    if (response.status === 409 && allowReauthentication) {
      reauthenticateRosterThen(() => copyInvitation(accountId, false));
      return;
    }
    if (!response.ok) throw new Error('Invitation link could not be created.');
    const result = await response.json();
    clearInvitationFallback();
    try {
      await navigator.clipboard.writeText(result.invitation_url);
      announceRoster('Invitation link copied. Older links no longer work.');
    } catch {
      showInvitationFallback(result.invitation_url);
    }
  };

  const sendInvitation = async (accountId, allowReauthentication = true) => {
    const response = await rosterRequest(
      `/admin/accounts/${encodeURIComponent(accountId)}/invitation/send`,
    );
    if (response.status === 409 && allowReauthentication) {
      reauthenticateRosterThen(() => sendInvitation(accountId, false));
      return;
    }
    if (!response.ok) throw new Error('Invitation email could not be queued.');
    announceRoster('Invitation email queued. Older invitation links no longer work.');
  };

  for (const button of document.querySelectorAll('[data-copy-invitation]')) {
    const accountId = button.dataset.copyInvitation;
    if (!accountId) continue;
    button.addEventListener('click', () => copyInvitation(accountId).catch(
      (error) => showRosterError(error.message),
    ));
  }
  for (const button of document.querySelectorAll('[data-send-invitation]')) {
    const accountId = button.dataset.sendInvitation;
    if (!accountId) continue;
    button.addEventListener('click', () => sendInvitation(accountId).catch(
      (error) => showRosterError(error.message),
    ));
  }

  roster?.querySelector('[data-invitation-copy-dismiss]')?.addEventListener(
    'click', clearInvitationFallback,
  );
  roster?.querySelector('[data-invitation-copy-manual]')?.addEventListener(
    'click', async () => {
      if (!fallbackValue) return;
      try {
        await navigator.clipboard.writeText(fallbackValue.value);
        announceRoster('Invitation link copied.');
      } catch {
        fallbackValue.focus();
        fallbackValue.select();
      }
    },
  );
  roster?.querySelector('[data-roster-reauth-cancel]')?.addEventListener(
    'click', () => {
      rosterRetry = null;
      if (rosterReauthPanel) rosterReauthPanel.hidden = true;
    },
  );
  roster?.querySelector('[data-roster-reauth-submit]')?.addEventListener(
    'click', async () => {
      try {
        const response = await rosterRequest('/admin/reauthenticate', {
          password: rosterReauthPassword?.value || '',
        });
        if (!response.ok) throw new Error('Reauthentication failed.');
        if (rosterReauthPanel) rosterReauthPanel.hidden = true;
        const retry = rosterRetry;
        rosterRetry = null;
        await retry?.();
      } catch (error) {
        showRosterError(error.message);
      }
    },
  );

  const form = document.querySelector('[data-admin-account-form]');
  if (!form) return;
  const error = form.parentElement?.querySelector('[data-admin-form-error]');
  const status = form.parentElement?.querySelector('[data-admin-form-status]');
  const submit = form.querySelector('button[type="submit"]');
  const reauthPanel = form.querySelector('[data-reauth-panel]');
  const reauthPassword = form.querySelector('[data-reauth-password]');
  let pendingRetry = null;

  const showError = (message) => {
    if (!error) return;
    error.hidden = false;
    error.textContent = message || 'Account management is temporarily unavailable.';
  };

  const showStatus = (message) => {
    if (!status) return;
    status.hidden = false;
    status.textContent = message;
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
          username: form.elements.username.value,
          contact_email: form.elements.contact_email.value,
          capability_keys: data.getAll('capability_keys').map(String),
          send_invitation: form.elements.send_invitation.checked,
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
      if (action === 'reset' || action === 'welcome') {
        const data = new FormData(form);
        const accountId = String(data.get('account_id') || '');
        const endpoint = action === 'reset' ? 'password-reset' : 'welcome';
        button.disabled = true;
        if (error) error.hidden = true;
        if (status) status.hidden = true;
        try {
          await requestJson(
            `/admin/accounts/${encodeURIComponent(accountId)}/${endpoint}`,
            'POST',
            {},
            String(data.get('csrf_token') || ''),
          );
          showStatus(action === 'reset'
            ? 'If delivery is available, a password reset email has been queued.'
            : 'If delivery is available, a welcome email has been queued.');
        } catch (requestError) {
          if (requestError.message === 'Recent authentication is required.') {
            requireReauthentication(() => button.click());
            return;
          }
          showError(requestError.message);
        } finally {
          button.disabled = false;
        }
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
