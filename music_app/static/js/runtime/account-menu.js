// Shared disclosure menu: action ownership remains with the rendered links/forms.
// Consumers may position the same menu inside a scrolling table or app bar.
function attachAccountMenu(component, options = {}) {
  const trigger = component.querySelector('[data-account-menu-trigger]');
  const menu = component.querySelector('[data-account-menu]');
  if (!trigger || !menu) return;
  const listeners = [];
  const on = (target, name, callback, config) => {
    target.addEventListener?.(name, callback, config);
    listeners.push(() => target.removeEventListener?.(name, callback, config));
  };
  const disabled = (item) => item.disabled || item.getAttribute('aria-disabled') === 'true';
  const enabledItems = () => Array.from(menu.querySelectorAll('[role="menuitem"]'))
    .filter((item) => !disabled(item) && !item.hidden);
  const close = (restoreFocus = false) => {
    menu.hidden = true;
    if (typeof clearTriggerAnchor === 'function') clearTriggerAnchor(menu);
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger.focus();
  };
  const position = () => {
    if (typeof options?.position === 'function') options.position(trigger, menu);
    if (typeof syncTriggerAnchor === 'function') syncTriggerAnchor(menu, trigger);
  };
  const open = (last = false, focusItem = true) => {
    if (typeof activateTriggerSurface === 'function') activateTriggerSurface(menu, () => close(false));
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    position();
    const items = enabledItems();
    if (focusItem) (last ? items[items.length - 1] : items[0])?.focus({ preventScroll: true });
  };
  on(globalThis, 'resize', () => {
    if (!menu.hidden) position();
  });
  const reject = (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  on(trigger, 'click', (event) => {
    event.preventDefault();
    if (menu.hidden) open(false, options?.focusOnPointer === true || event.detail === 0);
    else close(true);
  });
  on(menu, 'click', (event) => {
    const item = event.target?.closest?.('[role="menuitem"]');
    if (!item || !menu.contains(item)) return;
    if (disabled(item)) {
      reject(event);
      return;
    }
    // Restore the opener before Settings captures focus for its modal.
    close(true);
  }, true);
  on(component, 'keydown', (event) => {
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
    if (!items.length) return;
    const current = items.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus({ preventScroll: true });
  });
  const closeOutside = (event) => {
    if (!component.contains(event.target)) close();
  };
  on(document, 'pointerdown', closeOutside);
  on(document, 'click', closeOutside);
  on(component, 'focusout', (event) => {
    if (!component.contains(event.relatedTarget)) close();
  });
  return () => {
    close();
    listeners.forEach(dispose => dispose());
  };
}
