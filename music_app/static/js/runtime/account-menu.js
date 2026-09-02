// Shared disclosure menu: action ownership remains with the rendered links/forms.
function attachAccountMenu(component) {
  const trigger = component.querySelector('[data-account-menu-trigger]');
  const menu = component.querySelector('[data-account-menu]');
  if (!trigger || !menu) return;
  const disabled = (item) => item.disabled || item.getAttribute('aria-disabled') === 'true';
  const enabledItems = () => Array.from(menu.querySelectorAll('[role="menuitem"]')).filter((item) => !disabled(item));
  const close = (restoreFocus = false) => {
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger.focus();
  };
  const open = (last = false) => {
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    const items = enabledItems();
    (last ? items[items.length - 1] : items[0])?.focus();
  };
  const reject = (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  trigger.addEventListener('click', (event) => {
    event.preventDefault();
    if (menu.hidden) open();
    else close(true);
  });
  menu.addEventListener('click', (event) => {
    const item = event.target?.closest?.('[role="menuitem"]');
    if (!item || !menu.contains(item)) return;
    if (disabled(item)) {
      reject(event);
      return;
    }
    // Restore the opener before Settings captures focus for its modal.
    close(true);
  }, true);
  component.addEventListener('keydown', (event) => {
    const item = event.target?.closest?.('[role="menuitem"]');
    if (item && disabled(item) && ['Enter', ' ', 'Spacebar'].includes(event.key)) {
      reject(event);
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.target === trigger && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      open(event.key === 'ArrowUp');
      return;
    }
    if (menu.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = enabledItems();
    const current = items.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  });
  document.addEventListener('click', (event) => {
    if (!component.contains(event.target)) close();
  });
  component.addEventListener('focusout', (event) => {
    if (!component.contains(event.relatedTarget)) close();
  });
}
