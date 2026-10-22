import {mountButton} from './native-controls.mjs';

// Native form owns stacking, dismissal and focus. Consumer owns its subtree.
// Opening failure is explicit; fallback is confined to a supplied consumer host.
export function openNativeDialog(runtime, initial, callbacks = {}) {
  let options = initial, owner, mountClose, child, mountedHost, fallback, fallbackButton;
  let disposed = false, closed = false, failed = false, closeOptions;
  let opening = true, nativeClosed = false, nativeRetired = false, pendingClose;
  // Physical cleanup is independent of logical disposal and opening failure.
  // Only the native owner can provide these two positive settlement proofs.
  let physicalObserver = typeof callbacks.onNativeSettlement === 'function' ? callbacks.onNativeSettlement : null;
  if (physicalObserver) {
    // Do not keep a second observer reference in the retained logical callbacks.
    callbacks = {...callbacks};
    delete callbacks.onNativeSettlement;
  }
  let physicalEvent = null, physicalDelivered = false;
  const recordPhysical = (status, next) => {
    if (!physicalObserver || physicalDelivered || physicalEvent) return;
    physicalEvent = Object.freeze({status,
      current: status === 'closed' && next?.current !== false,
      restoreFocusRequested: status === 'closed' && (next || closeOptions)?.restoreFocus !== false});
  };
  const flushPhysical = () => {
    if (opening || !physicalEvent || physicalDelivered) return;
    const observer = physicalObserver, event = physicalEvent;
    physicalDelivered = true; physicalObserver = null; physicalEvent = null;
    try {observer?.(event);} catch { /* Observation cannot change native cleanup or legacy errors. */ }
  };
  const disposeChild = () => {const previous = child; child = null; previous?.dispose?.();};
  const disposeFallback = () => {fallbackButton?.dispose(); fallbackButton = null; fallback?.remove(); fallback = null;};
  const finish = next => {
    if (disposed || closed) return;
    closed = true; mountedHost = null;
    disposeChild(); disposeFallback();
    callbacks.onClose?.({restoreFocus: false, restoreFocusRequested: (next || closeOptions)?.restoreFocus !== false,
      current: next?.current !== false});
  };
  const retireNative = () => {
    const nativeClose = mountClose || owner?.close;
    owner = null; mountClose = null;
    if (nativeClosed || nativeRetired || !nativeClose) return;
    nativeRetired = true;
    const completion = nativeClose(null, {force: true, restoreFocus: false, returnToParent: false});
    if (completion && typeof completion.then === 'function') {
      Promise.resolve(completion).catch(() => { /* Unknown cleanup is not physical settlement. */ });
    }
  };
  const close = next => {
    if (disposed || closed) return;
    closeOptions = {restoreFocus: next?.restoreFocus !== false, force: next?.force === true,
      reason: next?.reason || 'cancel', ...(next?.returnToParent === false ? {returnToParent: false} : {})};
    if (failed) {if (!opening) finish(closeOptions); return;}
    if (nativeClosed) return;
    return (mountClose || owner?.close)?.(null, closeOptions);
  };
  let openingError;
  try {
  try {
    const opened = runtime.openForm({...initial,
      onAdmissionRejected: () => recordPhysical('not-acquired'),
      returnFocus: () => options.returnFocus?.(),
      beforeDismiss: initial.beforeDismiss ? reason => options.beforeDismiss?.(reason) : undefined,
      onMount: (host, nativeClose) => {
        if (disposed || closed || failed || nativeClosed) return;
        mountClose = nativeClose; mountedHost = host;
        let nextChild;
        try {nextChild = callbacks.mount?.(host, close);}
        catch (error) {
          // Classify before the helper catches this exception and calls finish.
          // Forced retirement also prevents error cleanup from restoring focus.
          failed = true;
          try {retireNative();} catch (_cleanupError) { /* Preserve the opening error. */ }
          throw error;
        }
        if (disposed || closed || failed || nativeClosed) nextChild?.dispose?.();
        else child = nextChild;
      },
      onClose: (_host, next) => {
        if (nativeClosed) return;
        nativeClosed = true; mountedHost = null;
        recordPhysical('closed', next);
        // Native cleanup can precede a throw. It is not consumer success yet.
        if (opening) {pendingClose = next; return;}
        try {if (!failed && !disposed) finish(next);}
        finally {flushPhysical();}
      },
    });
    if (!opened || typeof opened.close !== 'function') throw new Error('This dialog is not available right now.');
    if (!nativeClosed && !disposed && !failed) owner = opened;
  } catch (error) {
    failed = true; openingError = error;
    try {retireNative();} catch (_cleanupError) { /* Preserve the opening error. */ }
    finally {disposeChild(); mountedHost = null;}
  }
  opening = false;
  if (failed && !disposed) {
    if (callbacks.fallbackHost) {
      const host = callbacks.fallbackHost, doc = host.ownerDocument;
      fallback = doc.createElement('div'); const alert = doc.createElement('div'), buttonHost = doc.createElement('span');
      alert.innerHTML = runtime.alertHtml({severity: 'info', role: 'status', message: 'This dialog is not available right now.'});
      fallback.append(alert, buttonHost); host.append(fallback);
      fallbackButton = mountButton(buttonHost, runtime, {label: 'Close', onClick: () => close()});
    }
    callbacks.onError?.(openingError, close);
  } else if (nativeClosed && !disposed) {
    // Outside the opening catch: a consumer callback throw is not an open failure.
    finish(pendingClose);
  }
  } finally {opening = false; flushPhysical();}
  return {
    get element() {return mountedHost || null;},
    get closed() {return closed;},
    get failed() {return failed;},
    close,
    update(next) {
      if (disposed || closed || failed) return;
      options = next;
      const current = owner;
      current?.updatePresentation?.({title: next.title, pageId: next.pageId});
      if (!disposed && !closed && current === owner) current?.setDismissDisabled?.(next.dismissDisabled === true);
    },
    dispose() {
      if (disposed) return; disposed = true;
      try {if (!closed && !failed) retireNative();}
      finally {closed = true; owner = null; mountClose = null; disposeChild(); disposeFallback(); mountedHost = null;}
    },
  };
}
