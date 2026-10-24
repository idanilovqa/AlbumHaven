import React, {useSyncExternalStore} from 'react';
import {Button, NativeHtml, Status} from './components.jsx';
import {profilePerson} from './model.mjs';
import {ProfileIdentity} from './profile.jsx';

// A readable person and an accepted listening relationship are independent
// projections. A profile response cannot grant access to private history.
export function MemberProfile({runtime, controller, accountRef, onActivity, onCompare, showIdentity = true}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const source = profilePerson(state, accountRef);
  const selected = state.selectedProfileRef === accountRef;
  const value = selected ? state.profile : {status: 'denied', data: null};
  const missing = ['loading', 'error', 'denied', 'unavailable'].includes(state.friends.status) ? state.friends : {status: 'denied'};
  const profile = source && (value.status === 'ready' && value.data?.account_ref === accountRef
    ? value.data : value.status === 'unavailable' ? source : null);
  const friend = profile && ['ready', 'empty'].includes(state.friends.status)
    ? state.friends.data?.friends.find(person => person.account_ref === accountRef && person.relationship === 'accepted') : null;
  const open = (grant, callback) => {
    const latest = controller.getSnapshot();
    const current = latest.friends.data?.friends.find(person => person.account_ref === accountRef && person.relationship === 'accepted');
    if (latest.selectedProfileRef === accountRef && profilePerson(latest, accountRef)
      && ['ready', 'empty'].includes(latest.friends.status) && current?.allowed_actions[grant] === true) callback?.(accountRef);
  };
  return <section className="home-member-profile" aria-label="Member profile">
    {profile && showIdentity && <ProfileIdentity runtime={runtime} profile={profile} fallbackName="Member"/>}
    <Status runtime={runtime} value={source ? value : missing} label="Profile details"
      retry={selected ? () => controller.loadProfile() : undefined}/>
    {profile && <>
      <div className="home-friends__actions">
        {onActivity && friend?.allowed_actions.can_view_activity === true && <Button runtime={runtime}
          onClick={() => open('can_view_activity', onActivity)}>Listening activity</Button>}
        {onCompare && friend?.allowed_actions.can_compare === true && <Button runtime={runtime} icon="compare"
          onClick={() => open('can_compare', onCompare)}>Compare with you</Button>}
      </div>
      {friend?.allowed_actions.can_view_activity !== true && <NativeHtml html={runtime.alertHtml({severity: 'info', role: 'status',
        message: 'Listening activity is not shared with you.'})}/>}
    </>}
  </section>;
}
