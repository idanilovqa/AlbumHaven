import {safeServerArtworkUrl} from './model.mjs';
import {detailSelection} from './detail-projection.mjs';
const known = value => typeof value === 'string' && value.trim() ? value : 'Unknown artist';
const readable = row => row?.source_readable !== false && !(Object.hasOwn(row?.allowed_actions || {}, 'can_read') && row.allowed_actions.can_read !== true);
export function resourceArtwork(runtime, data, label) {
  const url = safeServerArtworkUrl(data.artwork_url);
  return runtime.artboxHtml({state: url ? 'ready' : 'empty', label, coverHtml: url ? `<img src="${runtime.escapeHtml(url)}" alt="" loading="lazy" decoding="async">` : ''});
}
function paint(host, html) {
  const holder = host.ownerDocument.createElement('div'); holder.innerHTML = html;
  const next = holder.firstElementChild, current = host.firstElementChild;
  if (!current || !next || current.tagName !== next.tagName) {host.replaceChildren(...holder.childNodes); return;}
  for (const attr of [...current.attributes]) if (!next.hasAttribute(attr.name)) current.removeAttribute(attr.name);
  for (const attr of [...next.attributes]) if (current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name, attr.value);
  if (current.innerHTML !== next.innerHTML) current.innerHTML = next.innerHTML;
}
export function mountArtistSelectionRows(host, runtime, initial) {
  let props, disposed = false, revision = 0; const nodes = new Map(); host.setAttribute('aria-label', 'Artists');
  function click(event) {
    const trigger = event.target.closest('[data-home-artist-select]');
    if (disposed || !trigger || !host.contains(trigger) || trigger.disabled || event.defaultPrevented) return;
    const row = props.rows?.find(value => value.id === trigger.getAttribute('data-home-artist-select'));
    if (!row || !readable(row)) return;
    event.preventDefault(); event.stopPropagation(); props.onSelect?.(row);
  }
  host.addEventListener('click', click);
  function dispose() {if (!disposed) {disposed = true; revision++; host.removeEventListener('click', click); nodes.clear(); host.replaceChildren();}}
  function update(next) {
    if (disposed) return; const token = ++revision; props = next;
    try { host.className = `home-artists home-artists--${props.view === 'cards' ? 'circles' : 'rows'}`;
    const keep = new Set(); let position = 0;
    for (const row of props.rows || []) {
      keep.add(row.id); let item = nodes.get(row.id);
      if (!item) {item = host.ownerDocument.createElement('div'); item.className = 'home-artists__item'; nodes.set(row.id, item);}
      const allowed = readable(row), name = allowed ? known(row.title) : 'Unavailable artist';
      const html = runtime.navigationItemHtml({label: name, key: row.id, action: true, variant: 'wide', selected: allowed && row.id === props.selectedId,
        disabled: !allowed, count: allowed ? row.listen_count ?? null : null, artworkHtml: allowed ? resourceArtwork(runtime, row, `${name} artwork`) : '', attributes: {'data-home-artist-select': row.id}});
      if (disposed || token !== revision) return; paint(item, html);
      const at = host.children[position++]; if (at !== item) host.insertBefore(item, at || null);
    }
    for (const [id, item] of nodes) if (!keep.has(id)) {item.remove(); nodes.delete(id);}
    } catch (error) {try {dispose();} catch {} throw error;}
  }
  update(initial); return {element: host, update, dispose};
}
export function mountListenedAlbums(host, runtime, initial) {
  let props, disposed = false, revision = 0; const nodes = new Map();
  function click(event) {
    const trigger = event.target.closest('[data-gallery-card-intent="select"]');
    if (disposed || !trigger || !host.contains(trigger) || trigger.disabled || event.defaultPrevented || typeof props.onSelect !== 'function') return;
    const item = trigger.closest('[data-listened-album-id]'), album = props.albums?.find(value => value.id === item?.dataset.listenedAlbumId), target = detailSelection(album?.detail_target);
    if (target?.allowed_actions.can_view_details !== true) return;
    event.preventDefault(); event.stopPropagation(); props.onSelect(detailSelection({...target, native_actions: album.native_actions || target.native_actions}));
  }
  host.addEventListener('click', click);
  function dispose() {if (!disposed) {disposed = true; revision++; host.removeEventListener('click', click); nodes.clear(); host.replaceChildren();}}
  function update(next) {
    if (disposed) return; const token = ++revision; props = next;
    try {
    if (!props.albums?.length) {nodes.clear(); host.replaceChildren(); host.className = 'home-friends__muted'; host.textContent = props.albums == null ? 'Listened albums were not supplied for this period.' : 'No albums listened to in this period.'; return;}
    if (!nodes.size) host.replaceChildren(); host.className = 'home-detail__listened-albums'; const keep = new Set(); let position = 0;
    for (const album of props.albums) {
      keep.add(album.id); let item = nodes.get(album.id);
      if (!item) {item = host.ownerDocument.createElement('div'); item.dataset.listenedAlbumId = album.id; nodes.set(album.id, item);}
      const target = detailSelection(album.detail_target), canSelect = target?.allowed_actions.can_view_details === true && typeof props.onSelect === 'function';
      const html = runtime.galleryCardHtml({interaction: canSelect ? 'controlled' : 'none', identity: album.id, actionRef: album.id, displayMode: 'cards', title: album.title || 'Unknown album', year: album.year,
        listeningSummaryHtml: '', artboxHtml: resourceArtwork(runtime, album, `${album.title || 'Album'} artwork`), actions: {select: canSelect}}); if (disposed || token !== revision) return; paint(item, html); const at = host.children[position++]; if (at !== item) host.insertBefore(item, at || null);
    }
    for (const [id, item] of nodes) if (!keep.has(id)) {item.remove(); nodes.delete(id);}
    } catch (error) {try {dispose();} catch {} throw error;}
  }
  update(initial); return {element: host, update, dispose};
}
