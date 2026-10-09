// Reconcile the URL-selected identity before initiating any private read. Shared
// native history remains the URL owner; this function only connects projections.
export function loadFriendRoute(controller, {profileRef, friendRef, mode, kind, period}) {
  const projection = controller.getSnapshot().friends;
  if (!['ready', 'empty'].includes(projection.status)) return;
  if (profileRef) {
    if (friendRef || !controller.selectProfile(profileRef)) { controller.selectProfile(null); return; }
    return controller.loadProfile();
  }
  if (!controller.selectFriend(friendRef || null)) {
    controller.selectFriend(null);
    return;
  }
  if (!friendRef) return;
  if (mode === 'comparison') return controller.loadComparison({kind: kind === 'listens' ? 'tracks' : kind, period});
  return controller.loadActivity({kind, period});
}

// Native history snapshots are immutable; live scroll bookkeeping must be local.
export function createScrollState(saved) {
  return {page: saved?.page ?? 0, recent: saved?.recent ?? 0, friends: saved?.friends ?? 0};
}

export function updateOwnedScroll(scroll, target, owners) {
  const key = Object.keys(owners).find(name => owners[name] === target);
  if (!key || !Number.isFinite(target?.scrollTop) || target.scrollTop < 0) return false;
  scroll[key] = target.scrollTop;
  return true;
}

export function scrollRestoreState({section, profileRef, selectedProfileRef, profileExists, profileStatus,
  friendRef, selectedFriendRef, friendExists, friendsStatus, recentStatus, historyStatus}) {
  const ready = status => ['ready', 'empty'].includes(status);
  if (section === 'recent') return ready(recentStatus) ? 'ready' : 'pending';
  if (profileRef) {
    if (friendRef || friendsStatus === 'denied' || profileStatus === 'denied') return 'discard';
    if (!ready(friendsStatus)) return 'pending';
    if (!profileExists) return 'discard';
    return selectedProfileRef === profileRef && ['ready', 'empty', 'unavailable'].includes(profileStatus) ? 'ready' : 'pending';
  }
  if (!friendRef) return ready(friendsStatus) ? 'ready' : 'pending';
  if (!ready(friendsStatus)) return friendsStatus === 'denied' ? 'discard' : 'pending';
  if (!friendExists) return 'discard';
  return selectedFriendRef === friendRef && ready(historyStatus) ? 'ready' : 'pending';
}
