/* Private native track refs stay here; React receives only public preferences
   and opaque identities. Persistence and playback retain their existing owners. */
const TrackActionsRuntime = (() => {
  const identities = new Map(), pending = new Map(), confirmed = new Map(), denied = new Set();
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
    if (key !== owner) {owner = key; ownerToken = {}; identities.clear(); confirmed.clear(); denied.clear(); preferenceEpoch++;}
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
  function preference(source) {
    const value = own(source, 'track_preference') ? overlay(source.track_preference) : null, track = ref(source), current = scope();
    if (!value || !track || !current.actor || !current.library) return null;
    if (!identities.has(track)) identities.set(track, `native-track:${++serial}`);
    if (source.read_only_subject) return Object.freeze({identity: `subject:${source.read_only_subject}:${source.inventory_track_ref || track}`,
      love_tier: value.love_tier, rating: value.rating, allowed_actions: Object.freeze({can_set_love_tier: false})});
    const saved = confirmed.get(track);
    return Object.freeze({identity: identities.get(track), love_tier: saved?.love_tier ?? value.love_tier,
      rating: saved ? saved.rating : value.rating,
      allowed_actions: Object.freeze({can_set_love_tier: value.allowed_actions.can_set_love_tier && !denied.has(track)})});
  }
  function readEpoch() {scope(); return preferenceEpoch;}
  function acceptRead(source, epoch) {
    if (source?.read_only_subject) return;
    const track = ref(source);
    const value = own(source, 'track_preference') ? overlay(source.track_preference) : null;
    if (epoch === readEpoch() && track && value) {
      const previous = confirmed.get(track), wasDenied = denied.delete(track);
      confirmed.set(track, value);
      if (wasDenied || previous && (previous.love_tier !== value.love_tier || previous.rating !== value.rating)) notify(preferenceListeners);
    }
  }
  async function setLove({source, love_tier, signal, isCurrent} = {}) {
    const current = scope(), track = ref(source), value = preference(source);
    const active = () => {
      try {return !signal?.aborted && current.token === scope().token && typeof isCurrent === 'function' && isCurrent() === true;}
      catch {return false;}
    };
    if (!active()) throw aborted();
    if (!tiers.includes(love_tier)) throw failure('Invalid track love tier.');
    if (!value || value.allowed_actions.can_set_love_tier !== true) throw failure('Track love editing is unavailable.', 403);
    const pendingKey = JSON.stringify([current.actor, current.library, track]);
    if (pending.has(pendingKey)) throw failure('A track love change is already pending.', 409);
    const request = {};
    pending.set(pendingKey, request);
    try {
      // session-csrf-fetch owns CSRF, credentials, and the underlying fetch.
      // The live route has neither a revision nor an idempotency-key contract.
      // UI cancellation suppresses publication, but cannot undo a dispatched
      // write. Keep its guard until transport finishes, including scope changes.
      const response = await fetch('/track-preferences', {method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: {Accept: 'application/json', 'Content-Type': 'application/json'},
        body: JSON.stringify({track_ref: track, track_preference: {love_tier}})});
      if (!active()) throw aborted();
      if (!response.ok) throw failure('Track love could not be saved.', response.status);
      const result = await response.json();
      if (!active()) throw aborted();
      const acknowledged = overlay(result?.track_preference);
      if (result?.ok !== true || result.actor_id !== current.actor || String(result.library_id) !== current.library
        || result.track_ref !== track || !acknowledged || acknowledged.love_tier !== love_tier
        || acknowledged.allowed_actions.can_set_love_tier !== true) throw failure('Track love returned an invalid acknowledgement.');
      confirmed.set(track, acknowledged); denied.delete(track); preferenceEpoch++;
      notify(preferenceListeners);
      return Object.freeze({identity: value.identity, ...acknowledged});
    } catch (error) {
      if (!active()) throw aborted();
      if (active() && (error.status === 401 || error.status === 403)) {
        denied.add(track); preferenceEpoch++; notify(preferenceListeners);
      }
      throw error;
    } finally {
      if (pending.get(pendingKey) === request) pending.delete(pendingKey);
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
  return Object.freeze({scope, overlay, preference, setLove, canPlay, play, readEpoch, acceptRead, playback, syncPlayback,
    subscribePreferences: listener => subscribe(preferenceListeners, listener),
    subscribePlayback: listener => subscribe(playbackListeners, listener)});
})();
window.AlbumHavenTrackPlayback = Object.freeze({sync: TrackActionsRuntime.syncPlayback});
