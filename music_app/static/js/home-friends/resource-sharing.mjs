import {mountButton, mountChoice} from './native-controls.mjs';

// These presentation owners never grant access or write roles. The resource
// controller supplies current authority and handles every requested change.
function node(host, tag, className, text) {
  const element = host.ownerDocument.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  host.append(element); return element;
}
// A factory can fail before its caller receives an owner. Retire each acquired
// child in reverse order on either construction or update failure, even when a
// later cleanup also throws. Preserve the original operation error.
function sharingLifetime(host) {
  const children = []; let disposed = false;
  function dispose() {
    if (disposed) return; disposed = true;
    let failure;
    for (const child of children.splice(0).reverse()) {try {child.dispose();} catch (error) {failure ||= error;}}
    try {host.replaceChildren();} catch (error) {failure ||= error;}
    if (failure) throw failure;
  }
  return {get disposed() {return disposed;}, own(owner) {children.push(owner); return owner;}, dispose,
    run(work) {if (disposed) return; try {return work();} catch (error) {try {dispose();} catch (_cleanupError) {} throw error;}}};
}
export function mountSharingVisibility(host, runtime, initial) {
  const life = sharingLifetime(host); return life.run(() => {
  const choiceHost = node(host, 'div'), note = node(host, 'p', 'playlists__note');
  let props = initial;
  const choice = life.own(mountChoice(choiceHost, runtime, options()));
  function options() {return {label: props.label, value: props.visibility, disabled: props.disabled,
    options: [['private', 'Private'], ['server_shared', 'Shared with this server'], ...(props.publicUnavailable ? [['link', 'Public link unavailable', true]] : [])],
    onChange: value => {if (!life.disposed && ['private', 'server_shared'].includes(value)) props.onChange?.(value);}};}
  function update(next) {return life.run(() => {props = next; choice.update(options()); note.textContent = props.note || ''; note.hidden = !props.note;});}
  update(initial); return {element: host, update, dispose: life.dispose};
  });
}
export function mountSharingMember(host, initial) {
  const life = sharingLifetime(host); return life.run(() => {
  host.classList.add('playlists__share-person');
  const label = node(host, 'span'), actions = node(host, 'span');
  function update(next) {return life.run(() => {const {person} = next; label.textContent = `${person.display_name || person.username_display || 'Library member'}${person.username_display && person.username_display !== person.display_name ? ` (${person.username_display})` : ''}${person.is_active === false ? ' · Inactive account' : ''}`;});}
  update(initial); return {element: host, actions, update, dispose: life.dispose};
  });
}
export function mountSharingReaderAccess(host, runtime, initial) {
  const life = sharingLifetime(host); return life.run(() => {
  const note = node(host, 'p', 'playlists__note'), status = node(host, 'p'), buttonHost = node(host, 'span'); status.setAttribute('role', 'status');
  let props = initial;
  const button = life.own(mountButton(buttonHost, runtime, {label: 'Request edit access', onClick: () => {if (!life.disposed && props.value.can_request_edit && !props.disabled && props.value.request_status !== 'pending') props.onRequest?.();}}));
  function update(next) {return life.run(() => {props = next; const {value, disabled} = props;
    note.textContent = `${value.visibility === 'server_shared' ? 'Shared with this library.' : 'Shared with you.'} Only the owner can change access.`;
    status.textContent = value.request_status === 'pending' ? 'Edit access requested. The owner can review it in Notifications.' : value.request_status === 'declined' ? 'The owner declined your previous request.' : '';
    status.hidden = !status.textContent; buttonHost.hidden = !value.can_request_edit;
    button.update({label: 'Request edit access', disabled: disabled || value.request_status === 'pending', onClick: () => {if (!life.disposed && props.value.can_request_edit && !props.disabled && props.value.request_status !== 'pending') props.onRequest?.();}});
  });}
  update(initial); return {element: host, update, dispose: life.dispose};
  });
}
export function mountSharingRequestDecision(host, runtime, initial) {
  const life = sharingLifetime(host); return life.run(() => {
  host.classList.add('playlists__share-person'); const label = node(host, 'span'), choiceHost = node(host, 'span'), applyHost = node(host, 'span'), declineHost = node(host, 'span');
  let props = initial;
  const choice = life.own(mountChoice(choiceHost, runtime, {label: 'Access', options: [['viewer', 'Viewer'], ['editor', 'Editor']]})), apply = life.own(mountButton(applyHost, runtime, {label: 'Apply'})), decline = life.own(mountButton(declineHost, runtime, {label: 'Decline'}));
  function update(next) {return life.run(() => {props = next; const {request, disabled, role = 'viewer'} = props, name = request.display_name || request.username_display || 'Library member';
    label.textContent = `${name} requested edit access.`;
    choice.update({label: `Access for ${name}`, value: role, disabled, options: [['viewer', 'Viewer'], ['editor', 'Editor']], onChange: value => {if (!life.disposed && !props.disabled && ['viewer', 'editor'].includes(value)) props.onRole?.(value);}});
    apply.update({label: 'Apply', disabled: disabled || role !== 'editor', onClick: () => {if (!life.disposed && !props.disabled && props.role === 'editor') props.onDecision?.('approve');}});
    decline.update({label: 'Decline', disabled, onClick: () => {if (!life.disposed && !props.disabled) props.onDecision?.('decline');}});
  });}
  update(initial); return {element: host, update, dispose: life.dispose};
  });
}
