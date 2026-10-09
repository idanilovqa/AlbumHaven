import React, {useEffect, useRef, useState} from 'react';
import {Button, NativeHtml} from '../home-friends/components.jsx';

const messages = {loading: 'Saving…', ready: 'The server confirmed the change.', error: 'The change was not confirmed. Your draft is still here.',
  denied: 'You do not have permission to make this change.', unavailable: 'This action is not available on this server yet.'};
export function RetryOriginalRequest({runtime, scopeKey, available, disabled = false, retry, current, onRecovered}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), alive = useRef(true), pending = useRef(false), latest = useRef(null);
  latest.current = {scopeKey, retry, current};
  useEffect(() => {alive.current = true; return () => {alive.current = false;};}, []);
  if (!available || typeof retry !== 'function' || typeof current !== 'function' || typeof runtime.confirmRetryOriginal !== 'function') return null;
  return <><Button runtime={runtime} disabled={disabled || busy} onClick={async () => {
    if (busy || pending.current || disabled || !current()) return;
    const owner = latest.current; let confirmed = false; pending.current = true; setBusy(true); setError('');
    try {
      if (await runtime.confirmRetryOriginal(scopeKey) !== true || !alive.current
        || latest.current.scopeKey !== owner.scopeKey || latest.current.retry !== owner.retry || !owner.current()) return;
      const result = await owner.retry();
      confirmed = Boolean(result);
      if (alive.current && owner.current() && result) await onRecovered?.(result);
    } catch {if (alive.current) setError(confirmed ? 'The original request was confirmed, but the view could not refresh.' : 'The original request is still unconfirmed. Check its result before starting another.');}
    finally {pending.current = false; if (alive.current) setBusy(false);}
  }}>Retry original request</Button>{error && <NativeHtml html={runtime.alertHtml({severity: 'error', role: 'alert', message: error})}/>}</>;
}
export function MutationStatus({runtime, value, controller}) {
  if (!value || value.status === 'idle') return null;
  const scopeKey = controller?.getSnapshot().scopeKey;
  return <><NativeHtml html={runtime.alertHtml({severity: ['error', 'denied'].includes(value.status) ? 'error' : 'info',
    role: ['error', 'denied'].includes(value.status) ? 'alert' : 'status', message: messages[value.status]})}/>
    {controller && <RetryOriginalRequest runtime={runtime} scopeKey={scopeKey} available={controller.canRetryMutation?.() === true}
      retry={controller.retryMutation} current={() => controller.getSnapshot().scopeKey === scopeKey}/>}
  </>;
}
