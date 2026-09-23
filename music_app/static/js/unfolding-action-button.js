(function (scope) {
  'use strict';
  const instances = new WeakMap();
  function mount(root, options = {}) {
    if (instances.has(root)) {
      const instance = instances.get(root);
      instance.configure(options);
      return instance;
    }
    const buttons = Array.from(root.querySelectorAll('button'));
    if (!buttons.length) throw new TypeError('UnfoldingActionButton requires actions.');
    let config = options;
    let selected = buttons.find(button => button.classList.contains('is-active')) || buttons[0];
    let expanded = false;
    root.classList.add('unfolding-action-button');
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', options.label || 'Actions');
    buttons.forEach(button => {
      button.classList.add('action-button', 'unfolding-action-button__action');
    });
    function sync() {
      root.classList.toggle('is-open', expanded);
      root.style.setProperty('--unfolding-action-count', buttons.length);
      buttons.forEach(button => {
        const active = button === selected;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', String(active));
        button.setAttribute('aria-expanded', String(expanded));
        button.tabIndex = !button.disabled && (expanded || active) ? 0 : -1;
        button.setAttribute('aria-hidden', String(!expanded && !active));
      });
    }
    function close(returnFocus = false) {
      expanded = false;
      sync();
      if (returnFocus) selected.focus();
    }
    function open(keyboard = false) {
      expanded = true;
      sync();
      if (keyboard) (buttons.find(button => button !== selected && !button.disabled) || selected).focus();
    }
    function click(event) {
      const button = event.target.closest('button');
      if (!buttons.includes(button) || button.disabled) return;
      event.preventDefault();
      event.stopPropagation();
      if (!expanded) { open(event.detail === 0); return; }
      selected = button;
      close(true);
      config.onSelect?.(button.dataset.actionValue, button);
    }
    function keydown(event) {
      if (event.key === 'Escape' && expanded) {
        event.preventDefault(); event.stopPropagation(); close(true); return;
      }
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      if (!expanded) open();
      const enabled = buttons.filter(button => !button.disabled);
      const index = enabled.indexOf(root.ownerDocument.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + enabled.length) % enabled.length;
      enabled[next]?.focus();
    }
    function outside(event) { if (!root.contains(event.target)) close(); }
    function focusout(event) { if (!root.contains(event.relatedTarget)) close(); }
    root.addEventListener('click', click);
    root.addEventListener('keydown', keydown);
    root.addEventListener('focusout', focusout);
    root.ownerDocument.addEventListener('pointerdown', outside);
    const api = {
      open, close,
      configure(next) { config = next; },
      select(value) {
        const choice = buttons.find(button => button.dataset.actionValue === value);
        if (choice) { selected = choice; sync(); }
      },
      destroy() {
        root.removeEventListener('click', click);
        root.removeEventListener('keydown', keydown);
        root.removeEventListener('focusout', focusout);
        root.ownerDocument.removeEventListener('pointerdown', outside);
        instances.delete(root);
      },
    };
    instances.set(root, api);
    sync();
    return api;
  }
  function render(options = {}) {
    const buttonComponent = scope?.ButtonComponent || require('./button-component.js');
    const actions = options.actions || [];
    if (!actions.length) throw new TypeError('UnfoldingActionButton requires actions.');
    return '<div class="unfolding-action-button">' + actions.map((action, index) =>
      buttonComponent.renderActionButton({ ...action,
        className: 'unfolding-action-button__action' + (action.value === options.value || (!options.value && index === 0) ? ' is-active' : ''),
        attributes: { ...action.attributes, 'data-action-value': action.value },
      })).join('') + '</div>';
  }
  const api = { mount, render };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (scope) scope.UnfoldingActionButton = api;
})(typeof window !== 'undefined' ? window : null);
