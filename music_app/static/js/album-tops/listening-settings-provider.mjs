const PATH = '/account/album-top-listening-settings';
const CONTEXT_SCOPE = 'album-top-settings-v1';
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, fields) => record(value) && Reflect.ownKeys(value).length === fields.length
  && fields.every(key => Object.hasOwn(value, key));
const revision = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value)
  && (value.length < 19 || value <= '9223372036854775807');
export const isCompletedTarget = value => Number.isSafeInteger(value) && value > 0;
const fail = (code, status) => Object.assign(new Error('Album Top listening settings are unavailable.'), {code, status});
const abort = () => Object.assign(new Error('Listening settings session retired.'), {name: 'AbortError'});
export function normalizeListeningSettings(value) {
  if (!keys(value, ['completed_target', 'settings_revision', 'preference_status'])
    || !isCompletedTarget(value.completed_target) || !revision(value.settings_revision)
    || !['default', 'saved'].includes(value.preference_status)
    || value.preference_status === 'default' && (value.completed_target !== 5 || value.settings_revision !== '1')
    || value.preference_status === 'saved' && value.settings_revision === '1') throw fail('invalid_settings_response', 502);
  return Object.freeze({...value});
}

// Dedicated account-only route. Never use library-context private transport:
// this server family rejects X-AlbumHaven-Context. Production injects the existing
// window.fetch wrapper, which owns same-origin session CSRF for PUT.
export function createListeningSettingsProvider({fetch, isCurrent}) {
  let disposed = false, blocked = false, marker = null, acknowledged = null;
  const alive = () => {
    let live = false; try {live = isCurrent() === true;} catch { /* Retired session. */ }
    return !disposed && !blocked && live;
  };
  const assert = signal => {if (!alive() || signal?.aborted) throw abort();};
  async function request(method, command, signal) {
    assert(signal);
    const expected = marker;
    if (method === 'PUT' && (!expected || !acknowledged || command.settings_revision !== acknowledged.settings_revision))
      throw fail('settings_read_required', 409);
    const options = {method, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal,
      headers: {Accept: 'application/json', ...(expected ? {'X-AlbumHaven-Account-Context': expected} : {}),
        ...(command ? {'Content-Type': 'application/json'} : {})},
      ...(command ? {body: JSON.stringify(command)} : {})};
    assert(signal);
    let response;
    try {response = await fetch(PATH, options);} catch (error) {assert(signal); throw error;}
    assert(signal);
    if ([401, 403].includes(response.status)) {
      blocked = true; marker = null; acknowledged = null;
      throw fail('forbidden', response.status);
    }
    let payload;
    try {payload = await response.json();} catch (error) {assert(signal); throw error;}
    assert(signal);
    if (!response.ok) {
      const code = typeof payload?.error === 'string' ? payload.error : 'settings_unavailable';
      if (code === 'stale_context') {blocked = true; marker = null; acknowledged = null;}
      throw fail(code, response.status);
    }
    if (response.status !== 200 || !keys(payload, ['status', 'data', 'context_ref', 'context_scope']) || payload.status !== 'ready'
      || payload.context_scope !== CONTEXT_SCOPE || typeof payload.context_ref !== 'string'
      || !/^[a-f0-9]{64}$/.test(payload.context_ref) || expected && payload.context_ref !== expected) {
      blocked = true; marker = null; acknowledged = null; throw fail('stale_context', 409);
    }
    const data = normalizeListeningSettings(payload.data);
    if (acknowledged && (BigInt(data.settings_revision) < BigInt(acknowledged.settings_revision)
      || data.settings_revision === acknowledged.settings_revision
        && (data.completed_target !== acknowledged.completed_target || data.preference_status !== acknowledged.preference_status)))
      throw fail('invalid_settings_response', 502);
    if (command && (data.preference_status !== 'saved' || data.completed_target !== command.completed_target
      || BigInt(data.settings_revision) !== BigInt(command.settings_revision)
        + (acknowledged.preference_status === 'default' || command.completed_target !== acknowledged.completed_target ? 1n : 0n))) throw fail('invalid_save_receipt', 502);
    assert(signal); marker = payload.context_ref; acknowledged = data;
    return data;
  }
  return Object.freeze({
    read: ({signal} = {}) => request('GET', null, signal),
    save(command, {signal} = {}) {
      if (!keys(command, ['completed_target', 'settings_revision']) || !isCompletedTarget(command.completed_target)
        || !revision(command.settings_revision)) return Promise.reject(fail('invalid_command', 400));
      return request('PUT', {...command}, signal);
    },
    dispose() {disposed = true; marker = null; acknowledged = null;},
  });
}
