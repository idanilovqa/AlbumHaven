import React, {useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore} from 'react';
import {Button, NativeHtml} from './components.jsx';
import {safeAvatarUrl, validAvatarFile, validProfileDraft} from './model.mjs';

const fileError = 'Choose a PNG, JPEG or WebP image no larger than 5 MiB.';
const emptyAvatar = () => ({file: null, url: '', status: 'idle', error: ''});

function imageSignature(type, buffer) {
  if (!(buffer instanceof ArrayBuffer)) return false;
  const bytes = new Uint8Array(buffer);
  const begins = expected => expected.every((value, index) => bytes[index] === value);
  if (type === 'image/png') return begins([137, 80, 78, 71, 13, 10, 26, 10]);
  if (type === 'image/jpeg') return begins([255, 216, 255]);
  return type === 'image/webp' && begins([82, 73, 70, 70])
    && [87, 69, 66, 80].every((value, index) => bytes[index + 8] === value);
}

// This owner reads only a local file header. It owns every preview URL it makes,
// performs no upload, and never places a File in the shared controller snapshot.
export function createAvatarDraft(onChange, {
  createReader = () => new FileReader(),
  createObjectURL = file => URL.createObjectURL(file),
  revokeObjectURL = url => URL.revokeObjectURL(url),
} = {}) {
  let pending = null, url = '', disposed = false;
  function release() {
    const reader = pending; pending = null;
    if (reader?.readyState === 1) reader.abort();
    if (url) { const previous = url; url = ''; revokeObjectURL(previous); }
  }
  function clear(error = '') {
    if (disposed) return;
    release();
    onChange({...emptyAvatar(), ...(error ? {status: 'error', error} : {})});
  }
  return {
    clear,
    rejectPreview(expectedUrl, error) { if (url && url === expectedUrl) clear(error); },
    select(file) {
      if (disposed) return;
      release();
      if (!validAvatarFile(file)) { clear(fileError); return; }
      onChange({...emptyAvatar(), status: 'loading'});
      let reader;
      try { reader = createReader(); }
      catch (_error) { clear('Image previews are not available in this browser.'); return; }
      pending = reader;
      const active = () => !disposed && pending === reader;
      reader.onerror = () => { if (active()) clear('This image could not be read. Choose another image.'); };
      reader.onabort = () => { if (active()) clear(); };
      reader.onload = () => {
        if (!active()) return;
        if (!imageSignature(file.type, reader.result)) { clear(fileError); return; }
        try { url = createObjectURL(file); }
        catch (_error) { clear('This image could not be previewed. Choose another image.'); return; }
        pending = null;
        onChange({file, url, status: 'ready', error: ''});
      };
      try { reader.readAsArrayBuffer(file.slice(0, 12)); }
      catch (_error) { if (active()) clear('This image could not be read. Choose another image.'); }
    },
    dispose() { if (!disposed) { disposed = true; release(); } },
  };
}

function Avatar({runtime, name, url, previewUrl = '', onInvalidPreview, onOpenError}) {
  const source = previewUrl || safeAvatarUrl(url), [failed, setFailed] = useState(null);
  const available = source && failed !== source;
  const label = `Profile image for ${name}`;
  if (!available) return <div className="home-profile__avatar" role="img" aria-label={`No profile image for ${name}`}>
    <NativeHtml html={runtime.artboxHtml({state: 'empty', label: `No profile image for ${name}`})}/>
  </div>;
  return <button type="button" className="album-card__artbox-trigger home-profile__avatar"
    aria-label={`View ${name}'s avatar`} onClick={() => {
      try { runtime.openAvatar(source, name); onOpenError?.(''); }
      catch (_error) { onOpenError?.('The profile image viewer is not available right now.'); }
    }}>
    <span className="album-artbox album-artbox--ready" data-album-artbox-state="ready">
      <img key={source} src={source} alt={label} decoding="async" referrerPolicy="no-referrer" onError={() => {
        setFailed(source); if (previewUrl) onInvalidPreview?.(previewUrl);
      }}/>
    </span>
  </button>;
}

export function ProfileIdentity({runtime, profile, own = false, fallbackName = 'My music', onEdit, heading = 'h1'}) {
  const name = profile?.display_name || fallbackName, Heading = heading === 'h2' ? 'h2' : 'h1';
  const [viewError, setViewError] = useState('');
  useEffect(() => {setViewError('');}, [profile?.avatar_url, name]);
  return <div className="home-profile__identity">
    <Avatar runtime={runtime} name={name} url={profile?.avatar_url} onOpenError={setViewError}/>
    <div className="home-profile__copy">
      <div className="home-profile__name"><Heading>{name}</Heading>
        {own && profile?.allowed_actions?.can_edit === true && onEdit
          && <Button runtime={runtime} icon="edit" attributes={{'data-home-profile-edit': 'true'}} onClick={onEdit}>Edit profile</Button>}
        {!own && profile?.relationship === 'accepted' && <span className="home-friends__muted">Friend</span>}
      </div>
      {(profile?.handle || profile?.bio) && <p className="home-friends__muted">
        {profile.handle && <span className="home-profile__handle">@{profile.handle}</span>}
        {profile.handle && profile.bio && <span aria-hidden="true"> · </span>}{profile.bio || ''}
      </p>}
      {viewError && <NativeHtml html={runtime.alertHtml({severity: 'info', role: 'status', message: viewError})}/>}
    </div>
  </div>;
}

export function ProfileEditor({runtime, profile, controller, onClose}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const currentProfile = state.friends.data?.profile;
  const canEdit = currentProfile?.allowed_actions?.can_edit === true;
  const canUpload = canEdit && currentProfile.allowed_actions?.can_upload_avatar === true;
  const busy = state.mutation.status === 'loading';
  const [draft, setDraft] = useState(() => ({display_name: profile.display_name || '', handle: profile.handle || '', bio: profile.bio || ''}));
  const [avatar, setAvatar] = useState(emptyAvatar), [editingName, setEditingName] = useState(false), [result, setResult] = useState('');
  const [viewError, setViewError] = useState('');
  const editorRoot = useRef(null);
  const fileInput = useRef(null), nameInput = useRef(null), nameButton = useRef(null), avatarOwner = useRef(null);
  const nameBeforeEdit = useRef(''), returnNameFocus = useRef(false), saveRequest = useRef(0), saving = useRef(false);
  const helpId = useId(), previewHelpId = useId();
  useEffect(() => {
    const owner = createAvatarDraft(setAvatar); avatarOwner.current = owner;
    return () => { saveRequest.current++; owner.dispose(); if (avatarOwner.current === owner) avatarOwner.current = null; };
  }, []);
  useEffect(() => { if (!canUpload && state.friends.status !== 'loading') avatarOwner.current?.clear(); }, [canUpload, state.friends.status]);
  useEffect(() => {setViewError('');}, [avatar.url]);
  useLayoutEffect(() => {
    if (editingName) { nameInput.current?.focus(); nameInput.current?.select(); }
    else if (returnNameFocus.current) { returnNameFocus.current = false; nameButton.current?.querySelector('button')?.focus(); }
  }, [editingName]);
  const change = key => event => {setDraft(previous => ({...previous, [key]: event.target.value})); setResult('');};
  function finishName(accept, restoreFocus = false) {
    if (!accept) setDraft(previous => ({...previous, display_name: nameBeforeEdit.current}));
    returnNameFocus.current = restoreFocus; setEditingName(false);
  }
  function cancel() { if (busy || saving.current) return; avatarOwner.current?.clear(); onClose(); }
  const valid = validProfileDraft(draft);
  const invalidAvatar = ['loading', 'error'].includes(avatar.status) || Boolean(avatar.file && !canUpload);
  async function save(event) {
    event.preventDefault();
    if (busy || saving.current || !canEdit || !valid || invalidAvatar) return;
    saving.current = true; const request = ++saveRequest.current, scope = state.scopeKey;
    setResult('loading');
    try {
      const next = await controller.mutate('saveProfile', null, {...draft, display_name: draft.display_name.trim(),
        ...(avatar.file ? {avatar_file: avatar.file} : {})});
      if (request !== saveRequest.current || scope !== controller.getSnapshot().scopeKey) return;
      if (next.status === 'ready') { avatarOwner.current?.clear(); onClose({restoreFocus: Boolean(editorRoot.current?.contains(document.activeElement))}); }
      else setResult(next.status);
    } catch (_error) { if (request === saveRequest.current) setResult('error'); }
    finally { if (request === saveRequest.current) saving.current = false; }
  }
  const message = {loading: 'Saving profile…', unavailable: 'Profile saving is not available on this server yet. Your changes have not been saved.',
    denied: 'You no longer have permission to save this profile.', error: 'Your profile could not be saved. Please try again.'}[result];
  return <form ref={editorRoot} className="home-friends__profile-editor home-profile__editor tag-editor-form" onSubmit={save} aria-label="Edit profile" aria-busy={busy}>
    <div className="home-profile__editor-title" ref={nameButton}>
      {editingName ? <label>Name<input ref={nameInput} required maxLength={50} value={draft.display_name} onChange={change('display_name')}
        disabled={busy || !canEdit} onBlur={() => finishName(true)} onKeyDown={event => {
          if (event.nativeEvent.isComposing || !['Enter', 'Escape'].includes(event.key)) return;
          event.preventDefault(); event.stopPropagation(); finishName(event.key === 'Enter', true);
        }}/></label> : <Button runtime={runtime} quiet ariaLabel={`Edit name: ${draft.display_name || 'Your name'}`} disabled={busy || !canEdit}
        onClick={() => {nameBeforeEdit.current = draft.display_name; setEditingName(true);}}>{draft.display_name || 'Your name'}</Button>}
    </div>
    <div className="home-profile__avatar-editor">
      <Avatar runtime={runtime} name={draft.display_name || 'You'} url={profile.avatar_url} previewUrl={avatar.url} onOpenError={setViewError}
        onInvalidPreview={url => avatarOwner.current?.rejectPreview(url, 'This image could not be displayed. Choose another image.')}/>
      {canUpload && <div className="home-profile__image-actions">
        <Button runtime={runtime} disabled={busy} attributes={{'aria-describedby': previewHelpId}} onClick={() => fileInput.current?.click()}>Choose image</Button>
        <input ref={fileInput} hidden type="file" accept="image/png,image/jpeg,image/webp" aria-label="Choose profile image" disabled={busy}
          onChange={event => {const selected = event.target.files?.[0]; event.target.value = ''; if (selected && !busy) {setResult(''); avatarOwner.current?.select(selected);}}}/>
        {avatar.status !== 'idle' && <Button runtime={runtime} disabled={busy} onClick={() => avatarOwner.current?.clear()}>Discard image</Button>}
      </div>}
    </div>
    <p id={previewHelpId} className="home-friends__muted">{canUpload
      ? 'PNG, JPEG or WebP, up to 5 MiB. The image stays on this device until you save.'
      : 'Image changes are not available for this profile.'}</p>
    {avatar.status === 'loading' && <p role="status" className="home-friends__muted">Checking image…</p>}
    {avatar.error && <NativeHtml html={runtime.alertHtml({severity: 'error', role: 'alert', message: avatar.error})}/>}
    {viewError && <NativeHtml html={runtime.alertHtml({severity: 'info', role: 'status', message: viewError})}/>}
    <label>Handle<input required pattern="[A-Za-z0-9_]{3,30}" maxLength={30} value={draft.handle} onChange={change('handle')}
      disabled={busy || !canEdit} aria-describedby={helpId} autoCapitalize="none" autoComplete="off" autoCorrect="off" spellCheck={false}/></label>
    <p id={helpId} className="home-friends__muted">3–30 letters, numbers or underscores.</p>
    <label>About you<textarea maxLength={240} rows={3} value={draft.bio} onChange={change('bio')} disabled={busy || !canEdit}/></label>
    <div className="home-friends__actions"><Button runtime={runtime} onClick={cancel} disabled={busy}>Cancel</Button>
      <Button runtime={runtime} type="submit" variant="primary" disabled={busy || !canEdit || !valid || invalidAvatar}>Save profile</Button></div>
    {message && <NativeHtml html={runtime.alertHtml({severity: result === 'error' ? 'error' : 'info', role: result === 'error' ? 'alert' : 'status', message})}/>}
  </form>;
}

export function ComparisonIdentity({runtime, profile, friend}) {
  const yours = profile?.display_name || 'You', theirs = friend?.display_name || 'Friend';
  return <div className="home-profile__identity home-profile__comparison-identity">
    <div className="home-profile__overlap" role="group" aria-label={`${yours} and ${theirs}`}>
      <Avatar runtime={runtime} name={yours} url={profile?.avatar_url}/>
      <Avatar runtime={runtime} name={theirs} url={friend?.avatar_url}/>
    </div>
    <div className="home-profile__copy"><div className="home-profile__name"><h1>You &amp; {theirs}</h1></div><p className="home-friends__muted">Taste comparison</p></div>
  </div>;
}
