import {ActivityMissingAction} from './activity-missing.jsx';
import {useNowPlaying} from './now-playing.jsx';
import {QueuePanel, QueueHeader, useExplicitQueue, useQueueDetails} from './queue.jsx';
import React, {useEffect, useLayoutEffect, useRef, useState} from 'react';
import {metric, profilePerson} from './model.mjs';
import {NativeDialog} from './native-dialog.jsx';
import {ComparisonPanel} from './comparison.jsx';
import {ActivityPanel} from './activity.jsx';
import {HistoryNavigation} from './history-navigation.jsx';
import {activityForQuery, navigateActivityHistory} from './history-presentation.mjs';
import {ResourceDetail} from './resource-detail.jsx';
import {detailSelection, detailSelectionKey} from './resource-target.mjs';
import {activitySelectionTarget, recentSelectionRow, reconcileSelectionLease, resolveActivitySelection, resolveActivityTrackSelection, resolveListenedAlbum, retireFriendSelections, sameSelectionTarget, selectionDescriptor,
  selectionEntry, selectionPresentation, selectionQueryKey, selectionSource, updateSelectionEntry} from './selection-presentation.mjs';
import {ComparisonIdentity, ProfileIdentity, ProfileEditor} from './profile.jsx';
import {ViewControl} from './view-control.jsx';
import {createScrollState, loadFriendRoute, scrollRestoreState, updateOwnedScroll} from './navigation.mjs';
import {HOME_PHONE_QUERY, initialHomeKind} from './presentation.mjs';
import {FriendsDirectory} from './friends-directory.jsx';
import {MemberProfile} from './member-profile.jsx';
import {FriendRequestDialog, currentFriendRequest} from './friend-request.jsx';
import {Button, NativeHtml, Period, RecentAlbums, Status, Tabs} from './components.jsx';

const kinds = [['albums', 'Albums'], ['tracks', 'Tracks'], ['artists', 'Artists']];
const comparisonKinds = kinds.slice(0, 3);
const homeSections = [['recent', 'Recent'], ['news', 'News', {disabled: true}], ['queue', 'Queue']];

export function HomeFriendsView({runtime, controller, state, shell, readDetail, readNowPlaying}) {
  const pageRoot = useRef(null), profileFocus = useRef(null), selectedFocus = useRef(null), selectionOpener = useRef(null);
  const root = useRef(null), recentWidget = useRef(null), friendsWidget = useRef(null), albumWidget = useRef(null), artistWidget = useRef(null), dashboard = useRef(null);
  const saved = shell.presentation;
  const [{kind, kindExplicit}, setKind] = useState(() => initialHomeKind(saved,
    typeof window !== 'undefined' && (window.matchMedia?.(HOME_PHONE_QUERY).matches ?? window.innerWidth <= 900)));
  const [homeSection, setHomeSection] = useState(saved?.homeSection === 'queue' ? 'queue' : 'recent');
  const queue = useExplicitQueue(runtime);
  const [period, setPeriod] = useState(saved?.period || 'week');
  const [views, setViews] = useState({tracks: 'grouped', artists: 'list', ...saved?.views, albums: 'cards'});
  const [friendViews, setFriendViews] = useState(saved?.friendViews || {albums: 'cards', tracks: 'grouped', artists: 'list'});
  const recentKind = kind === 'tracks' && views.tracks === 'history' ? 'listens' : kind;
  const [friendKind, setFriendKind] = useState(saved?.friendKind || 'tracks'), [friendPeriod, setFriendPeriod] = useState(saved?.friendPeriod || 'week');
  const friendActivityKind = friendKind === 'tracks' && friendViews.tracks === 'history' ? 'listens' : friendKind;
  const [friendMode, setFriendMode] = useState(saved?.friendMode || 'activity'), [selectedAlbum, setSelectedAlbum] = useState(saved?.selectedAlbum || null);
  const [selections, setSelections] = useState(() => {
    const entries = selectionPresentation(saved?.selectionPresentation);
    if (!entries.length && saved?.selectedAlbum) return updateSelectionEntry(entries,
      {section: 'recent', account_ref: null, kind: 'albums', period: 'week'}, {
        pane: saved.expanded === 'recent' ? 'recent' : 'album',
        expanded: saved.expanded === 'selection' ? 'album' : saved.expanded,
        scroll: {source: saved.scroll?.recent},
      });
    return entries;
  });
  const [listenedAlbumsHost, setListenedAlbumsHost] = useState(null), [artistDetail, setArtistDetail] = useState(null);
  const [albumDetail, setAlbumDetail] = useState(null);
  const [editing, setEditing] = useState(null), [actionError, setActionError] = useState('');
  const [directoryDialog, setDirectoryDialog] = useState(false);
  const [requestDialog, setRequestDialog] = useState(null);
  const [comparison, setComparison] = useState(saved?.comparison || null);
  const [comparisonViewHost, setComparisonViewHost] = useState(null);
  const savedScroll = saved?.scroll && {...saved.scroll, ...(saved.kindExplicit === false && saved.kind !== kind ? {recent: 0} : {})};
  const scroll = useRef(createScrollState(savedScroll)), pendingScroll = useRef(savedScroll), scrollTimer = useRef(null);
  const section = shell.section === 'friends' ? 'friends' : 'recent';
  const queueMode = section === 'recent' && homeSection === 'queue';
  const queueDetails = useQueueDetails({runtime, api: queue.api, scopeKey: state.scopeKey, enabled: queueMode});
  const friend = state.friends.data?.friends.find(person => person.account_ref === state.selectedFriendRef && person.account_ref === shell.friendRef);
  const invalidFriend = Boolean(section === 'friends' && shell.friendRef && ['ready', 'empty'].includes(state.friends.status)
    && !state.friends.data?.friends.some(person => person.account_ref === shell.friendRef));
  const profile = state.friends.data?.profile;
  const profileRoute = section === 'friends' && Boolean(shell.profileRef);
  const comparing = !profileRoute && section === 'friends' && Boolean(friend) && friendMode === 'comparison';
  const memberSource = profileRoute ? profilePerson(state, shell.profileRef) : null;
  const memberProfile = memberSource && state.selectedProfileRef === shell.profileRef
    ? state.profile?.status === 'ready' && state.profile.data?.account_ref === shell.profileRef ? state.profile.data
      : state.profile?.status === 'unavailable' ? memberSource : null : null;
  const activityFor = (accountRef, historyKind, historyPeriod) => activityForQuery(state,
    {account_ref: accountRef, kind: historyKind, period: historyPeriod});
  const currentRecent = kind === 'albums' && period === 'week' ? state.recent
    : state.selectedFriendRef === null ? activityFor(null, recentKind, period) : {status: 'loading', data: null};
  const friendResource = friendMode === 'comparison' ? state.comparison : friend?.allowed_actions?.can_view_activity === true
    ? activityFor(shell.friendRef, friendActivityKind, friendPeriod) : {status: 'denied', data: null};
  const nowPlaying = useNowPlaying({read: readNowPlaying, scopeKey: state.scopeKey, accountRef: shell.friendRef,
    allowed: section === 'friends' && !profileRoute && friendMode === 'activity' && friend?.allowed_actions?.can_view_activity === true});
  const historyKey = JSON.stringify([state.scopeKey, section, section === 'friends' ? shell.friendRef : null,
    section === 'friends' ? friendActivityKind : recentKind, section === 'friends' ? friendPeriod : period,
    section === 'friends' ? friendMode : 'activity']);
  const currentHistoryKey = useRef(historyKey); currentHistoryKey.current = historyKey;
  const query = {section, account_ref: section === 'friends' ? shell.friendRef : null,
    kind: section === 'friends' ? friendActivityKind : recentKind, period: section === 'friends' ? friendPeriod : period};
  const queryKey = selectionQueryKey(query), selectionEnabled = section === 'recent'
    || Boolean(friend && !profileRoute && friendMode === 'activity' && friend.allowed_actions?.can_view_activity === true);
  const source = section === 'recent' || !profileRoute && friendMode === 'activity'
    ? selectionSource(state, query) : {status: 'unavailable', data: null};
  const entry = selectionEntry(selections, query), expanded = entry.expanded;
  const ownRecent = section === 'recent' && kind === 'albums' && period === 'week';
  const customDetail = typeof readDetail === 'function';
  const selectedRow = ownRecent && selectionEnabled && !queueMode ? recentSelectionRow(source, selectedAlbum, {customDetail}) : null;
  const recentOrigin = {source: 'recent', account_ref: null, kind: 'albums', period: 'week'};
  // Only the native fallback may translate native browse authority. Custom
  // detail reads keep the exact supplied grant for their own strict boundary.
  const recentTarget = selectedRow && (customDetail
    ? {kind: 'album', ref: selectedRow.album_ref, allowed_actions: selectedRow.allowed_actions, origin: recentOrigin}
    : detailSelection({...runtime.albumDetailSelection?.(selectedRow.album_ref, state.scopeKey), origin: recentOrigin}));
  const candidate = selectionEnabled && !ownRecent ? resolveActivitySelection(state, query, entry.selected) : null;
  const trackCandidate = selectionEnabled ? resolveActivityTrackSelection(state, query, entry.tracks) : null;
  const detailProvider = queueMode ? queueDetails.adapter?.readAlbumProjection : customDetail ? readDetail : runtime.readAlbumProjection;
  const resourceLease = useRef(null);
  if (!queueMode) resourceLease.current = reconcileSelectionLease(resourceLease.current, {scopeKey: state.scopeKey, queryKey, descriptor: ownRecent ? null : entry.tracks || entry.selected,
    source, target: trackCandidate?.album || trackCandidate?.artist || candidate?.target, runtime, provider: detailProvider});
  const retiredSelection = !queueMode && resourceLease.current?.retired === true;
  const resolved = retiredSelection ? null : candidate;
  const trackSelection = queueMode || retiredSelection ? null : trackCandidate;
  const selectedTarget = queueMode ? null : ownRecent ? recentTarget : resolved?.target;
  const artistTarget = queueMode ? queueDetails.value.artist : trackSelection?.artist || (selectedTarget?.kind === 'artist' ? selectedTarget : null);
  const targetKey = queueMode ? JSON.stringify(['queue', queueDetails.value.selectedIds, detailSelectionKey(queueDetails.value.album), detailSelectionKey(queueDetails.value.artist)]) : trackSelection ? JSON.stringify([entry.tracks, detailSelectionKey(trackSelection.album), detailSelectionKey(artistTarget)]) : detailSelectionKey(selectedTarget);
  const lifetime = useRef(null), lifetimeSequence = useRef(0);
  if (lifetime.current?.scopeKey !== state.scopeKey || lifetime.current?.queryKey !== queryKey
    || lifetime.current?.targetKey !== targetKey || lifetime.current?.source !== source
    || lifetime.current?.runtime !== runtime || lifetime.current?.provider !== detailProvider
    || lifetime.current?.enabled !== selectionEnabled) {
    lifetime.current = {scopeKey: state.scopeKey, queryKey, targetKey, source, runtime, provider: detailProvider,
      enabled: selectionEnabled, generation: ++lifetimeSequence.current};
  }
  const owner = lifetime.current;
  const liveArtistDetail = artistDetail?.owner === owner ? artistDetail.value : null;
  const currentArtistDetail = useRef(null); currentArtistDetail.current = {owner, value: liveArtistDetail};
  const childAlbum = queueMode ? null : resolveListenedAlbum(liveArtistDetail, artistTarget, entry.childAlbumRef);
  const albumTarget = queueMode ? queueDetails.value.album : childAlbum || trackSelection?.album || (selectedTarget?.kind === 'album' ? selectedTarget : null);
  const albumTargetKey = detailSelectionKey(albumTarget), currentAlbum = useRef(null);
  currentAlbum.current = {owner, key: albumTargetKey};
  const selectedQueue = queueMode && queueDetails.value.selectedIds.length > 0;
  const hasArtist = Boolean(artistTarget || trackSelection || selectedQueue), hasAlbum = Boolean(albumTarget || selectedRow || trackSelection || selectedQueue), hasSelection = hasArtist || hasAlbum;
  const activePane = entry.pane === 'artist' && hasArtist || entry.pane === 'album' && hasAlbum ? entry.pane : 'recent';
  const currentQuery = useRef(null); currentQuery.current = {queryKey, owner};
  const updateEntry = patch => setSelections(previous => updateSelectionEntry(previous, query, patch));
  const setExpanded = next => updateEntry({expanded: next});
  const sourceWidget = section === 'friends' ? friendsWidget : recentWidget;
  const sourceBody = () => sourceWidget.current?.querySelector(section === 'friends'
    ? ':scope > .home-friends__widget-body' : '.home-recent__body, .home-friends__scroll');
  const sourceCurrent = () => currentQuery.current?.owner === owner && controller.getSnapshot().scopeKey === state.scopeKey
    && owner.provider === (typeof readDetail === 'function' ? readDetail : runtime.readAlbumProjection)
    && selectionSource(controller.getSnapshot(), query) === source;
  const targetCurrent = () => queueMode ? currentQuery.current?.owner === owner && queueDetails.adapter && queueDetails.adapter.getSnapshot() === queueDetails.value && queueDetails.value.selectedIds.length > 0 && controller.getSnapshot().scopeKey === state.scopeKey : sourceCurrent() && (ownRecent ? selectedRow && selectedAlbum === selectedRow.album_ref
    : trackSelection ? Boolean(resolveActivityTrackSelection(controller.getSnapshot(), query, entry.tracks))
      : sameSelectionTarget(resolveActivitySelection(controller.getSnapshot(), query, entry.selected)?.target, selectedTarget));
  const albumCurrent = () => targetCurrent() && currentAlbum.current?.owner === owner && currentAlbum.current.key === albumTargetKey;
  const restorationKey = JSON.stringify([section, shell.friendRef, shell.profileRef, kind, period, views, friendKind, friendPeriod, friendViews, friendMode]);
  const originalRestorationKey = useRef(restorationKey);
  const changeView = setter => value => {pendingScroll.current = null; setter(value);};

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(HOME_PHONE_QUERY);
    const resize = () => setKind(current => {
      if (current.kindExplicit) return current;
      const next = initialHomeKind(null, media.matches);
      return next.kind === current.kind ? current : next;
    });
    media.addEventListener?.('change', resize);
    return () => media.removeEventListener?.('change', resize);
  }, []);

  useLayoutEffect(() => {
    const descriptor = (key, element) => ({key, element, header: element.querySelector(':scope > header'), body: element.querySelector(':scope > .home-friends__widget-body')});
    const widgets = [descriptor(section, sourceWidget.current),
      ...(hasArtist ? [descriptor('artist', artistWidget.current)] : []),
      ...(hasAlbum ? [descriptor('album', albumWidget.current)] : [])];
    dashboard.current = runtime.mountDashboard(root.current, {widgets, returnPresentation: 'back', onSizeIntent: (_key, next) => {
      if (currentQuery.current?.owner !== owner) return;
      pendingScroll.current = null; setExpanded(next);
    }});
    return () => {dashboard.current?.dispose(); dashboard.current = null;};
  }, [runtime, section, hasArtist, hasAlbum, owner]);
  useLayoutEffect(() => {
    const available = expanded === section || expanded === 'artist' && hasArtist || expanded === 'album' && hasAlbum;
    dashboard.current?.update({expandedKey: available ? expanded : null});
  }, [section, expanded, hasArtist, hasAlbum, owner]);
  useLayoutEffect(() => {
    const phone = typeof window !== 'undefined' && window.matchMedia?.(HOME_PHONE_QUERY).matches === true;
    if (!selectedFocus.current || phone && activePane !== 'recent') return;
    const pending = selectedFocus.current; selectedFocus.current = null;
    if (pending.queryKey !== queryKey) return;
    const scope = sourceWidget.current;
    const control = (pending.control?.isConnected && scope?.contains(pending.control) ? pending.control
      : [...(scope?.querySelectorAll('[data-gallery-card-intent="select"], [data-home-activity-select], [data-home-artist-select]') || [])]
        .find(button => [button.getAttribute('data-gallery-card-ref'), button.getAttribute('data-home-activity-select'),
          button.getAttribute('data-home-artist-select')].includes(pending.ref)))
      || scope?.querySelector('[data-in-page-tab][aria-selected="true"]');
    if (control && !control.closest('[hidden], [inert], [data-dashboard-widget-state="suppressed"]')) control.focus({preventScroll: true});
  }, [activePane, hasSelection, section, queryKey]);
  useLayoutEffect(() => {
    if (typeof window === 'undefined' || window.matchMedia?.(HOME_PHONE_QUERY).matches !== true || activePane === 'recent') return;
    const active = pageRoot.current?.ownerDocument.activeElement;
    const focusedPane = active?.closest?.('[data-home-widget]')?.getAttribute('data-home-widget');
    if (!active?.isConnected || active === pageRoot.current?.ownerDocument.body || focusedPane && focusedPane !== activePane) {
      pageRoot.current.querySelector(`[data-in-page-tab="${activePane}"]`)?.focus({preventScroll: true});
    }
  }, [activePane, queryKey]);
  useLayoutEffect(() => {
    // A completed removal/denial permanently retires the descriptor, so an
    // identically named later row cannot resurrect a prior selection.
    if (queueMode || !queryKey || profileRoute || section === 'friends' && friendMode !== 'activity') return;
    const terminal = ['ready', 'empty', 'denied'].includes(source.status);
    if (terminal && ownRecent && selectedAlbum && !selectedRow) setSelectedAlbum(null);
    if ((terminal || retiredSelection) && !ownRecent && (entry.selected && !resolved || entry.tracks && !trackSelection)) updateEntry({selected: null, tracks: null, childAlbumRef: null, pane: 'recent', expanded: null});
    else if (entry.childAlbumRef && liveArtistDetail && ['ready', 'empty', 'denied'].includes(liveArtistDetail.status)
      && !childAlbum) updateEntry({childAlbumRef: null, pane: hasArtist ? 'artist' : 'recent', expanded: null});
  }, [selectionEnabled, queryKey, profileRoute, section, friendMode, source, ownRecent, selectedAlbum, selectedRow, retiredSelection, resolved?.target?.ref,
    entry.selected, entry.tracks, trackSelection, entry.childAlbumRef, liveArtistDetail, childAlbum?.ref]);
  useLayoutEffect(() => {
    if (selectedAlbum && ['ready', 'empty', 'denied'].includes(state.recent.status)
      && !recentSelectionRow(state.recent, selectedAlbum, {customDetail})) setSelectedAlbum(null);
  }, [state.recent, selectedAlbum, customDetail]);
  useLayoutEffect(() => {setSelections(previous => retireFriendSelections(previous, state.friends));}, [state.friends]);
  useEffect(() => {
    if (section === 'recent') {
      controller.selectFriend(null);
      if (kind === 'albums' && period === 'week') return;
      controller.loadActivity({kind: recentKind, period});
    }
  }, [controller, section, kind, recentKind, period]);
  useEffect(() => {
    if (section === 'friends') loadFriendRoute(controller, {profileRef: shell.profileRef, friendRef: shell.friendRef, mode: friendMode, kind: friendMode === 'comparison' ? friendKind : friendActivityKind, period: friendPeriod});
  }, [controller, section, shell.friendRef, shell.profileRef, state.friends, state.members, friendMode, friendKind, friendActivityKind, friendPeriod]);
  useEffect(() => {setActionError('');}, [queryKey]);
  useEffect(() => {setEditing(null); setRequestDialog(null);}, [section, shell.friendRef, shell.profileRef]);
  useEffect(() => {if (state.friends.status === 'denied') setEditing(null);}, [state.friends.status]);
  useLayoutEffect(() => {
    const pending = profileFocus.current;
    if (!editing && pending) {
      profileFocus.current = null;
      const control = pending.control?.isConnected ? pending.control : pageRoot.current?.querySelector('[data-home-profile-edit]');
      if (pending.section === section && pending.friendRef === shell.friendRef && control && !control.closest('[hidden], [inert]')) control.focus({preventScroll: true});
    }
  }, [editing, profile, section, shell.friendRef]);
  function closeProfile({restoreFocus = true} = {}) {
    profileFocus.current = restoreFocus ? {control: editing?.control, section, friendRef: shell.friendRef} : null;
    setEditing(null);
  }
  useEffect(() => {
    if (!comparison?.selection) return;
    const owner = state.friends.data?.friends.find(person => person.account_ref === comparison.friendRef);
    if (state.friends.status === 'denied' || (['ready', 'empty'].includes(state.friends.status) && owner?.allowed_actions?.can_compare !== true)) {
      setComparison({...comparison, selection: null});
    }
  }, [comparison, state.friends]);
  const presentation = {homeSection, kind, kindExplicit, period, views, friendKind, friendPeriod, friendViews, friendMode, selectedAlbum, expanded, comparison, selectionPresentation: selections};
  const latestPresentation = useRef(presentation); latestPresentation.current = presentation;
  useEffect(() => {runtime.savePresentation({...presentation, scroll: scroll.current}, shell);},
    [runtime, homeSection, kind, kindExplicit, period, views, friendKind, friendPeriod, friendViews, friendMode, selectedAlbum, expanded, comparison, selections]);
  useLayoutEffect(() => {
    if (!pendingScroll.current) return;
    if (restorationKey !== originalRestorationKey.current) {pendingScroll.current = null; return;}
    const restore = scrollRestoreState({section, friendRef: shell.friendRef, selectedFriendRef: state.selectedFriendRef,
      profileRef: shell.profileRef, selectedProfileRef: state.selectedProfileRef, profileExists: Boolean(memberSource), profileStatus: state.profile?.status,
      friendExists: state.friends.data?.friends.some(person => person.account_ref === shell.friendRef),
      friendsStatus: state.friends.status, recentStatus: currentRecent.status, historyStatus: friendResource.status});
    if (restore === 'discard') {pendingScroll.current = null; return;}
    if (restore !== 'ready') return;
    const recentBody = recentWidget.current?.querySelector('.home-recent__body, .home-friends__scroll');
    if (recentBody) recentBody.scrollTop = pendingScroll.current.recent;
    if (friendsWidget.current) friendsWidget.current.querySelector('.home-friends__widget-body').scrollTop = pendingScroll.current.friends;
    if (pageRoot.current) pageRoot.current.scrollTop = pendingScroll.current.page;
    pendingScroll.current = null;
  }, [section, shell.friendRef, shell.profileRef, state.selectedFriendRef, state.selectedProfileRef, state.profile, memberSource, currentRecent.status, friendResource.status, state.friends, restorationKey]);
  useEffect(() => () => {if (scrollTimer.current !== null) clearTimeout(scrollTimer.current);}, []);
  function rememberScroll(event) {
    const target = event.target;
    const selectionPane = target === sourceBody() ? 'source'
      : target === artistWidget.current?.querySelector(':scope > .home-friends__widget-body') ? 'artist'
      : target === albumWidget.current?.querySelector(':scope > .home-friends__widget-body') ? 'album' : null;
    if (selectionPane && queryKey && Number.isFinite(target.scrollTop) && target.scrollTop >= 0) {
      setSelections(previous => updateSelectionEntry(previous, query, {scroll: {[selectionPane]: target.scrollTop}}));
    }
    if (!updateOwnedScroll(scroll.current, target, {
      page: pageRoot.current,
      recent: recentWidget.current?.querySelector('.home-recent__body, .home-friends__scroll'),
      friends: friendsWidget.current?.querySelector(':scope > .home-friends__widget-body'),
    })) return;
    pendingScroll.current = null;
    if (scrollTimer.current !== null) clearTimeout(scrollTimer.current);
    const expected = shell;
    scrollTimer.current = setTimeout(() => {scrollTimer.current = null; runtime.savePresentation({...latestPresentation.current, scroll: scroll.current}, expected);}, 150);
  }
  function navigate(next, friendRef = '', profileRef = '', mode) {
    pendingScroll.current = null;
    runtime.savePresentation({...presentation, ...(mode ? {friendMode: mode} : {}), scroll: scroll.current}, shell);
    setDirectoryDialog(false);
    setEditing(null); setRequestDialog(null); setActionError('');
    runtime.navigate({section: next, friend: friendRef, profile: profileRef});
  }
  function openProfile(accountRef) {
    const current = controller.getSnapshot();
    if (current.scopeKey !== state.scopeKey || !profilePerson(current, accountRef)) return;
    navigate('friends', '', accountRef);
  }
  function openRequest(requestRef, trigger) {
    const current = controller.getSnapshot();
    if (current.scopeKey !== state.scopeKey || !currentFriendRequest(current, requestRef)) return;
    setDirectoryDialog(false);
    setRequestDialog({requestRef, scopeKey: state.scopeKey, returnFocus: () =>
      trigger?.isConnected && !trigger.closest('[hidden], [inert]') ? trigger : pageRoot.current?.querySelector('[data-home-open-friends]')});
  }
  function openFriend(accountRef, mode) {
    const current = controller.getSnapshot(), grant = mode === 'comparison' ? 'can_compare' : 'can_view_activity';
    const person = ['ready', 'empty'].includes(current.friends.status)
      && current.friends.data?.friends.find(value => value.account_ref === accountRef);
    if (current.scopeKey !== state.scopeKey || person?.relationship !== 'accepted' || person.allowed_actions?.[grant] !== true) return;
    navigate('friends', accountRef, '', mode);
  }
  function selectResource(row, targetKind) {
    if (!sourceCurrent()) return;
    if (row === null) {
      currentQuery.current = null;
      updateEntry({selected: null, tracks: null, childAlbumRef: null, pane: 'recent', expanded: null});
      return;
    }
    if (source.status !== 'ready' || !source.data?.rows?.includes(row)) return;
    const target = activitySelectionTarget(row, targetKind, query, source);
    if (!target) return;
    resourceLease.current = null;
    currentQuery.current = null;
    pendingScroll.current = null;
    selectionOpener.current = selectedFocus.current = {queryKey, ref: row.id, control: typeof document !== 'undefined' ? document.activeElement : null};
    updateEntry({selected: selectionDescriptor(row, target, source), tracks: null, childAlbumRef: null,
      pane: target.kind, expanded: null, scroll: {artist: 0, album: 0}});
  }
  function selectQueuedTracks(ids, {inspect = false} = {}) {
    if (!queueMode || currentQuery.current?.owner !== owner || !queueDetails.adapter || controller.getSnapshot().scopeKey !== state.scopeKey) return;
    if (!inspect && JSON.stringify(queueDetails.value.selectedIds) === JSON.stringify(ids)) return;
    pendingScroll.current = null;
    selectionOpener.current = {queryKey, ref: ids[0], control: typeof document !== 'undefined' ? document.activeElement : null};
    updateEntry({pane: 'recent', expanded: null, childAlbumRef: null});
    Promise.resolve(queueDetails.adapter.select(ids)).catch(() => {});
  }
  function selectTracks(rowIds, {inspect = false} = {}) {
    if (!sourceCurrent() || !selectionEnabled || !['tracks', 'listens'].includes(query.kind)) return;
    const tracks = {rowIds: [...rowIds], snapshotRef: source.data?.snapshot_ref ?? null};
    if (rowIds.length && !resolveActivityTrackSelection(controller.getSnapshot(), query, tracks)) return;
    if (!inspect && JSON.stringify(entry.tracks?.rowIds || []) === JSON.stringify(rowIds)) return;
    resourceLease.current = null;
    currentQuery.current = null;
    pendingScroll.current = null;
    selectionOpener.current = {queryKey, ref: rowIds[0], control: typeof document !== 'undefined' ? document.activeElement : null};
    updateEntry({selected: null, tracks: rowIds.length ? tracks : null, childAlbumRef: null,
      pane: 'recent', expanded: null, scroll: {artist: 0, album: 0}});
  }
  function selectRecentAlbum(ref) {
    if (!sourceCurrent() || !ownRecent) return;
    if (ref !== null && !recentSelectionRow(source, ref, {customDetail})) return;
    currentQuery.current = null;
    pendingScroll.current = null;
    selectionOpener.current = selectedFocus.current = ref ? {queryKey, ref, control: typeof document !== 'undefined' ? document.activeElement : null} : null;
    setSelectedAlbum(ref); updateEntry({pane: ref ? 'album' : 'recent', expanded: null, scroll: {album: 0}});
  }
  function selectedArtistChanged(value, target) {
    if (!targetCurrent() || !sameSelectionTarget(target, artistTarget)) return;
    currentArtistDetail.current = {owner, value};
    setArtistDetail(previous => previous?.owner === owner && previous.value === value ? previous : {owner, value});
  }
  function selectedAlbumChanged(value, target) {
    if (!albumCurrent() || !sameSelectionTarget(target, albumTarget)) return;
    setAlbumDetail(previous => previous?.owner === owner && previous.value === value ? previous : {owner, value});
  }
  function selectListenedAlbum(target) {
    if (!targetCurrent() || currentArtistDetail.current?.owner !== owner
      || currentArtistDetail.current.value !== liveArtistDetail) return;
    const current = resolveListenedAlbum(liveArtistDetail, artistTarget, target?.ref);
    if (!sameSelectionTarget(current, target)) return;
    currentAlbum.current = {owner, key: detailSelectionKey(current)};
    pendingScroll.current = null;
    updateEntry({childAlbumRef: current.ref, pane: 'album', expanded: null, scroll: {album: 0}});
  }
  function showPane(next) {
    if (currentQuery.current?.owner !== owner || !['recent', ...(hasArtist ? ['artist'] : []), ...(hasAlbum ? ['album'] : [])].includes(next)) return;
    if (next === 'recent') selectedFocus.current = selectionOpener.current;
    pendingScroll.current = null; updateEntry({pane: next});
  }
  function closeSelection(which) {
    if (queueMode) {if (targetCurrent()) {queueDetails.adapter.clear(); updateEntry({pane: 'recent', expanded: null});} return;}
    if (!targetCurrent() || which === 'album' && !albumCurrent()) return;
    currentQuery.current = null;
    if (which === 'album' && childAlbum) {
      selectedFocus.current = selectionOpener.current;
      updateEntry({childAlbumRef: null, pane: 'artist', expanded: null});
    }
    else {
      selectedFocus.current = selectionOpener.current;
      if (ownRecent) setSelectedAlbum(null);
      updateEntry({selected: null, tracks: null, childAlbumRef: null, pane: 'recent', expanded: null});
    }
  }
  const restoredPaneScroll = useRef({source: null, artist: null, album: null});
  useLayoutEffect(() => {
    const restore = (name, key, element, ready) => {
      if (!ready || !element || restoredPaneScroll.current[name] === key) return;
      restoredPaneScroll.current[name] = key;
      if (selections.some(value => selectionQueryKey(value.query) === queryKey)) element.scrollTop = entry.scroll[name];
    };
    restore('source', queryKey, sourceBody(), ['ready', 'empty'].includes(source.status));
    restore('artist', `${owner.generation}:${detailSelectionKey(artistTarget)}`, artistWidget.current?.querySelector(':scope > .home-friends__widget-body'),
      hasArtist && liveArtistDetail?.status === 'ready');
    restore('album', `${owner.generation}:${albumTargetKey}`, albumWidget.current?.querySelector(':scope > .home-friends__widget-body'),
      hasAlbum && albumDetail?.owner === owner && albumDetail.value.status === 'ready');
  }, [queryKey, source.status, artistTarget, albumTarget, liveArtistDetail, albumDetail, hasArtist, hasAlbum, owner]);
  const retryRecent = () => kind === 'albums' && period === 'week' ? controller.loadRecent() : controller.loadActivity({kind: recentKind, period});
  const friendControls = <div className="home-friends__control-row"><Tabs runtime={runtime} id="home-friend-kinds" label={friendMode === 'comparison' ? 'Comparison view' : 'Friend activity view'} items={comparisonKinds} value={friendKind} onChange={changeView(setFriendKind)}/>
    <Period runtime={runtime} value={friendPeriod} onChange={changeView(setFriendPeriod)} total={friendResource.data?.total_listens} range={friendResource.data?.range_label}/></div>;
  const retryFriend = () => friendMode === 'comparison' ? controller.loadComparison({kind: friendKind, period: friendPeriod}) : controller.loadActivity({kind: friendActivityKind, period: friendPeriod});
  const navigateHistory = (method, target) => navigateActivityHistory({controller, snapshot: state, method, target,
    query: {account_ref: section === 'friends' ? shell.friendRef : null,
      kind: section === 'friends' ? friendActivityKind : recentKind, period: section === 'friends' ? friendPeriod : period},
    isCurrent: () => currentHistoryKey.current === historyKey && (section !== 'friends' || friendMode === 'activity'),
    onIntent: () => {pendingScroll.current = null;}, onPageCommitted: () => {
      const body = section === 'friends' ? friendsWidget.current?.querySelector('.home-friends__widget-body')
        : recentWidget.current?.querySelector('.home-friends__scroll');
      if (body) body.scrollTop = 0;
    }});
  const historyControls = value => <HistoryNavigation runtime={runtime} value={value} navigation={state.activityNavigation} queryKey={historyKey}
    onPage={page => navigateHistory('loadActivityPage', page)} onLoadMore={() => navigateHistory('loadMoreActivity')}
    onRetry={() => navigateHistory('retryActivityNavigation')}/>;
  return <div ref={pageRoot} className="home-friends" onScrollCapture={rememberScroll} data-home-section={section} data-home-pane={activePane}>
    <header className="gallery-bar home-friends__page-header">
      <div className={`gallery-bar__context${comparing ? ' home-comparison__header-context' : ''}`}>{profileRoute ? <ProfileIdentity runtime={runtime} profile={memberProfile} own={false} fallbackName="Profile"/>
        : comparing
        ? <><Button runtime={runtime} icon="back" attributes={{'data-home-comparison-back': 'true'}} onClick={() => navigate('friends')}>Back to friends</Button>
          <ComparisonIdentity runtime={runtime} profile={profile} friend={friend}/></>
        : <ProfileIdentity runtime={runtime} profile={section === 'friends' && friend ? friend : profile} own={!(section === 'friends' && friend)} fallbackName={shell.accountName || 'My music'} onEdit={event => setEditing({profile, control: event.target.closest('button')})}/>}</div>
      <div className="gallery-bar__actions">
        {comparing ? <span ref={setComparisonViewHost} data-home-comparison-view-host="true"/>
          : <Button runtime={runtime} icon="friends" attributes={{'data-home-open-friends': 'true'}} onClick={() => {if (section === 'recent' && window.innerWidth > 900) setDirectoryDialog(true); else navigate(section === 'friends' ? 'recent' : 'friends');}} selected={section === 'friends'}>Friends</Button>}
      </div>
    </header>
    {editing && state.friends.status !== 'denied' && <NativeDialog runtime={runtime} title="Edit profile" onClose={closeProfile}><ProfileEditor key={state.scopeKey} runtime={runtime} profile={editing.profile} controller={controller} onClose={closeProfile}/></NativeDialog>}
    {directoryDialog && <NativeDialog runtime={runtime} title="Friends" contentOwnsFooter={false} onClose={() => setDirectoryDialog(false)}><FriendsDirectory runtime={runtime} value={state.friends} selected={state.selectedFriendRef} controller={controller} onSelect={ref => navigate('friends', ref)} onProfile={openProfile} onRequest={openRequest}/></NativeDialog>}
    {requestDialog?.scopeKey === state.scopeKey && <FriendRequestDialog key={`${state.scopeKey}:${requestDialog.requestRef}`} runtime={runtime} controller={controller}
      requestRef={requestDialog.requestRef} returnFocus={requestDialog.returnFocus} onClose={() => setRequestDialog(null)} onProfile={openProfile}/>}
    {actionError && <NativeHtml html={runtime.alertHtml({severity: 'error', role: 'alert', message: actionError})}/>}
    {hasSelection && <div className="gallery-bar home-friends__pane-navigation">
      <Button runtime={runtime} icon="back" onClick={() => showPane(activePane === 'album' && hasArtist ? 'artist' : 'recent')}
        disabled={activePane === 'recent'}>{activePane === 'album' && hasArtist ? 'Back to Artist Info' : queueMode ? 'Back to Queue' : 'Back to Recent'}</Button>
      <Tabs runtime={runtime} id="home-selected-sections" label="Selected resource sections"
        items={ [['recent', queueMode ? 'Queue' : 'Recent'], ...(hasArtist ? [['artist', 'Artist Info']] : []), ...(hasAlbum ? [['album', 'Album Info']] : [])] }
        value={activePane} onChange={showPane}/>
    </div>}
    <div ref={root} className="home-friends__dashboard">
      <section ref={recentWidget} className="home-friends__widget" hidden={section !== 'recent'} data-home-widget="recent" aria-label={queueMode ? 'Queued tracks' : 'Recent listening'}>
        <header className="gallery-bar home-friends__widget-header home-friends__recent-header">
          <div className="home-friends__control-row home-friends__section-controls">
            <Tabs runtime={runtime} id="home-recent-sections" label="Home sections" items={section === 'recent' ? homeSections : homeSections.filter(([key]) => key !== 'queue')} value={homeSection} onChange={setHomeSection}/>
            {homeSection === 'recent' && <Period runtime={runtime} value={period} onChange={changeView(setPeriod)} total={currentRecent.data?.total_listens} range={currentRecent.data?.range_label || (period === 'week' ? 'Last 7 days' : '')}/>}
            {section === 'recent' && homeSection === 'queue' && <QueueHeader runtime={runtime} {...queue}/>}
          </div>
          <div className="home-friends__catalog-controls" hidden={homeSection === 'queue'}>
            <Tabs runtime={runtime} id="home-recent-kinds" label="Recent listening view" items={kinds} value={kind}
              onChange={changeView(value => setKind({kind: value, kindExplicit: true}))}/>
            <div className="gallery-bar__actions"><ActivityMissingAction runtime={runtime} value={currentRecent} scopeKey={state.scopeKey}
              kind={recentKind} period={period} selectedRowIds={trackSelection?.rows.map(row => row.id)}
              enabled={section === 'recent' && homeSection === 'recent'} onError={setActionError}/>{kind !== 'albums' && <ViewControl runtime={runtime} kind={kind} value={views[kind]} onChange={changeView(value => setViews({...views, [kind]: value}))}/>}</div>
          </div>
        </header>
        <div className="home-friends__widget-body home-friends__recent-body">
          {homeSection === 'queue' ? section === 'recent' && <QueuePanel runtime={runtime} {...queue} scopeKey={state.scopeKey} selectedIds={queueDetails.value.selectedIds} onSelect={selectQueuedTracks}/> : kind === 'albums' && period === 'week' ? <RecentAlbums runtime={runtime} value={state.recent} retry={retryRecent} selected={selectedAlbum}
            selectionMode={customDetail ? 'details' : 'native'} onSelect={selectRecentAlbum} onError={setActionError}/>
            : <div className="home-friends__scroll gallery-scrollbar"><Status runtime={runtime} value={currentRecent} label="Listening activity" retry={retryRecent}/>
              {['ready', 'empty'].includes(currentRecent.status) && currentRecent.data && <><ActivityPanel key={`${state.scopeKey}:${recentKind}:${period}`} runtime={runtime} scopeKey={state.scopeKey} readDetail={readDetail} account_ref={null} period={period} value={currentRecent} kind={recentKind} selectedResourceId={resolved?.row.id ?? null} onResourceSelect={selectResource} onTracksSelect={selectTracks} selectedTrackIds={trackSelection?.rows.map(row => row.id)} listenedAlbumsRef={setListenedAlbumsHost} view={views[kind] === 'list' ? 'rows' : views[kind]}/>
                {historyControls(currentRecent)}</>}</div>}
        </div>
      </section>
      <section ref={friendsWidget} className="home-friends__widget" hidden={section !== 'friends'} data-home-widget="friends" aria-label="Friends">
        <header className="gallery-bar home-friends__widget-header" hidden={comparing && !hasSelection}><div className="gallery-bar__context"><h2 className={friend && friendMode === 'comparison' ? 'sr-only' : undefined}>{profileRoute ? 'Profile' : friend ? friendMode === 'comparison' ? 'Taste comparison' : 'Recent' : 'Friends'}</h2></div><div className="gallery-bar__actions">
          {friend && friendMode === 'activity' && <ActivityMissingAction runtime={runtime} value={friendResource} scopeKey={state.scopeKey}
            account_ref={friend.account_ref} kind={friendActivityKind} period={friendPeriod} selectedRowIds={trackSelection?.rows.map(row => row.id)}
            enabled={section === 'friends'} onError={setActionError}/>}
          {friend && friendMode === 'activity' && <ViewControl runtime={runtime} kind={friendKind} value={friendViews[friendKind]} onChange={changeView(value => setFriendViews({...friendViews, [friendKind]: value}))}/>}
          {section === 'friends' && !comparing && <Button runtime={runtime} icon="back" onClick={() => navigate(friend || profileRoute ? 'friends' : 'recent')}>{friend || profileRoute ? 'Back to friends' : 'Back to Home'}</Button>}
        </div></header>
        <div className="home-friends__widget-body gallery-scrollbar">
          {invalidFriend && <Status runtime={runtime} value={{status: 'denied'}} label="This friend's activity"/>}
          {profileRoute ? <MemberProfile runtime={runtime} controller={controller} accountRef={shell.profileRef} showIdentity={false}
            onActivity={ref => openFriend(ref, 'activity')} onCompare={ref => openFriend(ref, 'comparison')}/>
            : !friend ? <FriendsDirectory runtime={runtime} value={state.friends} selected={state.selectedFriendRef} controller={controller} onSelect={ref => navigate('friends', ref)} onProfile={openProfile} onRequest={openRequest}/>
            : <>
              <div className="home-friends__friend-actions"><Button runtime={runtime} selected={friendMode === 'activity'} disabled={friend.allowed_actions?.can_view_activity !== true} onClick={() => changeView(setFriendMode)('activity')}>Recent</Button>
                <Button runtime={runtime} icon="compare" selected={friendMode === 'comparison'} disabled={friend.allowed_actions?.can_compare !== true} onClick={() => changeView(setFriendMode)('comparison')}>Compare with you</Button>
              </div>
              {friendMode === 'comparison' ? <ComparisonPanel key={`${state.scopeKey}:${friend.account_ref}:${friendKind}:${friendPeriod}`}
                runtime={runtime} value={friend.allowed_actions?.can_compare === true ? friendResource : {status: 'denied'}} friendName={friend.display_name} friendRef={friend.account_ref} kind={friendKind} period={friendPeriod}
                presentation={comparison} onPresentationChange={setComparison} headerControls={friendControls} viewControlsHost={comparisonViewHost} retry={retryFriend} onUserIntent={() => {pendingScroll.current = null;}}/>
                : <>{friendControls}<Status runtime={runtime} value={friendResource} label="Friend activity" retry={retryFriend}/>
                  {['ready', 'empty'].includes(friendResource.status) && <><ActivityPanel key={`${state.scopeKey}:${friend.account_ref}:${friendActivityKind}:${friendPeriod}`} runtime={runtime} scopeKey={state.scopeKey} readDetail={readDetail} account_ref={friend.account_ref} period={friendPeriod} nowPlaying={nowPlaying} value={friendResource} kind={friendActivityKind} selectedResourceId={resolved?.row.id ?? null} onResourceSelect={selectResource} onTracksSelect={selectTracks} selectedTrackIds={trackSelection?.rows.map(row => row.id)} listenedAlbumsRef={setListenedAlbumsHost} view={friendViews[friendKind] === 'list' ? 'rows' : friendViews[friendKind]}/>
                    {historyControls(friendResource)}</>}</>}
              {friendMode === 'comparison' && ['ready', 'empty'].includes(friendResource.status) && friendResource.data?.next_cursor && <Button runtime={runtime} onClick={() => controller.loadComparison({kind: friendKind, period: friendPeriod, cursor: friendResource.data.next_cursor})}>Next page</Button>}
            </>}
          {['loading', 'error', 'denied', 'unavailable'].includes(state.mutation.status) && <Status runtime={runtime} value={state.mutation} label="Friend changes"/>}
        </div>
      </section>
      {hasArtist && <section ref={artistWidget} className="home-friends__widget" data-home-widget="artist" aria-label="Selected Artist Info">
        <header className="gallery-bar home-friends__widget-header"><div className="gallery-bar__context"><h2>Artist Info</h2></div><div className="gallery-bar__actions">
          <Button runtime={runtime} icon="close" onClick={() => closeSelection('artist')}>Close Artist Info</Button>
        </div></header>
        <div className="home-friends__widget-body gallery-scrollbar">{!artistTarget && (trackSelection || selectedQueue) ? <p className="home-friends__muted">Selected tracks do not share one available artist.</p> : <ResourceDetail key={`${owner.generation}:artist`}
          runtime={queueMode ? queueDetails.runtime : runtime} scopeKey={state.scopeKey} readDetail={queueMode ? queueDetails.adapter?.readAlbumProjection : readDetail} selection={artistTarget}
          listenedAlbumsHost={!queueMode && query.kind === 'artists' ? listenedAlbumsHost : undefined}
          onDetailChange={selectedArtistChanged} onSelectAlbum={queueMode ? undefined : selectListenedAlbum}
          onError={message => {if (targetCurrent()) setActionError(message);}}/>}</div>
      </section>}
      {hasAlbum && <section ref={albumWidget} className="home-friends__widget" data-home-widget="album" aria-label="Selected Album Info">
        <header className="gallery-bar home-friends__widget-header"><div className="gallery-bar__context"><h2>Album Info</h2></div><div className="gallery-bar__actions">
          <Button runtime={runtime} icon="close" onClick={() => closeSelection('album')}>Close Album Info</Button>
        </div></header>
        <div className="home-friends__widget-body gallery-scrollbar">
          {!albumTarget && (trackSelection || selectedQueue) ? <p className="home-friends__muted">Selected tracks do not share one available album.</p> : <ResourceDetail key={`${owner.generation}:album:${detailSelectionKey(albumTarget)}`} runtime={queueMode ? queueDetails.runtime : runtime}
            scopeKey={state.scopeKey} readDetail={queueMode ? queueDetails.adapter?.readAlbumProjection : readDetail} selection={albumTarget} onDetailChange={selectedAlbumChanged}
            onError={message => {if (albumCurrent()) setActionError(message);}}/>}
          {selectedRow && <dl className="home-friends__album-summary"><dt>Listen events</dt><dd>{metric(selectedRow.listen_event_count)}</dd>
            <dt>Listened tracks</dt><dd>{metric(selectedRow.listened_track_count)}</dd><dt>Album tracks</dt><dd>{metric(selectedRow.album_track_count)}</dd></dl>}
        </div>
      </section>}
    </div>
  </div>;
}
