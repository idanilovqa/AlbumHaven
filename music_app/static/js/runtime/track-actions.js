/* Private native track refs stay here; React receives only public preferences
   and opaque identities. Persistence and playback retain their existing owners. */
const TrackActionsRuntime = (() => {
  const identities = new Map(), inventoryIdentities = new Map(), pending = new Map(), confirmed = new Map(), denied = new Set();
  const preferenceListeners = new Set(), playbackListeners = new Set();
  let owner = null, ownerToken = null, serial = 0, preferenceEpoch = 0, lastPlayback = null;
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
  const grant = (value, key) => own(value, key) && value[key] === true;
  const tiers = ['off', 'loved', 'obsessed'];
  const failure = (message, status) => Object.assign(new Error(message), status ? {status} : {});
  const aborted = () => Object.assign(new Error('Track action was superseded.'), {name: 'AbortError'});
  const notify = listeners => {for (const listener of [...listeners]) {try {listener();} catch { /* Paint subscribers cannot change a native action result. */ }}};
  function scope() {
    const shell = document.getElementById('app-shell'), home = document.getElementById('mobile-home');
    const actor = String(shell?.dataset?.nativeAccountId ?? home?.dataset?.homeAccountId ?? '');
    const library = String(shell?.dataset?.nativeLibraryId ?? home?.dataset?.homeLibraryId ?? '');
    const key = JSON.stringify([actor, library, PrivateUITransport.generation()]);
    if (key !== owner) {owner = key; ownerToken = {}; identities.clear(); inventoryIdentities.clear(); confirmed.clear(); denied.clear(); preferenceEpoch++;}
    return {actor, library, key, token: ownerToken};
  }
  function overlay(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || !own(value, 'love_tier') || !tiers.includes(value.love_tier)
      || !own(value, 'rating') || value.rating !== null && (!Number.isInteger(value.rating) || value.rating < 1 || value.rating > 5)) return null;
    return Object.freeze({love_tier: value.love_tier, rating: value.rating,
      allowed_actions: Object.freeze({can_set_love_tier: own(value, 'allowed_actions') && grant(value.allowed_actions, 'can_set_love_tier')})});
  }
  function ref(source) {
    return own(source, 'track_ref') && typeof source.track_ref === 'string' && source.track_ref.trim()
      ? source.track_ref.trim() : null;
  }
  function recordFor(track) {
    if (!identities.has(track)) identities.set(track, {identity: `native-track:${++serial}`, serial,
      refs: new Set([track]), inventory: null, canonical: null, version: 0, invalid: false, refreshRequired: false});
    return identities.get(track);
  }
  function pendingFor(record, current) {
    return [...pending.values()].filter(operation => operation.actor === current.actor && operation.library === current.library
      && (operation.record === record || record.inventory && operation.inventory === record.inventory
        || record.refs.has(operation.writeRef) || [...operation.record.refs].some(value => record.refs.has(value))));
  }
  function admit(source, current, deniedInBatch) {
    const track = ref(source), canonical = typeof source.canonical_track_ref === 'string' && source.canonical_track_ref.trim() || null;
    const inventory = typeof source.inventory_track_ref === 'string' ? source.inventory_track_ref : null;
    const match = inventory?.match(/^inventory-track:([1-9]\d*):([1-9]\d*)$/);
    const original = recordFor(track);
    if (!inventory && !canonical) return original;
    if (!match || match[1] !== current.library) {original.invalid = true; original.version++; return original;}
    const refs = [...new Set([track, canonical].filter(Boolean))];
    const records = [...new Set([original, inventoryIdentities.get(inventory), ...refs.map(value => identities.get(value))].filter(Boolean))];
    const conflict = records.some(record => record.invalid || record.inventory && record.inventory !== inventory
      || canonical && record.canonical && record.canonical !== canonical);
    const survivor = records.sort((a, b) => a.serial - b.serial)[0];
    const transports = records.flatMap(record => pendingFor(record, current));
    if (conflict || records.length > 1) {
      for (const record of records) record.version++;
      survivor.refreshRequired ||= transports.length > 0;
    }
    const wasDenied = records.some(record => denied.has(record));
    const deniedValue = records.filter(record => denied.has(record)).map(record => confirmed.get(record)).find(Boolean);
    if (records.some(record => deniedInBatch?.has(record))) deniedInBatch.add(survivor);
    for (const record of records) {
      for (const alias of record.refs) {survivor.refs.add(alias); identities.set(alias, survivor);}
      if (record !== survivor) {confirmed.delete(record); denied.delete(record);}
    }
    if (wasDenied) {denied.add(survivor); if (deniedValue) confirmed.set(survivor, deniedValue);}
    for (const alias of refs) {survivor.refs.add(alias); identities.set(alias, survivor);}
    for (const operation of transports) operation.record = survivor;
    survivor.inventory = inventory;
    survivor.canonical ||= canonical;
    survivor.invalid ||= conflict;
    inventoryIdentities.set(inventory, survivor);
    return survivor;
  }
  function preference(source) {
    const value = own(source, 'track_preference') ? overlay(source.track_preference) : null, track = ref(source), current = scope();
    if (!value || !track || !current.actor || !current.library) return null;
    if (source.read_only_subject) return Object.freeze({identity: `subject:${source.read_only_subject}:${source.inventory_track_ref || track}`,
      love_tier: value.love_tier, rating: value.rating, allowed_actions: Object.freeze({can_set_love_tier: false})});
    const record = recordFor(track);
    if (record.invalid || record.refreshRequired && !denied.has(record) || record.inventory && source.inventory_track_ref && record.inventory !== source.inventory_track_ref
      || record.canonical && source.canonical_track_ref && record.canonical !== source.canonical_track_ref) return null;
    const saved = confirmed.get(record);
    return Object.freeze({identity: record.identity, love_tier: saved?.love_tier ?? value.love_tier,
      rating: saved ? saved.rating : value.rating,
      allowed_actions: Object.freeze({can_set_love_tier: value.allowed_actions.can_set_love_tier && (!saved || saved.allowed_actions.can_set_love_tier) && !record.refreshRequired && !denied.has(record)})});
  }
  function readEpoch() {scope(); return preferenceEpoch;}
  function acceptRead(source, epoch, deniedInBatch, onAccepted) {
    if (source?.read_only_subject || epoch !== readEpoch()) return false;
    const track = ref(source), value = own(source, 'track_preference') ? overlay(source.track_preference) : null;
    if (!track || !value) return false;
    const current = scope();
    if (!current.actor || !current.library) return false;
    const record = admit(source, current, deniedInBatch);
    if (!value.allowed_actions.can_set_love_tier) {
      if (!denied.has(record)) {record.version++; preferenceEpoch++;}
      denied.add(record); deniedInBatch?.add(record);
      if (!record.invalid) confirmed.set(record, value);
    } else if (!record.invalid && !deniedInBatch?.has(record) && !pendingFor(record, current).length) {
      if (denied.delete(record) || record.refreshRequired) preferenceEpoch++;
      record.refreshRequired = false; confirmed.set(record, value);
    }
    const accepted = !record.invalid;
    if (accepted) onAccepted?.(preferenceEpoch);
    notify(preferenceListeners); return accepted;
  }

  // One completed native response can contain unrelated tracks and duplicate
  // aliases. Its own denials advance the epoch without discarding other rows;
  // a denial cannot be undone by a sibling read from that same response.
  function readBatch(epoch) {
    const deniedInBatch = new Set(), owner = scope().token;
    let admittedEpoch = epoch;
    return Object.freeze({get epoch() {return admittedEpoch;}, accept(source) {
      if (owner !== scope().token) return false;
      // Advance only this admission's epoch before synchronous subscribers run.
      return acceptRead(source, admittedEpoch, deniedInBatch, next => {admittedEpoch = next;});
    }});
  }

  async function setLove({source, love_tier, signal, isCurrent} = {}) {
    const current = scope(), track = ref(source), value = preference(source), record = track && recordFor(track);
    const version = record?.version, writeRef = record?.canonical || track;
    const active = () => {
      try {return !signal?.aborted && current.token === scope().token && record?.version === version && !record.invalid && !record.refreshRequired
        && identities.get(track) === record && !denied.has(record) && typeof isCurrent === 'function' && isCurrent() === true;}
      catch {return false;}
    };
    if (!active()) throw aborted();
    if (!tiers.includes(love_tier)) throw failure('Invalid track love tier.');
    if (!value || value.allowed_actions.can_set_love_tier !== true) throw failure('Track love editing is unavailable.', 403);
    if (pendingFor(record, current).length) throw failure('A track love change is already pending.', 409);
    const request = {actor: current.actor, library: current.library, record, inventory: record.inventory, writeRef};
    pending.set(request, request);
    try {
      // Cancellation cannot undo a dispatched write. Retain its transport lock
      // through alias admission, owner changes, and caller cancellation.
      const response = await fetch('/track-preferences', {method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: {Accept: 'application/json', 'Content-Type': 'application/json'},
        body: JSON.stringify({track_ref: writeRef, track_preference: {love_tier}})});
      if (!active()) throw aborted();
      if (!response.ok) throw failure('Track love could not be saved.', response.status);
      const result = await response.json();
      if (!active()) throw aborted();
      const acknowledged = overlay(result?.track_preference);
      if (result?.ok !== true || result.actor_id !== current.actor || String(result.library_id) !== current.library
        || result.track_ref !== writeRef || !acknowledged || acknowledged.love_tier !== love_tier
        || acknowledged.allowed_actions.can_set_love_tier !== true) throw failure('Track love returned an invalid acknowledgement.');
      confirmed.set(record, acknowledged); denied.delete(record); preferenceEpoch++;
      notify(preferenceListeners);
      return Object.freeze({identity: value.identity, ...acknowledged});
    } catch (error) {
      if (!active()) {request.record.refreshRequired = true; request.stale = true; throw aborted();}
      if (error.status === 401 || error.status === 403) {
        denied.add(record); preferenceEpoch++; notify(preferenceListeners);
      }
      throw error;
    } finally {
      pending.delete(request);
      // Only a read begun after an unpublishable transport settled may restore
      // authority; an earlier read could precede the dispatched server write.
      if (request.stale) {
        const live = scope();
        if (live.actor === request.actor && live.library === request.library) {preferenceEpoch++; notify(preferenceListeners);}
      }
    }
  }
  function canPlay(source) {
    return Boolean(typeof source?.path === 'string' && source.path.trim()
      && grant(source.playback_state, 'can_start_here') && typeof activateSharedTrackButton === 'function'
      && (!window.AlbumHavenCapabilities || typeof window.AlbumHavenCapabilities.allows === 'function'
        && window.AlbumHavenCapabilities.allows('library.media.read') === true));
  }
  function play(source) {
    if (!canPlay(source)) throw failure('This track action is unavailable.', 403);
    const button = document.createElement('button');
    const text = value => typeof value === 'string' ? value : '';
    const attributes = {'data-inventory-track-ref': text(source.inventory_track_ref), 'data-src': `/track?path=${encodeURIComponent(source.path)}`, 'data-track-path': source.path,
      'data-track-title': text(source.title), 'data-track-artist': text(source.artist || source.secondary_artist),
      'data-track-album': text(source.album_title), 'data-track-duration-seconds': source.duration_seconds};
    for (const [name, value] of Object.entries(attributes)) if (value !== undefined) button.setAttribute(name, String(value));
    activateSharedTrackButton(button, {focusTimeline: true});
  }
  const inactive = Object.freeze({isCurrent: false, isPlaying: false});
  const paused = Object.freeze({isCurrent: true, isPlaying: false});
  const playing = Object.freeze({isCurrent: true, isPlaying: true});
  function playbackState() {
    const playback = typeof getPlayerPlaybackSnapshot === 'function' ? getPlayerPlaybackSnapshot() : {};
    return {scope: scope().token, path: state.player?.current?.path || '', occurrence: state.player?.current?.playlistItemId || '',
      src: playback.src || '', paused: playback.paused,
      ended: playback.ended, locked: typeof isPlaybackLockedByAnotherTab === 'function' && isPlaybackLockedByAnotherTab()};
  }
  function playback(source) {
    const current = playbackState();
    if (!source?.path || source.path !== current.path || !current.src) return inactive;
    return !current.locked && current.paused === false && current.ended !== true ? playing : paused;
  }
  function syncPlayback() {
    let next;
    try {next = playbackState();} catch {return;}
    if (lastPlayback && Object.keys(next).every(key => next[key] === lastPlayback[key])) return;
    lastPlayback = next; notify(playbackListeners);
  }
  const subscribe = (listeners, listener) => {listeners.add(listener); return () => listeners.delete(listener);};
  return Object.freeze({scope, overlay, preference, setLove, canPlay, play, readEpoch, acceptRead, readBatch, playback, syncPlayback,
    subscribePreferences: listener => subscribe(preferenceListeners, listener),
    subscribePlayback: listener => subscribe(playbackListeners, listener)});
})();
window.AlbumHavenTrackPlayback = Object.freeze({sync: TrackActionsRuntime.syncPlayback});
