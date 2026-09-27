(() => {
  'use strict';

  function bindCapabilityAssignment(form) {
    const editor = form.querySelector('[data-capability-assignment]');
    if (!editor) return null;
    const roleInputs = [...editor.querySelectorAll('[name="role_keys"]')];
    const inputs = [...form.querySelectorAll('input[type="checkbox"][name="capability_keys"], input[type="checkbox"][name="additional_capability_keys"]')];
    const direct = new Set(inputs.filter((input) => input.dataset.explicitGrant === 'true'
      || input.dataset.explicitGrant === undefined && input.checked).map((input) => input.value));
    editor.querySelectorAll('input[type="hidden"][name="additional_capability_keys"]').forEach((input) => direct.add(input.value));
    const summary = editor.querySelector('[data-role-summary]');
    const rolesOnly = editor.querySelector('[data-roles-only]');
    let newUserDefaults = form.dataset.mode === 'create';
    const selectedRoles = () => roleInputs.filter((input) => input.checked);
    const sync = () => {
      const selected = selectedRoles();
      const inherited = new Set(selected.flatMap((input) => JSON.parse(input.dataset.roleGrants)));
      for (const input of inputs) {
        input.checked = direct.has(input.value) || inherited.has(input.value);
        input.disabled = inherited.has(input.value);
        input.title = inherited.has(input.value) ? 'Included by a selected role' : '';
      }
      if (rolesOnly) rolesOnly.disabled = selected.length === 0;
      if (summary) summary.textContent = selected.length
        ? `Assigned roles: ${selected.map((input) => input.dataset.roleLabel).join(' + ')}. ${direct.size} explicit grants.`
        : `No named roles. ${direct.size} explicit grants.`;
    };
    for (const input of inputs) input.addEventListener('change', () => {
      newUserDefaults = false;
      if (input.disabled) return;
      if (input.checked) direct.add(input.value); else direct.delete(input.value);
      sync();
    });
    for (const input of roleInputs) input.addEventListener('change', () => {
      if (newUserDefaults && selectedRoles().length) { direct.clear(); newUserDefaults = false; }
      sync();
    });
    rolesOnly?.addEventListener('click', () => { direct.clear(); newUserDefaults = false; sync(); });
    sync();
    return { capabilityKeys: () => [...direct].sort(), roleKeys: () => selectedRoles().map((input) => input.value) };
  }


  function mount(root, options = {}) {
  const document = root;
  let active = true;
  let disposeMemberMenus = () => {};
  let removePlacementListeners = () => {};
  const requests = typeof AbortController === 'undefined' ? null : new AbortController();
  const nativeFetch = globalThis.fetch;
  const fetch = (url, init) => nativeFetch(url, { ...init, ...(requests ? { signal: requests.signal } : {}) });
  const cleanup = () => { active = false; requests?.abort(); disposeMemberMenus(); removePlacementListeners(); };
  const navigate = (url) => {
    if (!active) return Promise.resolve(false);
    return options.navigate ? options.navigate(url) : window.location.assign(url);
  };

  document.querySelectorAll('[data-password-toggle]').forEach((button) => {
    button.addEventListener('click', () => {
      const input = document.getElementById
        ? document.getElementById(button.dataset.passwordToggle || '')
        : document.querySelector(`[id="${button.dataset.passwordToggle || ''}"]`);
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
  let fallbackAccountId = null;
  const pendingInvitationAccounts = new Set();

  const setInvitationBusy = (accountId, busy) => {
    if (busy) pendingInvitationAccounts.add(accountId);
    else pendingInvitationAccounts.delete(accountId);
    for (const [selector, key] of [['[data-copy-invitation]', 'copyInvitation'], ['[data-send-invitation]', 'sendInvitation']]) {
      for (const button of document.querySelectorAll(selector)) {
        if (button.dataset[key] === accountId) button.disabled = busy;
      }
    }
  };

  const finishInvitationAction = async (accountId, action) => {
    try { await action(); }
    finally { setInvitationBusy(accountId, false); }
  };

  const runInvitationAction = (accountId, action) => {
    if (!active || pendingInvitationAccounts.has(accountId)) return Promise.resolve();
    setInvitationBusy(accountId, true);
    return finishInvitationAction(accountId, action);
  };

  const announceRoster = (message) => {
    if (!rosterStatus) return;
    rosterStatus.querySelector('.on-page-alert__message').textContent = message;
    rosterStatus.hidden = false;
  };

  const showRosterError = (message) => {
    if (!rosterError) return;
    rosterError.querySelector('.on-page-alert__message').textContent = message;
    rosterError.hidden = false;
  };

  const clearInvitationFallback = () => {
    fallbackAccountId = null;
    if (fallbackValue) fallbackValue.value = '';
    if (fallback) fallback.hidden = true;
  };

  const showInvitationFallback = (url, accountId) => {
    if (!fallback || !fallbackValue) return;
    fallbackAccountId = accountId;
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

  const closeMenu = (trigger, menu) => {
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (typeof clearTriggerAnchor === 'function') clearTriggerAnchor(menu);
  };

  const positionMenu = (trigger, menu) => {
    const anchor = trigger.getBoundingClientRect();
    const host = trigger.closest?.('.settings-outlet') || trigger.closest?.('[data-settings-host]');
    const bounds = host?.getBoundingClientRect() || {
      left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight,
    };
    const left = Math.max(8, bounds.left + 8);
    const top = Math.max(8, bounds.top + 8);
    const right = Math.min(window.innerWidth - 8, bounds.right - 8);
    const bottom = Math.min(window.innerHeight - 8, bounds.bottom - 8);
    menu.style.maxWidth = `${Math.max(0, right - left)}px`;
    menu.style.maxHeight = `${Math.max(0, bottom - top)}px`;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(left, Math.min(anchor.right - rect.width, right - rect.width))}px`;
    const preferredTop = anchor.bottom + 5 + rect.height <= bottom
      ? anchor.bottom + 5 : anchor.top - rect.height - 5;
    menu.style.top = `${Math.max(top, Math.min(preferredTop, bottom - rect.height))}px`;
  };

  const closeMenuForAction = (accountId) => {
    const trigger = document.querySelector(
      `[data-member-menu-trigger="${accountId}"]`,
    );
    const menu = document.querySelector(`[data-member-menu="${accountId}"]`);
    if (!trigger || !menu) return;
    closeMenu(trigger, menu);
    trigger.focus();
  };

  const validatedInvitationUrl = (value) => {
    if (typeof value !== 'string' || !value || value !== value.trim()) {
      throw new Error('Invitation link could not be created.');
    }
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error('Invitation link could not be created.');
    }
    const purpose = parsed.searchParams.getAll('purpose');
    const tokens = parsed.searchParams.getAll('token');
    const queryKeys = [...parsed.searchParams.keys()];
    const expectedKeys = queryKeys.every(
      (key) => key === 'purpose' || key === 'token',
    );
    if (
      !['http:', 'https:'].includes(parsed.protocol)
      || !parsed.hostname
      || parsed.username
      || parsed.password
      || parsed.hash
      || parsed.pathname !== '/accept-invitation'
      || purpose.length !== 1
      || purpose[0] !== 'account-invitation'
      || tokens.length !== 1
      || !/^[A-Za-z0-9_-]{43}$/.test(tokens[0])
      || queryKeys.length !== 2
      || !expectedKeys
    ) {
      throw new Error('Invitation link could not be created.');
    }
    return value;
  };

  const memberMenuCleanups = [];
  for (const component of document.querySelectorAll('.member-actions[data-account-menu-component]')) {
    memberMenuCleanups.push(attachAccountMenu(component, { position: positionMenu, focusOnPointer: true }));
  }
  disposeMemberMenus = () => memberMenuCleanups.forEach(dispose => dispose?.());
  const closeOnLayoutChange = (event) => {
    for (const menu of document.querySelectorAll('[data-member-menu]:not([hidden])')) {
      if (event?.type === 'scroll' && menu.contains(event.target)) continue;
      const trigger = document.querySelector(`[data-member-menu-trigger="${menu.dataset.memberMenu}"]`);
      if (trigger) closeMenu(trigger, menu);
    }
  };
  window.addEventListener?.('scroll', closeOnLayoutChange, true);
  window.addEventListener?.('resize', closeOnLayoutChange);
  removePlacementListeners = () => {
    closeOnLayoutChange();
    window.removeEventListener?.('scroll', closeOnLayoutChange, true);
    window.removeEventListener?.('resize', closeOnLayoutChange);
  };

  const copyInvitation = async (accountId) => {
    const response = await rosterRequest(
      `/admin/accounts/${encodeURIComponent(accountId)}/invitation/copy`,
    );
    if (!response.ok) throw new Error('Invitation link could not be created.');
    const result = await response.json().catch(() => null);
    const invitationUrl = validatedInvitationUrl(result?.invitation_url);
    clearInvitationFallback();
    try {
      await navigator.clipboard.writeText(invitationUrl);
      announceRoster('Invitation link copied. Older links no longer work.');
    } catch {
      showInvitationFallback(invitationUrl, accountId);
    }
  };

  const sendInvitation = async (accountId) => {
    const response = await rosterRequest(
      `/admin/accounts/${encodeURIComponent(accountId)}/invitation/send`,
    );
    if (!response.ok) throw new Error('Invitation email could not be queued.');
    if (fallbackAccountId === accountId) clearInvitationFallback();
    announceRoster('Invitation email queued. Older invitation links no longer work.');
  };

  for (const button of document.querySelectorAll('[data-copy-invitation]')) {
    const accountId = button.dataset.copyInvitation;
    if (!accountId) continue;
    button.addEventListener('click', () => {
      closeMenuForAction(accountId);
      return runInvitationAction(accountId, () => copyInvitation(accountId)).catch(
        (error) => showRosterError(error.message),
      );
    });
  }
  for (const button of document.querySelectorAll('[data-send-invitation]')) {
    const accountId = button.dataset.sendInvitation;
    if (!accountId) continue;
    button.addEventListener('click', () => {
      closeMenuForAction(accountId);
      return runInvitationAction(accountId, () => sendInvitation(accountId)).catch(
        (error) => showRosterError(error.message),
      );
    });
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
  const form = document.querySelector('[data-admin-account-form]');
  if (!form) return cleanup;
  const assignment = bindCapabilityAssignment(form);
  const error = form.parentElement?.querySelector('[data-admin-form-error]');
  const status = form.parentElement?.querySelector('[data-admin-form-status]');
  const submit = form.querySelector('button[type="submit"]');
  let completedDestination = null;

  const showError = (message) => {
    if (!error) return;
    error.hidden = false;
    error.querySelector('.on-page-alert__message').textContent = message || 'Account management is temporarily unavailable.';
  };

  const showStatus = (message) => {
    if (!status) return;
    status.hidden = false;
    status.querySelector('.on-page-alert__message').textContent = message;
  };

  const navigateAfterMutation = async (destination, button) => {
    if (button) button.disabled = true;
    try {
      if (await navigate(destination) !== false) return;
    } catch {
      // The mutation succeeded. Only the destination read may be retried.
    }
    if (!active) return;
    showStatus('Changes saved. The next page could not be loaded. Retry navigation to continue.');
    if (button) {
      button.disabled = false;
      (button.querySelector?.('.ui-button__content') || button).textContent = 'Retry navigation';
      button.formNoValidate = true;
    }
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
    if (response.status === 401) {
      window.location.assign('/login');
      throw new Error('Session expired. Sign in again.');
    }
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.detail || 'Account management is temporarily unavailable.');
    }
    return response;
  };

  form.addEventListener('change', () => { if (status) status.hidden = true; });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submit?.disabled) return;
    if (completedDestination) {
      await navigateAfterMutation(completedDestination, submit);
      return;
    }
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }
    const data = new FormData(form);
    if (status) status.hidden = true;
    if (submit) submit.disabled = true;
    if (error) error.hidden = true;
    try {
      const csrfToken = String(data.get('csrf_token') || '');
      if (form.dataset.mode === 'create') {
        await requestJson('/admin/accounts', 'POST', {
          username: form.elements.username.value,
          contact_email: form.elements.contact_email.value,
          capability_keys: assignment ? assignment.capabilityKeys() : data.getAll('capability_keys').map(String),
          send_invitation: form.elements.send_invitation.checked,
          ...(assignment ? { role_keys: assignment.roleKeys() } : {}),
        }, csrfToken);
        completedDestination = '/admin/members?created=1';
        await navigateAfterMutation(completedDestination, submit);
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
      const response = await requestJson(`/admin/accounts/${encodeURIComponent(accountId)}`, 'PATCH', {
        is_active: isActive,
        current_library_access: hasAccess,
        capability_keys: assignment ? assignment.capabilityKeys() : data.getAll('capability_keys').map(String),
        confirm_disable: confirmDisable,
        confirm_remove_access: confirmRemoveAccess,
        ...(assignment ? { role_keys: assignment.roleKeys(), access_revision: String(data.get('access_revision') || '') } : {}),
      }, csrfToken);
      const saved = await response.json();
      if (!active) return;
      const revision = form.querySelector('[name="access_revision"]');
      if (assignment && (!revision || !/^[a-f0-9]{64}$/.test(saved.access_revision || ''))) {
        throw new Error('Changes were saved, but the access revision could not be refreshed. Reload this user before editing again.');
      }
      if (revision) revision.value = saved.access_revision;
      form.dataset.initialActive = String(isActive);
      form.dataset.initialLibraryAccess = String(hasAccess);
      const toggle = form.querySelector('[data-admin-action="toggle-active"]');
      if (toggle) (toggle.querySelector?.('.ui-button__content') || toggle).textContent = isActive ? 'Disable account' : 'Enable account';
      showStatus('Changes saved.');
      if (submit) submit.disabled = false;
    } catch (requestError) {
      showError(requestError.message);
      if (submit) submit.disabled = false;
    }
  });

  form.querySelectorAll?.('[data-admin-action]')?.forEach((button) => {
    let completedActionDestination = null;
    button.addEventListener('click', async () => {
      if (completedActionDestination) {
        await navigateAfterMutation(completedActionDestination, button);
        return;
      }
      const action = button.dataset.adminAction;
      if (action === 'toggle-active') {
        const checkbox = form.querySelector('[name="is_active"]');
        if (checkbox) checkbox.checked = form.dataset.initialActive !== 'true';
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
        completedActionDestination = `/admin/accounts/${encodeURIComponent(accountId)}`;
        await navigateAfterMutation(completedActionDestination, button);
      } catch (requestError) {
        showError(requestError.message);
        button.disabled = false;
      }
    });
  });

  return cleanup;
  }
  window.AlbumHavenMountAdmin = mount;
  window.AlbumHavenBindCapabilityAssignment = bindCapabilityAssignment;
  // The Settings controller owns mounting in the shared host.
  if (!document.querySelector('[data-settings-host]')) mount(document);
})();
