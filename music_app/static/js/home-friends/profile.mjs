import {mountButton} from './native-controls.mjs';
import {safeAvatarUrl, validAvatarFile, validProfileDraft} from './model.mjs';


// Teardown is best effort: one native cleanup must not strand later owners.
function releaseAll(releases) {for (const release of releases) {try {release();} catch (_error) {}}}

const fileError = 'Choose a PNG, JPEG or WebP image no larger than 5 MiB.';
const emptyAvatar = () => ({file: null, url: '', status: 'idle', error: ''});
let nextEditorId = 0;
function node(host, tag, className, text) {
  const element = host.ownerDocument.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  host.append(element); return element;
}
function alert(host, runtime, message, error = false) {
  host.hidden = !message;
  const html = message ? runtime.alertHtml({severity: error ? 'error' : 'info', role: error ? 'alert' : 'status', message}) : '';
  if (host.innerHTML !== html) host.innerHTML = html;
}
function imageSignature(type, buffer) {
  if (!(buffer instanceof ArrayBuffer)) return false;
  const bytes = new Uint8Array(buffer);
  const begins = expected => expected.every((value, index) => bytes[index] === value);
  if (type === 'image/png') return begins([137, 80, 78, 71, 13, 10, 26, 10]);
  if (type === 'image/jpeg') return begins([255, 216, 255]);
  return type === 'image/webp' && begins([82, 73, 70, 70])
    && [87, 69, 66, 80].every((value, index) => bytes[index + 8] === value);
}

// Own only a local header reader and preview URL. Files never enter snapshots.
export function createAvatarDraft(onChange, {
  createReader = () => new FileReader(),
  createObjectURL = file => URL.createObjectURL(file),
  revokeObjectURL = url => URL.revokeObjectURL(url),
} = {}) {
  let pending = null, url = '', disposed = false;
  function release() {
    const reader = pending; pending = null;
    if (reader?.readyState === 1) reader.abort();
    if (url) {const previous = url; url = ''; revokeObjectURL(previous);}
  }
  function clear(error = '') {
    if (disposed) return;
    release();
    onChange({...emptyAvatar(), ...(error ? {status: 'error', error} : {})});
  }
  return {
    clear,
    rejectPreview(expectedUrl, error) {if (url && url === expectedUrl) clear(error);},
    select(file) {
      if (disposed) return;
      release();
      if (!validAvatarFile(file)) {clear(fileError); return;}
      onChange({...emptyAvatar(), status: 'loading'});
      let reader;
      try {reader = createReader();}
      catch (_error) {clear('Image previews are not available in this browser.'); return;}
      pending = reader;
      const active = () => !disposed && pending === reader;
      reader.onerror = () => {if (active()) clear('This image could not be read. Choose another image.');};
      reader.onabort = () => {if (active()) clear();};
      reader.onload = () => {
        if (!active()) return;
        if (!imageSignature(file.type, reader.result)) {clear(fileError); return;}
        try {url = createObjectURL(file);}
        catch (_error) {clear('This image could not be previewed. Choose another image.'); return;}
        pending = null;
        onChange({file, url, status: 'ready', error: ''});
      };
      try {reader.readAsArrayBuffer(file.slice(0, 12));}
      catch (_error) {if (active()) clear('This image could not be read. Choose another image.');}
    },
    dispose() {if (!disposed) {disposed = true; release();}},
  };
}

function mountAvatar(host, runtime, initial) {
  let props = initial, disposed = false, failed = null, renderedSource = null, button = null, image = null;
  const click = () => {
    if (disposed || !button || !renderedSource) return;
    try {runtime.openAvatar(renderedSource, props.name); props.onOpenError?.('');}
    catch (_error) {props.onOpenError?.('The profile image viewer is not available right now.');}
  };
  const imageError = () => {
    if (disposed || !image) return;
    const invalid = renderedSource, preview = props.previewUrl;
    failed = invalid; render();
    if (preview && preview === invalid) props.onInvalidPreview?.(preview);
  };
  function clear() {
    button?.removeEventListener('click', click); image?.removeEventListener('error', imageError);
    host.replaceChildren(); button = null; image = null;
  }
  function render() {
    if (disposed) return;
    const source = props.previewUrl || safeAvatarUrl(props.url), available = source && failed !== source;
    if (!available) {
      clear(); renderedSource = null;
      const empty = node(host, 'div', 'home-profile__avatar');
      empty.setAttribute('role', 'img'); empty.setAttribute('aria-label', `No profile image for ${props.name}`);
      node(empty, 'div').innerHTML = runtime.artboxHtml({state: 'empty', label: `No profile image for ${props.name}`});
      return;
    }
    if (!button || renderedSource !== source) {
      clear(); renderedSource = source;
      button = node(host, 'button', 'album-card__artbox-trigger home-profile__avatar'); button.type = 'button';
      const artbox = node(button, 'span', 'album-artbox album-artbox--ready'); artbox.dataset.albumArtboxState = 'ready';
      image = node(artbox, 'img'); image.decoding = 'async'; image.referrerPolicy = 'no-referrer';
      image.addEventListener('error', imageError); button.addEventListener('click', click); image.src = source;
    }
    button.setAttribute('aria-label', `View ${props.name}'s avatar`); image.alt = `Profile image for ${props.name}`;
  }
  function update(next) {if (!disposed) {props = next; render();}}
  update(initial);
  return {element: host, update, dispose() {if (!disposed) {disposed = true; clear();}}};
}

export function mountProfileIdentity(host, runtime, initial) {
  const root = node(host, 'div', 'home-profile__identity'), avatarHost = node(root, 'div');
  const copy = node(root, 'div', 'home-profile__copy'), nameRow = node(copy, 'div', 'home-profile__name');
  let heading = node(nameRow, initial.heading === 'h2' ? 'h2' : 'h1');
  const editHost = node(nameRow, 'span'), friend = node(nameRow, 'span', 'home-friends__muted', 'Friend');
  const bio = node(copy, 'p', 'home-friends__muted'), errorHost = node(copy, 'div');
  let props = initial, disposed = false, viewError = '', previousName, previousUrl;
  let avatar, edit;
  function dispose() {if (!disposed) {disposed = true; releaseAll([() => avatar?.dispose(), () => edit?.dispose(), () => root.remove()]);}}
  try {
  avatar = mountAvatar(avatarHost, runtime, avatarProps()); edit = mountButton(editHost, runtime, editProps());
  function name() {return props.profile?.display_name || props.fallbackName || 'My music';}
  function avatarProps() {return {name: name(), url: props.profile?.avatar_url, onOpenError: value => {viewError = value; alert(errorHost, runtime, value);}};}
  function editProps() {return {label: 'Edit profile', icon: 'edit', attributes: {'data-home-profile-edit': 'true'}, onClick: () => {
    if (!disposed && props.own && props.profile?.allowed_actions?.can_edit === true) props.onEdit?.();
  }};}
  function update(next) {
    if (disposed) return; props = next;
    const nextName = name(), url = props.profile?.avatar_url, tag = props.heading === 'h2' ? 'H2' : 'H1';
    if (previousName !== nextName || previousUrl !== url) viewError = '';
    previousName = nextName; previousUrl = url;
    if (heading.tagName !== tag) {const replacement = host.ownerDocument.createElement(tag.toLowerCase()); heading.parentNode.insertBefore(replacement, heading); heading.remove(); heading = replacement;}
    heading.textContent = nextName; avatar.update(avatarProps());
    editHost.hidden = !(props.own && props.profile?.allowed_actions?.can_edit === true && props.onEdit); edit.update(editProps());
    friend.hidden = !!props.own || props.profile?.relationship !== 'accepted';
    bio.replaceChildren(); bio.hidden = !(props.profile?.handle || props.profile?.bio);
    if (props.profile?.handle) node(bio, 'span', 'home-profile__handle', `@${props.profile.handle}`);
    if (props.profile?.handle && props.profile?.bio) {const dot = node(bio, 'span', '', ' · '); dot.setAttribute('aria-hidden', 'true');}
    if (props.profile?.bio) bio.append(host.ownerDocument.createTextNode(props.profile.bio));
    alert(errorHost, runtime, viewError);
  }
  update(initial); return {element: host, update, dispose};
  } catch (error) {dispose(); throw error;}
}

export function mountComparisonIdentity(host, runtime, initial) {
  const root = node(host, 'div', 'home-profile__identity home-profile__comparison-identity');
  const overlap = node(root, 'div', 'home-profile__overlap'); overlap.setAttribute('role', 'group');
  const first = mountAvatar(node(overlap, 'div'), runtime, {name: 'You'}), second = mountAvatar(node(overlap, 'div'), runtime, {name: 'Friend'});
  const copy = node(root, 'div', 'home-profile__copy'), nameRow = node(copy, 'div', 'home-profile__name'), title = node(nameRow, 'h1');
  node(copy, 'p', 'home-friends__muted', 'Taste comparison'); let disposed = false;
  function update({profile, friend}) {if (disposed) return; const yours = profile?.display_name || 'You', theirs = friend?.display_name || 'Friend';
    overlap.setAttribute('aria-label', `${yours} and ${theirs}`); first.update({name: yours, url: profile?.avatar_url}); second.update({name: theirs, url: friend?.avatar_url}); title.textContent = `You & ${theirs}`;}
  update(initial); return {element: host, update, dispose() {if (!disposed) {disposed = true; first.dispose(); second.dispose(); root.remove();}}};
}

export function mountProfileEditor(host, runtime, initial) {
  function draftFor(profile) {return {display_name: profile?.display_name || '', handle: profile?.handle || '', bio: profile?.bio || ''};}
  let props = initial, state = props.controller.getSnapshot(), scope = state.scopeKey, disposed = false;
  let draft = draftFor(props.profile), avatar = emptyAvatar(), editingName = false, nameBeforeEdit = '', result = '', viewError = '', saving = false, saveRequest = 0;
  let unsubscribe = null, rendering = false, avatarOwner, avatarView;
  const listeners = [], buttons = [], id = `home-profile-editor-${++nextEditorId}`;
  const form = node(host, 'form', 'home-friends__profile-editor home-profile__editor tag-editor-form'); form.setAttribute('aria-label', 'Edit profile');
  function dispose() {if (!disposed) {disposed = true; saveRequest++; const release = unsubscribe; unsubscribe = null; releaseAll([() => release?.(), () => avatarOwner?.dispose(), () => avatarView?.dispose(), ...listeners.splice(0), ...buttons.splice(0).reverse().map(owner => () => owner.dispose()), () => form.remove()]);}}
  try {
  const title = node(form, 'div', 'home-profile__editor-title'), nameButtonHost = node(title, 'span');
  const nameLabel = node(title, 'label', '', 'Name'), nameInput = node(nameLabel, 'input'); nameInput.required = true; nameInput.maxLength = 50;
  const avatarEditor = node(form, 'div', 'home-profile__avatar-editor'), avatarHost = node(avatarEditor, 'div');
  const imageActions = node(avatarEditor, 'div', 'home-profile__image-actions'), chooseHost = node(imageActions, 'span');
  const fileInput = node(imageActions, 'input'); fileInput.hidden = true; fileInput.type = 'file'; fileInput.accept = 'image/png,image/jpeg,image/webp'; fileInput.setAttribute('aria-label', 'Choose profile image');
  const discardHost = node(imageActions, 'span'), previewHelp = node(form, 'p', 'home-friends__muted'); previewHelp.id = `${id}-preview`;
  const checking = node(form, 'p', 'home-friends__muted', 'Checking image…'); checking.setAttribute('role', 'status');
  const avatarError = node(form, 'div'), viewErrorHost = node(form, 'div');
  const handleLabel = node(form, 'label', '', 'Handle'), handleInput = node(handleLabel, 'input');
  handleInput.required = true; handleInput.pattern = '[A-Za-z0-9_]{3,30}'; handleInput.maxLength = 30;
  handleInput.setAttribute('aria-describedby', `${id}-help`); handleInput.setAttribute('autocapitalize', 'none'); handleInput.autocomplete = 'off'; handleInput.setAttribute('autocorrect', 'off'); handleInput.spellcheck = false;
  const help = node(form, 'p', 'home-friends__muted', '3–30 letters, numbers or underscores.'); help.id = `${id}-help`;
  const bioLabel = node(form, 'label', '', 'About you'), bioInput = node(bioLabel, 'textarea'); bioInput.maxLength = 240; bioInput.rows = 3;
  const actions = node(form, 'div', 'home-friends__actions'), cancelHost = node(actions, 'span'), saveHost = node(actions, 'span'), resultHost = node(form, 'div');
  avatarOwner = createAvatarDraft(value => {if (disposed) return; if (avatar.url !== value.url) viewError = ''; avatar = value; render();});
  avatarView = mountAvatar(avatarHost, runtime, avatarProps());
  const nameButton = button(nameButtonHost, {label: ''}), chooseButton = button(chooseHost, {label: 'Choose image'}), discardButton = button(discardHost, {label: 'Discard image'});
  const cancelButton = button(cancelHost, {label: 'Cancel'}), saveButton = button(saveHost, {label: 'Save profile'});
  function button(target, options) {const owner = mountButton(target, runtime, options); buttons.push(owner); return owner;}
  function listen(target, event, callback) {target.addEventListener(event, callback); listeners.push(() => target.removeEventListener(event, callback));}
  function rights() {
    const current = props.controller.getSnapshot(), canEdit = Object.is(scope, current.scopeKey) && ['ready', 'empty'].includes(current.friends.status) && current.friends.data?.profile?.allowed_actions?.can_edit === true;
    return {canEdit, canUpload: canEdit && current.friends.data.profile.allowed_actions.can_upload_avatar === true, busy: current.mutation.status === 'loading' || saving};
  }
  function avatarProps() {return {name: draft.display_name || 'You', url: props.profile?.avatar_url, previewUrl: avatar.url,
    onOpenError: value => {viewError = value; render();}, onInvalidPreview: url => avatarOwner.rejectPreview(url, 'This image could not be displayed. Choose another image.')};}
  function finishName(accept, restoreFocus = false) {
    if (!editingName) return;
    if (!accept) draft.display_name = nameBeforeEdit;
    editingName = false; render();
    if (restoreFocus && !disposed) nameButtonHost.querySelector('button')?.focus();
  }
  function cancel() {if (disposed || rights().busy) return; avatarOwner.clear(); props.onClose?.();}
  async function save(event) {
    event.preventDefault(); const {busy, canEdit, canUpload} = rights();
    if (disposed || busy || !canEdit || !validProfileDraft(draft) || ['loading', 'error'].includes(avatar.status) || avatar.file && !canUpload) return;
    const controller = props.controller, request = ++saveRequest, requestScope = controller.getSnapshot().scopeKey;
    saving = true; result = 'loading'; render();
    try {
      const next = await controller.mutate('saveProfile', null, {...draft, display_name: draft.display_name.trim(), ...(avatar.file ? {avatar_file: avatar.file} : {})});
      if (disposed || request !== saveRequest || controller !== props.controller || !Object.is(requestScope, controller.getSnapshot().scopeKey)) return;
      if (next.status === 'ready') {avatarOwner.clear(); props.onClose?.({restoreFocus: form.contains(form.ownerDocument.activeElement)});}
      else {result = next.status; render();}
    } catch (_error) {if (!disposed && request === saveRequest && Object.is(requestScope, controller.getSnapshot().scopeKey)) {result = 'error'; render();}}
    finally {if (!disposed && request === saveRequest) {saving = false; render();}}
  }
  listen(form, 'submit', save);
  for (const [key, input] of [['display_name', nameInput], ['handle', handleInput], ['bio', bioInput]]) listen(input, 'input', event => {
    if (disposed || rights().busy || !rights().canEdit) return; draft[key] = event.target.value; result = ''; render();
  });
  listen(nameInput, 'blur', () => finishName(true));
  listen(nameInput, 'keydown', event => {if (event.isComposing || !['Enter', 'Escape'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation(); finishName(event.key === 'Enter', true);});
  listen(fileInput, 'change', event => {const selected = event.target.files?.[0]; event.target.value = '';
    const {busy, canUpload} = rights(); if (selected && !busy && canUpload) {result = ''; avatarOwner.select(selected);}});
  function render() {
    if (disposed || rendering) return; rendering = true;
    try {
      state = props.controller.getSnapshot(); const {canEdit, canUpload, busy} = rights();
      if (!canUpload && state.friends.status !== 'loading' && avatar.status !== 'idle') avatarOwner.clear();
      form.setAttribute('aria-busy', String(busy)); nameButtonHost.hidden = editingName; nameLabel.hidden = !editingName;
      for (const [key, input] of [['display_name', nameInput], ['handle', handleInput], ['bio', bioInput]]) {if (input.value !== draft[key]) input.value = draft[key]; input.disabled = busy || !canEdit;}
      nameButton.update({label: draft.display_name || 'Your name', quiet: true, ariaLabel: `Edit name: ${draft.display_name || 'Your name'}`, disabled: busy || !canEdit, onClick: () => {
        if (disposed || rights().busy || !rights().canEdit) return; nameBeforeEdit = draft.display_name; editingName = true; render(); nameInput.focus(); nameInput.select();
      }});
      avatarView.update(avatarProps()); imageActions.hidden = !canUpload; fileInput.disabled = busy || !canUpload;
      chooseButton.update({label: 'Choose image', disabled: busy || !canUpload, attributes: {'aria-describedby': previewHelp.id}, onClick: () => {const now = rights(); if (!disposed && now.canUpload && !now.busy) fileInput.click();}});
      discardHost.hidden = avatar.status === 'idle'; discardButton.update({label: 'Discard image', disabled: busy, onClick: () => {if (!disposed && !rights().busy) avatarOwner.clear();}});
      previewHelp.textContent = canUpload ? 'PNG, JPEG or WebP, up to 5 MiB. The image stays on this device until you save.' : 'Image changes are not available for this profile.';
      checking.hidden = avatar.status !== 'loading'; alert(avatarError, runtime, avatar.error, true); alert(viewErrorHost, runtime, viewError);
      cancelButton.update({label: 'Cancel', disabled: busy, onClick: cancel});
      saveButton.update({label: 'Save profile', type: 'submit', variant: 'primary', disabled: busy || !canEdit || !validProfileDraft(draft) || ['loading', 'error'].includes(avatar.status) || Boolean(avatar.file && !canUpload)});
      const message = {loading: 'Saving profile…', unavailable: 'Profile saving is not available on this server yet. Your changes have not been saved.', denied: 'You no longer have permission to save this profile.', error: 'Your profile could not be saved. Please try again.'}[result];
      alert(resultHost, runtime, message, result === 'error');
    } finally {rendering = false;}
  }
  function subscribe() {unsubscribe = props.controller.subscribe(() => {
    if (disposed) return;
    if (!Object.is(scope, props.controller.getSnapshot().scopeKey)) {saveRequest++; saving = false; result = ''; if (avatar.status !== 'idle') avatarOwner.clear();}
    render();
  });}
  function update(next) {
    if (disposed) return;
    const replaced = next.controller !== props.controller; props = next;
    if (replaced) {unsubscribe?.(); saveRequest++; saving = false; avatarOwner.clear(); state = props.controller.getSnapshot(); scope = state.scopeKey; draft = draftFor(props.profile); editingName = false; result = ''; subscribe();}
    render();
  }
  subscribe(); render();
  return {element: host, update, dispose};
  } catch (error) {dispose(); throw error;}
}
