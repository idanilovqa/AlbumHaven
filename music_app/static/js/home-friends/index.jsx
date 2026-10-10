import {createPresencePublisher} from './presence.mjs';
import {normalizeCreationResult, prepareMissingDraft} from '../playlists/creation.mjs';
import {createPlaylistMatchProviders} from '../playlists/match-providers.mjs';
import {createPlaylistBackendProviders} from '../playlists/backend-providers.mjs';
import {createHomeBackendProviders} from './backend-providers.mjs';
import React, {useEffect, useState, useSyncExternalStore} from 'react';
import {createRoot} from 'react-dom/client';
import {mountPlaylists} from '../playlists/index.jsx';
import {createHomeFriendsController} from './model.mjs';
import {HomeFriendsView} from './app.jsx';
import {createFriendNotifications} from './friend-notifications.mjs';
import {FriendNotifications} from './friend-notifications.jsx';
import {mountPlaytableSelection} from '../playtables/selection.jsx';
import {PlaylistActionSession} from '../playlists/selection-actions.jsx';
import {mountAlbumTops} from '../album-tops/index.jsx';
import {createAlbumTopBackendProviders} from '../album-tops/backend-providers.mjs';
import {mountLibraryNavigation} from './library-navigation.jsx';

let requestedProviders = null, providers = {}, providerGeneration = 0, activeController = null, root = null, mountedRuntime = null;
let friendNotifications = null, ownedHomeProviders = null, presencePublisher = null;
function bindProviders(runtime) {
  // The native resolver can inspect private media authority. Only its sanitized
  // activity reader crosses into the React controller.
  if (requestedProviders === null && window.AlbumHavenPrivateUITransport) requestedProviders = ownedHomeProviders = createHomeBackendProviders(window.AlbumHavenPrivateUITransport, {runtime});
  const {readActivity, resolveActivityTrack, resolveActivityNativeTarget, ...publicProviders} = requestedProviders || {};
  return {...publicProviders, readActivity: runtime?.configureActivityProvider?.({readActivity, resolveActivityTrack, resolveActivityNativeTarget}) ?? null};
}
function Session({runtime, shell, notifications}) {
  const [controller] = useState(() => {
    const next = createHomeFriendsController({readRecent: runtime.readRecent, providers, onFriendsAuthority: runtime.retireFriendActivity});
    next.setScope(shell.scopeKey);
    return next;
  });
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    if (shell.payload) controller.acceptRecent(shell.payload);
    else controller.loadRecent();
  }, [controller, shell.payload]);
  useEffect(() => {
    activeController = controller;
    // Bootstrap Home summaries may be intentionally empty; always read the real seam once.
    if (shell.payload) controller.loadRecent();
    controller.loadFriends();
    return () => {if (activeController === controller) activeController = null; controller.dispose();};
  }, [controller]);
  useEffect(() => notifications?.useHome(controller), [controller, notifications]);
  return <HomeFriendsView key={shell.entryKey ?? 'initial'} {...{runtime, controller, state, shell}} readDetail={providers.readDetail} readNowPlaying={providers.readNowPlaying}/>;
}
function Root({runtime, generation, notifications}) {
  const shell = useSyncExternalStore(runtime.subscribe, runtime.snapshot, runtime.snapshot);
  return <>{notifications && <FriendNotifications producer={notifications}/>}
    {shell.visible && <Session key={`${shell.scopeKey}:${generation}`}
      runtime={runtime} shell={shell} notifications={notifications}/>}</>;
}
function renderRoot() {
  root?.render(<Root runtime={mountedRuntime} generation={providerGeneration} notifications={friendNotifications}/>);
}
function mountNotifications() {
  if (!mountedRuntime || friendNotifications || !window.AlbumHavenNotifications?.registerSource) return;
  friendNotifications = createFriendNotifications({runtime: mountedRuntime,
    notifications: window.AlbumHavenNotifications, providers});
  renderRoot();
}
function mount() {
  const runtime = window.AlbumHavenHomeRuntime, host = document.getElementById('home-friends-root');
  if (root || !runtime || !host) return;
  mountedRuntime = runtime;
  if (!presencePublisher && window.AlbumHavenPrivateUITransport && runtime.readPresencePlayback && window.crypto?.randomUUID) {
    presencePublisher = createPresencePublisher({transport: window.AlbumHavenPrivateUITransport,
      readPlayback: runtime.readPresencePlayback, subscribe: runtime.subscribeTrackPlayback, playerRef: window.crypto.randomUUID()});
  }
  providers = bindProviders(runtime);
  mountNotifications();
  root = createRoot(host);
  renderRoot();
}
// The backend integration supplies explicitly authorized DTO readers/writers.
// No demo transport, local store, endpoint guessing, or optimistic persistence.
window.AlbumHavenHomeUI = Object.freeze({
  configureProviders(next = {}) {
    if (!next || typeof next !== 'object' || Array.isArray(next)) throw new TypeError('Home providers must be an object.');
    activeController?.dispose();
    activeController = null;
    ownedHomeProviders?.dispose(); ownedHomeProviders = null;
    requestedProviders = {...next};
    providers = mountedRuntime ? bindProviders(mountedRuntime) : {};
    friendNotifications?.configure(providers);
    providerGeneration++;
    renderRoot();
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

function closePlaylistAction(owner) {
  if (playlistAction !== owner) return;
  playlistAction = null; owner.lifetime.dispose?.(); owner.releasePresentation?.();
  queueMicrotask(() => {owner.root.unmount(); owner.host.remove();});
}
function openPlaylistAction(packet, lifetime, sourceAdapter, anchor, options = {}) {
  const native = window.AlbumHavenPlaylistRuntime;
  if (playlistAction || !native?.playtableFormRuntime || !native.canOpenPlaytableForm?.()
    || !lifetime?.isCurrent?.() || sourceAdapter?.snapshot?.()?.scopeKey !== packet?.scopeKey) return false;
  playlistBackend(native);
  const generation = playlistProviderGeneration;
  const host = document.createElement('div'); document.body.appendChild(host);
  const owner = {host, root: createRoot(host), lifetime};
  const homeRuntime = window.AlbumHavenHomeRuntime, homePresentation = homeRuntime?.snapshot();
  // Native Album sources can use the Playlist adapter generation while their
  // visible Home parent has independently recovered from a denied Recent read.
  // Pin that actual presentation owner; source/target authority stays separate.
  owner.releasePresentation = homePresentation?.visible
    ? homeRuntime.retainPlaytablePresentation?.(homePresentation.scopeKey) : null;
  playlistAction = owner;
  const isCurrent = () => playlistAction === owner && generation === playlistProviderGeneration
    && lifetime.isCurrent() && sourceAdapter.snapshot()?.scopeKey === packet.scopeKey;
  const runtime = native.playtableFormRuntime(isCurrent);
  const surface = anchor?.closest?.('#non-album-modal, #track-modal, [data-resource-selection-content="album"]');
  const parentSurface = surface?.id ? `#${surface.id}` : surface ? '[data-resource-selection-content="album"]' : undefined;
  owner.root.render(<PlaylistActionSession {...{runtime, packet, lifetime, sourceAdapter, parentSurface}} initialMode={options.mode}
    providers={playlistProviders} readDetail={playlistProviders.readDetail}
    returnFocus={() => anchor?.isConnected ? anchor : null}
    onClose={() => closePlaylistAction(owner)}
    onNavigate={async playlist_id => {
      if (!isCurrent()) return false;
      const sourceReceipt = sourceAdapter.retainNavigation?.(packet.row_keys);
      if (!sourceReceipt) return false;
      try {return await native.navigateFromPlaytable({playlist_id, sourceReceipt,
        providerCurrent: () => generation === playlistProviderGeneration});}
      finally {sourceReceipt.dispose();}
    }}
    onNotice={() => native.notifyPlaytableCreation?.()}/>);
  return true;
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
  configureProviders(next = {}) {
    if (!next || typeof next !== 'object' || Array.isArray(next)) throw new TypeError('Playlist providers must be an object.');
    playlistProviderGeneration++;
    if (playlistAction) closePlaylistAction(playlistAction);
    ownedPlaylistProviders?.dispose(); ownedPlaylistProviders = null;
    ownedMatchProviders?.dispose(); ownedMatchProviders = null;
    window.AlbumHavenPlaylistRuntime?.configurePlaybackPreferences?.({});
    playlistProviders = {...next}; playlistMount?.configureProviders(playlistProviders);
  },
  refresh() {return playlistMount?.refresh();},
});
window.addEventListener('albumhaven:playlist-runtime-ready', mountPlaylistSurface);
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
