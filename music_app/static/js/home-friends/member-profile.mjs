import {mountButton, mountStatus} from './native-controls.mjs';
import {profilePerson} from './model.mjs';
import {mountProfileIdentity} from './profile.mjs';

function node(host, tag, className) {const element = host.ownerDocument.createElement(tag); if (className) element.className = className; host.append(element); return element;}

// A readable profile never grants access to private listening history.
export function mountMemberProfile(host, runtime, initial) {
  let props = initial, disposed = false, unsubscribe;
  const root = node(host, 'section', 'home-member-profile'); root.setAttribute('aria-label', 'Member profile');
  const identityHost = node(root, 'div'), statusHost = node(root, 'div'), body = node(root, 'div');
  const actions = node(body, 'div', 'home-friends__actions'), activityHost = node(actions, 'span'), compareHost = node(actions, 'span'), note = node(body, 'div');
  const identity = mountProfileIdentity(identityHost, runtime, {fallbackName: 'Member'});
  const status = mountStatus(statusHost, runtime, {label: 'Profile details'}), activity = mountButton(activityHost, runtime, {label: 'Listening activity'}), compare = mountButton(compareHost, runtime, {label: 'Compare with you'});
  function open(grant, callback) {
    if (disposed) return;
    const latest = props.controller.getSnapshot(), accountRef = props.accountRef;
    const friend = latest.friends.data?.friends.find(person => person.account_ref === accountRef && person.relationship === 'accepted');
    if (latest.selectedProfileRef === accountRef && profilePerson(latest, accountRef)
      && ['ready', 'empty'].includes(latest.friends.status) && friend?.allowed_actions[grant] === true) callback?.(accountRef);
  }
  function render() {
    if (disposed) return;
    const state = props.controller.getSnapshot(), accountRef = props.accountRef, source = profilePerson(state, accountRef), selected = state.selectedProfileRef === accountRef;
    const value = selected ? state.profile : {status: 'denied', data: null};
    const missing = ['loading', 'error', 'denied', 'unavailable'].includes(state.friends.status) ? state.friends : {status: 'denied'};
    const profile = source && (value.status === 'ready' && value.data?.account_ref === accountRef ? value.data : value.status === 'unavailable' ? source : null);
    const friend = profile && ['ready', 'empty'].includes(state.friends.status) ? state.friends.data?.friends.find(person => person.account_ref === accountRef && person.relationship === 'accepted') : null;
    identityHost.hidden = !(profile && props.showIdentity !== false); identity.update({profile, fallbackName: 'Member'});
    status.update({value: source ? value : missing, label: 'Profile details', retry: selected ? () => {if (!disposed && props.controller.getSnapshot().selectedProfileRef === props.accountRef) props.controller.loadProfile();} : undefined});
    body.hidden = !profile;
    activityHost.hidden = !(props.onActivity && friend?.allowed_actions.can_view_activity === true);
    compareHost.hidden = !(props.onCompare && friend?.allowed_actions.can_compare === true);
    activity.update({label: 'Listening activity', onClick: () => open('can_view_activity', props.onActivity)});
    compare.update({label: 'Compare with you', icon: 'compare', onClick: () => open('can_compare', props.onCompare)});
    note.hidden = !profile || friend?.allowed_actions.can_view_activity === true;
    const html = note.hidden ? '' : runtime.alertHtml({severity: 'info', role: 'status', message: 'Listening activity is not shared with you.'});
    if (note.innerHTML !== html) note.innerHTML = html;
  }
  function subscribe() {unsubscribe = props.controller.subscribe(render);}
  function update(next) {if (disposed) return; const changed = props.controller !== next.controller; if (changed) unsubscribe?.(); props = next; if (changed) subscribe(); render();}
  subscribe(); render(); return {element: host, update, dispose() {if (!disposed) {disposed = true; unsubscribe?.(); for (const owner of [identity, status, activity, compare]) owner.dispose(); root.remove();}}};
}
