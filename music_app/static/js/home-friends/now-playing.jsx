import {useEffect, useState} from 'react';
import {currentPresence} from './presence.mjs';

export function useNowPlaying({read, scopeKey, accountRef, allowed}) {
  const [held, setHeld] = useState(null);
  useEffect(() => {
    let disposed = false, poll = null, expiry = null;
    setHeld(null);
    if (!allowed || !accountRef || typeof read !== 'function') return undefined;
    const request = new AbortController();
    const refresh = async () => {
      try {
        const result = await read({scopeKey, account_ref: accountRef, signal: request.signal});
        if (disposed) return;
        const data = currentPresence(result, accountRef);
        setHeld(data ? {read, scopeKey, accountRef, data} : null);
        clearTimeout(expiry);
        if (data) expiry = setTimeout(() => setHeld(null), Math.max(0, Date.parse(data.expires_at) - Date.now()));
      } catch {if (!disposed) setHeld(null);}
      finally {if (!disposed) poll = setTimeout(refresh, 5000);}
    };
    refresh();
    return () => {disposed = true; request.abort(); clearTimeout(poll); clearTimeout(expiry);};
  }, [read, scopeKey, accountRef, allowed]);
  return allowed && held && held.read === read && held.scopeKey === scopeKey && held.accountRef === accountRef
    ? currentPresence({status: 'ready', data: held.data}, accountRef) : null;
}
