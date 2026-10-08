function getBrowserDialogTarget() {
  try {
    return window || null;
  } catch (_error) {
    return null;
  }
}

let activeAppFormDialog = null;
let appFormSequence = 0;
function appFormScopeIdentity() {
  const shell = document.getElementById('app-shell'), home = document.getElementById('mobile-home');
  return JSON.stringify([shell?.dataset?.nativeAccountId ?? home?.dataset?.homeAccountId ?? '',
    shell?.dataset?.nativeLibraryId ?? home?.dataset?.homeLibraryId ?? '']);
}
function getActiveAppFormPage() {
  return activeAppFormDialog?.pageId && activeAppFormDialog.isActive() ? activeAppFormDialog : null;
}
function showAppFormDialog(options = {}) {
  if (typeof isMobileFormReturning === 'function' && isMobileFormReturning()) return Promise.resolve(null);
  if (activeAppFormDialog) {
    const active = activeAppFormDialog;
    if (options.anchor && active.anchor === options.anchor) active.dismiss('cancel');
    return active.promise;
  }
  const get = name => document.getElementById(`app-form-${name}`);
  const modal = get('modal'), title = get('title'), content = get('content'), error = get('error'), cancel = get('cancel'), submit = get('submit');
  if (!modal || !title || !content || !error || !cancel || !submit) return Promise.resolve(null);
  const previousFocus = document.activeElement;
  // Parent ownership belongs here, alongside native dismissal and focus. A
  // request form can retain the one drawer without another overlay or trap.
  const parentSelectors = ['#cover-lookup-drawer', '#track-modal', '#non-album-modal', '[data-resource-selection-content="album"]'];
  const parentSurface = parentSelectors.includes(options.parentSurface) ? document.querySelector(options.parentSurface) : null;
  const parent = parentSurface && !parentSurface.hidden ? parentSurface : null;
  const parentInert = parent?.inert;
  const previousLayer = modal.style.zIndex;
  const containParentClick = event => event.stopPropagation();
  const anchor = options.anchor;
  const contentOwnsFooter = options.contentOwnsFooter === true;
  const footer = contentOwnsFooter ? cancel.closest?.('.confirm-modal-actions') : null;
  const footerHidden = footer?.hidden;
  const contentTabIndex = contentOwnsFooter ? content.getAttribute('tabindex') : null;
  const anchoredPanel = anchor ? modal.querySelector('.confirm-modal-dialog') : null;
  const listeners = [];
  let positionObserver = null, focusObserver = null;
  const listen = (node, name, handler) => { node.addEventListener(name, handler); listeners.push([node, name, handler]); };
  let resolve; const promise = new Promise(done => { resolve = done; });
  const pageId = typeof options.pageId === 'string' && options.pageId.trim() ? options.pageId : null;
  const sequence = ++appFormSequence, scope = appFormScopeIdentity();
  const token = `app-form-${Date.now().toString(36)}-${sequence}-${Math.random().toString(36).slice(2)}`;
  const owner = { promise, anchor, pageId, token, title: options.title || 'Settings' }; activeAppFormDialog = owner;
  const guarded = typeof options.beforeDismiss === 'function';
  const contentInert = content.inert;
  let submitEnabled = options.submitEnabled !== false, submitting = false, finishing = false, dismissal = null;
  const syncSubmit = () => {
    if (activeAppFormDialog !== owner) return;
    submit.disabled = submitting || Boolean(dismissal) || !submitEnabled;
    cancel.disabled = Boolean(dismissal) || (guarded && submitting);
    if (guarded) content.inert = Boolean(dismissal) || contentInert;
  };
  const controls = { setSubmitEnabled(value) {
    if (activeAppFormDialog !== owner) return;
    submitEnabled = Boolean(value); syncSubmit();
  }, close: (value, closeOptions = {}) => guarded && closeOptions.force !== true
    ? requestDismiss(closeOptions.reason || 'cancel', closeOptions, value)
    : finish(value ?? null, closeOptions), dismiss: (reason, closeOptions) => requestDismiss(reason, closeOptions) };
  const finish = (value, {restoreFocus = true, updateHistory = true, returnToParent = true} = {}) => {
    if (activeAppFormDialog !== owner || finishing) return false;
    finishing = true;
    modal.hidden = true;
    listeners.forEach(([node, name, handler]) => node.removeEventListener(name, handler));
    positionObserver?.disconnect();
    focusObserver?.disconnect();
    let navigation = null, completion;
    const settled = (returned = true) => {
      const current = returned !== false && owner.isCurrentContext();
      try { options.onAfterClose?.(content, {restoreFocus, returnToParent, current}); }
      finally {
        resolve(current ? value : null);
        if (restoreFocus && current && owner.isCurrentContext() && !activeAppFormDialog) {
          const available = node => Boolean(node) && node.isConnected !== false && !node.disabled
            && node.getAttribute?.('aria-disabled') !== 'true' && !node.closest?.('[hidden], [inert]');
          const fallback = options.returnFocus?.() || (parent?.id === 'cover-lookup-drawer' ? document.querySelector?.('#cover-lookup-drawer [data-close-cover-lookup-drawer]') : null);
          const target = available(previousFocus) ? previousFocus : available(fallback) ? fallback
            : parent?.id === 'cover-lookup-drawer' ? document.getElementById('cover-lookup-drawer-button') : null;
          if (available(target)) target?.focus?.({preventScroll: true});
        }
      }
      return current;
    };
    try {
      if (activeAppConfirmDialog?.formOwner === owner) activeAppConfirmDialog.cancel({restoreFocus: false});
      if (pageId && typeof retireMobileAppFormPage === 'function') {
        navigation = retireMobileAppFormPage(owner.token, {restoreFocus, updateHistory, returnToParent, isCurrent: owner.isCurrentContext,
          retainParentView: options.retainParentView});
      }
      options.onClose?.(content, {restoreFocus});
    }
    finally {
      if (contentOwnsFooter) {
        if (footer) footer.hidden = footerHidden;
        if (contentTabIndex === null) content.removeAttribute('tabindex');
        else content.setAttribute('tabindex', contentTabIndex);
        cancel.hidden = false;
      }
      if (anchoredPanel) { clearTriggerAnchor(anchoredPanel); anchoredPanel.removeAttribute('style'); anchoredPanel.setAttribute('aria-modal', 'true'); modal.classList.remove('app-form-anchored'); }
      modal.classList?.remove('app-form-reading'); submit.hidden = false;
      content.inert = contentInert; cancel.disabled = false;
      content.innerHTML = ''; activeAppFormDialog = null;
      modal.style.zIndex = previousLayer;
      if (parent) {
        parent.inert = parentInert;
        // A content action may close before the click reaches this modal. Keep
        // containment through that event so the drawer does not close as an
        // unrelated outside click, then release only this form's listener.
        window.setTimeout(() => modal.removeEventListener('click', containParentClick), 0);
        if (parent.id === 'cover-lookup-drawer' && !returnToParent && owner.isCurrentContext() && typeof closeNotificationDrawer === 'function') closeNotificationDrawer();
      }
      completion = navigation ? Promise.resolve(navigation).then(settled) : settled();
    }
    return completion;
  };
  const requestDismiss = (reason = 'cancel', closeOptions = {}, value = null) => {
    if (activeAppFormDialog !== owner || finishing || (guarded && submitting)) return Promise.resolve(false);
    if (dismissal) return dismissal;
    if (!guarded) return Promise.resolve(finish(value ?? null, closeOptions));
    const dismissFocus = document.activeElement;
    // Defer the callback until the shared pending token is installed. Reentrant
    // clicks, Back and Escape all await this exact decision.
    dismissal = Promise.resolve().then(() => owner.isActive() && owner.isCurrentContext() ? options.beforeDismiss(reason) : false)
      .catch(() => false).then(accepted => {
      if (owner.isActive() && !owner.isCurrentContext()) {
        finish(null, {restoreFocus: false, returnToParent: false}); return false;
      }
      if (activeAppFormDialog !== owner || finishing || accepted !== true) return false;
      return finish(value ?? null, closeOptions);
    }).finally(() => {
      dismissal = null; syncSubmit();
      if (activeAppFormDialog === owner && !activeAppConfirmDialog && dismissFocus?.isConnected !== false
        && !dismissFocus?.closest?.('[hidden], [inert]')) dismissFocus?.focus?.({preventScroll: true});
    });
    syncSubmit();
    return dismissal;
  };
  owner.close = controls.close;
  owner.dismiss = controls.dismiss;
  owner.isActive = () => activeAppFormDialog === owner && !finishing;
  owner.isCurrentContext = () => appFormSequence === sequence && appFormScopeIdentity() === scope;
  const apply = async event => {
    event?.preventDefault?.();
    if (submit.disabled || dismissal || options.mode === 'reading') return;
    submitting = true; syncSubmit(); error.textContent = '';
    try { const result = await options.onSubmit?.(content); if (activeAppFormDialog === owner) finish(result ?? true); }
    catch (failure) { if (activeAppFormDialog === owner) error.textContent = failure.message || 'Unable to apply changes.'; }
    finally { submitting = false; syncSubmit(); }
  };
  title.textContent = options.title || 'Settings'; content.innerHTML = options.contentHtml || ''; error.textContent = '';
  submit.textContent = options.submitLabel || 'Apply'; syncSubmit(); cancel.textContent = options.cancelLabel || 'Cancel';
  submit.hidden = contentOwnsFooter || options.mode === 'reading'; cancel.hidden = contentOwnsFooter;
  if (footer) footer.hidden = true;
  if (contentOwnsFooter) content.setAttribute('tabindex', '-1');
  if (options.mode === 'reading') { cancel.textContent = 'Close'; modal.classList?.add('app-form-reading'); }
  modal.hidden = false; modal.style.zIndex = '125';
  if (parent) {
    const layer = typeof getComputedStyle === 'function' ? Number(getComputedStyle(parent).zIndex) : 135;
    modal.style.zIndex = String(Math.max(125, Number.isFinite(layer) ? layer : 135) + 1);
    parent.inert = true;
    modal.addEventListener('click', containParentClick);
  }
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
      const pageBottom = boundaryElement?.closest?.('.is-mobile-page')
        ? document.querySelector('.global-player')?.getBoundingClientRect().top || window.innerHeight
        : boundary?.bottom || window.innerHeight;
      const bottom = Math.max(9, Math.min(window.innerHeight - 8, Number(pageBottom) - 8));
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
    if (typeof activateTriggerSurface === 'function') activateTriggerSurface(anchoredPanel, () => requestDismiss('replace'));
    position();
    listen(document, 'pointerdown', event => {
      if (!anchoredPanel.contains(event.target) && !anchor.contains(event.target)) requestDismiss('overlay');
    });
    if (typeof window.addEventListener === 'function') listen(window, 'resize', position);
    if (window.visualViewport?.addEventListener) listen(window.visualViewport, 'resize', position);
    if (typeof ResizeObserver === 'function') {
      positionObserver = new ResizeObserver(position);
      positionObserver.observe(anchor);
      if (boundaryElement) positionObserver.observe(boundaryElement);
    }
  }
  if (typeof bindOverlayPointerOrigin === 'function') bindOverlayPointerOrigin(modal);
  listen(cancel, 'click', () => requestDismiss('cancel')); listen(submit, 'click', apply);
  const contentControls = () => [...content.querySelectorAll('input, button, textarea, select, a[href], [tabindex="0"]')]
    .filter(node => !node.disabled && !node.hidden && node.type !== 'hidden'
      && !node.closest?.('[hidden], [inert]') && (!node.getClientRects || node.getClientRects().length));
  listen(modal, 'keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); return requestDismiss('escape'); }
    if (event.key !== 'Tab') return;
    if (modal.classList?.contains?.('is-mobile-page')) return;
    const controls = contentOwnsFooter ? contentControls()
      : [...content.querySelectorAll('input, button, textarea, [tabindex="0"]'), cancel, submit].filter(node => !node.disabled && !node.hidden);
    if (contentOwnsFooter && (!controls.length || !controls.includes(document.activeElement))) {
      event.preventDefault(); (event.shiftKey ? controls[controls.length - 1] || content : controls[0] || content).focus(); return;
    }
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  listen(modal, 'click', event => {
    if (parent) event.stopPropagation();
    if (!modal.classList?.contains?.('is-mobile-page') && typeof overlayClickStartedOnOverlay === 'function'
      && overlayClickStartedOnOverlay(modal, event)) return requestDismiss('overlay');
  });
  try {
    if (pageId && typeof presentMobileAppFormPage === 'function') presentMobileAppFormPage(owner);
    options.onMount?.(content, controls);
  } catch (error) { finish(null, {returnToParent: Boolean(parent)}); throw error; }
  if (activeAppFormDialog !== owner) return promise;
  if (contentOwnsFooter) {
    const focusContent = () => (contentControls()[0] || content).focus();
    focusContent();
    // React portals may commit after onMount returns. The native owner transfers
    // initial focus when controls arrive, without stealing it after interaction.
    if (typeof MutationObserver === 'function') {
      focusObserver = new MutationObserver(() => {
        if (activeAppFormDialog === owner && document.activeElement === content) focusContent();
      });
      focusObserver.observe(content, {childList: true, subtree: true});
    }
  } else (content.querySelectorAll('input, button, textarea, [tabindex="0"]')[0] || cancel).focus();
  return promise;
}

function openReactFormDialog({title, pageId, beforeDismiss, onMount, onClose, parentSurface, returnFocus, retainParentView, contentOwnsFooter = true} = {}, isAvailable = () => true) {
  if (!isAvailable() || typeof showAppFormDialog !== 'function' || activeAppFormDialog) throw new Error('The form dialog is unavailable.');
  let controls, host;
  const close = (value, options) => controls?.close(value, options);
  const promise = showAppFormDialog({title, pageId, beforeDismiss, parentSurface, returnFocus, retainParentView, mode: 'reading', contentOwnsFooter: contentOwnsFooter === true,
    onMount(content, owner) {controls = owner; host = document.createElement('div'); content.appendChild(host); onMount?.(host, close);},
    onAfterClose(_content, closeOptions) {onClose?.(host, closeOptions);},
  });
  if (!controls) throw new Error('The form dialog is unavailable.');
  return Object.freeze({promise, close, dismiss: (reason, options) => controls?.dismiss(reason, options)});
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
  const formOwner = activeAppFormDialog;
  activeAppConfirmDialog = { promise, formOwner, cancel: options => finish(false, options) };
  const finish = (accepted, {restoreFocus = true} = {}) => {
    if (activeAppConfirmDialog?.promise !== promise) return;
    listeners.forEach(([element, name, handler]) => element?.removeEventListener?.(name, handler));
    modal.hidden = true;
    activeAppConfirmDialog = null;
    resolveDialog(Boolean(accepted));
    if (restoreFocus && (!formOwner || activeAppFormDialog === formOwner)
      && previousFocus?.isConnected !== false && !previousFocus?.closest?.('[hidden], [inert]')) previousFocus?.focus?.();
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
