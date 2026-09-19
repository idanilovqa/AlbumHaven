function getBrowserDialogTarget() {
  try {
    return window || null;
  } catch (_error) {
    return null;
  }
}

let activeAppFormDialog = null;
function showAppFormDialog(options = {}) {
  if (activeAppFormDialog) return activeAppFormDialog.promise;
  const get = name => document.getElementById(`app-form-${name}`);
  const modal = get('modal'), title = get('title'), content = get('content'), error = get('error'), cancel = get('cancel'), submit = get('submit');
  if (!modal || !title || !content || !error || !cancel || !submit) return Promise.resolve(null);
  const previousFocus = document.activeElement;
  const anchor = options.anchor;
  const anchoredPanel = anchor ? modal.querySelector('.confirm-modal-dialog') : null;
  const listeners = [];
  let positionObserver = null;
  const listen = (node, name, handler) => { node.addEventListener(name, handler); listeners.push([node, name, handler]); };
  let resolve; const promise = new Promise(done => { resolve = done; });
  const owner = { promise }; activeAppFormDialog = owner;
  let submitEnabled = options.submitEnabled !== false, submitting = false;
  const syncSubmit = () => { if (activeAppFormDialog === owner) submit.disabled = submitting || !submitEnabled; };
  const controls = { setSubmitEnabled(value) {
    if (activeAppFormDialog !== owner) return;
    submitEnabled = Boolean(value); syncSubmit();
  } };
  const finish = value => {
    if (activeAppFormDialog !== owner) return;
    listeners.forEach(([node, name, handler]) => node.removeEventListener(name, handler));
    positionObserver?.disconnect();
    options.onClose?.(content);
    if (anchoredPanel) { clearTriggerAnchor(anchoredPanel); anchoredPanel.removeAttribute('style'); anchoredPanel.setAttribute('aria-modal', 'true'); modal.classList.remove('app-form-anchored'); }
    modal.classList?.remove('app-form-reading'); submit.hidden = false;
    modal.hidden = true; content.innerHTML = ''; activeAppFormDialog = null;
    resolve(value); previousFocus?.focus?.({ preventScroll: true });
  };
  const apply = async event => {
    event?.preventDefault?.();
    if (submit.disabled || options.mode === 'reading') return;
    submitting = true; syncSubmit(); error.textContent = '';
    try { const result = await options.onSubmit?.(content); if (activeAppFormDialog === owner) finish(result ?? true); }
    catch (failure) { if (activeAppFormDialog === owner) error.textContent = failure.message || 'Unable to apply changes.'; }
    finally { submitting = false; syncSubmit(); }
  };
  title.textContent = options.title || 'Settings'; content.innerHTML = options.contentHtml || ''; error.textContent = '';
  submit.textContent = options.submitLabel || 'Apply'; syncSubmit(); cancel.textContent = options.cancelLabel || 'Cancel';
  submit.hidden = options.mode === 'reading'; cancel.hidden = false;
  if (options.mode === 'reading') { cancel.textContent = 'Close'; modal.classList?.add('app-form-reading'); }
  modal.hidden = false; modal.style.zIndex = '125';
  modal.querySelector?.('.confirm-modal-dialog')?.removeAttribute('hidden');
  if (anchoredPanel) {
    const boundaryElement = anchor.closest?.('.utility-modal-dialog');
    const position = () => {
      if (activeAppFormDialog !== owner || modal.hidden) return;
      const rect = anchor.getBoundingClientRect();
      const searchField = boundaryElement && anchor.closest?.('.search-field-control');
      const searchRect = searchField?.getBoundingClientRect();
      const joinedTop = searchRect ? searchRect.bottom - 1 : rect.bottom + 4;
      const boundary = boundaryElement?.getBoundingClientRect();
      const left = Math.max(8, Math.min(window.innerWidth - 16, Number(boundary?.left || 0) + 8));
      const right = Math.max(left + 1, Math.min(window.innerWidth - 8, Number(boundary?.right || window.innerWidth) - 8));
      const bottom = Math.max(9, Math.min(window.innerHeight - 8, Number(boundary?.bottom || window.innerHeight) - 8));
      const width = Math.min(440, right - left);
      const top = Math.max(8, Math.min(joinedTop, Math.max(8, bottom - 240)));
      const panelLeft = searchRect
        ? Math.max(left, Math.min(searchRect.left, right - width))
        : Math.max(left, Math.min(rect.right - width, right - width));
      anchoredPanel.style.position = 'fixed'; anchoredPanel.style.left = `${panelLeft}px`; anchoredPanel.style.top = `${top}px`;
      anchoredPanel.style.width = `${width}px`; anchoredPanel.style.maxHeight = `${bottom - top}px`;
      syncTriggerAnchor(anchoredPanel, anchor);
    };
    modal.classList.add('app-form-anchored'); anchoredPanel.setAttribute('aria-modal', 'false');
    position();
    if (typeof window.addEventListener === 'function') listen(window, 'resize', position);
    if (window.visualViewport?.addEventListener) listen(window.visualViewport, 'resize', position);
    if (typeof ResizeObserver === 'function') {
      positionObserver = new ResizeObserver(position);
      positionObserver.observe(anchor);
      if (boundaryElement) positionObserver.observe(boundaryElement);
    }
  }
  if (typeof bindOverlayPointerOrigin === 'function') bindOverlayPointerOrigin(modal);
  listen(cancel, 'click', () => finish(null)); listen(submit, 'click', apply);
  listen(modal, 'keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(null); return; }
    if (event.key !== 'Tab') return;
    const controls = [...content.querySelectorAll('input, button, textarea, [tabindex="0"]'), cancel, submit].filter(node => !node.disabled && !node.hidden);
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  listen(modal, 'click', event => { if (typeof overlayClickStartedOnOverlay === 'function' && overlayClickStartedOnOverlay(modal, event)) finish(null); });
  options.onMount?.(content, controls);
  (content.querySelectorAll('input, button, textarea, [tabindex="0"]')[0] || cancel).focus();
  return promise;
}

function showBrowserAlert(message) {
  const target = getBrowserDialogTarget();
  if (typeof target?.alert !== 'function') return false;
  target.alert(String(message || ''));
  return true;
}

function showBrowserPrompt(message, defaultValue = '') {
  const target = getBrowserDialogTarget();
  if (typeof target?.prompt !== 'function') return null;
  return target.prompt(String(message || ''), String(defaultValue || ''));
}

function showBrowserConfirm(message) {
  const target = getBrowserDialogTarget();
  if (typeof target?.confirm !== 'function') return false;
  return Boolean(target.confirm(String(message || '')));
}

let activeAppConfirmDialog = null;

function showAppConfirmDialog(options = {}) {
  if (activeAppConfirmDialog) return activeAppConfirmDialog.promise;
  if (typeof document === 'undefined') return Promise.resolve(false);
  const modal = document.getElementById('app-confirm-modal');
  const title = document.getElementById('app-confirm-title');
  const text = document.getElementById('app-confirm-text');
  const cancelButton = document.getElementById('app-confirm-cancel');
  const acceptButton = document.getElementById('app-confirm-accept');
  if (!modal || !title || !text || !cancelButton || !acceptButton) return Promise.resolve(false);

  const previousFocus = document.activeElement;
  const listeners = [];
  const listen = (element, name, handler) => {
    element?.addEventListener?.(name, handler);
    listeners.push([element, name, handler]);
  };
  let resolveDialog;
  const promise = new Promise(resolve => { resolveDialog = resolve; });
  activeAppConfirmDialog = { promise };
  const finish = accepted => {
    if (activeAppConfirmDialog?.promise !== promise) return;
    listeners.forEach(([element, name, handler]) => element?.removeEventListener?.(name, handler));
    modal.hidden = true;
    activeAppConfirmDialog = null;
    resolveDialog(Boolean(accepted));
    previousFocus?.focus?.();
  };
  const handleKeydown = event => {
    if (event?.key === 'Escape') {
      event.preventDefault?.();
      event.stopPropagation?.();
      finish(false);
      return;
    }
    if (event?.key !== 'Tab') return;
    if (event.shiftKey && document.activeElement === cancelButton) {
      event.preventDefault?.(); acceptButton.focus?.();
    } else if (!event.shiftKey && document.activeElement === acceptButton) {
      event.preventDefault?.(); cancelButton.focus?.();
    }
  };
  const handleBackdropClick = event => {
    if (typeof overlayClickStartedOnOverlay === 'function' && overlayClickStartedOnOverlay(modal, event)) finish(false);
  };
  if (typeof bindOverlayPointerOrigin === 'function') bindOverlayPointerOrigin(modal);
  listen(cancelButton, 'click', () => finish(false));
  listen(acceptButton, 'click', () => finish(true));
  listen(modal, 'keydown', handleKeydown);
  listen(modal, 'click', handleBackdropClick);
  title.textContent = String(options.title || 'Confirm action');
  text.textContent = String(options.message || 'Continue?');
  cancelButton.textContent = String(options.cancelLabel || 'Cancel');
  acceptButton.textContent = String(options.acceptLabel || 'Continue');
  acceptButton.classList?.toggle?.('confirm-modal-danger', Boolean(options.danger));
  modal.style.zIndex = '140';
  modal.hidden = false;
  document.body?.classList?.add?.('modal-open');
  cancelButton.focus?.();
  return promise;
}

let activeLoopNameDialog = null;

function showLoopNameDialog(options = {}) {
  if (activeLoopNameDialog) return activeLoopNameDialog.promise;
  if (typeof document === 'undefined') return Promise.resolve(null);

  const modal = document.getElementById('loop-name-modal');
  const form = document.getElementById('loop-name-form');
  const title = document.getElementById('loop-name-title');
  const description = document.getElementById('loop-name-description');
  const input = document.getElementById('loop-name-input');
  const error = document.getElementById('loop-name-error');
  const cancelButton = document.getElementById('loop-name-cancel');
  const submitButton = document.getElementById('loop-name-submit');
  if (!modal || !input || !error || !cancelButton || !submitButton) {
    return Promise.resolve(null);
  }

  const previousFocus = document.activeElement;
  const listeners = [];
  const listen = (element, name, handler) => {
    element?.addEventListener?.(name, handler);
    listeners.push([element, name, handler]);
  };
  const setError = (message = '') => {
    error.textContent = message;
    error.hidden = !message;
    if (message) input.setAttribute?.('aria-invalid', 'true');
    else input.removeAttribute?.('aria-invalid');
  };

  let resolveDialog;
  const promise = new Promise((resolve) => {
    resolveDialog = resolve;
  });
  activeLoopNameDialog = { promise };

  const finish = (value) => {
    if (activeLoopNameDialog?.promise !== promise) return;
    listeners.forEach(([element, name, handler]) => {
      element?.removeEventListener?.(name, handler);
    });
    modal.hidden = true;
    activeLoopNameDialog = null;
    resolveDialog(value);
    previousFocus?.focus?.();
  };
  const submit = (event) => {
    event?.preventDefault?.();
    const name = String(input.value || '').trim();
    if (!name) {
      setError('A loop name is required.');
      input.focus?.();
      return;
    }
    finish(name);
  };
  const handleKeydown = (event) => {
    if (event?.key === 'Escape') {
      event.preventDefault?.();
      finish(null);
      return;
    }
    if (event?.key === 'Tab') {
      const focusable = [input, cancelButton, submitButton].filter((element) => element && !element.hidden && !element.disabled);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault?.();
        last.focus?.();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault?.();
        first.focus?.();
      }
      return;
    }
    if (event?.key === 'Enter' && !form) submit(event);
  };

  listen(form, 'submit', submit);
  listen(submitButton, 'click', submit);
  listen(cancelButton, 'click', () => finish(null));
  listen(input, 'input', () => setError(''));
  listen(modal, 'keydown', handleKeydown);

  if (title) title.textContent = String(options.title || 'Save loop');
  if (description) description.textContent = String(options.description || 'Enter a name for this loop.');
  submitButton.textContent = String(options.submitLabel || 'Save loop');
  input.value = String(options.defaultValue || '');
  input.setAttribute?.('placeholder', String(options.placeholder || ''));
  setError('');
  modal.hidden = false;
  input.focus?.();
  input.select?.();

  return promise;
}

let activeLoopDeleteConfirmDialog = null;

function showLoopDeleteConfirmDialog(loopName = '') {
  if (activeLoopDeleteConfirmDialog) return activeLoopDeleteConfirmDialog.promise;
  if (typeof document === 'undefined') return Promise.resolve(false);

  const modal = document.getElementById('loop-delete-confirm-modal');
  const text = document.getElementById('loop-delete-confirm-text');
  const cancelButton = document.getElementById('loop-delete-confirm-cancel');
  const acceptButton = document.getElementById('loop-delete-confirm-accept');
  if (!modal || !text || !cancelButton || !acceptButton) return Promise.resolve(false);

  const previousFocus = document.activeElement;
  const listeners = [];
  const listen = (element, name, handler) => {
    element?.addEventListener?.(name, handler);
    listeners.push([element, name, handler]);
  };
  let resolveDialog;
  const promise = new Promise((resolve) => {
    resolveDialog = resolve;
  });
  activeLoopDeleteConfirmDialog = { promise };

  const finish = (accepted) => {
    if (activeLoopDeleteConfirmDialog?.promise !== promise) return;
    listeners.forEach(([element, name, handler]) => {
      element?.removeEventListener?.(name, handler);
    });
    modal.hidden = true;
    activeLoopDeleteConfirmDialog = null;
    resolveDialog(Boolean(accepted));
    previousFocus?.focus?.();
  };
  const handleKeydown = (event) => {
    if (event?.key === 'Escape') {
      event.preventDefault?.();
      event.stopPropagation?.();
      finish(false);
      return;
    }
    if (event?.key !== 'Tab') return;
    if (event.shiftKey && document.activeElement === cancelButton) {
      event.preventDefault?.();
      acceptButton.focus?.();
    } else if (!event.shiftKey && document.activeElement === acceptButton) {
      event.preventDefault?.();
      cancelButton.focus?.();
    }
  };
  const handleBackdropClick = (event) => {
    if (overlayClickStartedOnOverlay(modal, event)) finish(false);
  };

  bindOverlayPointerOrigin(modal);
  listen(cancelButton, 'click', () => finish(false));
  listen(acceptButton, 'click', () => finish(true));
  listen(modal, 'keydown', handleKeydown);
  listen(modal, 'click', handleBackdropClick);

  const name = String(loopName || 'this loop');
  text.textContent = `Remove "${name}"? This will delete the saved loop file.`;
  modal.style.zIndex = '125';
  modal.hidden = false;
  document.body?.classList?.add?.('modal-open');
  cancelButton.focus?.();
  return promise;
}
