import {mountButton, mountChoice, mountStatus} from '../home-friends/native-controls.mjs';
import {albumTopActionAllowed} from './model.mjs';

const ROW_LIMIT = 25, SOURCE_LIMIT = 25, CURSOR_LIMIT = 100;
const unavailable = () => ({status: 'unavailable', data: null, error: null});
const busy = state => state?.mutation?.refreshing === true || ['loading', 'uncertain'].includes(state?.mutation?.status);
const sourceKey = source => `${source.selected_local_album_id}:${source.selected_source_ref}`;
const selectedSource = row => Number.isSafeInteger(row?.selected_local_album_id) && row.selected_local_album_id > 0
  && typeof row.selected_source_ref === 'string';
const metadata = row => [row.artist, row.year].filter(value => value !== null && value !== undefined && value !== '').join(' · ');
function sourceSuffix(source, rows = []) {
  const ref = source.selected_source_ref;
  for (const length of [8, 12, 16, 36]) {
    const suffix = ref.slice(-length);
    if (!rows.some(other => other.selected_source_ref !== ref && other.selected_source_ref.endsWith(suffix))) return suffix;
  }
  return ref;
}
function ownerObservation(state) {
  const observation = state?.publication, detail = state?.detail;
  return Boolean(state?.scopeKey && state.selectedTopRef && detail?.status === 'ready'
    && detail.data?.top_ref === state.selectedTopRef && detail.data.allowed_actions?.['library.browse.read'] === true
    && observation?.status === 'ready' && observation.data && observation.scopeKey === state.scopeKey
    && observation.top_ref === state.selectedTopRef && observation.revision === detail.data.revision);
}
function savedDraft(state) {
  const detail = state?.detail?.data, draft = state?.publicationDraft;
  if (!detail || !Array.isArray(detail.items) || !draft || draft.top_ref !== detail.top_ref
    || draft.revision !== detail.revision || !Array.isArray(draft.items) || draft.items.length !== detail.items.length
    || draft.items.some((row, index) => row.item_ref !== detail.items[index]?.item_ref
      || row.album_ref !== detail.items[index]?.album_ref)) return null;
  return draft.items;
}

// Presentation only: the existing controller owns saved membership, review
// tokens, publication authority and every mutation/retry. This pane never reads
// sharing on its own and requests sources only after an explicit row gesture.
export function mountAlbumTopPublication(host, runtime, initial) {
  const {controller, onChange, onError} = initial, doc = host.ownerDocument;
  const root = doc.createElement('section'); root.className = 'album-top-share__publication';
  root.setAttribute('aria-label', 'Public link'); host.append(root);
  let state = initial.state, alive = true, mounting = true, rendering = false, pendingRender = false, revision = 0;
  let cancelled = false, failed = false, identity = null, albumPage = 0, focused = null;
  let sourceRequest = null, sourceEpoch = 0, sourceValue = unavailable(), cursor = null, seenCursors = new Set(), seenSources = new Set();
  let copyEpoch = 0, confirmationEpoch = 0, copying = false, confirming = false, notice = null;
  const records = new Map(), superseded = Symbol('superseded publication render');

  function retireSources({clearFocus = true} = {}) {
    sourceEpoch++; sourceRequest?.abort(); sourceRequest = null;
    sourceValue = unavailable(); cursor = null; seenCursors = new Set(); seenSources = new Set();
    if (clearFocus) focused = null;
  }
  function retireGestures() {copyEpoch++; confirmationEpoch++; copying = false; confirming = false; notice = null;}
  function dispose() {
    if (!alive) return;
    // Retire before native cleanup or cancellation can synchronously reenter us.
    alive = false; revision++; pendingRender = false; identity = null;
    retireSources(); retireGestures();
    const previous = [...records.values()]; records.clear();
    for (const record of previous) {
      const owner = record.owner; record.owner = null;
      try {owner?.dispose();} catch (_cleanupError) { /* Continue retiring every owner. */ }
    }
    root.remove();
    if (!cancelled) {
      cancelled = true;
      try {controller.cancelPublicationPreparation();} catch (_cleanupError) { /* Disposal must not strand the dialog. */ }
    }
  }
  function fail(error) {
    if (!alive || failed) return;
    failed = true; dispose();
    try {onError?.(error);} catch (_callbackError) { /* Keep retirement final. */ }
  }
  function changed() {
    if (!alive) return;
    state = controller.getSnapshot(); render();
    if (alive) onChange?.();
  }
  function sameSubject(captured, next = controller.getSnapshot()) {
    return alive && next.scopeKey === captured.scopeKey && next.selectedTopRef === captured.topRef
      && next.detail?.data === captured.detail && next.detail?.data?.revision === captured.revision;
  }
  function capture(next = controller.getSnapshot()) {
    return {scopeKey: next.scopeKey, topRef: next.selectedTopRef, detail: next.detail?.data,
      revision: next.detail?.data?.revision, observation: next.publication};
  }
  function sameObservation(captured, next = controller.getSnapshot()) {
    return sameSubject(captured, next) && ownerObservation(next) && next.publication === captured.observation;
  }
  function actionable(captured, action) {
    const next = controller.getSnapshot();
    return sameObservation(captured, next) && !busy(next) && albumTopActionAllowed(next, action);
  }
  function canNext(next) {
    return typeof next === 'string' && next.length > 0 && next.length <= 4096
      && next !== cursor && !seenCursors.has(next) && seenCursors.size < CURSOR_LIMIT;
  }
  function readSources(itemRef, nextCursor = null, first = false) {
    const captured = capture();
    if (!actionable(captured, 'enable_external') || !captured.detail.items.some(row => row.item_ref === itemRef)) return;
    if (first || focused !== itemRef) {
      retireSources(); focused = itemRef;
    } else if (nextCursor !== cursor && !canNext(nextCursor)) return;
    sourceRequest?.abort();
    const epoch = ++sourceEpoch, request = new AbortController(); sourceRequest = request;
    cursor = nextCursor; if (nextCursor) seenCursors.add(nextCursor);
    sourceValue = {status: 'loading', data: null, error: null}; notice = null;
    const current = () => alive && sourceEpoch === epoch && sourceRequest === request && !request.signal.aborted
      && focused === itemRef && cursor === nextCursor && actionable(captured, 'enable_external');
    // Render before starting the read, then recheck in case a renderer closed us.
    render();
    Promise.resolve().then(() => current()
      ? controller.readPublicationSources(itemRef, {cursor: nextCursor, limit: SOURCE_LIMIT, signal: request.signal}) : null)
      .then(result => {
        if (!current()) return;
        sourceRequest = null;
        sourceValue = result || {status: 'error', data: null, error: null};
        for (const source of sourceValue.data?.sources || []) seenSources.add(sourceKey(source));
        changed();
      }, error => {
        if (!current() || error?.name === 'AbortError') return;
        sourceRequest = null; sourceValue = {status: 'error', data: null, error}; changed();
      }).catch(error => {if (alive && sourceEpoch === epoch) fail(error);});
  }
  function copyLink() {
    const next = controller.getSnapshot(), captured = capture(next), publication = next.publication?.data;
    if (!sameObservation(captured, next) || busy(next) || copying || publication?.state !== 'enabled'
      || !publication.deployment_available || !publication.public_url) return;
    const clipboard = doc.defaultView?.navigator?.clipboard || globalThis.navigator?.clipboard;
    if (typeof clipboard?.writeText !== 'function') {
      notice = {text: 'Clipboard access is unavailable. Try copying again in a supported browser.', error: true}; render(); return;
    }
    const epoch = ++copyEpoch, url = publication.public_url;
    const current = () => alive && copyEpoch === epoch && sameObservation(captured)
      && !busy(controller.getSnapshot()) && controller.getSnapshot().publication.data.public_url === url
      && controller.getSnapshot().publication.data.share_ref === publication.share_ref
      && controller.getSnapshot().publication.data.link_revision === publication.link_revision
      && controller.getSnapshot().publication.data.publication_ref === publication.publication_ref
      && controller.getSnapshot().publication.data.publication_revision === publication.publication_revision;
    copying = true; notice = null;
    let copied;
    // Keep the standard clipboard call inside this explicit user gesture.
    try {copied = clipboard.writeText(url);} catch (error) {copied = Promise.reject(error);}
    render();
    Promise.resolve(copied).then(() => {
      if (!current()) return;
      copying = false; notice = {text: 'Public link copied.', error: false}; render();
    }, () => {
      if (!current()) return;
      copying = false; notice = {text: 'The public link could not be copied. Try again.', error: true}; render();
    }).catch(fail);
  }
  function revokeLink() {
    const captured = capture();
    if (confirming || typeof runtime.confirm !== 'function' || !actionable(captured, 'revoke_external')) return;
    const epoch = ++confirmationEpoch; confirming = true; notice = null;
    let confirmation;
    try {confirmation = runtime.confirm('Revoke this public link? People with the link will no longer have access.',
      {title: 'Revoke public link', acceptLabel: 'Revoke public link', danger: true});}
    catch (error) {confirmation = Promise.reject(error);}
    render();
    Promise.resolve(confirmation).then(accepted => {
      if (!alive || confirmationEpoch !== epoch) return;
      confirming = false;
      if (accepted === true && actionable(captured, 'revoke_external')) {
        return Promise.resolve(controller.mutate('revoke_external')).then(() => {if (alive) changed();});
      }
      render();
    }, () => {
      if (!alive || confirmationEpoch !== epoch || !sameObservation(captured)) return;
      confirming = false; notice = {text: 'The public link could not be revoked. Try again.', error: true}; render();
    }).catch(fail);
  }
  function prepare(captured) {
    if (!actionable(captured, 'enable_external') || state.preparation?.status === 'loading') return;
    notice = null;
    Promise.resolve(controller.preparePublication()).then(() => {if (alive && sameSubject(captured)) changed();}).catch(fail);
  }
  function publish(captured, token) {
    const next = controller.getSnapshot();
    if (!actionable(captured, 'enable_external') || next.preparation?.status !== 'ready'
      || !token || next.preparation.token !== token) return;
    notice = null;
    Promise.resolve(controller.publishPrepared(token)).then(() => {if (alive && sameSubject(captured)) changed();}).catch(fail);
  }

  function render() {
    if (!alive || failed) return;
    revision++; pendingRender = true;
    if (rendering) return;
    rendering = true;
    try {
      while (pendingRender && alive && !failed) {
        pendingRender = false; const operation = revision;
        try {renderPass(operation);}
        catch (error) {
          if (error === superseded || !alive || operation !== revision) continue;
          if (mounting) throw error;
          fail(error);
        }
      }
    } finally {rendering = false;}
  }
  function renderPass(operation) {
    const current = () => alive && !failed && revision === operation;
    const check = () => {if (!current()) throw superseded;};
    const detail = state.detail?.data, scopeKey = state.scopeKey, observation = state.publication;
    const identityChanged = !identity || identity.scopeKey !== scopeKey || identity.detail !== detail
      || identity.topRef !== state.selectedTopRef || identity.revision !== detail?.revision;
    if (identityChanged || identity.observation !== observation || busy(state) !== identity.busy) {
      retireSources(); retireGestures();
      if (identityChanged) albumPage = 0;
    }
    identity = {...capture(state), busy: busy(state)};
    const captured = capture(state), observed = ownerObservation(state), publication = observed ? observation.data : null;
    const enable = observed && albumTopActionAllowed(state, 'enable_external'), blocked = busy(state);
    const draft = savedDraft(state), items = Array.isArray(detail?.items) ? detail.items : null;
    const used = new Set(), children = new Map();
    function node(key, parent, tag = 'div') {
      check(); used.add(key);
      let record = records.get(key);
      if (!record) {record = {node: doc.createElement(tag), owner: null}; records.set(key, record);}
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(record.node); return record;
    }
    function section(key, parent, tag = 'div', className = '') {
      const record = node(key, parent, tag); record.node.className = className;
      children.set(record.node, []); return record.node;
    }
    function text(key, parent, message, className = '', role = null, tag = 'p') {
      const record = node(key, parent, tag); record.node.textContent = message; record.node.className = className;
      if (role) record.node.setAttribute('role', role); else record.node.removeAttribute('role');
      return record.node;
    }
    function control(key, parent, mount, props, tag = 'div') {
      const record = node(key, parent, tag);
      if (record.owner) {record.owner.update(props); check();}
      else {
        const acquired = mount(record.node, runtime, props);
        if (!current()) {try {acquired?.dispose();} finally {throw superseded;}}
        record.owner = acquired;
      }
      return record.node;
    }
    const button = (key, parent, label, disabled, onClick, options = {}) => control(key, parent, mountButton,
      {...options, label, disabled, onClick}, 'span');
    text('heading', root, 'Public link', '', null, 'h3');
    if (!observed) {
      control('owner:status', root, mountStatus, {value: observation?.status === 'ready' ? unavailable() : observation || unavailable(), label: 'public link settings'});
      text('owner:note', root, 'Public link settings require a current owner view of this Album Top.', 'playlists__note');
    } else {
      text('publication:state', root, {unpublished: 'Not published', enabled: 'Public link enabled', revoked: 'Public link revoked'}[publication.state], '', 'status');
      text('publication:hosting', root, publication.deployment_available
        ? 'Public hosting is available.' : 'Public hosting is unavailable on this server.', 'playlists__note');
      text('publication:privacy', root,
        'Publication shares album and track metadata only. Audio files, artwork, private source identifiers, ratings and listening progress stay private.', 'playlists__note');
      const actions = section('publication:actions', root, 'div', 'playlists__actions album-top-share__publication-actions');
      if (publication.state === 'enabled' && publication.public_url) {
        text('publication:url', root, publication.public_url, 'album-top-share__text');
        button('copy', actions, copying ? 'Copying link…' : 'Copy link', blocked || copying, copyLink);
      }
      if (publication.can_revoke_external) button('revoke', actions, 'Revoke public link', blocked || confirming
        || typeof runtime.confirm !== 'function', revokeLink);
      if (!enable) text('publication:disabled', root,
        'Publishing is unavailable with the current editing permissions or hosting settings.', 'playlists__note');
      if (items) {
        const count = items.length, pages = Math.max(1, Math.ceil(count / ROW_LIMIT));
        albumPage = Math.min(albumPage, pages - 1);
        const start = albumPage * ROW_LIMIT, end = Math.min(count, start + ROW_LIMIT);
        const selected = draft?.filter(selectedSource).length || 0;
        text('albums:heading', root, 'Saved albums', '', null, 'h4');
        text('albums:coverage', root, `${selected} of ${count} albums have a selected metadata source.`, 'playlists__note', 'status');
        if (!draft) text('albums:unavailable', root, 'The complete saved source selection is unavailable. Refresh this Album Top before previewing.', 'playlists__note');
        if (!count) text('albums:empty', root, 'This saved Album Top has no albums.', 'playlists__note');
        if (pages > 1) control('albums:page', root, mountChoice, {label: 'Saved albums page', value: String(albumPage),
          options: Array.from({length: pages}, (_, page) => [String(page), `Albums ${page * ROW_LIMIT + 1}–${Math.min(count, (page + 1) * ROW_LIMIT)} of ${count}`]),
          onChange: value => {
            if (!sameSubject(captured) || !/^\d+$/.test(value)) return;
            const page = Number(value); if (page < 0 || page >= pages) return;
            albumPage = page; retireSources(); render();
          }});
        const rowsHost = section('albums:rows', root, 'ol', 'album-top-share__saved-albums');
        rowsHost.setAttribute('start', String(start + 1)); rowsHost.setAttribute('aria-label', 'Saved publication albums');
        for (let index = start; index < end; index++) {
          const item = items[index], selection = draft?.[index], key = `album:${item.item_ref}`;
          const row = section(key, rowsHost, 'li', 'album-top-share__saved-album'); row.setAttribute('data-item-ref', item.item_ref);
          text(`${key}:title`, row, item.title || 'Untitled album', 'album-top-share__text');
          text(`${key}:metadata`, row, metadata(item), 'album-top-share__text playlists__note');
          const chosen = selectedSource(selection);
          text(`${key}:source`, row, chosen
            ? `Source selected: local copy ${selection.selected_local_album_id} · ${sourceSuffix(selection)}` : 'No metadata source selected.', 'playlists__note');
          const rowActions = section(`${key}:actions`, row, 'div', 'playlists__actions');
          button(`${key}:choose`, rowActions, chosen ? 'Change source' : 'Choose source', blocked || !enable || !draft,
            () => {if (actionable(captured, 'enable_external')) readSources(item.item_ref, null, true);});
          if (chosen) button(`${key}:clear`, rowActions, 'Clear source', blocked || !enable,
            () => {if (actionable(captured, 'enable_external')) {
              retireSources(); controller.setPublicationSource(item.item_ref, null); changed();
            }});
          if (focused === item.item_ref) {
            const chooser = section('sources:chooser', row, 'div', 'album-top-share__source-chooser');
            chooser.setAttribute('aria-label', `Metadata sources for ${item.title || 'this album'}`);
            text('sources:heading', chooser, 'Choose an eligible local metadata source', '', null, 'h5');
            control('sources:status', chooser, mountStatus, {value: sourceValue, label: 'metadata sources',
              retry: () => {if (actionable(captured, 'enable_external')) readSources(item.item_ref, cursor);}});
            const results = section('sources:results', chooser, 'div', 'album-top-share__source-results');
            results.setAttribute('aria-label', 'Available metadata sources');
            // Retain distinct physical copies, but never reconcile the same
            // exact tuple host twice if an upstream page repeats that tuple.
            const sources = [...new Map((sourceValue.data?.sources || []).map(source => [sourceKey(source), source])).values()];
            for (const source of sources) {
              const sourceId = sourceKey(source), sourceRow = section(`source:${sourceId}`, results, 'div', 'album-top-share__source-row');
              sourceRow.setAttribute('data-source-ref', source.selected_source_ref);
              sourceRow.setAttribute('title', source.selected_source_ref);
              text(`source:${sourceId}:title`, sourceRow, source.title, 'album-top-share__text');
              text(`source:${sourceId}:metadata`, sourceRow, metadata(source), 'album-top-share__text playlists__note');
              const suffix = sourceSuffix(source, sources);
              text(`source:${sourceId}:copy`, sourceRow, `Local copy ${source.selected_local_album_id} · source ${suffix}`, 'playlists__note');
              const page = sourceValue;
              button(`source:${sourceId}:use`, sourceRow, `Use source ${suffix}`, blocked || !enable,
                () => {
                  if (!actionable(captured, 'enable_external') || focused !== item.item_ref || sourceValue !== page) return;
                  retireSources();
                  controller.setPublicationSource(item.item_ref, {selected_local_album_id: source.selected_local_album_id,
                    selected_source_ref: source.selected_source_ref}); changed();
                });
            }
            const next = sourceValue.data?.next_cursor;
            if (sourceValue.status === 'ready' && !sources.length) {
              text('sources:empty', results, next ? 'No eligible sources on this page. Continue to check more sources.'
                : seenSources.size ? 'There are no more eligible sources on this page. Return to the first page to choose an earlier source.'
                  : 'No eligible local metadata source is available for this album. Remote/nonlocal metadata publication is not supported here. Publication cannot proceed while this album has no eligible source.', 'playlists__note', 'status');
            }
            const sourceActions = section('sources:actions', chooser, 'div', 'playlists__actions');
            if (cursor) button('sources:first', sourceActions, 'First sources page', blocked || sourceValue.status === 'loading',
              () => {if (actionable(captured, 'enable_external')) readSources(item.item_ref, null, true);}, {size: 'small'});
            if (next) {
              button('sources:next', sourceActions, 'More sources', blocked || !canNext(next),
                () => {if (actionable(captured, 'enable_external')) readSources(item.item_ref, next);}, {size: 'small'});
              if (!canNext(next)) text('sources:bounded', chooser,
                'Source paging stopped because the continuation repeated or reached its page limit. Start from the first page to try again.', 'playlists__note', 'status');
            }
            button('sources:close', sourceActions, 'Close source chooser', false, () => {if (sameSubject(captured)) {retireSources(); render();}});
          }
        }
        const preparation = state.preparation || unavailable();
        const actions = section('preview:actions', root, 'div', 'playlists__actions album-top-share__publication-actions');
        button('preview', actions, 'Preview publication', blocked || !enable || !draft || selected !== count || preparation.status === 'loading',
          () => prepare(captured));
        if (['loading', 'error', 'denied'].includes(preparation.status)) {
          control('preview:status', root, mountStatus, {value: preparation, label: 'publication preview'});
          if (preparation.status === 'error') text('preview:retry-note', root,
            'Your source selections are kept. Check them and preview the publication again.', 'playlists__note');
        }
        if (preparation.status === 'ready' && preparation.token && preparation.data?.top_ref === state.selectedTopRef
          && preparation.data.revision === detail.revision && Array.isArray(preparation.data.items)) {
          const preview = section('preview:content', root, 'div', 'album-top-share__publication-preview');
          text('preview:heading', preview, 'Publication preview', '', null, 'h4');
          text('preview:title', preview, detail.title, 'album-top-share__text');
          if (detail.description) text('preview:description', preview, detail.description, 'album-top-share__text');
          text('preview:summary', preview, `${preparation.data.items.length} albums · ${preparation.data.items.reduce((sum, row) => sum + row.track_count, 0)} tracks`, '', 'status');
          text('preview:note', preview, 'Review the metadata below. Publishing requires the separate Publish action.', 'playlists__note');
          const previewRows = section('preview:rows', preview, 'ol', 'album-top-share__saved-albums');
          previewRows.setAttribute('start', String(start + 1));
          for (const item of preparation.data.items.slice(start, end)) {
            const previewKey = `preview:item:${item.item_ref}`;
            const row = section(previewKey, previewRows, 'li', 'album-top-share__saved-album');
            text(`${previewKey}:title`, row, item.title || 'Untitled album', 'album-top-share__text');
            text(`${previewKey}:metadata`, row, `${metadata(item)}${metadata(item) ? ' · ' : ''}${item.track_count} tracks`, 'album-top-share__text playlists__note');
          }
          if (enable && !blocked) button('publish', actions, publication.state === 'unpublished' ? 'Publish' : 'Republish', false,
            () => publish(captured, preparation.token), {variant: 'primary'});
        }
      }
    }
    if (notice) text('notice', root, notice.text, 'playlists__note', notice.error ? 'alert' : 'status');
    check();
    for (const [key, record] of records) if (!used.has(key)) {
      records.delete(key); const previous = record.owner; record.owner = null;
      previous?.dispose(); check(); record.node.remove();
    }
    for (const [parent, desired] of children) {
      check(); let cursorNode = parent.firstChild;
      for (const child of desired) {
        check();
        if (child === cursorNode) cursorNode = cursorNode.nextSibling; else parent.insertBefore(child, cursorNode);
      }
      while (cursorNode) {check(); const next = cursorNode.nextSibling; cursorNode.remove(); cursorNode = next;}
    }
    check();
  }
  try {render();} catch (error) {dispose(); throw error;} finally {mounting = false;}
  return {element: root, update({state: next}) {if (!alive) return; state = next; render();}, dispose};
}
