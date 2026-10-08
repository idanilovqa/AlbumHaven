import React, {useEffect, useState, useSyncExternalStore} from 'react';
import {createRoot} from 'react-dom/client';
import {mountPlaylists} from '../playlists/index.jsx';
import {createHomeFriendsController} from './model.mjs';
import {HomeFriendsView} from './app.jsx';
import {createFriendNotifications} from './friend-notifications.mjs';
import {FriendNotifications} from './friend-notifications.jsx';

let requestedProviders = {}, providers = {}, providerGeneration = 0, activeController = null, root = null, mountedRuntime = null;
let friendNotifications = null;
function bindProviders(runtime) {
  // The native resolver can inspect private media authority. Only its sanitized
  // activity reader crosses into the React controller.
  const {readActivity, resolveActivityTrack, ...publicProviders} = requestedProviders;
  return {...publicProviders, readActivity: runtime?.configureActivityProvider?.({readActivity, resolveActivityTrack}) ?? null};
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
  return <HomeFriendsView key={shell.entryKey ?? 'initial'} {...{runtime, controller, state, shell}} readDetail={providers.readDetail}/>;
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

let playlistMount = null, playlistProviders = {};
function mountPlaylistSurface() {
  const host = document.getElementById('playlists-root'), runtime = window.AlbumHavenPlaylistRuntime;
  if (!playlistMount && host && runtime) playlistMount = mountPlaylists({host, runtime, providers: playlistProviders});
}
window.AlbumHavenPlaylistUI = Object.freeze({
  configureProviders(next = {}) {
    if (!next || typeof next !== 'object' || Array.isArray(next)) throw new TypeError('Playlist providers must be an object.');
    playlistProviders = {...next}; playlistMount?.configureProviders(playlistProviders);
  },
  refresh() {return playlistMount?.refresh();},
});
window.addEventListener('albumhaven:playlist-runtime-ready', mountPlaylistSurface);
mountPlaylistSurface();
