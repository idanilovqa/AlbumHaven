import {createAlbumTopController, albumTopActionAllowed} from './model.mjs';
import {openAlbumTopBuilder} from './builder.mjs';
import {mountSharedHeader} from '../home-friends/shared-header.mjs';
import {mountButton} from '../home-friends/native-controls.mjs';

const headerOwners = new WeakMap();
const providerKeys = ['list', 'read', 'execute', 'listScopedAlbums', 'searchAlbums', 'admitAlbum', 'remoteContext',
  'searchRemoteAlbums', 'beginRemotePreparation', 'acquireRemoteAlbum', 'readRemotePreparationState',
  'maintainRemotePreparations', 'closeRemotePreparation'];
const nativeKeys = ['buttonHtml', 'alertHtml', 'openChoice', 'searchHtml', 'tabsHtml', 'mountTabs',
  'galleryCardHtml', 'artistSeparatorHtml', 'galleryRatingHtml', 'artboxHtml', 'escapeHtml',
  'createGalleryHost', 'createGalleryMetadataOwner', 'createGalleryFocusOwner'];
let serial = 0;
export function mountArtistListenThroughCreation({runtime, providers}) {
  const namespace = runtime?.artistCreation;
  if (!namespace?.snapshot || !namespace.subscribe) return {dispose() {}};
  let disposed = false, session = null, running = false, queued = false;
  const make = (parent, tag = 'span') => {const node = parent.ownerDocument.createElement(tag); parent.append(node); return node;};
  function releaseController(owner) {
    owner.unsubscribe?.(); owner.unsubscribe = null;
    const controller = owner.controller; owner.controller = null; controller?.dispose();
  }
  function releaseHeader(owner) {
    const header = owner.header; owner.header = null;
    if (!header) return;
    for (const control of owner.controls) {try {control.dispose();} catch { /* Release every control. */ }} owner.controls = [];
    const root = owner.origin.headerRoot, ours = headerOwners.get(root) === owner;
    const retained = ours ? owner.original.filter(({node, slot}) => node.parentNode === slot) : [];
    for (const {node} of retained) node.remove();
    try {header.dispose();} finally {
    if (ours && headerOwners.get(root) === owner) {
      for (const {node} of retained) if (!node.parentNode) root.append(node);
      headerOwners.delete(root);
    }
    owner.original = [];
    }
  }
  function retire(owner, dismiss = false) {
    if (!owner || owner.retired) return;
    owner.retired = true; if (session === owner) session = null;
    if (dismiss) {try {owner.origin.dispose();} catch { /* Still release this consumer. */ }}
    const editor = owner.editor; owner.editor = null;
    try {editor?.dispose();} finally {try {releaseController(owner);} finally {releaseHeader(owner);}}
  }
  const live = owner => !disposed && session === owner && !owner.retired && runtime.artistCreation === namespace
    && providerKeys.every(key => providers[key] === owner.providerMethods[key]);
  function current(owner) {
    if (!live(owner) || !owner.origin.isOwnerCurrent()) return false;
    const shell = runtime.snapshot();
    return live(owner) && shell.authenticated && shell.scopeKey === owner.origin.scopeKey
      && namespace.snapshot() === owner.origin && live(owner);
  }
  function actionCurrent(owner) {
    const allowed = current(owner);
    // Observed retirement is reconciled now, not deferred until an unrelated
    // notification. The existing owner releases only this captured session.
    if (!allowed) schedule();
    return allowed && live(owner);
  }
  function canCreate(owner) {
    if (!current(owner) || !owner.controller || owner.receipt || !owner.origin.canCreate()) return false;
    const state = owner.controller.getSnapshot();
    return state.scopeKey === owner.origin.scopeKey && albumTopActionAllowed(state, 'create')
      && current(owner) && owner.controller?.getSnapshot() === state && owner.origin.canCreate();
  }
  function acknowledgement(owner, value) {
    if (!actionCurrent(owner) || !owner.controller || owner.receipt) return false;
    const state = owner.controller.getSnapshot(), mutation = state.mutation;
    if (mutation.status !== 'ready' || mutation.action !== 'create' || mutation.refreshing
      || mutation.command?.request_key !== value.submittedRequestKey || mutation.data?.request_key !== value.submittedRequestKey
      || mutation.data?.action !== 'create' || mutation.command.artist_scope?.root_artist_id !== owner.origin.artistScope.root_artist_id
      || !['artist', 'family'].includes(mutation.command.artist_scope?.mode)
      || ['request_key', 'top_ref', 'revision', 'action'].some(key => mutation.data?.[key] !== value.receipt?.[key])) return false;
    if (!current(owner) || owner.controller?.getSnapshot() !== state) return false;
    const receipt = Object.freeze(Object.fromEntries(['request_key', 'top_ref', 'revision', 'action'].map(key => [key, value.receipt[key]])));
    owner.receipt = receipt;
    const proof = () => current(owner) && owner.controller?.getSnapshot() === state;
    open(owner, proof); return true;
  }
  function open(owner, proof = () => current(owner)) {
    if (!actionCurrent(owner) || !owner.receipt || owner.opening) return;
    owner.opening = true; schedule();
    Promise.resolve(owner.origin.openCreatedTop(owner.receipt, {isCurrent: proof, onSettled(result) {
      if (!live(owner)) return;
      owner.opening = false; owner.recovery = result.recoverable === true;
      schedule();
    }})).then(() => {if (live(owner)) {owner.opening = false; schedule();}}, () => {if (live(owner)) {owner.opening = false; schedule();}});
  }
  function start(owner) {
    if (!actionCurrent(owner) || owner.editor || owner.starting || !canCreate(owner)) return;
    owner.starting = true;
    const facade = {...runtime, openForm: options => owner.origin.openForm(options), confirm: (...args) => owner.origin.confirm(...args)};
    try {
      const editor = openAlbumTopBuilder({runtime: facade, controller: owner.controller, providers,
        state: owner.controller.getSnapshot(), artistScope: owner.origin.artistScope, artistLabel: owner.origin.artistLabel,
        isCurrent: () => current(owner), onScopedCreateAcknowledged: value => acknowledgement(owner, value),
        onClose() {
          owner.editor = null; releaseController(owner);
          if (live(owner)) schedule();
        }});
      if (!current(owner)) {editor.dispose(); return;}
      owner.editor = editor;
    } finally {owner.starting = false; if (live(owner)) schedule();}
  }
  function adopt(owner) {
    const root = owner.origin.headerRoot;
    if (headerOwners.has(root)) return false;
    const original = [...root.childNodes]; headerOwners.set(root, owner);
    owner.original = original.map(node => ({node, slot: null}));
    for (const node of original) node.remove();
    let header;
    try {
      header = mountSharedHeader(root, runtime, {id: `artist-create-${++serial}`, adoptRoot: true, ariaLabel: owner.origin.artistLabel});
      owner.header = header;
      if (!current(owner) || headerOwners.get(root) !== owner) {releaseHeader(owner); return false;}
      for (const node of original) {
        const slot = node.nodeType === 1 && node.classList.contains('gallery-bar__context') ? header.slots.identity : header.slots.actions;
        slot.append(node); owner.original.find(record => record.node === node).slot = slot;
      }
      owner.status = make(header.slots.content, 'div'); owner.actionHost = make(header.slots.actions);
      const primary = mountButton(make(owner.actionHost), runtime, {label: 'Create Listen-through', onClick: () => start(owner)});
      owner.controls.push(primary); owner.primary = primary;
      const dismiss = mountButton(make(owner.actionHost), runtime, {label: 'Dismiss', onClick: () => {if (actionCurrent(owner)) retire(owner, true);}});
      owner.controls.push(dismiss); owner.dismiss = dismiss;
      return current(owner);
    } catch (error) {
      if (owner.header) releaseHeader(owner); else {header?.dispose(); if (headerOwners.get(root) === owner) {for (const node of original) if (!node.parentNode) root.append(node); headerOwners.delete(root);}}
      throw error;
    }
  }
  function paint(owner) {
    if (!current(owner)) {retire(owner); return;}
    owner.editor?.update({state: owner.controller?.getSnapshot()});
    if (!current(owner)) return;
    const phase = owner.origin.phase();
    if (!owner.header) {if (!canCreate(owner) || !adopt(owner)) return;}
    if (!current(owner)) return;
    const recovery = Boolean(owner.receipt && phase === 'recovery');
    owner.status.innerHTML = recovery ? runtime.alertHtml({severity: 'error', role: 'alert', message: 'Top created; opening failed.'}) : '';
    if (!current(owner)) return;
    owner.primary.update({label: owner.receipt ? 'Open' : 'Create Listen-through', disabled: owner.receipt
      ? !recovery || owner.opening : !canCreate(owner), onClick: () => owner.receipt ? open(owner) : start(owner)});
    if (!current(owner)) return;
    owner.dismiss.element.hidden = !recovery;
    owner.dismiss.update({label: 'Dismiss', disabled: !recovery || owner.opening, onClick: () => {if (actionCurrent(owner) && owner.origin.phase() === 'recovery') retire(owner, true);}});
    owner.header?.refresh();
  }
  function schedule() {
    if (disposed) return; queued = true; if (running) return; running = true;
    try {while (queued && !disposed) {
      queued = false;
      const origin = namespace.snapshot();
      if (session && (session.origin !== origin || !live(session))) retire(session, session.origin === origin);
      if (!session && origin && origin.canCreate() && providerKeys.every(key => typeof providers?.[key] === 'function')
        && nativeKeys.every(key => typeof runtime[key] === 'function')) {
        const owner = {origin, retired: false, controller: createAlbumTopController({providers}), unsubscribe: null,
          providerMethods: Object.fromEntries(providerKeys.map(key => [key, providers[key]])), editor: null,
          header: null, original: [], controls: [], receipt: null, opening: false, starting: false};
        session = owner; owner.controller.setScope(origin.scopeKey);
        owner.unsubscribe = owner.controller.subscribe(() => schedule());
        owner.controller.load();
      }
      if (session) {const owner = session; try {paint(owner);} catch {retire(owner, true);}}
    }} finally {running = false;}
  }
  const unsubscribe = namespace.subscribe(schedule), unsubscribeShell = runtime.subscribe(schedule);
  schedule();
  return {dispose() {if (disposed) return; disposed = true; unsubscribe(); unsubscribeShell(); retire(session, true);}};
}
