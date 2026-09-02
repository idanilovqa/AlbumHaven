(() => {
  'use strict';

  document.querySelectorAll('[data-password-toggle]').forEach((button) => {
    button.addEventListener('click', () => {
      const input = document.getElementById(button.dataset.passwordToggle || '');
      if (!input) return;
      const revealing = input.type === 'password';
      input.type = revealing ? 'text' : 'password';
      button.textContent = revealing ? 'Hide' : 'Show';
      button.setAttribute('aria-pressed', String(revealing));
      input.focus();
    });
  });

  const form = document.querySelector('[data-password-form]');
  if (!form) return;
  const password = form.querySelector('[name="new_password"]');
  const confirmation = form.querySelector('[name="confirm_password"]');
  const error = form.querySelector('[data-password-match-error]');

  const validateMatch = () => {
    if (!password || !confirmation || !error) return true;
    const matches = password.value === confirmation.value;
    confirmation.setCustomValidity(matches ? '' : 'Passwords do not match.');
    error.textContent = matches ? '' : 'Passwords do not match.';
    return matches;
  };

  confirmation?.addEventListener('input', validateMatch);
  password?.addEventListener('input', () => {
    if (confirmation?.value) validateMatch();
  });
  form.addEventListener('submit', (event) => {
    if (!validateMatch()) event.preventDefault();
  });
})();
