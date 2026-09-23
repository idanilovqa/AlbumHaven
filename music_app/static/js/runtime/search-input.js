function updateSearchClearAction(input) {
  const clear = input?.closest?.('.search-field-control')?.querySelector?.('[data-search-clear]');
  if (clear) clear.hidden = !input.value || input.disabled || input.readOnly;
}

document.addEventListener('input', (event) => {
  if (event.target?.matches?.('.search-field input[type="search"]')) {
    updateSearchClearAction(event.target);
  }
});

document.addEventListener('click', (event) => {
  const clear = event.target?.closest?.('[data-search-clear]');
  if (!clear) return;
  const input = clear.closest('.search-field-control')?.querySelector('input[type="search"]');
  if (!input) return;
  input.value = '';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
});

document.querySelectorAll('.search-field input[type="search"]').forEach(updateSearchClearAction);
