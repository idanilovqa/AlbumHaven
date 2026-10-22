// Client consumers render the same inert server macro as the global Search.
// The existing input/clear handlers below remain its sole behavior owner.
function buildSearchInputHtml({id, value = '', disabled = false, label = 'Search', placeholder = 'Search'} = {}) {
  if (typeof id !== 'string' || !/^[A-Za-z][A-Za-z0-9_:.-]*$/.test(id) || id === 'search-input') {
    throw new TypeError('A distinct native Search field identity is required.');
  }
  const template = document.getElementById('native-search-field-template');
  if (!template) throw new Error('The native Search template is unavailable.');
  const holder = document.createElement('div'); holder.innerHTML = template.innerHTML;
  const field = holder.firstElementChild, input = field?.querySelector('input[type="search"]');
  if (!input) throw new Error('The native Search template is invalid.');
  input.setAttribute('id', id); input.removeAttribute('name');
  input.setAttribute('value', typeof value === 'string' ? value : '');
  input.setAttribute('aria-label', String(label)); input.setAttribute('placeholder', String(placeholder));
  for (const element of [input, ...field.querySelectorAll('button')]) {
    if (disabled === true) {element.setAttribute('disabled', ''); element.setAttribute('aria-disabled', 'true');}
    else {element.removeAttribute('disabled'); element.removeAttribute('aria-disabled');}
  }
  const submit = field.querySelector('[data-search-submit]');
  if (submit) {submit.setAttribute('type', 'button'); submit.setAttribute('aria-label', String(label)); submit.setAttribute('title', String(label));}
  const clear = field.querySelector('[data-search-clear]');
  if (clear) {
    if (!value || disabled === true) clear.setAttribute('hidden', '');
    else clear.removeAttribute('hidden');
  }
  return field.outerHTML;
}

function updateSearchClearAction(input) {
  const clear = input?.closest?.('.search-field-control')?.querySelector?.('[data-search-clear]');
  if (clear) clear.hidden = !input.value || input.disabled || input.readOnly;
  if (input?.id === 'search-input' && typeof syncMobileSearchQueryIndicator === 'function') syncMobileSearchQueryIndicator();
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
