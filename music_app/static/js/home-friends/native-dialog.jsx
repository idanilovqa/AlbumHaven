import React, {useLayoutEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {Button, NativeHtml} from './components.jsx';

// Native form ownership includes dismissal, focus trap and return focus. React
// owns only a dedicated inner host, safe to unmount after native teardown.
export function NativeDialog({runtime, title, pageId, parentSurface, returnFocus, beforeDismiss, onClose, children, contentOwnsFooter = true}) {
  const [host, setHost] = useState(null), [failed, setFailed] = useState(false);
  const latest = useRef(onClose), ownerRef = useRef(null), closeOptions = useRef(null); latest.current = onClose;
  const dismissal = useRef(beforeDismiss); dismissal.current = beforeDismiss;
  const fallback = useRef(returnFocus); fallback.current = returnFocus;
  useLayoutEffect(() => {
    let disposed = false, owner;
    try {
      owner = runtime.openForm({title, pageId, parentSurface, returnFocus: () => fallback.current?.(), contentOwnsFooter,
        beforeDismiss: beforeDismiss ? reason => dismissal.current?.(reason) : undefined,
        onMount: element => {if (!disposed) setHost(element);},
        onClose: (_host, options) => {if (!disposed) {setHost(null); latest.current?.({restoreFocus: false,
          restoreFocusRequested: (options || closeOptions.current)?.restoreFocus !== false,
          current: options?.current !== false});}},
      });
      ownerRef.current = owner;
    } catch (_error) {setFailed(true);}
    return () => {disposed = true; ownerRef.current = null; owner?.close(null, {force: true, restoreFocus: false, returnToParent: false});};
  }, [runtime, title, pageId, parentSurface, contentOwnsFooter, Boolean(beforeDismiss)]);
  if (failed) return <div><NativeHtml html={runtime.alertHtml({severity: 'info', role: 'status', message: 'This dialog is not available right now.'})}/>
    <Button runtime={runtime} onClick={() => latest.current?.()}>Close</Button></div>;
  const close = options => {
    closeOptions.current = {restoreFocus: options?.restoreFocus !== false,
      force: options?.force === true, reason: options?.reason || 'cancel',
      ...(options?.returnToParent === false ? {returnToParent: false} : {})};
    return ownerRef.current?.close(null, closeOptions.current);
  };
  return host ? createPortal(typeof children === 'function' ? children(close) : children, host) : null;
}
