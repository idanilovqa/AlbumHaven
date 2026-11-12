/* Album Details second artbox (slot 1): one extra user-chosen artwork under the album cover.
   Slot 0 stays the album cover. The artbox always holds art: an empty "Add art" box exists only
   until Album Details closes. Both artboxes use the same Cover Look Up. */
const ALBUM_ADDITIONAL_ARTBOX_SLOT = 1;
const albumAdditionalArtboxState = { pendingAlbumKey: '' };

function getCurrentAlbumDetailsRelease() {
  return state.modalReleases?.[state.modalReleaseIndex] || null;
}

// UI-14 (owner): Cover Look Up may hold another copy of the album (gallery card, notification), so the
// Album Details release that carries the saved artworks answers for it.
function getAlbumAdditionalArtwork(album) {
  const findArtwork = (source) => (
    Array.isArray(source?.additional_artworks)
      ? source.additional_artworks.find((artwork) => Number(artwork?.slot) === ALBUM_ADDITIONAL_ARTBOX_SLOT)
      : null
  );
  const direct = findArtwork(album);
  if (direct) return direct;
  const stableAlbumId = (source) => {
    const albumId = Number(source?.album_id || source?.id || 0);
    return Number.isSafeInteger(albumId) && albumId > 0 ? albumId : 0;
  };
  const identityAliases = (source) => {
    return [
      source?.key,
      source?.album_ref,
      source?.request_key,
      source?.identity_key,
      typeof getAlbumRequestKey === 'function' ? getAlbumRequestKey(source) : '',
    ].map((value) => String(value || '').trim()).filter(Boolean);
  };
  const releases = state.modalReleases || [];
  const albumId = stableAlbumId(album);
  const stableSource = albumId
    ? releases.find((release) => stableAlbumId(release) === albumId && findArtwork(release))
    : null;
  const aliases = new Set(identityAliases(album));
  const source = stableSource || releases.find((release) => (
    findArtwork(release) && identityAliases(release).some((value) => aliases.has(value))
  ));
  return findArtwork(source) || null;
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
  let updatedRelease = null;
  for (const release of state.modalReleases || []) {
    if (String(release?.key || '') === key) {
      release.additional_artworks = list;
      updatedRelease ||= release;
    }
  }
  if (updatedRelease && typeof cacheHydratedTrackModalAlbum === 'function') {
    cacheHydratedTrackModalAlbum(key, updatedRelease);
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
  // Owner (11-09): removing the artbox is immediate; the server confirms in the background, and a refusal puts
  // the art back with its error.
  const previous = Array.isArray(album.additional_artworks) ? album.additional_artworks : [];
  applyAlbumAdditionalArtworks(album.key, previous.filter((artwork) => Number(artwork?.slot) !== ALBUM_ADDITIONAL_ARTBOX_SLOT));
  void postAlbumAdditionalArtwork('/utilities/cover-lookup/additional-artwork/remove', {
    album, slot: ALBUM_ADDITIONAL_ARTBOX_SLOT,
  }).then((data) => applyAlbumAdditionalArtworks(album.key, data.additional_artworks)).catch((error) => {
    applyAlbumAdditionalArtworks(album.key, previous);
    showToast(error.message, 'error', 3200);
  });
}

// Windows paths compare without case: the library holds both n: and N: spellings of one file.
function sameLocalPath(left, right) {
  const normalize = (value) => String(value || '').trim().replaceAll('/', '\\').toLowerCase();
  return Boolean(normalize(left)) && normalize(left) === normalize(right);
}

// Cover Look Up opened for the second artbox: the first artbox's art cannot be chosen again.
function isCoverLookupItemInFirstArtbox(item, kind) {
  const modal = state.coverLookup?.modal;
  if (!modal?.artboxSlot) return false;
  const album = modal.album || {};
  if (kind === 'saved-remote') return true;
  if (kind === 'local') {
    return sameLocalPath(album.cover_path, item?.path);
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

// UI-14 (owner): the second artbox's Cover Look Up starts with its saved remote art selected (a blue frame);
// clicking that art deselects it, so Save empties the artbox.
function isSecondArtboxSavedRemote(candidate) {
  const modal = state.coverLookup?.modal;
  if (!modal?.artboxSlot) return false;
  const url = String(getAlbumAdditionalArtwork(modal.album)?.remote_cover_url || '').trim();
  return Boolean(url) && [candidate?.url, candidate?.thumbnail_url].map((value) => String(value || '').trim()).includes(url);
}

function isSecondArtboxSavedRemoteActive(candidate) {
  const modal = state.coverLookup?.modal;
  return Boolean(modal) && !modal.artboxCleared && !modal.selectedRemoteId && !modal.pendingLocalPath
    && !modal.pendingPastedImageId && isSecondArtboxSavedRemote(candidate);
}

// UI-14 (owner): in the album cover's Cover Look Up, the art in the second artbox is dimmed and cannot be chosen.
function isCoverLookupItemInSecondArtbox(item, kind) {
  const modal = state.coverLookup?.modal;
  if (!modal || modal.artboxSlot) return false;
  const artwork = getAlbumAdditionalArtwork(modal.album);
  if (!artwork) return false;
  if (kind === 'local') {
    return sameLocalPath(artwork.cover_path, item?.path);
  }
  if (kind === 'remote') {
    const url = String(artwork.remote_url || artwork.remote_cover_url || '').trim();
    return Boolean(url) && [item?.url, item?.thumbnail_url].map((value) => String(value || '').trim()).includes(url);
  }
  return false;
}

// UI-14 (owner): neither artbox can take the other's picture, even from another source or size: choosing the
// second artbox's picture as the album cover would otherwise replace it and empty the second artbox. A 64-bit
// difference hash (dHash) of each preview is computed as it loads (a 9x8 grey downscale, well under a
// millisecond) and compared with the other artbox's; a near-identical picture is dimmed and cannot be chosen.
// Previews are same-origin (local covers and the remote-image proxy), so they are readable.
// The dHash compares brightness gradients only, so two flat or near-flat pictures of different colors hash
// alike; their average colors must also be close for the pictures to count as the same.
const ARTBOX_DUPLICATE_MAX_DISTANCE = 6;
const ARTBOX_DUPLICATE_MAX_COLOR_DELTA = 24;
const artboxPictureHashes = new Map();

function computeImageDHash(image) {
  const canvas = document.createElement('canvas');
  canvas.width = 9;
  canvas.height = 8;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(image, 0, 0, 9, 8);
  let pixels;
  try { pixels = context.getImageData(0, 0, 9, 8).data; } catch (_error) { return null; }
  const grey = (x, y) => { const i = (y * 9 + x) * 4; return pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114; };
  let bits = '';
  for (let y = 0; y < 8; y += 1) for (let x = 0; x < 8; x += 1) bits += grey(x, y) > grey(x + 1, y) ? '1' : '0';
  const mean = [0, 1, 2].map((channel) => {
    let total = 0;
    for (let index = channel; index < pixels.length; index += 4) total += pixels[index];
    return total / (pixels.length / 4);
  });
  return { bits, mean };
}

function dHashDistance(left, right) {
  let distance = 0;
  for (let index = 0; index < 64; index += 1) if (left[index] !== right[index]) distance += 1;
  return distance;
}

function isSameArtboxPicture(left, right) {
  return dHashDistance(left.bits, right.bits) <= ARTBOX_DUPLICATE_MAX_DISTANCE
    && left.mean.every((value, channel) => Math.abs(value - right.mean[channel]) <= ARTBOX_DUPLICATE_MAX_COLOR_DELTA);
}

function hashArtboxPicture(url) {
  if (!url) return Promise.resolve(null);
  if (!artboxPictureHashes.has(url)) {
    artboxPictureHashes.set(url, new Promise((resolve) => {
      const image = new Image();
      image.decoding = 'async';
      image.onload = () => resolve(computeImageDHash(image));
      image.onerror = () => resolve(null);
      image.src = url;
    }));
  }
  return artboxPictureHashes.get(url);
}

function hashLoadedPreview(image) {
  const url = image.currentSrc || image.src;
  if (!url) return Promise.resolve(null);
  if (!artboxPictureHashes.has(url) && image.complete && image.naturalWidth > 0) {
    artboxPictureHashes.set(url, Promise.resolve(computeImageDHash(image)));
  }
  return artboxPictureHashes.has(url)
    ? artboxPictureHashes.get(url)
    : new Promise((resolve) => image.addEventListener('load', () => resolve(hashLoadedPreview(image)), { once: true }));
}

function getOtherArtboxPicture(modal) {
  if (modal.artboxSlot) return { url: buildAlbumDisplayCoverUrl(modal.album), label: 'Same picture as the album cover' };
  const artwork = getAlbumAdditionalArtwork(modal.album);
  return artwork
    ? { url: buildAlbumDisplayCoverUrl(buildAdditionalArtworkCoverSource(modal.album, artwork)), label: 'Same picture as the second artbox' }
    : null;
}

function markOtherArtboxDuplicatePictures(body) {
  const modal = state.coverLookup?.modal;
  if (!body?.querySelectorAll || !modal?.album || typeof buildAlbumDisplayCoverUrl !== 'function') return;
  const other = getOtherArtboxPicture(modal);
  if (!other?.url) return;
  void hashArtboxPicture(other.url).then((coverHash) => {
    if (!coverHash) return;
    body.querySelectorAll('.cover-lookup-art-card:not(.is-disabled) .cover-lookup-art-preview img').forEach((image) => {
      void hashLoadedPreview(image).then((hash) => {
        if (!hash || !isSameArtboxPicture(hash, coverHash)) return;
        const card = image.closest('.cover-lookup-art-card');
        if (!card || !card.isConnected || card.classList.contains('is-active')) return;
        card.classList.add('is-disabled');
        card.setAttribute('aria-disabled', 'true');
        card.setAttribute('role', 'group');
        card.removeAttribute('tabindex');
        ['data-select-local-cover', 'data-select-remote-cover', 'data-select-pasted-cover'].forEach((name) => card.removeAttribute(name));
        const label = card.querySelector('.cover-lookup-art-action-label');
        if (label) label.textContent = other.label;
      });
    });
  });
}
