import React from 'react';
import {Button} from './components.jsx';
import {NativeChoice} from './native-choice.jsx';

// Presentation shared by native resource Share forms. Resource controllers own
// authority, revisions and writes; these controls never infer or persist roles.
export function SharingVisibility({runtime, label, visibility, disabled, onChange, publicUnavailable = false, children}) {
  return <><NativeChoice runtime={runtime} label={label} value={visibility} disabled={disabled}
    options={[['private', 'Private'], ['server_shared', 'Shared with this server'], ...(publicUnavailable ? [['link', 'Public link unavailable', true]] : [])]}
    onChange={value => {if (['private', 'server_shared'].includes(value)) onChange(value);}}/>
    {children && <p className="playlists__note">{children}</p>}</>;
}
export function SharingMember({person, children}) {
  return <div className="playlists__share-person"><span>{person.display_name || person.username_display || 'Library member'}
    {person.username_display && person.username_display !== person.display_name ? ` (${person.username_display})` : ''}
    {person.is_active === false ? ' · Inactive account' : ''}</span>{children}</div>;
}
export function SharingReaderAccess({runtime, value, disabled, onRequest}) {
  return <><p className="playlists__note">{value.visibility === 'server_shared' ? 'Shared with this library.' : 'Shared with you.'} Only the owner can change access.</p>
    {value.request_status === 'pending' && <p role="status">Edit access requested. The owner can review it in Notifications.</p>}
    {value.request_status === 'declined' && <p role="status">The owner declined your previous request.</p>}
    {value.can_request_edit && <Button runtime={runtime} disabled={disabled || value.request_status === 'pending'} onClick={onRequest}>Request edit access</Button>}</>;
}
export function SharingRequestDecision({runtime, request, role = 'viewer', disabled, onRole, onDecision}) {
  const name = request.display_name || request.username_display || 'Library member';
  return <div className="playlists__share-person"><span>{name} requested edit access.</span>
    <NativeChoice runtime={runtime} label={`Access for ${name}`} value={role} disabled={disabled}
      options={ [['viewer', 'Viewer'], ['editor', 'Editor']] } onChange={onRole}/>
    <Button runtime={runtime} disabled={disabled || role !== 'editor'} onClick={() => onDecision('approve')}>Apply</Button>
    <Button runtime={runtime} disabled={disabled} onClick={() => onDecision('decline')}>Decline</Button>
  </div>;
}
