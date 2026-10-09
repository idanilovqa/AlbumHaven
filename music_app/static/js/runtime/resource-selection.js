/* Native selection owns hydration and the one retained Album content lease.
   React receives canonical intents/display projections only. */
(() => {
'use strict';
// Canonical catalog targets only. Account profile identity has a separate owner.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const reference = value => typeof value === 'string' && value.trim().length > 0
  && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
const freeze = Object.freeze;
const grant = (value, name) => object(value) && Object.hasOwn(value, name) && value[name] === true;

function detailOrigin(value) {
  if (object(value) && value.source === 'queue') {
    if (Object.keys(value).some(key => !['source', 'occurrence_refs'].includes(key))
      || !Array.isArray(value.occurrence_refs) || !value.occurrence_refs.length || value.occurrence_refs.length > 5000
      || !value.occurrence_refs.every(reference) || new Set(value.occurrence_refs).size !== value.occurrence_refs.length) return null;
    return freeze({source: 'queue', occurrence_refs: freeze([...value.occurrence_refs])});
  }
  if (!object(value) || !['recent', 'activity', 'playlist', 'comparison'].includes(value.source)) return null;
  const playlist = value.source === 'playlist';
  if (value.account_ref != null && !reference(value.account_ref)) return null;
  if (value.source === 'recent' && value.account_ref != null) return null;
  if (!playlist && (!['albums', 'artists', 'tracks', 'listens'].includes(value.kind)
    || !['week', 'month', 'six', 'year', 'all'].includes(value.period))) return null;
  if (playlist && !reference(value.playlist_ref)) return null;
  if (value.snapshot_ref != null && !reference(value.snapshot_ref)) return null;
  return freeze({source: value.source, account_ref: value.account_ref ?? null,
    ...(!playlist ? {kind: value.kind, period: value.period} : {playlist_ref: value.playlist_ref}),
    ...(value.snapshot_ref == null ? {} : {snapshot_ref: value.snapshot_ref})});
}

function detailSelection(value) {
  if (!object(value) || !['album', 'artist'].includes(value.kind) || !reference(value.ref)) return null;
  const origin = value.origin == null ? null : detailOrigin(value.origin);
  if (value.origin != null && !origin) return null;
  const native = nativeActions(value.native_actions, value.kind);
  return freeze({kind: value.kind, ref: value.ref,
    ...(reference(value.identity_ref) ? {identity_ref: value.identity_ref} : {}),
    allowed_actions: freeze({can_view_details: grant(value.allowed_actions, 'can_view_details')}),
    ...(origin ? {origin} : {}),
    ...(native ? {native_actions: native} : {})});
}

function nativeActions(value, kind = 'album') {
  if (!object(value)) return null;
  if (kind === 'artist') return reference(value.artist_ref) ? freeze({artist_ref: value.artist_ref,
    allowed_actions: freeze({can_open_artist_gallery: grant(value.allowed_actions, 'can_open_artist_gallery')})}) : null;
  if (!reference(value.album_ref)) return null;
  const canOpen = grant(value.allowed_actions, 'can_open_album');
  return freeze({album_ref: value.album_ref, allowed_actions: freeze({
    can_open_album: canOpen, can_play_album: canOpen && grant(value.allowed_actions, 'can_play_album'),
    ...(Object.hasOwn(value.allowed_actions || {}, 'can_view_artwork')
      ? {can_view_artwork: canOpen && grant(value.allowed_actions, 'can_view_artwork')} : {}),
    ...(Object.hasOwn(value.allowed_actions || {}, 'can_open_album_page')
      ? {can_open_album_page: canOpen && grant(value.allowed_actions, 'can_open_album_page')} : {}),
  })});
}
const error = (message, status = 403) => Object.assign(new Error(message), {status});
const stale = () => Object.assign(new Error('Resource selection was superseded.'), {name: 'AbortError'});
function createResourceSelection({sourceResource, retainResource, revalidateResource, authorizeResource, projectAlbum} = {}) {
  let sequence = 0, artistReadSequence = 0;
  const artistAlbums = new Set(), mounted = new Set();
  const readSource = (target, context) => {
    try {return sourceResource?.(target, context) || null;} catch {return null;}
  };
  const sourceKey = value => value ? JSON.stringify(value) : '';
  function retainedSource(target, context) {
    const matches = [];
    for (const record of artistAlbums) {
      if (context.scopeKey !== record.context.scopeKey || JSON.stringify(context.origin) !== JSON.stringify(record.context.origin)
        || sourceKey(readSource(record.parent, record.context)) !== record.parentKey) continue;
      const child = record.albums.get(target.ref);
      if (target.kind === 'album' && child) matches.push(child);
    }
    return matches.length && matches.every(value => sourceKey(value) === sourceKey(matches[0])) ? matches[0] : null;
  }
  function retainArtistAlbums(selection, context, data) {
    const parent = detailSelection(selection), origin = detailOrigin(context?.origin || parent?.origin);
    const source = parent && readSource(parent, {...context, origin});
    if (parent?.kind !== 'artist' || !origin || !source || source.kind !== parent.kind || source.ref !== parent.ref
      || !grant(source.allowed_actions, 'can_view_details')
      || data?.kind !== parent.kind || data.ref !== parent.ref
      || JSON.stringify(detailOrigin(data.origin)) !== JSON.stringify(origin) || !Array.isArray(data.listened_albums)) return () => {};
    const albums = new Map();
    for (const row of data.listened_albums) {
      if (!object(row)) return () => {};
      const target = detailSelection({...row.detail_target, origin, native_actions: row.native_actions || row.detail_target?.native_actions});
      if (!target || target.kind !== 'album' || !target.allowed_actions.can_view_details) continue;
      if (albums.has(target.ref) && sourceKey(albums.get(target.ref)) !== sourceKey(target)) return () => {};
      albums.set(target.ref, target);
    }
    const record = {parent, context: {...context, origin}, parentKey: sourceKey(source),
      parentTargetKey: sourceKey(detailSelection(source)), albums, sequence: ++artistReadSequence};
    artistAlbums.add(record);
    return ({retire = false} = {}) => {
      if (retire && artistReadSequence === record.sequence) artistReadSequence++;
      artistAlbums.delete(record); for (const invalidate of mounted) invalidate();
    };
  }
  const grants = {open: 'can_open_album', artwork: 'can_view_artwork', page: 'can_open_album_page',
    artist_gallery: 'can_open_artist_gallery', embed: 'can_open_album'};
  function source(selection, context, intent) {
    const target = detailSelection(selection);
    if (!target || !target.allowed_actions.can_view_details || typeof sourceResource !== 'function'
      || !reference(context?.scopeKey) || !Object.hasOwn(grants, intent)) return null;
    if (context?.origin != null && !detailOrigin(context.origin)) return null;
    const origin = target.origin || detailOrigin(context?.origin);
    if (target.origin && context?.origin && JSON.stringify(target.origin) !== JSON.stringify(detailOrigin(context.origin))) return null;
    const requested = {...context, ...(origin ? {origin} : {})};
    const value = readSource(target, requested) || retainedSource(target, requested);
    if (!object(value) || value.kind !== target.kind || value.ref !== target.ref || value.source_readable === false
      || !grant(value.allowed_actions, 'can_view_details')) return null;
    const actions = nativeActions(value.native_actions, target.kind);
    if (!actions) return null;
    // Native Album browse permission already includes its artwork and responsive
    // page presentation. Supplied explicit restrictions still take precedence.
    const presentation = ['artwork', 'page'].includes(intent) && !Object.hasOwn(actions.allowed_actions, grants[intent])
      && grant(actions.allowed_actions, 'can_open_album');
    if (!presentation && !grant(actions.allowed_actions, grants[intent])) return null;
    if (target.kind === 'artist') {
      if (intent !== 'artist_gallery' || !reference(value.gallery_target?.artist)
        || typeof handleSidebarArtistSelectionClick !== 'function') return null;
    } else {
      if (intent === 'artist_gallery') return null;
      if (intent === 'open' && actions.allowed_actions.can_open_album_page === false
        && typeof usesMobilePageLayout === 'function' && usesMobilePageLayout()) return null;
      if (intent === 'page' && (typeof usesMobilePageLayout !== 'function' || !usesMobilePageLayout()
        || typeof presentMobileAlbumPage !== 'function')) return null;
      if (intent === 'embed' && typeof acquireTrackModalSelection !== 'function') return null;
      if (typeof fetchTrackModalAlbumDetails !== 'function') return null;
    }
    return {target, actions, gallery_target: target.kind === 'artist' ? {artist: value.gallery_target.artist} : null};
  }
  const fingerprint = value => value ? JSON.stringify([value.target.kind, value.target.ref, value.actions, value.gallery_target]) : '';
  const canResourceIntent = (intent, selection, context) => !!source(selection, context, intent);
  function retainNativeSource(selection, context, admitted, intent, current) {
    // Older adapters retain their stricter live-view lifetime. Native bridges
    // provide a receipt whose scope/source authority survives the UI transfer.
    if (typeof retainResource !== 'function') return () => current()
      && fingerprint(source(selection, context, intent)) === fingerprint(admitted);
    const origin = detailOrigin(context.origin || selection.origin);
    const requested = {...context, ...(origin ? {origin} : {})};
    const matches = receipt => {
      const target = detailSelection(receipt?.target);
      return target?.allowed_actions.can_view_details && target.kind === admitted.target.kind && target.ref === admitted.target.ref
        && sourceKey(target.origin || null) === sourceKey(origin)
        && sourceKey(nativeActions(target.native_actions, target.kind)) === sourceKey(admitted.actions)
        && typeof receipt.isCurrent === 'function' && receipt.isCurrent() === true;
    };
    const receipt = retainResource(selection, requested);
    if (receipt) return matches(receipt) ? receipt.isCurrent : null;
    // A listened Album transfers only through the exact currently retained
    // Artist read and a durable receipt from that Artist's source owner.
    const receipts = [];
    for (const record of artistAlbums) {
      if (context.scopeKey !== record.context.scopeKey || sourceKey(origin) !== sourceKey(record.context.origin)
        || sourceKey(readSource(record.parent, record.context)) !== record.parentKey) continue;
      const child = record.albums.get(selection.ref);
      if (!child || !matches({target: child, isCurrent: () => true})) continue;
      const parentReceipt = retainResource(record.parent, record.context);
      if (sourceKey(detailSelection(parentReceipt?.target)) !== record.parentTargetKey
        || typeof parentReceipt?.isCurrent !== 'function' || !parentReceipt.isCurrent()) return null;
      const readSequence = record.sequence;
      receipts.push(() => artistReadSequence === readSequence && parentReceipt.isCurrent() === true);
    }
    return receipts.length ? () => receipts.every(isCurrent => isCurrent()) : null;
  }
  async function hydrate(selection, context, intent, signal, current) {
    const admitted = source(selection, context, intent), key = fingerprint(admitted);
    if (!admitted) throw error('This resource action is no longer available.');
    const token = Number(state.ui?.pendingTrackModalLoadToken || 0);
    if (typeof authorizeResource === 'function') {
      await authorizeResource(selection, {...context, signal}, intent);
      if (signal?.aborted || !current() || token !== Number(state.ui?.pendingTrackModalLoadToken || 0)) throw stale();
      if (fingerprint(source(selection, context, intent)) !== key) throw error('This resource action is no longer available.');
    }
    const album = await fetchTrackModalAlbumDetails(admitted.actions.album_ref, {signal});
    if (signal?.aborted || !current() || token !== Number(state.ui?.pendingTrackModalLoadToken || 0)) throw stale();
    if (fingerprint(source(selection, context, intent)) !== key) throw error('This resource action is no longer available.');
    if (!album || String(album.key || album.album_ref || '') !== admitted.actions.album_ref
      || typeof albumRequiresHydration === 'function' && albumRequiresHydration(album)) throw error('Album details did not match this selection.', 409);
    return typeof projectAlbum === 'function' ? projectAlbum(album, selection, context) : album;
  }
  function replaySource(selection, context, original) {
    return async ({signal, albumKey}) => {
      if (typeof revalidateResource !== 'function') throw error('This source cannot restore Album pages.', 503);
      const fresh = await revalidateResource(selection, {...context, signal: undefined}, {signal});
      if (fresh == null) throw error('This source cannot restore this Album page.', 503);
      const target = detailSelection(fresh?.target), actions = nativeActions(target?.native_actions);
      const origin = detailOrigin(context.origin || selection.origin);
      if (signal?.aborted) throw stale();
      if (!target || target.kind !== 'album' || target.ref !== selection.ref || !target.allowed_actions.can_view_details
        || JSON.stringify(target.origin || null) !== JSON.stringify(origin) || !actions?.allowed_actions.can_open_album
        || actions.album_ref !== albumKey || typeof fresh?.isCurrent !== 'function' || !fresh.isCurrent()) {
        throw error('This album page is no longer authorized by its source.');
      }
      const album = await fetchTrackModalAlbumDetails(actions.album_ref, {signal});
      if (signal?.aborted) throw stale();
      if (!fresh.isCurrent()) throw error('This album page is no longer authorized by its source.');
      if (!album || String(album.key || album.album_ref || '') !== actions.album_ref
        || typeof albumRequiresHydration === 'function' && albumRequiresHydration(album)) throw error('Album details did not match the restored source.', 409);
      const admitted = actions.allowed_actions, prior = original.allowed_actions;
      return {album: typeof projectAlbum === 'function' ? projectAlbum(album, selection, {...context, subjectTaste: fresh.subjectTaste}) : album, isCurrent: fresh.isCurrent, presentationRestrictions: {
        can_play_album: prior.can_play_album === true && admitted.can_play_album === true,
        can_view_artwork: prior.can_view_artwork !== false && admitted.can_view_artwork !== false,
        can_open_album_page: prior.can_open_album_page !== false && admitted.can_open_album_page !== false,
      }};
    };
  }
  async function resourceIntent(intent, selection, context) {
    const admitted = source(selection, context, intent);
    if (!admitted || intent === 'embed') throw error('This resource action is unavailable.');
    const active = ++sequence;
    const current = () => sequence === active && !context.signal?.aborted;
    if (!current()) throw stale();
    if (typeof deferAppFormPageReplacement === 'function') {
      const deferred = deferAppFormPageReplacement(() => {
        if (!current()) throw stale();
        return resourceIntent(intent, selection, context);
      });
      if (deferred) return deferred;
    }
    if (intent === 'artist_gallery') {
      if (typeof authorizeResource === 'function') {
        await authorizeResource(selection, context, intent);
        if (!current()) throw stale();
      }
      const key = fingerprint(admitted);
      const item = document.createElement('button');
      item.setAttribute('data-sidebar-artist', admitted.gallery_target.artist);
      if (!current() || fingerprint(source(selection, context, intent)) !== key) throw stale();
      releaseTrackModalSelection('gallery');
      handleSidebarArtistSelectionClick({target: item, preventDefault() {}});
      return;
    }
    const album = await hydrate(selection, context, intent, context.signal, current);
    if (intent !== 'artwork') releaseTrackModalSelection(intent);
    if (!current() || fingerprint(source(selection, context, intent)) !== fingerprint(admitted)) throw stale();
    if (intent === 'artwork') {
      if (typeof albumHasDisplayCover !== 'function' || !albumHasDisplayCover(album)
        || typeof openImageLightbox !== 'function') throw error('Artwork is unavailable.', 404);
      const url = typeof buildAlbumLightboxCoverUrl === 'function' ? buildAlbumLightboxCoverUrl(album) : buildAlbumDisplayCoverUrl(album);
      openImageLightbox(url, `Album cover for ${String(album.name || 'Album')}`);
    } else {
      if (typeof openTrackModal !== 'function') throw error('Album details are unavailable.', 404);
      const sourceCurrent = retainNativeSource(selection, context, admitted, intent, current);
      if (!sourceCurrent || !sourceCurrent() || !current()) throw stale();
      const opened = openTrackModal(album, {coverLightboxGallery: false, foreground: true,
        presentationRestrictions: admitted.actions.allowed_actions,
        sourcePageOwner: {isCurrent: sourceCurrent,
          revalidate: replaySource(selection, context, admitted.actions)}});
      if (opened === false) throw error('This Album presentation is unavailable.');
    }
  }
  function mountResourceSelection(host, {selection, scopeKey, origin, onState, onError} = {}) {
    const controller = new AbortController();
    const context = {scopeKey, ...(origin ? {origin} : {}), signal: controller.signal};
    let disposed = false, lease = null, album = null, pending = false, returnFocus = null;
    const admitted = fingerprint(source(selection, context, 'embed'));
    const current = () => !disposed && !controller.signal.aborted && host?.isConnected
      && !!admitted && fingerprint(source(selection, context, 'embed')) === admitted;
    const release = () => {lease?.release('dispose'); lease = null;};
    const attempt = async () => {
      if (pending || lease || !current() || !document.getElementById('track-modal')?.hidden) return;
      pending = true;
      try {
        if (!album) album = await hydrate(selection, context, 'embed', controller.signal, current);
        if (!current()) return;
        lease = acquireTrackModalSelection(host, album, {isCurrent: current,
          retainNavigation() {
            const value = source(selection, context, 'embed');
            return current() && value ? retainNativeSource(selection, context, value, 'embed', current) : null;
          },
          canPlay: () => grant(source(selection, context, 'embed')?.actions.allowed_actions, 'can_play_album'),
          canArtwork: () => source(selection, context, 'artwork') !== null,
          canOpen: () => source(selection, context, 'open') !== null,
          canPage: () => source(selection, context, 'page') !== null,
          onRelease() {lease = null; if (!disposed) onState?.('unavailable');},
          onOpen() {if (current()) {returnFocus = host.contains(document.activeElement) ? 'open' : null;
            void resourceIntent('open', selection, context).catch(failure => onError?.(failure));}},
          onPage() {if (current()) {returnFocus = host.contains(document.activeElement) ? 'page' : null;
            void resourceIntent('page', selection, context).catch(failure => onError?.(failure));}}});
        if (lease) {
          onState?.('ready');
          const active = document.activeElement;
          if (returnFocus && (!active || active === document.body || !active.isConnected)) {
            (host.querySelector(`[data-resource-selection-${returnFocus}]`) || host.querySelector('[data-resource-selection-open]'))?.focus({preventScroll: true});
          }
          returnFocus = null;
        }
      } catch (failure) {if (current()) {onState?.('unavailable'); if (failure.name !== 'AbortError') onError?.(failure);}}
      finally {pending = false;}
    };
    const guard = event => {
      const valid = current();
      const play = event.target.closest?.('.play-track-button');
      const playGesture = play || event.type === 'dblclick' && event.target.closest?.('.album-track-table__row');
      const canPlay = grant(source(selection, context, 'embed')?.actions?.allowed_actions, 'can_play_album');
      const art = event.target.closest?.('[data-open-lightbox]');
      const canArt = source(selection, context, 'artwork') !== null;
      if (!valid || playGesture && !canPlay || art && !canArt) {event.preventDefault(); event.stopImmediatePropagation(); if (!valid) release();}
    };
    const invalidate = () => {if (!current()) {release(); album = null; onState?.('unavailable');}};
    mounted.add(invalidate);
    for (const event of ['click', 'dblclick', 'keydown']) host.addEventListener(event, guard, true);
    window.addEventListener('albumhaven:resource-selection-available', attempt);
    if (admitted) {onState?.('loading'); void attempt();}
    return {dispose() {
      if (disposed) return;
      disposed = true; controller.abort(); release(); album = null; mounted.delete(invalidate);
      for (const event of ['click', 'dblclick', 'keydown']) host.removeEventListener(event, guard, true);
      window.removeEventListener('albumhaven:resource-selection-available', attempt);
    }};
  }
  return Object.freeze({canResourceIntent, resourceIntent, mountResourceSelection, retainArtistAlbums});
}
window.AlbumHavenResourceSelection = Object.freeze({create: createResourceSelection,
  projectTarget: detailSelection, projectOrigin: detailOrigin});
})();
