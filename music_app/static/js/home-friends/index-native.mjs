import * as recommendationPresentation from '../recommendations/presentation.mjs';
import {normalizeArtistLovedDescriptor, normalizeArtistLovedLaunch, normalizeSavedArtistLovedRecipe} from '../playlists/artist-loved-recipe.mjs';
import {createGoalsOwner} from './goals-owner.mjs';
import {captureArtistMixScope} from '../playlists/library-mix-recipe.mjs';
import {createPresencePublisher} from './presence.mjs';
import {normalizeCreationResult, prepareMissingDraft} from '../playlists/creation.mjs';
import {createPlaylistMatchProviders} from '../playlists/match-providers.mjs';
import {createPlaylistBackendProviders} from '../playlists/backend-providers.mjs';
import {createHomeBackendProviders} from './backend-providers.mjs';
import {mountPlaylists} from '../playlists/native.mjs';
import {createHomeFriendsController} from './model.mjs';
import {mountHomeFriendsView} from './app.mjs';
import {createFriendNotifications} from './friend-notifications.mjs';
import {mountFriendNotifications} from './friend-notifications-ui.mjs';
import {mountPlaytableSelection} from '../playtables/native-selection.mjs';
import {mountPlaylistActionSession} from '../playlists/native-selection-actions.mjs';
import {mountAlbumTops} from '../album-tops/index.mjs';
import {createAlbumTopBackendProviders} from '../album-tops/backend-providers.mjs';
import {mountLibraryNavigation} from './library-navigation.mjs';
import {mountSearchResults} from '../search-results/native.mjs';
import {mountArtistPage} from '../artist-page/native.mjs';
import {createFoobarHistoryOwner} from '../foobar-history/owner.mjs';
import {createFoobarHistoryNativeActions} from '../foobar-history/native-actions.mjs';

window.AlbumHavenRecommendationPresentation = Object.freeze(recommendationPresentation);

let requestedProviders = null, providers = {}, providerGeneration = 0, activeController = null, homeOwner = null, mountedRuntime = null;
let friendNotifications = null, ownedHomeProviders = null, presencePublisher = null, notificationsView = null;
function bindProviders(runtime) {
  // The native resolver can inspect private media authority. Only its sanitized
  // activity reader crosses into the Home controller.
  if (requestedProviders === null && window.AlbumHavenPrivateUITransport) requestedProviders = ownedHomeProviders = createHomeBackendProviders(window.AlbumHavenPrivateUITransport, {runtime});
  const {readActivity, resolveActivityTrack, resolveActivityNativeTarget, retryActivityScrobble, canRetryActivityScrobble, lastfmHistoryCommand, ...publicProviders} = requestedProviders || {};
  return {...publicProviders, readActivity: runtime?.configureActivityProvider?.({readActivity, resolveActivityTrack, resolveActivityNativeTarget, retryActivityScrobble, canRetryActivityScrobble, lastfmHistoryCommand}) ?? null};
}
// The Home controller follows account/provider lifetime. Its view follows the
// native history entry; leaving Home retires both immediately.
function createHomeOwner(host, runtime) {
  let session = null, disposed = false, updating = false, queued = false, configurationDepth = 0;
  function retireSession() {
    const previous = session;
    if (!previous) return;
    session = null;
    if (activeController === previous.controller) activeController = null;
    let failure;
    for (const release of [previous.unsubscribe, previous.releaseNotifications, () => previous.view?.dispose(),
      () => previous.foobarHistoryOwner?.dispose(), () => previous.goalsOwner?.dispose(), () => previous.controller.dispose()]) {
      try {release?.();} catch (error) {failure ||= error;}
    }
    if (failure) throw failure;
  }
  function reconcile() {
    if (disposed) return;
    if (updating || configurationDepth) {queued = true; return;}
    updating = true;
    try {
      do {
        queued = false;
        const shell = runtime.snapshot();
        const goalsTransport = shell.authenticated === true ? window.AlbumHavenPrivateUITransport : null;
        if (!shell.visible) {retireSession(); continue;}
        if (session && (session.scopeKey !== shell.scopeKey || session.generation !== providerGeneration || session.goalsTransport !== goalsTransport)) retireSession();
        if (!session) {
          const controller = createHomeFriendsController({readRecent: runtime.readRecent, providers,
            onFriendsAuthority: runtime.retireFriendActivity});
          controller.setScope(shell.scopeKey);
          session = {controller, scopeKey: shell.scopeKey, generation: providerGeneration,
            view: null, entryKey: null, initialized: false, payload: undefined,
            notifications: null, releaseNotifications: null, goalsOwner: null, goalsTransport, foobarHistoryOwner: null};
          const owned = session;
          const foobarRoot = host.ownerDocument.getElementById('app-shell');
          if (shell.authenticated === true && foobarRoot?.dataset.accountFoobarHistoryAllowed === 'true') {
            try {owned.foobarHistoryOwner = createFoobarHistoryOwner({
              fetch: (...args) => window.fetch(...args), contextRoot: foobarRoot,
              allows: action => action === 'account.self.foobar.read' && foobarRoot.dataset.accountFoobarHistoryAllowed === 'true',
              isCurrent: () => session === owned && !disposed && runtime.snapshot().visible
                && runtime.snapshot().scopeKey === owned.scopeKey && host.ownerDocument.getElementById('app-shell') === foobarRoot,
            });} catch (error) {retireSession(); throw error;}
          }
          if (owned.goalsTransport) {
            try {owned.goalsOwner = createGoalsOwner({transport: owned.goalsTransport, sourceTransport: owned.goalsTransport, document:host.ownerDocument,
              isCurrent: () => session === owned && !disposed && runtime.snapshot().visible && runtime.snapshot().scopeKey === owned.scopeKey});}
            catch (error) {retireSession(); throw error;}
          }
          activeController = controller;
          session.unsubscribe = controller.subscribe(reconcile);
        }
        const current = session, entryKey = shell.entryKey ?? 'initial';
        const props = {runtime, controller: current.controller, state: current.controller.getSnapshot(), shell,
          readDetail: providers.readDetail, readNowPlaying: providers.readNowPlaying,
          goalsTransport: current.goalsTransport, goalsSourceTransport: current.goalsTransport, goalsOwner: current.goalsOwner,
          foobarHistoryOwner: current.foobarHistoryOwner,
          createFoobarNativeActions: options => {
            // TrackActionsRuntime is the actual classic-script lexical owner,
            // not a window property. Missing media runtime leaves display intact.
            const tracks = typeof TrackActionsRuntime === 'undefined' ? null : TrackActionsRuntime;
            const transport = window.AlbumHavenPrivateUITransport;
            if (!tracks || !transport) return null;
            const accountRoot = host.ownerDocument.getElementById('app-shell');
            const accountContext = accountRoot?.dataset.accountFoobarContext;
            const viewCurrent = options.isCurrent;
            return createFoobarHistoryNativeActions({...options, tracks, transport, isCurrent: () =>
              viewCurrent() && session === current && !disposed && current.generation === providerGeneration
              && accountRoot?.isConnected === true && host.ownerDocument.getElementById('app-shell') === accountRoot
              && accountRoot.dataset.accountFoobarContext === accountContext
              && accountRoot.dataset.accountFoobarScope === 'account-foobar-v1'
              && accountRoot.dataset.accountFoobarHistoryAllowed === 'true'
              && window.AlbumHavenPrivateUITransport === transport && TrackActionsRuntime === tracks
              && runtime.snapshot().visible && runtime.snapshot().scopeKey === current.scopeKey
              && (runtime.snapshot().entryKey ?? 'initial') === entryKey});
          }};
        const stillCurrent = () => {
          const latest = runtime.snapshot();
          return session === current && current.generation === providerGeneration && latest.visible
            && latest.scopeKey === current.scopeKey && (latest.entryKey ?? 'initial') === entryKey;
        };
        if (!current.view || current.entryKey !== entryKey) {
          const previous = current.view; current.view = null;
          previous?.dispose();
          if (!stillCurrent()) {queued = true; continue;}
          const mounted = mountHomeFriendsView(host, props);
          if (!stillCurrent()) {mounted.dispose(); queued = true; continue;}
          current.entryKey = entryKey; current.view = mounted;
        } else current.view.update(props);
        if (!stillCurrent()) {queued = true; continue;}
        if (current.notifications !== friendNotifications) {
          const previous = current.releaseNotifications; current.releaseNotifications = null;
          previous?.();
          if (!stillCurrent()) {queued = true; continue;}
          const producer = friendNotifications, release = producer?.useHome(current.controller);
          if (!stillCurrent()) {release?.(); queued = true; continue;}
          current.notifications = producer; current.releaseNotifications = release;
        }
        const initial = !current.initialized;
        current.initialized = true;
        if (initial || current.payload !== shell.payload) {
          current.payload = shell.payload;
          if (shell.payload) current.controller.acceptRecent(shell.payload);
          else current.controller.loadRecent();
        }
        if (initial) {
          // Off-tab startup reads only bounded attention; visible panel owns full reads.
          if (current.goalsOwner?.controller.getSnapshot().status === 'idle') void current.goalsOwner.refreshAttention();
          // Bootstrap summaries may be empty; always read the genuine seam.
          if (shell.payload) current.controller.loadRecent();
          current.controller.loadFriends();
        }
      } while (queued && !disposed);
    } finally {updating = false;}
  }
  const unsubscribe = runtime.subscribe(reconcile);
  const unsubscribeScrobble = runtime.subscribeRecentScrobbleRefresh?.(scopeKey => {
    const current = session, snapshot = runtime.snapshot();
    if (!disposed && current && snapshot.visible && current.scopeKey === scopeKey && snapshot.scopeKey === scopeKey)
      void current.controller.refreshOwnListenActivity();
  });
  return {
    update: reconcile,
    reconfigure(change) {
      configurationDepth++;
      try {retireSession(); change();}
      finally {configurationDepth--; reconcile();}
    },
    dispose() {if (disposed) return; disposed = true; unsubscribeScrobble?.(); unsubscribe?.(); retireSession();},
  };
}
function renderRoot() {homeOwner?.update();}
function mountNotifications() {
  if (!mountedRuntime || friendNotifications || !window.AlbumHavenNotifications?.registerSource) return;
  friendNotifications = createFriendNotifications({runtime: mountedRuntime,
    notifications: window.AlbumHavenNotifications, providers});
  notificationsView = mountFriendNotifications({producer: friendNotifications});
  renderRoot();
}
function mount() {
  const runtime = window.AlbumHavenHomeRuntime, host = document.getElementById('home-friends-root');
  if (homeOwner || !runtime || !host) return;
  mountedRuntime = runtime;
  if (!presencePublisher && window.AlbumHavenPrivateUITransport && runtime.readPresencePlayback && window.crypto?.randomUUID) {
    presencePublisher = createPresencePublisher({transport: window.AlbumHavenPrivateUITransport,
      readPlayback: runtime.readPresencePlayback, subscribe: runtime.subscribeTrackPlayback, playerRef: window.crypto.randomUUID()});
  }
  providers = bindProviders(runtime);
  mountNotifications();
  homeOwner = createHomeOwner(host, runtime);
  renderRoot();
}
// The backend integration supplies explicitly authorized DTO readers/writers.
// No demo transport, local store, endpoint guessing, or optimistic persistence.
window.AlbumHavenHomeUI = Object.freeze({
  configureProviders(next = {}) {
    if (!next || typeof next !== 'object' || Array.isArray(next)) throw new TypeError('Home providers must be an object.');
    const configuration = ++providerGeneration;
    const apply = () => {
      if (providerGeneration !== configuration) return;
      activeController = null;
      ownedHomeProviders?.dispose(); ownedHomeProviders = null;
      requestedProviders = {...next};
      providers = mountedRuntime ? bindProviders(mountedRuntime) : {};
      if (providerGeneration === configuration) friendNotifications?.configure(providers);
    };
    if (homeOwner) homeOwner.reconfigure(apply); else apply();
  },
  refresh() {
    if (activeController && mountedRuntime?.snapshot().visible) {
      activeController.loadRecent(); activeController.loadFriends();
    }
    else friendNotifications?.refresh();
  },
});
window.addEventListener('albumhaven:home-runtime-ready', mount);
window.addEventListener('albumhaven:notifications-ready', mountNotifications);
mount();

let playlistMount = null, playlistProviders = null, ownedPlaylistProviders = null, ownedMatchProviders = null;
let playlistAction = null, playlistProviderGeneration = 0;
let playlistMountOwner = null, playlistMountChanging = false;
let customPlaylistProviders = false, playlistBackendRuntime = null;
function playlistRuntimeCurrent(owner) {
  if (!owner || owner.retired) return false;
  if (playlistMountOwner !== owner || window.AlbumHavenPlaylistRuntime !== owner.runtime
    || document.getElementById('playlists-root') !== owner.host) owner.retired = true;
  return !owner.retired;
}
function playlistBackend(runtime) {
  if (playlistProviders === null) {
    playlistBackendRuntime = runtime;
    ownedPlaylistProviders = window.AlbumHavenPrivateUITransport
      ? createPlaylistBackendProviders({transport: window.AlbumHavenPrivateUITransport, runtime}) : null;
    ownedMatchProviders = ownedPlaylistProviders ? createPlaylistMatchProviders({transport: window.AlbumHavenPrivateUITransport, runtime}) : null;
    playlistProviders = ownedPlaylistProviders ? {...ownedPlaylistProviders, ...ownedMatchProviders,
      readPlayback: runtime.readPlayback, subscribePlayback: runtime.subscribePlayback, playbackIntent: runtime.playbackIntent} : {};
    runtime.configurePlaybackPreferences?.({read: ownedPlaylistProviders?.readPlaylistPreferences,
      write: ownedPlaylistProviders?.savePlaylistPreferences});
  }
  return playlistProviders;
}

function cleanPlaylistActionView(owner) {
  // Claim each resource before calling foreign code. A disposer may reenter or
  // throw; neither can prevent the remaining independent resources releasing.
  const view = owner.view; owner.view = null;
  try {view?.dispose();} catch {}
  if (!owner.hostRemoved) {
    owner.hostRemoved = true;
    try {owner.host.remove();} catch {}
  }
}
function closePlaylistAction(owner) {
  if (owner.closed) return;
  owner.closed = true;
  if (playlistAction === owner) playlistAction = null;
  const release = owner.releasePresentation; owner.releasePresentation = null;
  try {owner.lifetime.dispose?.();} catch {}
  try {release?.();} catch {}
  // Native close can happen inside mount. Wait until its returned view can be
  // claimed, and never touch a newer action's host or lifetime.
  queueMicrotask(() => cleanPlaylistActionView(owner));
}
function openPlaylistAction(packet, lifetime, sourceAdapter, anchor, options = {}) {
  const native = window.AlbumHavenPlaylistRuntime;
  if (playlistAction || !native?.playtableFormRuntime || !native.canOpenPlaytableForm?.()
    || !lifetime?.isCurrent?.() || sourceAdapter?.snapshot?.()?.scopeKey !== packet?.scopeKey) return false;
  playlistBackend(native);
  const generation = playlistProviderGeneration;
  const host = document.createElement('div');
  const owner = {host, view: null, lifetime, closed: false, releasePresentation: null};
  playlistAction = owner;
  try {
    document.body.appendChild(host);
    const homeRuntime = window.AlbumHavenHomeRuntime, homePresentation = homeRuntime?.snapshot();
    // Native Album sources can use the Playlist adapter generation while their
    // visible Home parent has independently recovered from a denied Recent read.
    // Pin that actual presentation owner; source/target authority stays separate.
    const release = homePresentation?.visible
      ? homeRuntime.retainPlaytablePresentation?.(homePresentation.scopeKey) : null;
    if (owner.closed) {try {release?.();} catch {} return false;}
    owner.releasePresentation = release;
    const isCurrent = () => !owner.closed && playlistAction === owner && generation === playlistProviderGeneration
      && lifetime.isCurrent() && sourceAdapter.snapshot()?.scopeKey === packet.scopeKey;
    if (!isCurrent()) {closePlaylistAction(owner); return false;}
    const runtime = native.playtableFormRuntime(isCurrent);
    if (!isCurrent()) {closePlaylistAction(owner); return false;}
    const surface = anchor?.closest?.('#non-album-modal, #track-modal, [data-resource-selection-content="album"]');
    const parentSurface = surface?.id ? `#${surface.id}` : surface ? '[data-resource-selection-content="album"]' : undefined;
    owner.view = mountPlaylistActionSession(host, {runtime, packet, lifetime, sourceAdapter, parentSurface, initialMode: options.mode,
      providers: playlistProviders, readDetail: playlistProviders.readDetail,
      returnFocus: () => anchor?.isConnected ? anchor : null,
      onClose: () => closePlaylistAction(owner),
      onNavigate: async playlist_id => {
        if (!isCurrent()) return false;
        const sourceReceipt = sourceAdapter.retainNavigation?.(packet.row_keys);
        if (!sourceReceipt) return false;
        try {return await native.navigateFromPlaytable({playlist_id, sourceReceipt,
          providerCurrent: () => generation === playlistProviderGeneration});}
        finally {sourceReceipt.dispose();}
      },
      onNotice: () => native.notifyPlaytableCreation?.()});
    if (!isCurrent()) {closePlaylistAction(owner); return false;}
    return true;
  } catch (error) {
    closePlaylistAction(owner);
    cleanPlaylistActionView(owner);
    throw error;
  }
}
function openPlaytableContext(packet, lifetime, sourceAdapter, anchor) {
  const native = window.AlbumHavenPlaylistRuntime;
  if (!lifetime?.isCurrent?.() || !native?.openChoice) return false;
  const queue = window.AlbumHavenExplicitQueue;
  const recommended = recommendationPresentation.singleRecommendedTrack(packet, lifetime, sourceAdapter);
  const formats = [{value: 'new', label: 'Create new playlist'}, {value: 'add', label: 'Add to playlist'},
    ...(recommended && window.AlbumHavenRecommendations ? [{value: 'recommend', label: 'Recommend'}, {value: 'recommend-manual', label: 'Add to Recommended By…'}] : []),
    ...(queue && sourceAdapter.canQueue?.(packet.row_keys) ? queue.timingOptions().map(option => ({value: `queue:${option.value ?? option.id}`, label: option.label, reason: option.reason, disabled: option.enabled !== true})) : [])];
  return Boolean(native.openChoice(anchor, {formats, label: 'Selected track actions', actionMenu: true, menuWidth: 'content',
    updateTriggerLabel: false, initialFocus: 'first', onSelect: value => {
      if (!lifetime.isCurrent()) return false;
      if (value === 'recommend' || value === 'recommend-manual') {
        const fresh = recommendationPresentation.singleRecommendedTrack(packet, lifetime, sourceAdapter);
        if (!recommendationPresentation.sameRecommendationResource(fresh, recommended)) return false;
        void window.AlbumHavenRecommendations.open({...fresh, manual: value === 'recommend-manual', anchor,
          isCurrent: () => lifetime.isCurrent() && recommendationPresentation.sameRecommendationResource(
            recommendationPresentation.singleRecommendedTrack(packet,lifetime,sourceAdapter), fresh)})
          .finally(() => lifetime.dispose?.());
        return true;
      }
      if (value === 'new' || value === 'add') return openPlaylistAction(packet, lifetime, sourceAdapter, anchor, {mode: value === 'new' ? 'create' : 'add'});
      if (!value.startsWith('queue:') || !queue) return false;
      const request = new AbortController();
      Promise.resolve(sourceAdapter.captureQueue(packet.row_keys, {signal: request.signal})).then(entries => {
        if (!entries || !lifetime.isCurrent()) return false;
        return queue.enqueue(entries, value.slice(6), {signal: request.signal, isCurrent: lifetime.isCurrent});
      }).catch(error => {if (error?.name !== 'AbortError' && lifetime.isCurrent()) native.notifyQueueFailure?.();}).finally(() => lifetime.dispose?.());
      return true;
    }}));
}
window.AlbumHavenPlaytableUI = Object.freeze({mount: mountPlaytableSelection, open: openPlaylistAction, context: openPlaytableContext,
  actions: (anchor, options) => window.AlbumHavenPlaylistRuntime?.openChoice?.(anchor, {...options, actionMenu: true, menuWidth: 'content', updateTriggerLabel: false, initialFocus: 'first'}) || null});
window.dispatchEvent(new Event('albumhaven:playtable-ui-ready'));
function mountPlaylistSurface() {
  // Nested readiness during disposal/acquisition fails closed. No successor can
  // mount into a host that the detached old owner's disposer is still clearing.
  if (playlistMountChanging) {
    if (playlistMountOwner) playlistRuntimeCurrent(playlistMountOwner);
    return;
  }
  const host = document.getElementById('playlists-root'), runtime = window.AlbumHavenPlaylistRuntime;
  if (playlistRuntimeCurrent(playlistMountOwner)) return;
  const replaceProviders = Boolean(playlistMountOwner) || playlistBackendRuntime && playlistBackendRuntime !== runtime;
  const previous = playlistMount, oldPlaylist = replaceProviders ? ownedPlaylistProviders : null,
    oldMatch = replaceProviders ? ownedMatchProviders : null;
  if (playlistMountOwner) playlistMountOwner.retired = true;
  playlistMount = null; playlistMountOwner = null;
  if (replaceProviders) {
    ownedPlaylistProviders = null; ownedMatchProviders = null; playlistBackendRuntime = null;
    if (!customPlaylistProviders) playlistProviders = null;
  }
  playlistMountChanging = true;
  let failure;
  const release = callback => {try {callback();} catch (error) {failure ||= error;}};
  try {
    release(() => previous?.dispose());
    release(() => oldPlaylist?.dispose());
    release(() => oldMatch?.dispose());
    if (failure) throw failure;
    if (!host || !runtime || window.AlbumHavenPlaylistRuntime !== runtime
      || document.getElementById('playlists-root') !== host) return;
    const owner = {runtime, host, retired: false}; playlistMountOwner = owner;
    const configuration = playlistProviderGeneration, providers = playlistBackend(runtime);
    if (!playlistRuntimeCurrent(owner) || configuration !== playlistProviderGeneration) return;
    const mounted = mountPlaylists({host, runtime, providers, isRuntimeCurrent: () => playlistRuntimeCurrent(owner)});
    if (!playlistRuntimeCurrent(owner) || configuration !== playlistProviderGeneration) {
      owner.retired = true; mounted.dispose(); return;
    }
    playlistMount = mounted;
  } finally {
    if (!playlistMount && playlistMountOwner) {
      playlistMountOwner.retired = true; playlistMountOwner = null;
    }
    playlistMountChanging = false;
  }
}
let activityInspect = null;
async function activityMissingEligibility(options) {
  const native = window.AlbumHavenPlaylistRuntime, home = window.AlbumHavenHomeRuntime?.snapshot();
  if (!native || !home?.visible || home.scopeKey !== options?.scopeKey || !options.isCurrent?.()) return null;
  const providers = playlistBackend(native), scopeKey = native.snapshot().scopeKey;
  const result = await providers.readActivityMissingEligibility?.({...options, scopeKey});
  return options.isCurrent?.() ? result : null;
}
async function inspectActivityMissing(options) {
  const native = window.AlbumHavenPlaylistRuntime, home = window.AlbumHavenHomeRuntime?.snapshot();
  if (activityInspect || playlistAction || !native?.canOpenPlaytableForm?.() || !home?.visible || home.scopeKey !== options?.scopeKey || !options.isCurrent?.()) return false;
  mountPlaylistSurface();
  if (!playlistMount) return false;
  const request = {generation: playlistProviderGeneration, scopeKey: native.snapshot().scopeKey};
  const current = () => activityInspect === request && request.generation === playlistProviderGeneration
    && native.canOpenPlaytableForm?.() === true && native.snapshot().scopeKey === request.scopeKey && options.isCurrent?.() === true;
  activityInspect = request;
  try {
    const result = await playlistBackend(native).beginActivityMissingSource?.({...options, scopeKey: request.scopeKey});
    if (!current()) return false;
    if (result?.recovered_creation) throw new Error('Your earlier playlist was already saved. Open it from Playlists before starting another.');
    if (!result?.source || !result.resource) return false;
    const context = {scopeKey: request.scopeKey, mode: 'missing', source: result.source, canCreate: true};
    const normalized = normalizeCreationResult(result.resource, context);
    if (normalized.status !== 'ready') return false;
    const packet = prepareMissingDraft({...context, sourceResource: normalized, mutation: {status: 'idle'},
      title: result.resource.data.title, description: '', selectedKeys: normalized.data.entries.map(row => row.row_key)});
    return packet && current() ? playlistMount.prepareActivityDraft(packet, options.scopeKey) : false;
  } finally {if (activityInspect === request) activityInspect = null;}
}
function canOpenArtistLoved({descriptor, launchContext} = {}) {
  try {
    const parsed = normalizeArtistLovedDescriptor(descriptor);
    const native = window.AlbumHavenPlaylistRuntime;
    // Observation retires A before any B lease can later round-trip back to A.
    if (playlistMountOwner) playlistRuntimeCurrent(playlistMountOwner);
    if (!parsed || !native || launchContext?.descriptor !== descriptor
      || launchContext.runtime !== native || launchContext.providerGeneration !== playlistProviderGeneration
      || launchContext.isCurrent?.() !== true) return false;
    return launchContext.responseStamp === window.AlbumHavenPrivateUITransport?.context()
      && launchContext.transportGeneration === window.AlbumHavenPrivateUITransport?.generation()
      && launchContext.isCurrent?.() === true;
  } catch {return false;}
}
window.AlbumHavenPlaylistUI = Object.freeze({
  openSamplePlaylist({originOwner, options, originNavigation} = {}) {
    if (!originNavigation || typeof originNavigation.presentation?.suspend !== 'function'
      || originNavigation.parentRegistration !== null && typeof originNavigation.parentRegistration?.registerPlaylistChild !== 'function') return false;
    if (!originOwner || typeof originOwner.isCurrent !== 'function' || typeof originOwner.back !== 'function' || !originOwner.origin) return false;
    const native = window.AlbumHavenPlaylistRuntime, generation = playlistProviderGeneration;
    let sourceCurrent; try {sourceCurrent = originOwner.isCurrent() === true;} catch {return false;}
    const start = native?.snapshot(); if (!sourceCurrent || !start?.authenticated) return false;
    const scopeKey = start.scopeKey;
    mountPlaylistSurface();
    const owner = playlistMountOwner, mounted = playlistMount; let retired = false;
    const current = () => {
      if (retired) return false;
      try {if (originOwner.isCurrent() !== true || window.AlbumHavenPlaylistRuntime !== native
        || playlistProviderGeneration !== generation || native.isCurrentPrivateScope?.(scopeKey) !== true
        || playlistMount !== mounted || !playlistRuntimeCurrent(owner)) retired = true;}
      catch {retired = true;}
      return !retired;
    };
    if (!current()) return false;
    const wrapper = Object.freeze({scopeKey, origin: originOwner.origin, isCurrent: current,
      back(returnToParent) {return current() ? originOwner.back(returnToParent) : false;}});
    return mounted?.openSamplePlaylist({originOwner: wrapper, options, originNavigation}) ?? false;
  },
  activityMissingEligibility, inspectActivityMissing,
  normalizeArtistLovedLaunch, normalizeSavedArtistLovedRecipe,
  artistLovedProviderGeneration: () => playlistProviderGeneration,
  canOpenArtistLoved,
  openArtistLoved(input) {
    if (!canOpenArtistLoved(input)) return false;
    const generation = playlistProviderGeneration, native = window.AlbumHavenPlaylistRuntime;
    mountPlaylistSurface();
    if (generation !== playlistProviderGeneration || native !== window.AlbumHavenPlaylistRuntime || !canOpenArtistLoved(input)) return false;
    return playlistRuntimeCurrent(playlistMountOwner) && playlistMountOwner.runtime === native
      ? playlistMount?.openArtistLoved(input) ?? false : false;
  },
  openLibraryMix() {mountPlaylistSurface(); return playlistMount?.openLibraryMix() ?? false;},
  canOpenArtistPopular({groups,albums,filters}) {return captureArtistMixScope(groups,albums,filters) !== null;},
  openArtistPopular({groups,albums,filters}) {
    const artistScope=captureArtistMixScope(groups,albums,filters);if(!artistScope)return false;
    mountPlaylistSurface();return playlistMount?.openLibraryMix({artistScope})??false;
  },
  configureProviders(next = {}) {
    if (!next || typeof next !== 'object' || Array.isArray(next)) throw new TypeError('Playlist providers must be an object.');
    const configuration = ++playlistProviderGeneration;
    const oldPlaylist = ownedPlaylistProviders, oldMatch = ownedMatchProviders;
    // Detach first: nested configuration must never dispose these twice or
    // subsequently have its newly acquired providers nulled by this caller.
    ownedPlaylistProviders = null; ownedMatchProviders = null;
    const current = () => configuration === playlistProviderGeneration;
    let failure;
    const release = callback => {try {callback();} catch (error) {failure ||= error;}};
    if (playlistAction) release(() => closePlaylistAction(playlistAction));
    // Detached old resources still belong to this transaction even if a close
    // callback superseded it. Their independent cleanup must finish.
    release(() => oldPlaylist?.dispose());
    release(() => oldMatch?.dispose());
    if (failure) throw failure;
    if (!current()) return;
    window.AlbumHavenPlaylistRuntime?.configurePlaybackPreferences?.({});
    if (!current()) return;
    const replacement = {...next};
    if (!current()) return;
    customPlaylistProviders = true; playlistProviders = replacement;
    playlistMount?.configureProviders(playlistProviders);
  },
  refresh() {return playlistMount?.refresh();},
});
// Gallery may render before the native entry publishes its Artist action.
// Refresh current controls only; readiness grants no captured scope or authority.
if (document.querySelector('[data-gallery-bar-action="popular-tracks"]')) window.updateGalleryMainControls?.();
window.addEventListener('albumhaven:playlist-runtime-ready', mountPlaylistSurface);
document.addEventListener('click', event => {
  const trigger = event.target.closest?.('[data-library-mix-open]');
  if (!trigger || trigger.disabled) return;
  event.preventDefault(); window.AlbumHavenPlaylistUI.openLibraryMix();
});
mountPlaylistSurface();

let albumTopsMount = null, libraryNavigationMount = null;
function mountAlbumTopSurface() {
  const runtime = window.AlbumHavenAlbumTopsRuntime, transport = window.AlbumHavenPrivateUITransport;
  const host = document.getElementById('album-tops-root'), navigationHost = document.getElementById('library-navigation-root');
  if (!runtime || !transport || !host) return;
  if (!albumTopsMount) albumTopsMount = mountAlbumTops({host, sidebarHost: document.getElementById('album-tops-sidebar-root'), runtime,
    providers: createAlbumTopBackendProviders({transport, acceptsScope: runtime.acceptsPrivateScope})});
  if (!libraryNavigationMount && navigationHost && window.AlbumHavenPlaylistRuntime) {
    libraryNavigationMount = mountLibraryNavigation({host: navigationHost, playlistHost: document.getElementById('playlist-sidebar-root'),
      runtime, playlistRuntime: window.AlbumHavenPlaylistRuntime});
  }
}
window.addEventListener('albumhaven:album-tops-runtime-ready', mountAlbumTopSurface);
window.addEventListener('albumhaven:playlist-runtime-ready', mountAlbumTopSurface);
mountAlbumTopSurface();

let searchMount = null, searchMountRuntime = null, searchMountHost = null;
function mountSearchSurface() {
  const runtime = window.AlbumHavenSearchRuntime, host = document.getElementById('search-results-root');
  if (!runtime || !host) return;
  if (searchMount && searchMountRuntime === runtime && searchMountHost === host) return;
  const previous = searchMount;
  searchMount = null; searchMountRuntime = null; searchMountHost = null;
  previous?.dispose();
  // Disposal may synchronously install a successor. Never overwrite its owner.
  if (searchMount || window.AlbumHavenSearchRuntime !== runtime
    || document.getElementById('search-results-root') !== host) return;
  const mounted = mountSearchResults({host, runtime});
  if (window.AlbumHavenSearchRuntime !== runtime || document.getElementById('search-results-root') !== host) {
    mounted?.dispose(); return;
  }
  searchMount = mounted; searchMountRuntime = runtime; searchMountHost = host;
}
window.addEventListener('albumhaven:search-runtime-ready', mountSearchSurface);
mountSearchSurface();

let artistMountOwner = null;
function mountArtistSurface() {
  const runtime = window.AlbumHavenArtistPageRuntime, host = document.getElementById('artist-page-root');
  if (!runtime || !host) return;
  if (artistMountOwner?.runtime === runtime && artistMountOwner.host === host) return;
  const previous = artistMountOwner;
  // Claim before callbacks. Repeated ready events during mounting are inert;
  // a reentrant successor owns its own transaction and cannot be overwritten.
  const owner = {runtime, host, mounted: null, unsubscribe: null, retired: false}; artistMountOwner = owner;
  const current = () => !owner.retired && artistMountOwner === owner && window.AlbumHavenArtistPageRuntime === runtime
    && document.getElementById('artist-page-root') === host;
  owner.dispose = () => {
    if (owner.retired) return;
    owner.retired = true;
    const stop = owner.unsubscribe, mounted = owner.mounted;
    owner.unsubscribe = null; owner.mounted = null;
    // Unsubscribe before disposal callbacks; cleanup remains idempotent even
    // if a callback acquires a successor or throws.
    try {stop?.();} finally {mounted?.dispose();}
  };
  let refreshing = false;
  const refreshLoved = () => {
    if (!current() || refreshing) return;
    refreshing = true;
    try {
      // Read the actual settled presentation and a fresh launch lease. This
      // does not admit a view or turn runtime readiness into authority.
      window.updateGalleryArtistLovedControl?.();
    } finally {refreshing = false;}
  };
  try {
    previous?.dispose();
    if (!current()) {owner.dispose(); return;}
    const mounted = mountArtistPage({host, runtime});
    if (!current()) {mounted?.dispose(); owner.dispose(); return;}
    owner.mounted = mounted;
    const unsubscribe = runtime.subscribe(refreshLoved);
    if (!current()) {unsubscribe?.(); owner.dispose(); return;}
    owner.unsubscribe = unsubscribe;
    refreshLoved();
  } catch (error) {
    if (artistMountOwner === owner) artistMountOwner = null;
    owner.dispose();
    throw error;
  }
}
window.addEventListener('albumhaven:artist-page-runtime-ready', mountArtistSurface);
mountArtistSurface();
