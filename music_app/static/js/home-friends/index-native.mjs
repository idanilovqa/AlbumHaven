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

let requestedProviders = null, providers = {}, providerGeneration = 0, activeController = null, homeOwner = null, mountedRuntime = null;
let friendNotifications = null, ownedHomeProviders = null, presencePublisher = null, notificationsView = null;
function bindProviders(runtime) {
  // The native resolver can inspect private media authority. Only its sanitized
  // activity reader crosses into the Home controller.
  if (requestedProviders === null && window.AlbumHavenPrivateUITransport) requestedProviders = ownedHomeProviders = createHomeBackendProviders(window.AlbumHavenPrivateUITransport, {runtime});
  const {readActivity, resolveActivityTrack, resolveActivityNativeTarget, ...publicProviders} = requestedProviders || {};
  return {...publicProviders, readActivity: runtime?.configureActivityProvider?.({readActivity, resolveActivityTrack, resolveActivityNativeTarget}) ?? null};
}
// The Home controller follows account/provider lifetime. Its view follows the
// native history entry; leaving Home retires both immediately.
function createHomeOwner(host, runtime) {
  let session = null, disposed = false, updating = false, queued = false, configurationDepth = 0;
  function retireSession() {
    const previous = session;
    if (!previous) return;
    session = null;
    previous.unsubscribe?.(); previous.releaseNotifications?.();
    previous.view?.dispose();
    if (activeController === previous.controller) activeController = null;
    previous.controller.dispose();
  }
  function reconcile() {
    if (disposed) return;
    if (updating || configurationDepth) {queued = true; return;}
    updating = true;
    try {
      do {
        queued = false;
        const shell = runtime.snapshot();
        if (!shell.visible) {retireSession(); continue;}
        if (session && (session.scopeKey !== shell.scopeKey || session.generation !== providerGeneration)) retireSession();
        if (!session) {
          const controller = createHomeFriendsController({readRecent: runtime.readRecent, providers,
            onFriendsAuthority: runtime.retireFriendActivity});
          controller.setScope(shell.scopeKey);
          session = {controller, scopeKey: shell.scopeKey, generation: providerGeneration,
            view: null, entryKey: null, initialized: false, payload: undefined,
            notifications: null, releaseNotifications: null};
          activeController = controller;
          session.unsubscribe = controller.subscribe(reconcile);
        }
        const current = session, entryKey = shell.entryKey ?? 'initial';
        const props = {runtime, controller: current.controller, state: current.controller.getSnapshot(), shell,
          readDetail: providers.readDetail, readNowPlaying: providers.readNowPlaying,
          goalsTransport: window.AlbumHavenPrivateUITransport};
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
          // Bootstrap summaries may be empty; always read the genuine seam.
          if (shell.payload) current.controller.loadRecent();
          current.controller.loadFriends();
        }
      } while (queued && !disposed);
    } finally {updating = false;}
  }
  const unsubscribe = runtime.subscribe(reconcile);
  return {
    update: reconcile,
    reconfigure(change) {
      configurationDepth++;
      try {retireSession(); change();}
      finally {configurationDepth--; reconcile();}
    },
    dispose() {if (disposed) return; disposed = true; unsubscribe?.(); retireSession();},
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
function playlistBackend(runtime) {
  if (playlistProviders === null) {
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
  const formats = [{value: 'new', label: 'Create new playlist'}, {value: 'add', label: 'Add to playlist'},
    ...(queue && sourceAdapter.canQueue?.(packet.row_keys) ? queue.timingOptions().map(option => ({value: `queue:${option.value ?? option.id}`, label: option.label, reason: option.reason, disabled: option.enabled !== true})) : [])];
  return Boolean(native.openChoice(anchor, {formats, label: 'Selected track actions', actionMenu: true, menuWidth: 'content',
    updateTriggerLabel: false, initialFocus: 'first', onSelect: value => {
      if (!lifetime.isCurrent()) return false;
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
  const host = document.getElementById('playlists-root'), runtime = window.AlbumHavenPlaylistRuntime;
  if (!playlistMount && host && runtime) {
    playlistMount = mountPlaylists({host, runtime, providers: playlistBackend(runtime)});
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
window.AlbumHavenPlaylistUI = Object.freeze({
  activityMissingEligibility, inspectActivityMissing,
  openLibraryMix() {mountPlaylistSurface(); return playlistMount?.openLibraryMix() ?? false;},
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
    playlistProviders = replacement;
    playlistMount?.configureProviders(playlistProviders);
  },
  refresh() {return playlistMount?.refresh();},
});
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
