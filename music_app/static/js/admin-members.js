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

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }
    if (form.dataset.mode !== 'create') {
      if (error) {
        error.hidden = false;
        error.textContent = 'No changes were saved. Choose a specific account action.';
      }
      return;
    }
    const data = new FormData(form);
    const payload = {
      username: String(data.get('username') || ''),
      contact_email: String(data.get('contact_email') || ''),
      password: String(data.get('password') || ''),
      capability_keys: data.getAll('capability_keys').map(String),
    };
    if (submit) submit.disabled = true;
    if (error) error.hidden = true;
    try {
      const response = await fetch('/admin/accounts', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-Album-Haven-CSRF': String(data.get('csrf_token') || ''),
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.detail || 'Account creation is temporarily unavailable.');
      }
      window.location.assign('/admin/members?created=1');
    } catch (requestError) {
      if (error) {
        error.hidden = false;
        error.textContent = requestError.message || 'Account creation is temporarily unavailable.';
      }
      if (submit) submit.disabled = false;
    }
  });
})();
