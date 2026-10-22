// Optional authenticated/native integration boundary. The player owns all queue
// state; a matching provider owns identity resolution. No transport is inferred.
const own = (value, key) => value != null && Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const ref = value => typeof value === 'string' && value.trim() && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);
const text = value => typeof value === 'string' ? value : '';
const freeze = Object.freeze;
const resource = (status = 'unavailable', data = null) => freeze({status, data});
const grant = (value, key) => own(value, 'allowed_actions') && own(value.allowed_actions, key) && value.allowed_actions[key] === true;
const invalid = () => {throw new TypeError('Invalid playlist integration projection.');};
const failure = error => [401, 403].includes(error?.status) ? 'denied' : error?.name === 'AbortError' ? 'unavailable' : 'error';
const providerNames = ['readPlayback', 'subscribePlayback', 'playbackIntent', 'readMatches', 'acceptMatch'];
const providerSet = value => Object.fromEntries(providerNames.map(key => [key, own(value, key) && typeof value[key] === 'function' ? value[key] : null]));

function sameSubject(value, subject, item = false) {
  return object(value) && own(value, 'scopeKey') && value.scopeKey === subject.scopeKey
    && own(value, 'playlist_id') && value.playlist_id === subject.detail.playlist_id
    && (!item || (ref(subject.selectedItemId) && own(value, 'playlist_item_id') && value.playlist_item_id === subject.selectedItemId));
}
function normalize(value, subject, kind) {
  if (object(value) && own(value, 'status')) {
    if (['denied', 'unavailable'].includes(value.status)) return resource(value.status);
    if (!['ready', 'empty'].includes(value.status)) invalid();
    if (value.status === 'empty') {
      if (value.data != null) invalid();
      return resource('empty');
    }
    value = value.data;
  }
  if (!sameSubject(value, subject, kind === 'matches') || !own(value, 'revision') || !ref(value.revision)) invalid();
  if (kind === 'playback') {
    if (!own(value, 'shuffle') || typeof value.shuffle !== 'boolean' || !own(value, 'repeat') || !['off', 'all', 'one'].includes(value.repeat)
      || !own(value, 'current_playlist_id') || !(value.current_playlist_id === null || ref(value.current_playlist_id))
      || !own(value, 'current_playlist_item_id') || !(value.current_playlist_item_id === null || ref(value.current_playlist_item_id))
      || ((value.current_playlist_id === null) !== (value.current_playlist_item_id === null))) invalid();
    return resource('ready', freeze({revision: value.revision, shuffle: value.shuffle, repeat: value.repeat,
      current_playlist_id: value.current_playlist_id, current_playlist_item_id: value.current_playlist_item_id,
      allowed_actions: freeze(Object.fromEntries(['can_shuffle', 'can_repeat', 'can_return_to_current'].map(key => [key, grant(value, key)])))}));
  }
  if (!Array.isArray(value.candidates)) invalid();
  const seen = new Set(), candidates = [];
  for (const candidate of value.candidates) {
    if (!object(candidate) || !own(candidate, 'candidate_ref') || !ref(candidate.candidate_ref) || seen.has(candidate.candidate_ref)) invalid();
    seen.add(candidate.candidate_ref);
    if (candidate.source_readable === false || (own(candidate.allowed_actions, 'can_read') && candidate.allowed_actions.can_read === false)) continue;
    candidates.push(freeze({candidate_ref: candidate.candidate_ref, title: text(candidate.title), artist: text(candidate.artist),
      album_title: text(candidate.album_title), version_label: text(candidate.version_label),
      allowed_actions: freeze({can_accept_match: grant(candidate, 'can_accept_match')})}));
  }
  return resource(candidates.length ? 'ready' : 'empty', freeze({revision: value.revision, candidates: freeze(candidates),
    allowed_actions: freeze({can_accept_match: grant(value, 'can_accept_match')})}));
}

export function createPlaylistIntegrations({providers = {}} = {}) {
  let supplied = providerSet(providers), disposed = false, blocked = false, subscription = null;
  let context = {scopeKey: null, detail: null, status: 'unavailable', selectedItemId: null};
  let state = freeze({...context, playback: resource(), matches: resource(), candidateRef: null,
    playbackMutation: resource('idle'), matchMutation: resource('idle'), currentItemId: null, available: freeze({})});
  const listeners = new Set(), requests = new Map();
  function selectedRow() {
    if (!ref(context.selectedItemId)) return null;
    const rows = context.detail?.track_rows?.filter(row => row.playlist_item_id === context.selectedItemId) || [];
    return rows.length === 1 && rows[0].source_readable !== false ? rows[0] : null;
  }
  function readable(kind) {
    if (disposed || blocked || context.status !== 'ready' || !ref(context.scopeKey) || !ref(context.detail?.playlist_id)) return false;
    if (kind === 'playback') return grant(context.detail, 'can_play');
    const row = selectedRow();
    return grant(context.detail, 'can_review_matches') && grant(row, 'can_review_matches') && ['missing', 'unresolved'].includes(row?.availability);
  }
  function actionAllowed(action) {
    const playback = state.playback.status === 'ready' ? state.playback.data : null;
    if (['shuffle', 'repeat', 'return_to_current'].includes(action)) {
      return readable('playback') && Boolean(supplied.playbackIntent) && state.playbackMutation.status !== 'loading'
        && grant(playback, `can_${action}`) && (action !== 'return_to_current'
          || (playback.current_playlist_id === context.detail.playlist_id && ref(playback.current_playlist_item_id)));
    }
    const row = selectedRow(), matches = state.matches.status === 'ready' ? state.matches.data : null;
    const candidate = matches?.candidates.find(value => value.candidate_ref === state.candidateRef);
    return action === 'acceptMatch' && readable('matches') && Boolean(supplied.acceptMatch) && state.matchMutation.status !== 'loading'
      && grant(context.detail, 'can_accept_match') && grant(row, 'can_accept_match')
      && grant(matches, 'can_accept_match') && grant(candidate, 'can_accept_match');
  }
  function publish(patch = {}) {
    if (disposed) return;
    state = {...state, ...patch};
    const playback = state.playback.status === 'ready' ? state.playback.data : null;
    const rows = playback?.current_playlist_id === context.detail?.playlist_id
      ? context.detail?.track_rows?.filter(row => row.playlist_item_id === playback.current_playlist_item_id && row.source_readable !== false) || [] : [];
    state = freeze({...state, currentItemId: rows.length === 1 ? rows[0].playlist_item_id : null,
      available: freeze(Object.fromEntries(['shuffle', 'repeat', 'return_to_current', 'acceptMatch'].map(action => [action, Boolean(actionAllowed(action))])))});
    for (const listener of listeners) listener();
  }
  function cancel(kind) {
    const pending = requests.get(kind); requests.delete(kind); pending?.request.abort();
  }
  function stopSubscription() {
    const previous = subscription; subscription = null;
    previous?.request.abort();
    try {previous?.unsubscribe?.();} catch { /* A failing cleanup cannot retain authorization. */ }
  }
  function cancelAll() {
    for (const kind of [...requests.keys()]) cancel(kind);
    stopSubscription();
  }
  function deny() {
    blocked = true; cancelAll();
    publish({detail: null, playback: resource('denied'), matches: resource('denied'), candidateRef: null,
      playbackMutation: resource('denied'), matchMutation: resource('denied')});
  }
  function begin(kind, intent = null) {
    cancel(kind); const request = new AbortController();
    const pending = {request, intent, subject: context,
      active: () => !disposed && !blocked && requests.get(kind) === pending && !request.signal.aborted};
    requests.set(kind, pending); return pending;
  }
  function acceptRead(kind, value, subject) {
    const result = normalize(value, subject, kind);
    if (result.status === 'denied') {deny(); return false;}
    publish({[kind]: result, ...(kind === 'matches' ? {candidateRef: null} : {})});
    return result.status === 'ready' || result.status === 'empty';
  }
  function revokePlaybackWrite() {
    if (!requests.has('playbackWrite')) return;
    cancel('playbackWrite'); publish({playbackMutation: resource('unavailable')});
  }
  function startSubscription() {
    if (subscription || !supplied.subscribePlayback || !readable('playback')) return;
    const subject = context, request = new AbortController(), entry = {request, unsubscribe: null}; subscription = entry;
    const active = () => !disposed && !blocked && subscription === entry && !request.signal.aborted;
    try {
      const unsubscribe = supplied.subscribePlayback({scopeKey: subject.scopeKey, playlist_id: subject.detail.playlist_id, signal: request.signal,
        onChange(value) {
          if (!active()) return;
          // A newer native notification supersedes a pending queue read.
          cancel('playback');
          try {
            acceptRead('playback', value, subject);
            if (!active()) return;
            const next = state.playback.data, intent = requests.get('playbackWrite')?.intent;
            if (intent && (!grant(next, `can_${intent.action}`) || (intent.action === 'return_to_current'
              && (next.current_playlist_id !== subject.detail.playlist_id || next.current_playlist_item_id !== intent.playlist_item_id)))) revokePlaybackWrite();
          } catch {revokePlaybackWrite(); publish({playback: resource('error')});}
        }});
      if (typeof unsubscribe !== 'function') throw new TypeError('Playback subscription requires cleanup.');
      if (!active()) {unsubscribe(); return;}
      entry.unsubscribe = unsubscribe;
    } catch {
      if (active()) {stopSubscription(); publish({playback: resource('error')});}
    }
  }
  async function load(kind, afterWrite = false) {
    if (disposed || blocked || (!afterWrite && state[`${kind === 'matches' ? 'match' : 'playback'}Mutation`].status === 'loading')) return false;
    cancel(kind);
    const provider = supplied[kind === 'playback' ? 'readPlayback' : 'readMatches'];
    if (!readable(kind) || !provider) {
      publish({[kind]: resource(), ...(kind === 'matches' ? {candidateRef: null} : {})}); return false;
    }
    const pending = begin(kind), {subject, request, active} = pending;
    publish({[kind]: resource('loading'), ...(kind === 'matches' ? {candidateRef: null} : {})});
    if (!active()) return false;
    try {
      const value = await provider({scopeKey: subject.scopeKey, playlist_id: subject.detail.playlist_id, signal: request.signal,
        ...(kind === 'matches' ? {playlist_item_id: subject.selectedItemId} : {})});
      if (!active()) return false;
      const accepted = acceptRead(kind, value, subject);
      if (active()) {
        requests.delete(kind);
        if (kind === 'playback' && accepted) startSubscription();
      }
      return accepted;
    } catch (error) {
      if (!active()) return false;
      requests.delete(kind); const status = failure(error);
      if (status === 'denied') deny(); else publish({[kind]: resource(status)});
      return false;
    }
  }
  async function mutate(action) {
    if (!actionAllowed(action)) return false;
    const matching = action === 'acceptMatch', kind = matching ? 'matches' : 'playback', writeKind = matching ? 'matchWrite' : 'playbackWrite';
    const field = matching ? 'matchMutation' : 'playbackMutation', projection = state[kind].data;
    const candidateRef = state.candidateRef, pending = begin(writeKind, matching ? null : {action, playlist_item_id: projection.current_playlist_item_id});
    const {subject, request, active} = pending;
    const payload = {scopeKey: subject.scopeKey, playlist_id: subject.detail.playlist_id, revision: projection.revision, signal: request.signal,
      ...(matching ? {playlist_item_id: subject.selectedItemId, candidate_ref: candidateRef} : {action,
        ...(action === 'shuffle' ? {shuffle: !projection.shuffle} : action === 'repeat'
          ? {repeat: {off: 'all', all: 'one', one: 'off'}[projection.repeat]} : {playlist_item_id: projection.current_playlist_item_id})})};
    publish({[field]: resource('loading')});
    if (!active()) return false;
    try {
      const result = await supplied[matching ? 'acceptMatch' : 'playbackIntent'](payload);
      if (!active()) return false;
      if (result?.status === 'denied') {deny(); return false;}
      if (result?.status === 'unavailable') {requests.delete(writeKind); publish({[field]: resource('unavailable')}); return false;}
      if (!own(result, 'ok') || result.ok !== true || (own(result, 'status') && result.status !== 'ready')
        || !sameSubject(result, subject, matching) || (matching ? !own(result, 'candidate_ref') || result.candidate_ref !== candidateRef
          : !own(result, 'action') || result.action !== action
            || (['shuffle', 'repeat'].includes(action) && (!own(result, action) || result[action] !== payload[action]))
            || (action === 'return_to_current' && (!own(result, 'playlist_item_id') || result.playlist_item_id !== payload.playlist_item_id)))) throw new TypeError('Playlist integration change was not acknowledged.');
      // Keep duplicate activation blocked through the authoritative refresh.
      await load(kind, true);
      if (!active()) return false;
      requests.delete(writeKind); publish({[field]: resource('ready')}); return true;
    } catch (error) {
      if (!active()) return false;
      requests.delete(writeKind); const status = failure(error);
      if (status === 'denied') deny(); else publish({[field]: resource(status)});
      return false;
    }
  }
  function reset(clearDenial = false) {
    cancelAll(); blocked = context.status === 'denied' || (!clearDenial && blocked);
    publish({...context, detail: blocked ? null : context.detail, playback: resource(blocked ? 'denied' : 'unavailable'),
      matches: resource(blocked ? 'denied' : 'unavailable'), candidateRef: null, playbackMutation: resource('idle'), matchMutation: resource('idle')});
    if (!blocked) {void load('playback'); void load('matches');}
  }
  return freeze({
    getSnapshot: () => state,
    subscribe(listener) {if (disposed) return () => {}; listeners.add(listener); return () => listeners.delete(listener);},
    setContext({scopeKey = null, detail = null, selectedItemId = null, status = 'ready'} = {}) {
      if (disposed) return;
      const previous = context;
      context = {scopeKey, detail: status === 'ready' ? detail : null, status, selectedItemId: ref(selectedItemId) ? selectedItemId : null};
      if (previous.scopeKey !== context.scopeKey || previous.detail !== context.detail || previous.status !== status) {reset(true); return;}
      if (previous.selectedItemId === context.selectedItemId) return;
      cancel('matches'); cancel('matchWrite');
      publish({selectedItemId: context.selectedItemId, matches: resource(blocked ? 'denied' : 'unavailable'), candidateRef: null, matchMutation: resource('idle')});
      void load('matches');
    },
    configure(providers = {}) {
      if (disposed) return;
      const next = providerSet(providers);
      if (providerNames.every(key => next[key] === supplied[key])) return;
      supplied = next; reset();
    },
    loadPlayback: () => load('playback'), loadMatches: () => load('matches'),
    playbackIntent: action => ['shuffle', 'repeat', 'return_to_current'].includes(action) ? mutate(action) : Promise.resolve(false),
    chooseCandidate(candidateRef) {
      if (!readable('matches') || state.matches.status !== 'ready' || state.matchMutation.status === 'loading'
        || !state.matches.data.candidates.some(candidate => candidate.candidate_ref === candidateRef)) return false;
      publish({candidateRef, matchMutation: resource('idle')}); return true;
    },
    acceptMatch: () => mutate('acceptMatch'),
    dispose() {
      if (disposed) return;
      disposed = true; cancelAll(); listeners.clear(); supplied = providerSet();
      context = {scopeKey: null, detail: null, status: 'unavailable', selectedItemId: null};
      state = freeze({...context, playback: resource(), matches: resource(), candidateRef: null,
        playbackMutation: resource('idle'), matchMutation: resource('idle'), currentItemId: null, available: freeze({})});
    },
  });
}
