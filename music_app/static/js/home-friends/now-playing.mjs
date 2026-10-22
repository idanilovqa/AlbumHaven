import {currentPresence} from './presence.mjs';

// Polling belongs to a single authenticated audience. Retiring an owner aborts
// its read and timers before another audience can receive a result.
export function createNowPlaying(initial, onChange) {
  let props, disposed = false, generation = 0, request, poll, expiry, value = null;
  const publish = next => {value = next; onChange?.(next);};
  function retire() {generation++; request?.abort(); clearTimeout(poll); clearTimeout(expiry); request = null;}
  function update(next) {
    if (disposed) return;
    if (props && ['read', 'scopeKey', 'accountRef', 'allowed'].every(key => Object.is(props[key], next[key]))) return;
    retire(); props = next; publish(null);
    const {read, scopeKey, accountRef, allowed} = props;
    if (!allowed || !accountRef || typeof read !== 'function') return;
    const owner = generation; request = new AbortController();
    const current = () => !disposed && generation === owner;
    const refresh = async () => {
      try {
        const result = await read({scopeKey, account_ref: accountRef, signal: request.signal});
        if (!current()) return;
        const data = currentPresence(result, accountRef); publish(data); clearTimeout(expiry);
        if (data) expiry = setTimeout(() => {if (current()) publish(null);}, Math.max(0, Date.parse(data.expires_at) - Date.now()));
      } catch {if (current()) publish(null);}
      finally {if (current()) poll = setTimeout(refresh, 5000);}
    };
    refresh();
  }
  update(initial);
  return {update, getSnapshot: () => value, dispose() {if (!disposed) {disposed = true; retire(); value = null;}}};
}
