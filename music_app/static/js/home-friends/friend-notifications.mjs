import {createHomeFriendsController, profilePerson} from './model.mjs';

const readable = resource => ['ready', 'empty'].includes(resource?.status);
const requestProviders = value => Object.fromEntries(['readFriends', 'acceptRequest', 'declineRequest', 'cancelRequest']
  .map(name => [name, typeof value?.[name] === 'function' ? value[name] : null]));

// The global drawer needs request authority outside Home. Its bounded fallback
// uses the existing controller with no private-history or profile readers.
export function createFriendNotifications({runtime, notifications, providers = {}}) {
  let supplied = requestProviders(providers), scope = null, home = null, background = null;
  let owner = null, unsubscribeController = null, disposed = false, sequence = 0;
  let snapshot = Object.freeze({dialog: null});
  const listeners = new Set();
  function publish(dialog) {
    if (snapshot.dialog === dialog) return;
    snapshot = Object.freeze({dialog});
    for (const listener of listeners) listener();
  }
  function releaseController() {
    unsubscribeController?.(); unsubscribeController = null;
    const previousBackground = background; background = null;
    owner = null;
    publish(null);
    previousBackground?.dispose();
  }
  function retire() {
    const previous = scope; scope = null;
    if (previous) {previous.projectedOwner = null; previous.projectedFriends = null;}
    previous?.source?.dispose();
    releaseController(); home = null;
  }
  function current(expected) {
    const shell = runtime.snapshot();
    return !disposed && scope === expected && shell.authenticated === true
      && shell.scopeKey === expected?.scopeKey;
  }
  function controllerCurrent(expected, controller) {
    return current(expected) && owner === controller && controller.getSnapshot().scopeKey === expected.scopeKey;
  }
  function requestAt(controller, requestRef) {
    const state = controller.getSnapshot();
    return readable(state.friends) ? state.friends.data?.requests.find(request =>
      request.request_ref === requestRef && request.direction === 'incoming') ?? null : null;
  }
  function register(expected) {
    if (!current(expected) || expected.source || expected.registering || expected.denied || !supplied.readFriends
      || typeof runtime.openFriendRequestForm !== 'function') return;
    expected.registering = true;
    const registration = {};
    expected.registration = registration;
    const registered = () => current(expected) && expected.registration === registration;
    expected.source = notifications.registerSource({name: 'friend-requests', scopeKey: expected.scopeKey,
      isCurrent: registered, onShow: () => registered() ? show(expected) : undefined,
      onOpen: (requestRef, options) => registered() && open(expected, requestRef, options)});
    expected.registering = false;
  }
  function project(expected) {
    if (!current(expected)) return;
    const state = owner?.getSnapshot(), value = state?.friends;
    if (expected.source && expected.projectedOwner === owner && expected.projectedFriends === value) return;
    if (value?.status === 'denied') {
      expected.denied = true;
      expected.registration = null;
      expected.source?.dispose(); expected.source = null;
      expected.projectedOwner = null; expected.projectedFriends = null;
      publish(null); return;
    }
    if (readable(value)) expected.denied = false;
    register(expected);
    const records = readable(value) ? (value.data?.requests ?? []).filter(request => request.direction === 'incoming')
      .map(request => ({id: request.request_ref, title: request.display_name || request.handle || 'Member',
        byline: 'Sent you a friend request', avatarUrl: request.avatar_url, createdAt: request.created_at})) : [];
    if (expected.source) {
      expected.source.replace(records, {status: value?.status ?? 'idle'});
      expected.projectedOwner = owner; expected.projectedFriends = value;
    }
  }
  function own(controller, isBackground = false) {
    releaseController();
    owner = controller;
    if (isBackground) background = controller;
    const expected = scope;
    unsubscribeController = controller.subscribe(() => {
      if (controllerCurrent(expected, controller)) project(expected);
    });
    project(expected);
  }
  function sync() {
    if (disposed) return;
    const shell = runtime.snapshot();
    if (!shell.authenticated || !shell.scopeKey) {retire(); return;}
    if (!scope || scope.scopeKey !== shell.scopeKey) {
      retire();
      scope = {scopeKey: shell.scopeKey, source: null, denied: false};
      register(scope);
      if (!shell.visible && supplied.readFriends) show(scope);
      project(scope);
    }
    if (!shell.visible && home) {
      const expected = scope;
      home = null; releaseController();
      project(expected);
      if (current(expected) && !expected.denied) show(expected);
    }
  }
  function show(expected) {
    if (!current(expected) || !supplied.readFriends || typeof runtime.openFriendRequestForm !== 'function') return;
    if (runtime.snapshot().visible) {project(expected); return;}
    if (!owner) {
      const controller = createHomeFriendsController({providers: supplied, onFriendsAuthority: runtime.retireFriendActivity});
      controller.setScope(expected.scopeKey);
      own(controller, true);
    }
    const state = owner.getSnapshot();
    if (state.friends.status !== 'loading' && state.mutation.status !== 'loading') return owner.loadFriends();
  }
  function open(expected, requestRef, options = {}) {
    const controller = owner;
    if (!controller || !controllerCurrent(expected, controller) || !requestAt(controller, requestRef)
      || options.parentSurface !== '#cover-lookup-drawer' || snapshot.dialog
      || typeof runtime.openFriendRequestForm !== 'function') return false;
    const active = () => controllerCurrent(expected, controller);
    const dialog = {key: ++sequence, controller, requestRef,
      parentSurface: options.parentSurface, returnFocus: options.returnFocus, closed: false, navigated: false};
    const activeDialog = () => active() && snapshot.dialog === dialog;
    dialog.runtime = Object.freeze({...runtime, openForm(formOptions) {
      try {
        if (!activeDialog() || !requestAt(controller, requestRef)) throw new Error('This friend request is no longer available.');
        return runtime.openFriendRequestForm({...formOptions, pageId: 'home-friend-request',
          scopeKey: expected.scopeKey, isCurrent: activeDialog});
      } catch (error) {
        if (activeDialog()) {
          expected.source?.replace([], {status: 'unavailable'});
          expected.projectedFriends = null;
        }
        if (snapshot.dialog === dialog) publish(null);
        throw error;
      }
    }});
    dialog.onClose = options => {
      dialog.closed = options?.current !== false;
      if (snapshot.dialog === dialog) publish(null);
    };
    dialog.onProfile = typeof runtime.openFriendProfile === 'function' ? accountRef => {
      const authorized = () => {
        if (!active()) return false;
        const request = requestAt(controller, requestRef), state = controller.getSnapshot();
        return Boolean(request && request.account_ref === accountRef && request.allowed_actions.can_view_profile === true
          && profilePerson(state, accountRef));
      };
      if (!dialog.closed || dialog.navigated || snapshot.dialog || !authorized()) return false;
      dialog.navigated = true;
      return runtime.openFriendProfile({scopeKey: expected.scopeKey, accountRef, isCurrent: authorized});
    } : undefined;
    publish(dialog);
    return true;
  }
  const unsubscribeRuntime = runtime.subscribe(sync);
  sync();
  return Object.freeze({
    getSnapshot: () => snapshot,
    subscribe(listener) {if (!disposed) listeners.add(listener); return () => listeners.delete(listener);},
    useHome(controller) {
      sync();
      if (!scope || !runtime.snapshot().visible || controller.getSnapshot().scopeKey !== scope.scopeKey) return () => {};
      const lease = {controller}; home = lease;
      own(controller);
      return () => {
        sync();
        if (home !== lease) return;
        home = null; releaseController();
        if (scope) project(scope);
      };
    },
    configure(next) {retire(); supplied = requestProviders(next); sync();},
    refresh() {sync(); return owner?.loadFriends();},
    dispose() {
      if (disposed) return;
      disposed = true; unsubscribeRuntime(); retire(); listeners.clear();
    },
  });
}
