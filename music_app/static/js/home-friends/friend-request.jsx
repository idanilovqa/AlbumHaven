import React, {useEffect, useRef, useState, useSyncExternalStore} from 'react';
import {Button, NativeHtml, Status} from './components.jsx';
import {NativeDialog} from './native-dialog.jsx';
import {profilePerson} from './model.mjs';
import {ProfileIdentity} from './profile.jsx';

const actions = {acceptRequest: ['incoming', 'can_accept'], declineRequest: ['incoming', 'can_decline'],
  cancelRequest: ['outgoing', 'can_cancel']};
const readable = value => ['ready', 'empty'].includes(value?.status);
export function currentFriendRequest(state, requestRef) {
  return readable(state.friends) ? state.friends.data?.requests.find(request => request.request_ref === requestRef) || null : null;
}

export function FriendRequestContent({runtime, state, requestRef, message, changeAcknowledged = false, onAction, onProfile, onRefresh, onClose}) {
  const request = currentFriendRequest(state, requestRef), busy = state.mutation.status === 'loading';
  const mutation = state.mutation.target === requestRef ? state.mutation : null;
  const acknowledged = changeAcknowledged || mutation?.status === 'ready';
  const canChange = request && (request.direction === 'incoming'
    ? request.allowed_actions.can_accept === true || request.allowed_actions.can_decline === true
    : request.allowed_actions.can_cancel === true);
  const canProfile = request?.account_ref && request.allowed_actions.can_view_profile === true
    && profilePerson(state, request.account_ref);
  return <section className="home-friend-request" aria-label="Friend request" aria-busy={busy}>
    {request ? <>
      <ProfileIdentity runtime={runtime} profile={request} fallbackName="Member" heading="h2"/>
      <p>{request.direction === 'incoming' ? 'This person has sent you a friend request.' : 'Your friend request is pending.'}</p>
      <div className="home-friend-request__actions">
        <Button runtime={runtime} disabled={busy || !canProfile || !onProfile} onClick={onProfile}>View profile</Button>
        {request.direction === 'incoming' ? <>
          <Button runtime={runtime} variant="primary" disabled={busy || acknowledged || request.allowed_actions.can_accept !== true}
            onClick={() => onAction('acceptRequest')}>Accept request</Button>
          <Button runtime={runtime} disabled={busy || acknowledged || request.allowed_actions.can_decline !== true}
            onClick={() => onAction('declineRequest')}>Decline</Button>
        </> : <Button runtime={runtime} disabled={busy || acknowledged || request.allowed_actions.can_cancel !== true}
          onClick={() => onAction('cancelRequest')}>Cancel request</Button>}
      </div>
    </> : readable(state.friends)
      ? <NativeHtml html={runtime.alertHtml({severity: 'info', role: 'status', message: 'This friend request is no longer available.'})}/>
      : <Status runtime={runtime} value={state.friends} label="Friend requests" retry={onRefresh}/>}
    {mutation && ['loading', 'error', 'denied', 'unavailable'].includes(mutation.status)
      && <Status runtime={runtime} value={mutation} label="Friend request changes"/>}
    {request && !canChange && mutation?.status !== 'denied'
      && <Status runtime={runtime} value={{status: 'denied'}} label="Friend request changes"/>}
    {message && <NativeHtml html={runtime.alertHtml({severity: 'info', role: 'status', message})}/>}
    {message && <Button runtime={runtime} disabled={busy} onClick={onRefresh}>Refresh</Button>}
    <div className="home-friend-request__footer"><Button runtime={runtime} onClick={onClose}>Close</Button></div>
  </section>;
}

export function FriendRequestDialog({runtime, controller, requestRef, parentSurface, returnFocus, onClose, onProfile}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [message, setMessage] = useState('');
  const active = useRef(true), working = useRef(false), pendingProfile = useRef(null);
  const completed = useRef(null);
  const scope = useRef(state.scopeKey);
  useEffect(() => {active.current = true; return () => {active.current = false; pendingProfile.current = null;};}, []);
  const current = () => active.current && Object.is(controller.getSnapshot().scopeKey, scope.current);
  function settle(close) {
    const latest = controller.getSnapshot(), outcome = completed.current;
    if (!outcome || !readable(latest.friends)) {
      setMessage('Your change was sent, but the updated request could not be loaded. Refresh to check its current status.'); return;
    }
    const resolved = !currentFriendRequest(latest, requestRef);
    const accepted = outcome.action !== 'acceptRequest' || outcome.accountRef && latest.friends.data?.friends.some(person =>
      person.account_ref === outcome.accountRef && person.relationship === 'accepted');
    if (resolved && accepted) close({reason: 'request-resolved'});
    else setMessage('The updated relationship has not been confirmed. Refresh to check its current status.');
  }
  async function mutate(action, close) {
    const before = controller.getSnapshot(), request = currentFriendRequest(before, requestRef), spec = actions[action];
    if (!current() || working.current || completed.current || before.mutation.status === 'loading' || !spec
      || before.mutation.status === 'ready' && before.mutation.target === requestRef) return;
    if (!request || request.direction !== spec[0] || request.allowed_actions[spec[1]] !== true) {
      setMessage('This request has changed. Refresh to see its current status.'); return;
    }
    working.current = true; setMessage('');
    try {
      const result = await controller.mutate(action, requestRef);
      if (!current()) return;
      if (result.status !== 'ready' || result.action !== action || result.target !== requestRef) return;
      completed.current = {action, accountRef: request.account_ref};
      settle(close);
    } catch (_error) {
      if (current()) setMessage('The request could not be updated. Refresh to check its current status.');
    } finally {working.current = false;}
  }
  async function refresh(close) {
    if (!current() || working.current || controller.getSnapshot().mutation.status === 'loading') return;
    setMessage('');
    await controller.loadFriends();
    if (current() && completed.current) settle(close);
  }
  function viewProfile(close) {
    const latest = controller.getSnapshot(), request = currentFriendRequest(latest, requestRef);
    if (!current() || working.current || latest.mutation.status === 'loading' || !onProfile
      || request?.allowed_actions.can_view_profile !== true || !profilePerson(latest, request.account_ref)) return;
    pendingProfile.current = request;
    if (close({restoreFocus: false, returnToParent: false, reason: 'view-profile'}) === false) pendingProfile.current = null;
  }
  function closed(options) {
    const requested = pendingProfile.current; pendingProfile.current = null;
    const wasCurrent = options?.current !== false && current();
    active.current = false;
    onClose?.(options);
    const latest = controller.getSnapshot(), request = currentFriendRequest(latest, requestRef);
    // Parent stores may synchronously unmount this component in onClose. That
    // expected retirement must not cancel navigation; authority is reread here.
    const canOpen = wasCurrent && Object.is(latest.scopeKey, scope.current) && requested && request === requested
      && request.allowed_actions.can_view_profile === true && profilePerson(latest, request.account_ref);
    // NativeDialog invokes this only after its form and optional drawer parent
    // have retired. A stale notification never carries authority across close.
    if (canOpen) onProfile?.(request.account_ref);
  }
  return <NativeDialog runtime={runtime} title="Friend request" parentSurface={parentSurface}
    returnFocus={returnFocus} onClose={closed}>{close => <FriendRequestContent runtime={runtime} state={state} requestRef={requestRef}
      message={message} changeAcknowledged={Boolean(completed.current)} onAction={action => mutate(action, close)} onProfile={onProfile ? () => viewProfile(close) : undefined}
      onRefresh={() => refresh(close)} onClose={() => close()}/>}</NativeDialog>;
}
