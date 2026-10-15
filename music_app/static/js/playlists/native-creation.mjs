/** Native SearchInput adapter. The production SearchInput owns clear behavior. */
export function mountCreationSearch(host, runtime, initialProps) {
  let props = initialProps, disposed = false;
  host.className = props.className || 'playlists-creation__search';
  host.innerHTML = runtime.searchHtml({id: props.id, value: props.value, disabled: props.disabled,
    label: props.label || 'Search tracks, albums or artists',
    placeholder: props.placeholder || props.label || 'Search tracks, albums or artists'});
  const input = host.querySelector('input[type="search"]');
  const onInput = event => {if (!disposed && !props.disabled && event.target === input) props.onChange?.(input.value);};
  const onKey = event => {if (event.key === 'Enter' && event.target === input) {event.preventDefault(); event.stopPropagation();}};
  const onClick = event => {if (!event.target.closest('[data-search-submit]')) return; event.preventDefault(); if (!props.disabled) input?.focus({preventScroll:true});};
  host.addEventListener('input', onInput); host.addEventListener('keydown', onKey); host.addEventListener('click', onClick);
  function update(next) {
    if (disposed) return;
    props = next; host.className = props.className || 'playlists-creation__search';
    if (!input) return;
    if (input.value !== (props.value || '')) input.value = props.value || '';
    if (Number.isSafeInteger(props.maxLength) && props.maxLength > 0) input.maxLength = props.maxLength;
    else input.removeAttribute('maxlength');
    for (const control of [input, ...host.querySelectorAll('button')]) {
      control.disabled = Boolean(props.disabled);
      if (props.disabled) control.setAttribute('aria-disabled', 'true'); else control.removeAttribute('aria-disabled');
    }
    const clear = host.querySelector('[data-search-clear]'); if (clear) clear.hidden = !props.value || Boolean(props.disabled);
  }
  update(props);
  return {element:host, update, dispose() {if (disposed) return; disposed=true; host.removeEventListener('input',onInput); host.removeEventListener('keydown',onKey); host.removeEventListener('click',onClick); host.replaceChildren();}};
}
