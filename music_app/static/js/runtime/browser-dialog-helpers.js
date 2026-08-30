function getBrowserDialogTarget() {
  try {
    return window || null;
  } catch (_error) {
    return null;
  }
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
