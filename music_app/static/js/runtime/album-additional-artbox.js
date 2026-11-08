/* Album Details second artbox (slot 1): one extra user-chosen artwork under the album cover.
   Slot 0 stays the album cover. The artbox always holds art: an empty "Add art" box exists only
   until Album Details closes. Both artboxes use the same Cover Look Up. */
const ALBUM_ADDITIONAL_ARTBOX_SLOT = 1;
const albumAdditionalArtboxState = { pendingAlbumKey: '' };

function getCurrentAlbumDetailsRelease() {
  return state.modalReleases?.[state.modalReleaseIndex] || null;
}

function getAlbumAdditionalArtwork(album) {
  const artworks = Array.isArray(album?.additional_artworks) ? album.additional_artworks : [];
  return artworks.find((artwork) => Number(artwork?.slot) === ALBUM_ADDITIONAL_ARTBOX_SLOT) || null;
}

// Cover URL helpers take an album-shaped source; give it its own identity so the album's
// optimistic main-cover state never leaks into the second artbox.
function buildAdditionalArtworkCoverSource(album, artwork) {
  return {
    key: `${album?.key || ''}::artbox-${ALBUM_ADDITIONAL_ARTBOX_SLOT}`,
    name: album?.name || '',
    album_artist: album?.album_artist || '',
    tracks: [],
    cover_path: artwork?.cover_path || '',
    remote_cover_url: artwork?.remote_cover_url || '',
    remote_cover_source: 'artbox',
  };
}

function buildAlbumAdditionalArtboxHtml(album) {
  const albumName = String(album?.name || 'Album');
  const artwork = getAlbumAdditionalArtwork(album);
  if (artwork) {
    const source = buildAdditionalArtworkCoverSource(album, artwork);
    const label = `Second artbox for ${albumName}`;
    const preview = buildAlbumDisplayCoverUrl(source);
    const full = (typeof buildAlbumLightboxCoverUrl === 'function' && buildAlbumLightboxCoverUrl(source)) || preview;
    // UI-14 (owner): like the first artbox, a click opens the full-size art; Cover Look Up and the quick cover
    // search are the hover tools.
    const toolsHtml = `${ButtonComponent.renderActionButton({
      icon: 'search', ariaLabel: `Cover Art Look Up for the ${label.toLowerCase()}`, title: 'Cover Art Look Up',
      className: 'track-modal-cover-tool is-lookup', attributes: { 'data-open-additional-artbox': '1' },
    })}${ButtonComponent.renderActionButton({
      icon: 'bolt', ariaLabel: `Search covers for the ${label.toLowerCase()}`, title: 'Quick cover search',
      className: 'track-modal-cover-tool is-fast-fetch', attributes: { 'data-additional-artbox-quick-search': '1' },
    })}`;
    return `<div class="track-modal-cover-shell track-modal-additional-artbox" data-artbox-slot="${ALBUM_ADDITIONAL_ARTBOX_SLOT}">${buildAlbumArtboxHtml({
      state: 'ready',
      label,
      coverHtml: `<button class="track-modal-cover-button" type="button" data-open-lightbox="1" data-cover-src="${escapeHtml(full)}" data-cover-preview-src="${escapeHtml(preview)}" data-cover-alt="${escapeHtml(label)}" aria-label="${escapeHtml(`Enlarge ${label}`)}"><img src="${escapeHtml(preview)}" alt="${escapeHtml(label)}" decoding="async"></button>`,
      overlayHtml: toolsHtml,
    })}</div>`;
  }
  if (albumAdditionalArtboxState.pendingAlbumKey && albumAdditionalArtboxState.pendingAlbumKey === String(album?.key || '')) {
    return `<div class="track-modal-cover-shell track-modal-additional-artbox" data-artbox-slot="${ALBUM_ADDITIONAL_ARTBOX_SLOT}">${buildAlbumArtboxHtml({
      state: 'add',
      label: `Add art to a second artbox for ${albumName}`,
      addLabel: 'Add art',
      addAttributes: { 'data-open-additional-artbox': '1' },
    })}</div>`;
  }
  return '';
}

function renderAlbumAdditionalArtbox(coverElement, album) {
  if (!coverElement?.querySelectorAll) return;
  coverElement.querySelectorAll('.track-modal-additional-artbox').forEach((node) => node.remove());
  const html = buildAlbumAdditionalArtboxHtml(album);
  if (html) coverElement.insertAdjacentHTML('beforeend', html);
}

function rerenderCurrentAlbumDetails() {
  const release = getCurrentAlbumDetailsRelease();
  if (release && typeof renderTrackModalRelease === 'function') renderTrackModalRelease(release);
}

function showAlbumArtboxContextMenu(x, y, slot) {
  const album = getCurrentAlbumDetailsRelease();
  if (!album) return false;
  const items = [];
  if (slot === ALBUM_ADDITIONAL_ARTBOX_SLOT) {
    items.push('<button type="button" class="album-card-context-menu-item" data-album-card-action="remove-artbox">Remove artbox</button>');
  } else if (
    albumHasDisplayCover(album)
    && !getAlbumAdditionalArtwork(album)
    && albumAdditionalArtboxState.pendingAlbumKey !== String(album.key || '')
  ) {
    items.push('<button type="button" class="album-card-context-menu-item" data-album-card-action="add-artbox">Add another artbox</button>');
  }
  if (!items.length) return false;
  const menu = ensureAlbumCardContextMenu();
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.dataset.albumKey = String(album.key || '');
  menu.dataset.menuKind = 'artbox';
  menu.innerHTML = items.join('');
  menu.hidden = false;
  if (typeof activateTriggerSurface === 'function') activateTriggerSurface(menu, hideAlbumCardContextMenu);
  return true;
}

function beginAlbumAdditionalArtbox() {
  const album = getCurrentAlbumDetailsRelease();
  if (!album || !albumHasDisplayCover(album) || getAlbumAdditionalArtwork(album)) return;
  albumAdditionalArtboxState.pendingAlbumKey = String(album.key || '');
  rerenderCurrentAlbumDetails();
}

function clearPendingAlbumAdditionalArtbox() {
  albumAdditionalArtboxState.pendingAlbumKey = '';
}

function openAlbumAdditionalArtboxLookup() {
  const album = getCurrentAlbumDetailsRelease();
  if (album) void openCoverLookupModal(album, { artboxSlot: ALBUM_ADDITIONAL_ARTBOX_SLOT });
}

// Quick cover search for the second artbox: its Cover Look Up opens and runs a fresh search right away.
async function quickSearchAlbumAdditionalArtbox() {
  const album = getCurrentAlbumDetailsRelease();
  if (!album) return;
  await openCoverLookupModal(album, { artboxSlot: ALBUM_ADDITIONAL_ARTBOX_SLOT });
  if (state.coverLookup?.modal?.artboxSlot === ALBUM_ADDITIONAL_ARTBOX_SLOT) startCoverLookupForAlbum(state.coverLookup.modal.album);
}

function applyAlbumAdditionalArtworks(albumKey, artworks) {
  const key = String(albumKey || '');
  const list = Array.isArray(artworks) ? artworks : [];
  for (const release of state.modalReleases || []) {
    if (String(release?.key || '') === key) release.additional_artworks = list;
  }
  if (getAlbumAdditionalArtwork({ additional_artworks: list }) && albumAdditionalArtboxState.pendingAlbumKey === key) {
    clearPendingAlbumAdditionalArtbox();
  }
  if (String(getCurrentAlbumDetailsRelease()?.key || '') === key) rerenderCurrentAlbumDetails();
}

async function postAlbumAdditionalArtwork(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || 'The artbox could not be updated.');
  return data;
}

async function removeAlbumAdditionalArtbox() {
  const album = getCurrentAlbumDetailsRelease();
  if (!album) return;
  if (!getAlbumAdditionalArtwork(album)) {
    clearPendingAlbumAdditionalArtbox();
    rerenderCurrentAlbumDetails();
    return;
  }
  try {
    const data = await postAlbumAdditionalArtwork('/utilities/cover-lookup/additional-artwork/remove', {
      album, slot: ALBUM_ADDITIONAL_ARTBOX_SLOT,
    });
    applyAlbumAdditionalArtworks(album.key, data.additional_artworks);
  } catch (error) {
    showToast(error.message, 'error', 3200);
  }
}

// Cover Look Up opened for the second artbox: the first artbox's art cannot be chosen again.
function isCoverLookupItemInFirstArtbox(item, kind) {
  const modal = state.coverLookup?.modal;
  if (!modal?.artboxSlot) return false;
  const album = modal.album || {};
  if (kind === 'saved-remote') return true;
  if (kind === 'local') {
    const coverPath = String(album.cover_path || '').trim();
    return Boolean(coverPath) && String(item?.path || '').trim() === coverPath;
  }
  if (kind === 'remote') {
    const urls = [album.remote_cover_url, album.remote_cover_thumbnail_url]
      .map((value) => String(value || '').trim()).filter(Boolean);
    return urls.includes(String(item?.url || '').trim());
  }
  return false;
}

async function saveAdditionalArtworkFromLookup() {
  const modal = state.coverLookup.modal;
  const album = modal.album;
  const remote = modal.selectedRemoteId
    ? (modal.possibleMatches || []).find((candidate) => String(candidate?.id || '') === String(modal.selectedRemoteId))
    : null;
  const selection = remote
    ? { source_kind: 'remote', remote_url: String(remote.url || '') }
    : (hasPendingLocalCoverSelection() ? { source_kind: 'local', source_path: modal.pendingLocalPath } : null);
  if (album && !selection && modal.artboxCleared) {
    // Saved with nothing selected: the second artbox is emptied, freeing its art for the album cover.
    await removeAlbumAdditionalArtbox();
    closeCoverLookupModal();
    return;
  }
  if (!album || !selection) return;
  modal.saving = true;
  syncCoverLookupSaveButton();
  try {
    const data = await postAlbumAdditionalArtwork('/utilities/cover-lookup/additional-artwork', {
      album, slot: modal.artboxSlot, ...selection,
    });
    applyAlbumAdditionalArtworks(album.key, data.additional_artworks);
    closeCoverLookupModal();
  } catch (error) {
    showToast(error.message, 'error', 3200);
  } finally {
    modal.saving = false;
    syncCoverLookupSaveButton();
  }
}

// UI-14 (owner): in the album cover's Cover Look Up, the art in the second artbox is dimmed and cannot be chosen.
function isCoverLookupItemInSecondArtbox(item, kind) {
  const modal = state.coverLookup?.modal;
  if (!modal || modal.artboxSlot) return false;
  const artwork = getAlbumAdditionalArtwork(modal.album);
  if (!artwork) return false;
  if (kind === 'local') {
    const path = String(artwork.cover_path || '').trim();
    return Boolean(path) && String(item?.path || '').trim() === path;
  }
  if (kind === 'remote') {
    const url = String(artwork.remote_url || artwork.remote_cover_url || '').trim();
    return Boolean(url) && [item?.url, item?.thumbnail_url].map((value) => String(value || '').trim()).includes(url);
  }
  return false;
}
