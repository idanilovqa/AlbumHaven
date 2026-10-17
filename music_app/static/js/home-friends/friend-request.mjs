import {mountButton, mountStatus} from './native-controls.mjs';
import {openNativeDialog} from './native-dialog.mjs';
import {profilePerson} from './model.mjs';
import {mountProfileIdentity} from './profile.mjs';


// Teardown is best effort: one native cleanup must not strand later owners.
function releaseAll(releases) {for (const release of releases) {try {release();} catch (_error) {}}}

const actions = {acceptRequest: ['incoming', 'can_accept'], declineRequest: ['incoming', 'can_decline'], cancelRequest: ['outgoing', 'can_cancel']};
const readable = value => ['ready', 'empty'].includes(value?.status);
function node(host, tag, className, text) {const element = host.ownerDocument.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; host.append(element); return element;}
function alert(host, runtime, message) {host.hidden = !message; const html = message ? runtime.alertHtml({severity: 'info', role: 'status', message}) : ''; if (host.innerHTML !== html) host.innerHTML = html;}
export function currentFriendRequest(state, requestRef) {return readable(state.friends) ? state.friends.data?.requests?.find(request => request.request_ref === requestRef) || null : null;}

export function mountFriendRequestContent(host, runtime, initial) {
  let props = initial, disposed = false;
  const root = node(host, 'section', 'home-friend-request'); root.setAttribute('aria-label', 'Friend request');
  const owners = [], own = owner => {owners.push(owner); return owner;};
  function dispose() {if (!disposed) {disposed = true; releaseAll([...owners.splice(0).reverse().map(owner => () => owner.dispose()), () => root.remove()]);}}
  try {
  const detail = node(root, 'div'), identityHost = node(detail, 'div'), explanation = node(detail, 'p'), actionRow = node(detail, 'div', 'home-friend-request__actions');
  const profileHost = node(actionRow, 'span'), acceptHost = node(actionRow, 'span'), declineHost = node(actionRow, 'span'), cancelHost = node(actionRow, 'span');
  const absent = node(root, 'div'), requestsStatusHost = node(root, 'div'), mutationHost = node(root, 'div'), deniedHost = node(root, 'div'), messageHost = node(root, 'div'), refreshHost = node(root, 'span');
  const footer = node(root, 'div', 'home-friend-request__footer'), closeHost = node(footer, 'span');
  const identity = own(mountProfileIdentity(identityHost, runtime, {fallbackName: 'Member', heading: 'h2'})), requestsStatus = own(mountStatus(requestsStatusHost, runtime, {label: 'Friend requests'}));
  const mutationStatus = own(mountStatus(mutationHost, runtime, {label: 'Friend request changes'})), deniedStatus = own(mountStatus(deniedHost, runtime, {value: {status: 'denied'}, label: 'Friend request changes'}));
  const profileButton = own(mountButton(profileHost, runtime, {label: 'View profile'})), acceptButton = own(mountButton(acceptHost, runtime, {label: 'Accept request'})), declineButton = own(mountButton(declineHost, runtime, {label: 'Decline'})), cancelButton = own(mountButton(cancelHost, runtime, {label: 'Cancel request'})), refreshButton = own(mountButton(refreshHost, runtime, {label: 'Refresh'})), closeButton = own(mountButton(closeHost, runtime, {label: 'Close'}));
  function update(next) {
    if (disposed) return; props = next;
    const {state, requestRef, message, changeAcknowledged} = props, request = currentFriendRequest(state, requestRef), busy = state.mutation.status === 'loading';
    const mutation = state.mutation.target === requestRef ? state.mutation : null, acknowledged = changeAcknowledged || mutation?.status === 'ready';
    const canChange = request && (request.direction === 'incoming' ? request.allowed_actions.can_accept === true || request.allowed_actions.can_decline === true : request.allowed_actions.can_cancel === true);
    const canProfile = request?.account_ref && request.allowed_actions.can_view_profile === true && profilePerson(state, request.account_ref);
    root.setAttribute('aria-busy', String(busy)); detail.hidden = !request;
    identity.update({profile: request, fallbackName: 'Member', heading: 'h2'});
    explanation.textContent = request?.direction === 'incoming' ? 'This person has sent you a friend request.' : 'Your friend request is pending.';
    profileButton.update({label: 'View profile', disabled: busy || !canProfile || !props.onProfile, onClick: () => {if (!disposed) props.onProfile?.();}});
    acceptHost.hidden = declineHost.hidden = request?.direction !== 'incoming'; cancelHost.hidden = request?.direction !== 'outgoing';
    acceptButton.update({label: 'Accept request', variant: 'primary', disabled: busy || acknowledged || request?.allowed_actions.can_accept !== true, onClick: () => {if (!disposed) props.onAction?.('acceptRequest');}});
    declineButton.update({label: 'Decline', disabled: busy || acknowledged || request?.allowed_actions.can_decline !== true, onClick: () => {if (!disposed) props.onAction?.('declineRequest');}});
    cancelButton.update({label: 'Cancel request', disabled: busy || acknowledged || request?.allowed_actions.can_cancel !== true, onClick: () => {if (!disposed) props.onAction?.('cancelRequest');}});
    alert(absent, runtime, !request && readable(state.friends) ? 'This friend request is no longer available.' : '');
    requestsStatus.update({value: state.friends, label: 'Friend requests', retry: props.onRefresh}); requestsStatusHost.hidden = !!request || readable(state.friends);
    mutationStatus.update({value: mutation, label: 'Friend request changes'}); mutationHost.hidden = !(mutation && ['loading', 'error', 'denied', 'unavailable'].includes(mutation.status));
    deniedHost.hidden = !(request && !canChange && mutation?.status !== 'denied');
    alert(messageHost, runtime, message); refreshHost.hidden = !message; refreshButton.update({label: 'Refresh', disabled: busy, onClick: () => {if (!disposed) props.onRefresh?.();}});
    closeButton.update({label: 'Close', onClick: () => {if (!disposed) props.onClose?.();}});
  }
  update(initial); return {element: host, update, dispose};
  } catch (error) {dispose(); throw error;}
}

export function mountFriendRequestDialog(host, runtime, initial) {
  let props = initial, disposed = false, active = true, working = false, refreshing = false, pendingProfile = null, completed = null, message = '';
  let scope = props.controller.getSnapshot().scopeKey, dialog = null, content = null, closeDialog = null, unsubscribe = null, generation = 0, fallback = null;
  const current = () => !disposed && active && Object.is(props.controller.getSnapshot().scopeKey, scope);
  function contentProps() {return {state: props.controller.getSnapshot(), requestRef: props.requestRef, message, changeAcknowledged: Boolean(completed), onAction: mutate,
    onProfile: props.onProfile ? viewProfile : undefined, onRefresh: refresh, onClose: () => closeDialog?.()};}
  function render() {if (!disposed && active) content?.update(contentProps());}
  function setMessage(value) {message = value; render();}
  function settle() {
    if (!current()) return;
    const latest = props.controller.getSnapshot(), outcome = completed;
    if (!outcome || !readable(latest.friends)) {setMessage('Your change was sent, but the updated request could not be loaded. Refresh to check its current status.'); return;}
    const resolved = !currentFriendRequest(latest, props.requestRef), accepted = outcome.action !== 'acceptRequest' || outcome.accountRef && latest.friends.data?.friends.some(person => person.account_ref === outcome.accountRef && person.relationship === 'accepted');
    if (resolved && accepted) closeDialog?.({reason: 'request-resolved'});
    else setMessage('The updated relationship has not been confirmed. Refresh to check its current status.');
  }
  async function mutate(action) {
    const before = props.controller.getSnapshot(), requestRef = props.requestRef, request = currentFriendRequest(before, requestRef), spec = actions[action];
    if (!current() || working || completed || before.mutation.status === 'loading' || !spec || before.mutation.status === 'ready' && before.mutation.target === requestRef) return;
    if (!request || request.direction !== spec[0] || request.allowed_actions[spec[1]] !== true) {setMessage('This request has changed. Refresh to see its current status.'); return;}
    const controller = props.controller, token = generation; working = true; setMessage('');
    try {
      const result = await controller.mutate(action, requestRef);
      if (!current() || token !== generation || controller !== props.controller) return;
      if (result.status !== 'ready' || result.action !== action || result.target !== requestRef) return;
      completed = {action, accountRef: request.account_ref}; render(); settle();
    } catch (_error) {if (current() && token === generation) setMessage('The request could not be updated. Refresh to check its current status.');}
    finally {if (token === generation) {working = false; render();}}
  }
  async function refresh() {
    if (!current() || working || refreshing || props.controller.getSnapshot().mutation.status === 'loading') return;
    const token = generation; refreshing = true; setMessage('');
    try {await props.controller.loadFriends(); if (current() && token === generation && completed) settle();}
    catch (_error) {if (current() && token === generation) setMessage('Friend requests could not be refreshed. Please try again.');}
    finally {if (token === generation) {refreshing = false; render();}}
  }
  function viewProfile() {
    const latest = props.controller.getSnapshot(), request = currentFriendRequest(latest, props.requestRef);
    if (!current() || working || latest.mutation.status === 'loading' || !props.onProfile || request?.allowed_actions.can_view_profile !== true || !profilePerson(latest, request.account_ref)) return;
    pendingProfile = request;
    if (closeDialog?.({restoreFocus: false, returnToParent: false, reason: 'view-profile'}) === false) pendingProfile = null;
  }
  function closed(options) {
    const requested = pendingProfile; pendingProfile = null;
    const wasCurrent = options?.current !== false && current(), callback = props.onProfile, controller = props.controller, requestRef = props.requestRef, oldScope = scope;
    retireAuthority(); props.onClose?.(options);
    // Retirement in onClose is expected; reread source authority after teardown.
    const latest = controller.getSnapshot(), request = currentFriendRequest(latest, requestRef);
    const canOpen = wasCurrent && Object.is(latest.scopeKey, oldScope) && requested && request === requested && request.allowed_actions.can_view_profile === true && profilePerson(latest, request.account_ref);
    if (canOpen) callback?.(request.account_ref);
  }
  function options() {return {title: 'Friend request', parentSurface: props.parentSurface, returnFocus: props.returnFocus};}
  function removeFallback() {const previous = fallback; fallback = null; releaseAll([() => previous?.button.dispose(), () => previous?.element.remove()]);}
  function retireAuthority() {
    // Native opening failures deliberately retain only their fallback Close.
    // Controller notifications and pending mutation/read results lose authority now.
    active = false; pendingProfile = completed = null; working = refreshing = false;
    const release = unsubscribe, child = content; unsubscribe = null; content = null;
    releaseAll([() => release?.(), () => child?.dispose()]);
  }
  function failed(error, close) {
    if (disposed) return; retireAuthority(); closeDialog = close;
    if (host) {
      removeFallback(); const element = node(host, 'div');
      alert(node(element, 'div'), runtime, 'This dialog is not available right now.');
      const button = mountButton(node(element, 'span'), runtime, {label: 'Close', onClick: () => close()}); fallback = {element, button};
    }
    try {props.onError?.(error);}
    finally {
      // Notifications intentionally have no fallback host. Dismiss their producer
      // even when a native factory returned an invalid owner without throwing.
      if (!host && !disposed) close({restoreFocus: false, returnToParent: false, reason: 'open-failed'});
    }
  }
  function start() {
    const token = generation;
    unsubscribe = props.controller.subscribe(render);
    dialog = openNativeDialog(runtime, options(), {mount(inner, close) {
      closeDialog = close; const owner = mountFriendRequestContent(inner, runtime, contentProps()); content = owner;
      return {element: inner, update: owner.update, dispose() {owner.dispose(); if (content === owner) content = null;}};
    }, onClose: value => {if (!disposed && token === generation) {removeFallback(); closed(value);}}, onError: (error, close) => {if (token === generation) failed(error, close);}});
  }
  function update(next) {
    if (disposed) return;
    const restart = props.controller !== next.controller || props.requestRef !== next.requestRef || props.parentSurface !== next.parentSurface;
    props = next;
    if (restart) {generation++; unsubscribe?.(); dialog?.dispose(); removeFallback(); content = null; closeDialog = null; active = true; working = refreshing = false; pendingProfile = completed = null; message = ''; scope = props.controller.getSnapshot().scopeKey; start();}
    else {dialog?.update(options()); render();}
  }
  start(); return {element: host, update, dispose() {if (!disposed) {disposed = true; active = false; generation++; pendingProfile = null; unsubscribe?.(); dialog?.dispose(); removeFallback(); content?.dispose(); content = null; closeDialog = null;}}};
}
