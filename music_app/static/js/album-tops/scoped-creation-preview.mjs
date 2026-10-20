import {mountButton} from '../home-friends/native-controls.mjs';

const leases = new WeakMap();
const rowKey = row => row?.album_ref || row?.selection_key;
const label = value => typeof value === 'string' && value.trim() ? value.trim() : 'Unknown artist';
const inert = () => ({update: () => false, dispose() {}});
const node = (document, className = '') => {const element = document.createElement('div'); element.className = className; return element;};
const methods = ['galleryCardHtml', 'artistSeparatorHtml', 'galleryRatingHtml', 'artboxHtml', 'escapeHtml',
  'buttonHtml', 'createGalleryHost', 'createGalleryMetadataOwner', 'createGalleryFocusOwner'];
function normalize(props, draft) {
  if (!props || typeof props !== 'object' || props.draft !== draft || typeof draft?.getSnapshot !== 'function'
    || typeof draft.remove !== 'function' || typeof props.isCurrent !== 'function'
    || !props.value || !Array.isArray(props.value.items)
    || Object.hasOwn(props, 'displayMode') && !['list', 'cards', 'covers'].includes(props.displayMode)
    || !['minimal', 'full'].includes(props.information === undefined ? 'minimal' : props.information)
    || Object.hasOwn(props, 'disabled') && typeof props.disabled !== 'boolean'
    || Object.hasOwn(props, 'blocked') && typeof props.blocked !== 'boolean') throw new TypeError('A current scoped Selected preview is required.');
  const keys = Array.from(props.value.items, rowKey);
  if (keys.some(key => typeof key !== 'string' || !key) || new Set(keys).size !== keys.length) throw new TypeError('Selected preview requires unique draft row keys.');
  return {...props, displayMode: props.displayMode ?? 'cards', information: props.information ?? 'minimal', disabled: props.disabled ?? false,
    blocked: props.blocked ?? props.disabled ?? false};
}
function observes(props, scopeKey) {
  try {
    return props.value === props.draft.getSnapshot() && props.value.scopeKey === scopeKey
      && typeof scopeKey === 'string' && Boolean(scopeKey) && props.value.artistScope?.mode
      && !props.value.denied && !props.value.stale
      && props.value.tab === 'selected' && props.isCurrent() === true
      && props.value === props.draft.getSnapshot() && props.value.scopeKey === scopeKey;
  } catch {return false;}
}
export function mountScopedCreationPreview(host, runtime, initial) {
  if (!host?.ownerDocument || methods.some(name => typeof runtime?.[name] !== 'function')) throw new TypeError('Native Gallery preview owners are required.');
  const draft = initial?.draft, first = normalize(initial, draft), scopeKey = first.value.scopeKey;
  const previous = leases.get(host);
  if (!observes(first, scopeKey) || leases.get(host) !== previous) return inert();
  let latest = first, disposed = false, revision = 0, admittedRevision = 0, rendering = false, queued = false;
  let gallery = null, metadata = null, focus = null, snapshot = null;
  const token = {}, superseded = Symbol('retired scoped preview'), document = host.ownerDocument;
  const viewport = node(document, 'albums-viewport'), glow = node(document, 'gallery-focus-glow');
  glow.hidden = true; glow.setAttribute('aria-hidden', 'true'); viewport.append(glow);
  const live = () => !disposed && leases.get(host) === token;
  const current = () => {const captured = latest, version = revision;
    return live() && observes(captured, scopeKey) && live() && latest === captured && revision === version;};
  // A newer admitted presentation supersedes a paint pass, not its native
  // Gallery lifetime. Never promote an in-progress, unadmitted reservation.
  const nativeCurrent = () => {
    const version = revision;
    if (current()) return true;
    const captured = latest;
    return live() && revision !== version && admittedRevision === revision
      && captured.value === draft.getSnapshot() && captured.value.scopeKey === scopeKey
      && captured.value.artistScope?.mode && captured.value.tab === 'selected'
      && !captured.value.denied && !captured.value.stale;
  };
  const editable = () => current() && !latest.disabled && !latest.blocked && !latest.value.busy
    && !latest.value.denied && !latest.value.stale && !latest.value.remote?.retired && !latest.value.remote?.membershipRetired;
  const check = version => {if (!current() || revision !== version) throw superseded;};
  function dispose() {
    if (disposed) return; disposed = true; revision++;
    if (leases.get(host) === token) leases.delete(host);
    // Every resource is tied to this private viewport, never a successor host.
    const owners = [metadata, focus, gallery]; metadata = focus = gallery = null;
    for (const owner of owners) {try {owner?.dispose();} catch { /* Retire all owners. */ }}
    viewport.remove(); snapshot = null;
  }
  token.dispose = dispose;
  function cardHtml(row, version) {
    const facts = row.creation_metadata, full = latest.information === 'full';
    const url = typeof facts?.artwork_url === 'string' ? facts.artwork_url : null;
    const artboxHtml = runtime.artboxHtml({state: url ? 'ready' : 'empty', label: `${row.title} artwork`,
      coverHtml: url ? `<img src="${runtime.escapeHtml(url)}" alt="" loading="lazy" decoding="async" onerror="handleUtilityAlbumArtboxError(this)">` : ''}); check(version);
    const ratingHtml = full && facts?.rating_state === 'available' && Number.isInteger(facts.rating)
      && facts.rating >= 1 && facts.rating <= 10 ? runtime.galleryRatingHtml({value: facts.rating, maximum: 10}) : '';
    check(version);
    const html = runtime.galleryCardHtml({identity: rowKey(row), actionRef: rowKey(row), interaction: 'none',
      title: row.title, artist: full ? label(row.artist ?? row.artist_display) : '', year: row.year,
      displayMode: latest.displayMode, artboxHtml, ratingHtml, listeningSummaryHtml: ''}); check(version);
    return html;
  }
  function renderCard(initialRow) {
    const element = node(document), card = node(document), actions = node(document, 'playlists__actions');
    const note = node(document, 'playlists__note'), moveHost = node(document), removeHost = node(document);
    element.append(card, note, actions); actions.append(moveHost, removeHost);
    let move = null, remove = null, html = null, row = initialRow.value, retired = false;
    const release = () => {if (retired) return; retired = true; move?.dispose(); remove?.dispose(); element.remove();};
    const controls = () => {
      const key = rowKey(row), disabled = !editable();
      return [{label: 'Move', disabled, attributes: {'data-album-draft-move': key, 'aria-label': `Move ${row.title}`}},
        {label: 'Remove', disabled, attributes: {'data-album-draft-remove': key, 'aria-label': `Remove ${row.title}`},
          onClick(event) {event.stopPropagation(); const captured = latest; if (!retired && editable() && latest === captured
            && captured.value.items.some(item => rowKey(item) === key)) draft.remove(key);}}];
    };
    function update(next) {
      try {
      if (retired) return;
      const version = revision; check(version); row = next.value;
      const markup = cardHtml(row, version); check(version);
      if (markup !== html) {card.innerHTML = markup; html = markup;}
      element.setAttribute('data-album-draft-key', rowKey(row));
      note.textContent = row.source_kind === 'remote_summary' ? 'Remote album summary · tracks unavailable' : '';
      note.hidden = !note.textContent;
      const props = controls(); check(version);
      if (move) move.update(props[0]); else move = mountButton(moveHost, runtime, props[0]); check(version);
      if (remove) remove.update(props[1]); else remove = mountButton(removeHost, runtime, props[1]); check(version);
      } catch (error) {if (error !== superseded) throw error;}
    }
    try {update(initialRow); return {element, update, dispose: release};}
    catch (error) {release(); throw error;}
  }
  function renderSeparator(initialRow) {
    const element = node(document); let html = null;
    const update = row => {
      try {
      const version = revision; check(version);
      const markup = runtime.artistSeparatorHtml({artist: row.label, albumCount: row.count, showInfo: false}); check(version);
      if (markup !== html) {element.innerHTML = markup; html = markup;}
      } catch (error) {if (error !== superseded) throw error;}
    };
    update(initialRow); return {element, update, dispose: () => element.remove()};
  }
  function rows(value) {
    const result = []; let previousLabel = null, separator = null;
    for (const item of value.items) {
      const artist = label(item.artist ?? item.artist_display), key = rowKey(item);
      if (artist !== previousLabel) {
        separator = {key: `separator:${key}`, kind: 'separator', label: artist, count: 0};
        result.push(separator); previousLabel = artist;
      }
      separator.count++; result.push({key: `album:${key}`, kind: 'album', value: item});
    }
    return result;
  }
  function update(next) {
    if (!live()) return false;
    const normalized = normalize(next, draft);
    // Reserve before any caller observation; a nested update owns a newer intent.
    const intent = ++revision;
    const admitted = observes(normalized, scopeKey);
    if (!live() || revision !== intent) return false;
    if (!admitted) {dispose(); return false;}
    latest = normalized; admittedRevision = intent; queued = true;
    if (rendering) return true;
    rendering = true;
    try {
      while (queued && live()) {
        queued = false; const version = revision;
        try {
        check(version);
        snapshot = Object.freeze({scopeKey, resourceKey: `artist-create:${latest.value.artistScope.root_artist_id}`,
          displayMode: latest.displayMode, galleryScalePercent: 100, layoutConfig: Object.freeze({cardMinWidth: 145})});
        const rendered = gallery.update(rows(latest.value)); check(version);
        if (!rendered) {dispose(); return false;}
        metadata.update(); check(version); focus.refresh(); check(version);
        } catch (error) {
          if (error !== superseded) throw error;
          // Renderer guards absorb this private signal locally, so the shared
          // Gallery stays valid. Drain the newest queued complete props here.
          if (live() && queued) continue;
          if (live() && !current()) dispose();
          return false;
        }
      }
      return current();
    } catch (error) {
      if (error === superseded) {if (live() && !current()) dispose(); return false;}
      dispose(); throw error;
    } finally {rendering = false;}
  }
  try {
    leases.set(host, token); previous?.dispose();
    if (!live()) return inert();
    host.append(viewport);
    const own = (value, assign) => {if (!live()) {value?.dispose(); throw superseded;} assign(value);};
    own(runtime.createGalleryHost({host: viewport, readSnapshot: () => snapshot, renderCard, renderSeparator, isCurrent: nativeCurrent}), value => {gallery = value;});
    own(runtime.createGalleryMetadataOwner({root: viewport, isCurrent: nativeCurrent}), value => {metadata = value;});
    own(runtime.createGalleryFocusOwner({viewport, scroll: host.closest?.('.album-top-builder__scroll') || host, glow, isCurrent: nativeCurrent}), value => {focus = value;});
    update(first);
    return {update, dispose};
  } catch (error) {dispose(); if (error === superseded) return inert(); throw error;}
}
