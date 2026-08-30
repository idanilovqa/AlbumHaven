function ensureAlbumCardContextMenu() {
  let menu = document.getElementById('album-card-context-menu');
  if (menu) return menu;
  menu = document.createElement('div');
  menu.id = 'album-card-context-menu';
  menu.className = 'album-card-context-menu';
  menu.hidden = true;
  menu.innerHTML = '';
  document.body.appendChild(menu);
  return menu;
}

function hideAlbumCardContextMenu() {
  const menu = document.getElementById('album-card-context-menu');
  if (!menu) return;
  menu.hidden = true;
  menu.dataset.albumKey = '';
}

function showAlbumCardContextMenu(x, y, album) {
  const menu = ensureAlbumCardContextMenu();
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.dataset.albumKey = getAlbumIdentity(album);
  const albumKey = String(album?.key || '');
  const manualVersionLinks = state.view?.manual_version_links && typeof state.view.manual_version_links === 'object'
    ? state.view.manual_version_links
    : {};
  const isMarkedVersion = Boolean(albumKey && manualVersionLinks[albumKey]);
  const moveActions = getAvailableAlbumMoveActions(album);
  menu.innerHTML = [
    '<button type="button" class="album-card-context-menu-item" data-album-card-action="open-explorer">Open in File Explorer</button>',
    ...moveActions.map((item) => (
      `<button type="button" class="album-card-context-menu-item" data-album-card-action="${escapeHtml(item.action)}">${escapeHtml(getAlbumMoveActionLabel(item))}</button>`
    )),
    isMarkedVersion
      ? '<button type="button" class="album-card-context-menu-item" data-album-card-action="unmark-version">Unmark as a version</button>'
      : '<button type="button" class="album-card-context-menu-item" data-album-card-action="mark-version">Mark as a version</button>',
  ].join('');
  menu.hidden = false;
}

function ensureVersionPickerModal() {
  let modal = document.getElementById('version-picker-modal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'version-picker-modal';
  modal.className = 'confirm-modal';
  modal.hidden = true;
  modal.innerHTML = `
    <div class="confirm-modal-dialog version-picker-card" role="dialog" aria-modal="true" aria-labelledby="version-picker-title">
      <div class="version-picker-header">
        <h3 id="version-picker-title">Mark As A Version</h3>
        <button type="button" class="icon-button version-picker-close" data-close-version-picker="1" aria-label="Close version picker">&times;</button>
      </div>
      <div class="version-picker-body">
        <p class="version-picker-description" data-version-picker-description></p>
        <div class="version-picker-list" data-version-picker-list></div>
      </div>
      <div class="confirm-modal-actions version-picker-actions">
        <button type="button" class="button version-picker-cancel" data-close-version-picker="1">Cancel</button>
        <button type="button" class="button version-picker-save" data-save-version-picker="1">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  bindOverlayPointerOrigin(modal);
  return modal;
}

function getVersionPickerCandidates(album) {
  const sourceAlbum = album || state.versionPicker.album;
  const sourceKey = String(sourceAlbum?.key || '');
  const sourceArtists = new Set(
    (Array.isArray(sourceAlbum?.artists) ? sourceAlbum.artists : [sourceAlbum?.album_artist])
      .map((value) => String(value || '').trim())
      .filter(Boolean),
  );
  const seen = new Set();
  return flattenVisibleAlbums()
    .filter((item) => (
      String(item?.key || '') !== sourceKey
      && (Array.isArray(item?.artists) ? item.artists : [item?.album_artist])
        .map((value) => String(value || '').trim())
        .filter(Boolean)
        .some((artist) => sourceArtists.has(artist))
    ))
    .filter((item) => {
      const key = String(item?.key || '');
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(compareAlbumVariants);
}

function renderVersionPickerModal() {
  const modal = ensureVersionPickerModal();
  const album = state.versionPicker.album;
  const description = modal.querySelector('[data-version-picker-description]');
  const list = modal.querySelector('[data-version-picker-list]');
  const saveButton = modal.querySelector('[data-save-version-picker="1"]');
  if (!(description instanceof HTMLElement) || !(list instanceof HTMLElement) || !(saveButton instanceof HTMLButtonElement)) return;
  const candidates = getVersionPickerCandidates(album);
  description.textContent = album
    ? `Choose which ${album.album_artist} album should own "${album.name}" as a version.`
    : '';
  list.innerHTML = candidates.length
    ? candidates.map((item) => {
      const key = String(item.key || '');
      const selected = key === String(state.versionPicker.selectedTargetKey || '');
      return `
        <button class="version-picker-option ${selected ? 'is-active' : ''}" type="button" data-version-picker-target="${escapeHtml(key)}" aria-pressed="${selected ? 'true' : 'false'}">
          <span class="version-picker-option-cover">
            ${item.cover_path
              ? `<img loading="lazy" decoding="async" src="${buildAlbumDisplayCoverUrl(item)}" alt="">`
              : '<span class="version-picker-option-cover-placeholder">No cover</span>'}
          </span>
          <span class="version-picker-option-meta">
            <span class="version-picker-option-name">${escapeHtml(item.name || 'Album')}</span>
            <span class="version-picker-option-subtitle">${escapeHtml(item.year || '')}</span>
          </span>
        </button>
      `;
    }).join('')
    : '<div class="version-picker-empty">No other albums from this artist are available in the current view.</div>';
  saveButton.disabled = state.versionPicker.saving || !state.versionPicker.selectedTargetKey;
  saveButton.textContent = state.versionPicker.saving ? 'Saving...' : 'Save';
}

function openVersionPickerModal(album) {
  const sourceAlbum = album || null;
  if (!sourceAlbum) return;
  state.versionPicker.album = sourceAlbum;
  state.versionPicker.saving = false;
  state.versionPicker.selectedTargetKey = '';
  const modal = ensureVersionPickerModal();
  renderVersionPickerModal();
  modal.hidden = false;
  document.body.classList.add('modal-open');
}

function closeVersionPickerModal() {
  const modal = document.getElementById('version-picker-modal');
  if (!modal) return;
  modal.hidden = true;
  state.versionPicker.album = null;
  state.versionPicker.selectedTargetKey = '';
  state.versionPicker.saving = false;
  const trackModalOpen = !document.getElementById('track-modal')?.hidden;
  const utilityModalOpen = !document.getElementById('utility-modal')?.hidden;
  const lightboxOpen = !document.getElementById('image-lightbox')?.hidden;
  if (!trackModalOpen && !utilityModalOpen && !lightboxOpen) {
    document.body.classList.remove('modal-open');
  }
}

function getVisibleNonAlbumTracks() {
  return Array.isArray(state.view.non_album_tracks) ? state.view.non_album_tracks : [];
}

function getNonAlbumMenuLabel() {
  return state.view.selected_artist ? 'Non-album tracks' : 'Loose tracks';
}

function buildNonAlbumTrackRowsMarkup(items, startingIndex) {
  return items.map((item, offset) => {
    const rowIndex = startingIndex + offset + 1;
    const src = `/track?path=${encodeURIComponent(item.path || '')}`;
    const duration = formatTrackDuration(item.duration_seconds);
    const trackPath = String(item.path || '');
    const playback = getPlayerPlaybackSnapshot();
    const isCurrentTrack = String(state.player.current?.path || '') === trackPath;
    const isActivelyPlaying = isCurrentTrack && !playback.paused && !playback.ended;
    const problematicAlbum = getProblematicAlbumForTrackPath(trackPath);
    const utilityJump = problematicAlbum
      ? `<button class="track-problem-link" type="button" data-open-track-problematic="1" data-track-path="${escapeHtml(trackPath)}" title="Open this track in Problematic Files" aria-label="Open this track in Problematic Files">!</button>`
      : '';
    const displayPath = String(item.display_path || '').trim();
    const metadataTitle = String(item.title || '').trim();
    const filename = String(item.filename || trackPath.split(/[\\/]/).pop() || '').trim();
    const title = metadataTitle && metadataTitle.toLocaleLowerCase() !== 'unknown track'
      ? metadataTitle
      : filename || 'Unknown track';
    const metadataArtist = String(item.artist || '').trim();
    const artistMarkup = metadataArtist && metadataArtist.toLocaleLowerCase() !== 'unknown artist'
      ? `<small class="non-album-track-artist">${escapeHtml(metadataArtist)}</small>`
      : '';
    return {
      key: trackPath || `${rowIndex}`,
      dataAttributes: {
        'track-row-path': trackPath,
        'non-album-row-index': rowIndex,
      },
      cells: {
        control: `
          <div class="non-album-track-control">
            <span class="track-number">${rowIndex}.</span>
            <button class="play-track-button" data-src="${src}" data-track-path="${escapeHtml(trackPath)}" data-track-title="${escapeHtml(title)}" data-track-artist="${escapeHtml(item.artist || '')}" data-track-album="" data-track-cover="" data-track-duration-seconds="${Number(item.duration_seconds) || 0}" type="button" aria-label="${isActivelyPlaying ? `Pause ${escapeHtml(title)}` : `Play ${escapeHtml(title)}`}">${isActivelyPlaying ? '&#x23F8;' : '&#x25B6;'}</button>
          </div>
        `,
        track: `
          <div class="non-album-track-cell">
            <strong class="track-title">${escapeHtml(title)}</strong>
            ${artistMarkup}
          </div>
          ${utilityJump}
        `,
        path: `<span class="non-album-track-path">${escapeHtml(displayPath || trackPath)}</span>`,
      },
      ariaSelected: isCurrentTrack,
    };
  });
}

function buildNonAlbumTrackSectionsMarkup(items) {
  const sectionDefinitions = [
    { key: 'non-album-rarity', title: 'Non-album rarity', exceptionType: 'Non-album rarity' },
    { key: 'interview', title: 'Interviews', exceptionType: 'Interview' },
    { key: 'other', title: 'Other', exceptionType: '' },
  ];
  let runningIndex = 0;
  return sectionDefinitions.map((section) => {
    const sectionItems = items.filter((item) => (
      String(
        Object.prototype.hasOwnProperty.call(item || {}, 'exception_type')
          ? item.exception_type
          : item.reason_label || '',
      ).trim() === section.exceptionType
    ));
    if (!sectionItems.length) return '';
    const rows = buildNonAlbumTrackRowsMarkup(sectionItems, runningIndex);
    runningIndex += sectionItems.length;
    return `
      <section class="non-album-track-section" data-non-album-section="${escapeHtml(section.key)}">
        <h4 class="non-album-track-section-title">${escapeHtml(section.title)}</h4>
        ${buildCompactDataTable({
          id: `non-album-${section.key}-table`,
          ariaLabel: `${section.title} tracks`,
          columns: '64px minmax(220px, 1fr) minmax(240px, 0.9fr)',
          columnsConfig: [
            { key: 'control', label: 'Play and number', header: 'absent' },
            { key: 'track', label: 'Track' },
            { key: 'path', label: 'File path' },
          ],
          headers: 'visible',
          density: 'compact',
          overflow: 'local',
          mobile: 'preserve',
          frame: 'outline',
          rows,
        })}
      </section>
    `;
  }).join('');
}

const LIBRARY_CATEGORY_LABELS = Object.freeze({
  main_library: 'Main Library',
  hoard: 'Hoard',
  new_arrivals: 'New Arrivals',
});

function getLibraryCategoryLabel(category) {
  const normalized = String(category || '').trim();
  return LIBRARY_CATEGORY_LABELS[normalized] || normalized || 'Library';
}

function getAlbumMoveAvailability(album) {
  return album?.move_availability && typeof album.move_availability === 'object'
    ? album.move_availability
    : null;
}

function getAlbumMoveActionConfig(album, action) {
  const availability = getAlbumMoveAvailability(album);
  if (!availability) return null;
  const normalizedAction = String(action || '').trim();
  if (!normalizedAction) return null;
  const actionPayload = availability.actions && typeof availability.actions === 'object'
    ? availability.actions[normalizedAction]
    : null;
  if (!actionPayload || typeof actionPayload !== 'object') return null;
  const targetCategory = String(actionPayload.target_category || '').trim();
  const blockedReasons = Array.isArray(actionPayload.blocked_reasons)
    ? actionPayload.blocked_reasons.map((reason) => String(reason || '').trim()).filter(Boolean)
    : [];
  return {
    action: normalizedAction,
    available: Boolean(actionPayload.available),
    targetCategory,
    targetLabel: getLibraryCategoryLabel(targetCategory),
    destinationPath: String(actionPayload.destination_path || '').trim(),
    destinationFolderName: String(actionPayload.destination_folder_name || '').trim(),
    blockedReasons,
  };
}

function getAvailableAlbumMoveActions(album) {
  const availability = getAlbumMoveAvailability(album);
  const actionNames = Array.isArray(availability?.available_actions)
    ? availability.available_actions
    : [];
  return actionNames
    .map((action) => getAlbumMoveActionConfig(album, action))
    .filter((item) => item && item.available);
}

function getAlbumMoveActionLabel(actionConfig) {
  if (!actionConfig || typeof actionConfig !== 'object') return 'Move album';
  return `Move to ${actionConfig.targetLabel || 'Library'}`;
}

function buildAlbumMoveConfirmMessage(album, actionConfig) {
  const albumName = String(album?.name || 'this album').trim() || 'this album';
  const destinationFolder = String(actionConfig?.destinationFolderName || '').trim();
  const targetLabel = String(actionConfig?.targetLabel || 'Library').trim() || 'Library';
  if (destinationFolder) {
    return `Move "${albumName}" to ${targetLabel} as "${destinationFolder}"?`;
  }
  return `Move "${albumName}" to ${targetLabel}?`;
}

function ensureGalleryOptionsMenu() {
  let menu = document.getElementById('gallery-options-menu');
  if (menu) return menu;
  menu = document.createElement('div');
  menu.id = 'gallery-options-menu';
  menu.className = 'gallery-options-menu';
  document.body.appendChild(menu);
  return menu;
}

function renderGalleryOptionsMenu() {
  const menu = ensureGalleryOptionsMenu();
  const looseCount = getVisibleNonAlbumTracks().length;
  const nonAlbumLabel = getNonAlbumMenuLabel();
  const preferenceArtist = getCurrentGalleryPreferenceArtist();
  const combineEnabled = getCombineSimilarArtistsPreference(preferenceArtist);
  const galleryScope = String(state.view?.gallery_scope || 'all');
  const visibleCategories = typeof normalizeVisibleLibraryCategorySelection === 'function'
    ? normalizeVisibleLibraryCategorySelection(state.view?.visible_library_categories)
    : ['main_library', 'hoard', 'new_arrivals'];
  const categoryButtons = galleryScope === 'new_arrivals'
    ? ''
    : Object.entries(LIBRARY_CATEGORY_LABELS).map(([category, label]) => {
      const isActive = visibleCategories.includes(category);
      const disableToggleOff = isActive && visibleCategories.length <= 1;
      return `
        <button
          type="button"
          class="gallery-options-menu-item"
          data-gallery-category-toggle="${escapeHtml(category)}"
          aria-pressed="${isActive ? 'true' : 'false'}"
          ${disableToggleOff ? 'disabled' : ''}
          title="${escapeHtml(isActive ? `Hide ${label}` : `Show ${label}`)}"
        >
          <span>${escapeHtml(label)}</span>
          <span class="gallery-options-count">${isActive ? 'On' : 'Off'}</span>
        </button>
      `;
    }).join('')
    + `
      <button type="button" class="gallery-options-menu-item" data-open-new-arrivals="1" title="Show only albums from New Arrivals roots">
        <span>Open New Arrivals</span>
        <span class="gallery-options-count">Page</span>
      </button>
    `;
  menu.innerHTML = `
    ${galleryScope === 'new_arrivals'
      ? `
        <button type="button" class="gallery-options-menu-item" data-open-main-gallery="1" title="Return to the main gallery and restore its category mix">
          <span>Back to Main Gallery</span>
          <span class="gallery-options-count">Page</span>
        </button>
      `
      : categoryButtons}
    <button
      type="button"
      class="gallery-options-menu-item"
      data-toggle-combine-similar-artists="1"
      ${preferenceArtist ? '' : 'disabled'}
      title="${preferenceArtist ? `Combine collaboration-style aliases for ${escapeHtml(preferenceArtist)}` : 'Select a single artist to change this setting'}"
    >
      <span>Combine similar artists</span>
      <span class="gallery-options-count">${preferenceArtist ? (combineEnabled ? 'On' : 'Off') : 'N/A'}</span>
    </button>
    <button type="button" class="gallery-options-menu-item" data-open-non-album-modal="1" ${looseCount ? '' : 'disabled'} title="${looseCount ? `Show ${escapeHtml(nonAlbumLabel.toLowerCase())} list` : `No ${escapeHtml(nonAlbumLabel.toLowerCase())} in this view`}">
      <span>${escapeHtml(nonAlbumLabel)}</span>
      <span class="gallery-options-count">${looseCount}</span>
    </button>
  `;
}

function showGalleryOptionsMenu(anchor) {
  const menu = ensureGalleryOptionsMenu();
  renderGalleryOptionsMenu();
  const rect = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(12, rect.right - 220)}px`;
  menu.style.top = `${rect.bottom + 8}px`;
  menu.hidden = false;
  state.gallery.menuOpen = true;
}

function hideGalleryOptionsMenu() {
  const menu = document.getElementById('gallery-options-menu');
  if (!menu) return;
  menu.hidden = true;
  state.gallery.menuOpen = false;
}

function openNonAlbumModal() {
  const els = getNonAlbumModalElements();
  if (!els.overlay || !els.table) return;
  bindOverlayPointerOrigin(els.overlay);
  const looseTracks = getVisibleNonAlbumTracks();
  if (els.subtitle) {
    els.subtitle.textContent = state.view.selected_artist
      ? `Non-album tracks found in ${state.view.selected_artist} and family artist folders.`
      : 'Non-album tracks found in the artist folders currently displayed.';
  }
  els.table.innerHTML = looseTracks.length
    ? buildNonAlbumTrackSectionsMarkup(looseTracks)
    : '<div class="utility-empty-state">No non-album tracks found in this view.</div>';
  els.overlay.hidden = false;
  document.body.classList.add('modal-open');
  attachSharedPlayer();
}

function openNonAlbumTagEditor() {
  const tracks = getVisibleNonAlbumTracks();
  if (!tracks.length) {
    showRepairAlert('No tracks to edit.', 'error');
    return;
  }
  const selectedArtist = String(state.view.selected_artist || '').trim();
  const album = {
    key: `non-album-tracks::${selectedArtist.toLocaleLowerCase() || 'all'}`,
    name: '',
    album_artist: '',
    tag_editor_title: getNonAlbumMenuLabel(),
    tag_editor_collection: true,
    tracks,
  };
  closeNonAlbumModal();
  openTagEditor(album, { tracksMode: 'all' });
}

function bindOverlayPointerOrigin(overlay) {
  // TODO: Make this backdrop-origin contract intrinsic to a shared modal component when modal shells are componentized.
  if (!overlay || overlay.dataset.pointerOriginBound === '1') return;
  overlay.dataset.pointerOriginBound = '1';
  overlay.dataset.pointerDownStartedOnOverlay = '0';
  overlay.addEventListener('pointerdown', (event) => {
    overlay.dataset.pointerDownStartedOnOverlay = event.target === overlay ? '1' : '0';
  });
  overlay.addEventListener('pointerup', () => {
    scheduleBrowserTimeout(() => {
      overlay.dataset.pointerDownStartedOnOverlay = '0';
    }, 0);
  });
  overlay.addEventListener('pointercancel', () => {
    overlay.dataset.pointerDownStartedOnOverlay = '0';
  });
}

function getGalleryFocusGlowElements() {
  return {
    glow: document.getElementById('gallery-focus-glow'),
    viewport: document.getElementById('albums-viewport'),
    scroll: document.getElementById('albums-scroll'),
  };
}

function getOffsetWithinAncestor(element, ancestor) {
  let top = 0;
  let left = 0;
  let current = element;
  while (current && current !== ancestor) {
    top += current.offsetTop || 0;
    left += current.offsetLeft || 0;
    current = current.offsetParent;
  }
  return { top, left };
}

function getGalleryFocusGlowKey(card, viewport) {
  return getGalleryFocusGlowMetrics(card, viewport).key;
}

function getGalleryFocusGlowMetrics(card, viewport) {
  if (!(card instanceof HTMLElement) || !(viewport instanceof HTMLElement)) {
    return { left: 0, top: 0, key: '' };
  }
  const glowAnchor = card.querySelector('.cover');
  const anchor = glowAnchor instanceof HTMLElement ? glowAnchor : card;
  const offset = getOffsetWithinAncestor(anchor, viewport);
  const width = Number(anchor.offsetWidth || 0);
  const height = Number(anchor.offsetHeight || 0);
  const left = offset.left + (width / 2);
  const top = offset.top + (height / 2);
  return {
    left,
    top,
    key: [left, top, width, height, viewport.clientWidth || 0, viewport.clientHeight || 0].join(':'),
  };
}

function positionGalleryFocusGlow(card, glowMetrics = null) {
  const { glow, viewport, scroll } = getGalleryFocusGlowElements();
  if (!(glow instanceof HTMLElement) || !(viewport instanceof HTMLElement) || !(scroll instanceof HTMLElement) || !(card instanceof HTMLElement)) {
    return;
  }
  const metrics = glowMetrics && typeof glowMetrics === 'object'
    ? glowMetrics
    : getGalleryFocusGlowMetrics(card, viewport);
  const nextGlowKey = String(metrics.key || '');
  if (!nextGlowKey) return;
  const nextLeft = `${metrics.left}px`;
  const nextTop = `${metrics.top}px`;
  if (state.gallery.focusGlowKey !== nextGlowKey || glow.style.left !== nextLeft) {
    glow.style.left = nextLeft;
  }
  if (state.gallery.focusGlowKey !== nextGlowKey || glow.style.top !== nextTop) {
    glow.style.top = nextTop;
  }
  glow.hidden = false;
  glow.classList.add('is-visible');
  state.gallery.focusedAlbumGlowCard = card;
  state.gallery.focusGlowKey = nextGlowKey;
  state.gallery.focusGlowVisible = true;
}

function scheduleGalleryFocusGlow(card, options = {}) {
  if (!(card instanceof HTMLElement)) return;
  const force = Boolean(options.force);
  if (!force && state.gallery.focusedAlbumGlowCard === card && !state.gallery.focusGlowRaf) {
    return;
  }
  state.gallery.pendingAlbumGlowCard = card;
  if (state.gallery.focusGlowRaf) return;
  state.gallery.focusGlowRaf = scheduleBrowserAnimationFrame(() => {
    state.gallery.focusGlowRaf = 0;
    const nextCard = state.gallery.pendingAlbumGlowCard;
    state.gallery.pendingAlbumGlowCard = null;
    if (nextCard instanceof HTMLElement) {
      const { glow, viewport } = getGalleryFocusGlowElements();
      if (!(glow instanceof HTMLElement) || !(viewport instanceof HTMLElement)) return;
      const nextGlowMetrics = getGalleryFocusGlowMetrics(nextCard, viewport);
      const nextGlowKey = nextGlowMetrics.key;
      const glowVisible = !glow.hidden && glow.classList.contains('is-visible');
      if (
        nextGlowKey
        && state.gallery.focusedAlbumGlowCard === nextCard
        && state.gallery.focusGlowKey === nextGlowKey
        && state.gallery.focusGlowVisible
        && glowVisible
      ) {
        return;
      }
      positionGalleryFocusGlow(nextCard, nextGlowMetrics);
    }
  });
}

function hideGalleryFocusGlow() {
  const { glow } = getGalleryFocusGlowElements();
  if (!(glow instanceof HTMLElement)) return;
  if (state.gallery.focusGlowRaf) {
    cancelBrowserAnimationFrame(state.gallery.focusGlowRaf);
    state.gallery.focusGlowRaf = 0;
  }
  state.gallery.pendingAlbumGlowCard = null;
  glow.classList.remove('is-visible');
  state.gallery.focusedAlbumGlowCard = null;
  state.gallery.focusGlowKey = '';
  state.gallery.focusGlowVisible = false;
  scheduleBrowserTimeout(() => {
    if (!glow.classList.contains('is-visible')) {
      glow.hidden = true;
    }
  }, 260);
}

function overlayClickStartedOnOverlay(overlay, event) {
  if (!overlay) return false;
  if (Date.now() < Number(state.ui?.ignoreOverlayCloseUntil || 0)) return false;
  return event.target === overlay && overlay.dataset.pointerDownStartedOnOverlay === '1';
}

function closeNonAlbumModal() {
  const els = getNonAlbumModalElements();
  if (!els.overlay) return;
  els.overlay.hidden = true;
  const trackModalOpen = !document.getElementById('track-modal')?.hidden;
  const utilityModalOpen = !document.getElementById('utility-modal')?.hidden;
  const lightboxOpen = !document.getElementById('image-lightbox')?.hidden;
  if (!trackModalOpen && !utilityModalOpen && !lightboxOpen) {
    document.body.classList.remove('modal-open');
  }
}

async function openAlbumInExplorer(album) {
  if (!album) {
    showToast('No album payload found for File Explorer action.', 'error', 3200);
    return;
  }
  try {
    const response = await fetch('/open-album-location', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ album }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || 'Failed to open album location');
    }
  } catch (error) {
    console.error(`${ALBUM_MENU_LOG_PREFIX} Open in File Explorer failed:`, error);
    showToast(error.message || 'Failed to open album location.', 'error', 3200);
  }
}

function getTrackModalElements() {
  return {
    overlay: document.getElementById('track-modal'),
    title: document.getElementById('track-modal-title'),
    subtitle: document.getElementById('track-modal-subtitle'),
    cover: document.getElementById('track-modal-cover'),
    duplicateWarning: document.getElementById('track-modal-duplicate-warning'),
    duplicateTabs: document.getElementById('track-modal-duplicate-tabs'),
    list: document.getElementById('track-modal-list'),
    footer: document.getElementById('track-modal-footer'),
    tabs: document.getElementById('track-modal-tabs'),
    editTags: document.getElementById('track-modal-edit-tags'),
    folder: document.getElementById('track-modal-folder'),
    close: document.getElementById('track-modal-close'),
  };
}

function getLightboxElements() {
  return {
    overlay: document.getElementById('image-lightbox'),
    image: document.getElementById('image-lightbox-image'),
    loading: document.getElementById('image-lightbox-loading'),
    close: document.getElementById('image-lightbox-close'),
    prev: document.getElementById('image-lightbox-prev'),
    next: document.getElementById('image-lightbox-next'),
  };
}

function getLightboxVisibleAlbumGroups() {
  const primaryGroups = Array.isArray(state.view?.primary_artist_groups) ? state.view.primary_artist_groups : [];
  const familyGroups = Array.isArray(state.view?.family_artist_groups) ? state.view.family_artist_groups : [];
  if (primaryGroups.length || familyGroups.length) {
    return [...primaryGroups, ...familyGroups];
  }
  return Array.isArray(state.view?.artist_groups) ? state.view.artist_groups : [];
}

function getLightboxGalleryItems() {
  const seen = new Set();
  return getLightboxVisibleAlbumGroups()
    .flatMap((group) => Array.isArray(group?.albums) ? group.albums : [])
    .filter((album) => album && albumHasDisplayCover(album))
    .map((album) => ({
      key: getAlbumPathSignature(album) || `${album?.key || ''}::${album?.name || ''}::${album?.album_artist || ''}`,
      src: typeof buildAlbumLightboxCoverUrl === 'function'
        ? buildAlbumLightboxCoverUrl(album)
        : buildAlbumDisplayCoverUrl(album),
      previewSrc: buildAlbumDisplayCoverUrl(album),
      remoteSrc: String(album?.remote_cover_url || album?.remote_cover_thumbnail_url || '').trim()
        ? buildAlbumRemoteCoverUrl(album, { preferThumbnail: false })
        : '',
      alt: `Album cover for ${album.name || 'Album'}`,
      album,
    }))
    .filter((item) => {
      if (!item.key || seen.has(item.key)) return false;
      seen.add(item.key);
      return true;
    });
}

const DISPLAY_COVER_MAX_SIZE = 480;

function getFailedLocalDisplayCoverPathState() {
  if (!state.coverFailures || typeof state.coverFailures !== 'object') {
    state.coverFailures = { localDisplayPaths: {} };
  }
  if (!state.coverFailures.localDisplayPaths || typeof state.coverFailures.localDisplayPaths !== 'object') {
    state.coverFailures.localDisplayPaths = {};
  }
  const root = typeof globalThis !== 'undefined' && globalThis ? globalThis : null;
  if (!root) {
    return {
      localDisplayPaths: state.coverFailures.localDisplayPaths,
      sharedLocalDisplayPaths: null,
    };
  }
  if (!root.__ALBUM_HAVEN_FAILED_LOCAL_DISPLAY_COVERS__
    || typeof root.__ALBUM_HAVEN_FAILED_LOCAL_DISPLAY_COVERS__ !== 'object') {
    root.__ALBUM_HAVEN_FAILED_LOCAL_DISPLAY_COVERS__ = {};
  }
  return {
    localDisplayPaths: state.coverFailures.localDisplayPaths,
    sharedLocalDisplayPaths: root.__ALBUM_HAVEN_FAILED_LOCAL_DISPLAY_COVERS__,
  };
}

function isKnownFailedLocalDisplayCoverPath(coverPath) {
  const normalizedPath = String(coverPath || '').trim();
  if (!normalizedPath) return false;
  const { localDisplayPaths, sharedLocalDisplayPaths } = getFailedLocalDisplayCoverPathState();
  return Boolean(localDisplayPaths[normalizedPath] || sharedLocalDisplayPaths?.[normalizedPath]);
}

function rememberFailedLocalDisplayCoverPath(coverPath) {
  const normalizedPath = String(coverPath || '').trim();
  if (!normalizedPath) return;
  const { localDisplayPaths, sharedLocalDisplayPaths } = getFailedLocalDisplayCoverPathState();
  localDisplayPaths[normalizedPath] = true;
  if (sharedLocalDisplayPaths) {
    sharedLocalDisplayPaths[normalizedPath] = true;
  }
}

function clearFailedLocalDisplayCoverPath(coverPath) {
  const normalizedPath = String(coverPath || '').trim();
  if (!normalizedPath) return;
  const { localDisplayPaths, sharedLocalDisplayPaths } = getFailedLocalDisplayCoverPathState();
  delete localDisplayPaths[normalizedPath];
  if (sharedLocalDisplayPaths) {
    delete sharedLocalDisplayPaths[normalizedPath];
  }
}

function markAlbumDisplayCoverImagePending(imageElement) {
  if (!(imageElement instanceof HTMLImageElement)) return false;
  imageElement.setAttribute('data-cover-visual-state', 'pending');
  imageElement.removeAttribute('data-cover-decoded-at-ms');
  imageElement.setAttribute('aria-hidden', 'true');
  return true;
}

function handleAlbumDisplayCoverImageLoad(imageElement) {
  if (
    !(imageElement instanceof HTMLImageElement)
    || !imageElement.complete
    || Number(imageElement.naturalWidth || 0) <= 0
  ) {
    return false;
  }
  imageElement.setAttribute('data-cover-visual-state', 'ready');
  imageElement.removeAttribute('aria-hidden');
  if (typeof imageElement.decode === 'function') {
    const decodedSource = String(imageElement.currentSrc || imageElement.src || '');
    Promise.resolve(imageElement.decode()).then(() => {
      const currentSource = String(imageElement.currentSrc || imageElement.src || '');
      if (
        currentSource !== decodedSource
        || !imageElement.complete
        || Number(imageElement.naturalWidth || 0) <= 0
        || imageElement.getAttribute('data-cover-visual-state') !== 'ready'
      ) {
        return;
      }
      imageElement.setAttribute('data-cover-decoded-at-ms', String(performance.now()));
    }).catch(() => {
      // The existing image error path remains authoritative for failed cover decoding.
    });
  }
  return true;
}

function handleAlbumDisplayCoverImageError(imageElement) {
  if (!imageElement) return false;
  if (imageElement instanceof HTMLImageElement) {
    markAlbumDisplayCoverImagePending(imageElement);
  }
  if (typeof imageElement.getAttribute === 'function') {
    rememberFailedLocalDisplayCoverPath(imageElement.getAttribute('data-cover-path') || '');
  }
  const remoteFallbackUrl = imageElement instanceof HTMLImageElement && typeof imageElement.getAttribute === 'function'
    ? String(imageElement.getAttribute('data-remote-cover-url') || '').trim()
    : '';
  if (remoteFallbackUrl && imageElement instanceof HTMLImageElement && imageElement.dataset?.remoteCoverTried !== '1') {
    imageElement.dataset.remoteCoverTried = '1';
    imageElement.src = remoteFallbackUrl;
    return false;
  }
  const trackModalVisual = typeof imageElement.closest === 'function'
    ? imageElement.closest('.track-modal-cover-visual')
    : null;
  const lightboxTrigger = trackModalVisual instanceof HTMLElement && typeof trackModalVisual.closest === 'function'
    ? trackModalVisual.closest('[data-open-lightbox="1"]')
    : null;
  if (lightboxTrigger instanceof HTMLElement) {
    lightboxTrigger.removeAttribute('data-open-lightbox');
    lightboxTrigger.removeAttribute('data-cover-src');
    lightboxTrigger.removeAttribute('data-cover-preview-src');
    lightboxTrigger.removeAttribute('data-cover-alt');
    lightboxTrigger.removeAttribute('data-lightbox-gallery');
    if ('disabled' in lightboxTrigger) {
      lightboxTrigger.disabled = true;
    } else {
      lightboxTrigger.setAttribute('aria-disabled', 'true');
    }
  }
  const replacementTarget = trackModalVisual instanceof HTMLElement ? trackModalVisual : imageElement;
  if (typeof replacementTarget.replaceWith === 'function') {
    const placeholder = document.createElement('div');
    const albumCard = typeof imageElement.closest === 'function'
      ? imageElement.closest('.album-card')
      : null;
    placeholder.className = albumCard instanceof HTMLElement
      ? 'cover-placeholder cover-placeholder-blank'
      : 'cover-placeholder';
    if (albumCard instanceof HTMLElement) {
      placeholder.setAttribute('aria-hidden', 'true');
    } else {
      placeholder.textContent = 'No cover art';
    }
    replacementTarget.replaceWith(placeholder);
  }
  return false;
}

const coverSessionVersionTokens = new Map();

function buildCoverUrl(coverPath, options = {}) {
  const normalizedPath = String(coverPath || '').trim();
  if (!normalizedPath) return '';
  const explicitRefreshToken = state.coverRefreshTokens[normalizedPath];
  const persistedRevision = String(options?.revision || '').trim();
  const size = Number(options?.size || 0);
  const params = [`path=${encodeURIComponent(normalizedPath)}`];
  if (Number.isFinite(size) && size > 0) {
    params.push(`size=${encodeURIComponent(String(Math.round(size)))}`);
  }
  const baseCoverUrl = `/cover?${params.join('&')}`;
  let refreshToken = explicitRefreshToken || persistedRevision || coverSessionVersionTokens.get(baseCoverUrl);
  if (!refreshToken) {
    const processToken = String(
      globalThis.__ALBUM_HAVEN_BOOTSTRAP_PAYLOAD__?.bootstrap?.coverCacheToken || '',
    ).trim();
    refreshToken = processToken
      ? `process-${processToken}`
      : `epoch-${Math.floor(Date.now() / 300000)}`;
    coverSessionVersionTokens.set(baseCoverUrl, refreshToken);
  }
  params.push(`v=${encodeURIComponent(String(refreshToken))}`);
  return `/cover?${params.join('&')}`;
}

function readCoverUrlQueryParam(url, name) {
  const query = String(url || '').split('?', 2)[1]?.split('#', 1)[0] || '';
  if (!query) return '';
  const expectedName = String(name || '');
  for (const part of query.split('&')) {
    const separatorIndex = part.indexOf('=');
    const rawName = separatorIndex >= 0 ? part.slice(0, separatorIndex) : part;
    try {
      if (decodeURIComponent(rawName.replace(/\+/g, ' ')) !== expectedName) continue;
      const rawValue = separatorIndex >= 0 ? part.slice(separatorIndex + 1) : '';
      return decodeURIComponent(rawValue.replace(/\+/g, ' '));
    } catch (_error) {
      return '';
    }
  }
  return '';
}

function coverPreviewUrlMatchesAlbum(url, coverPath, coverRevision = '') {
  const normalizedUrl = String(url || '').trim();
  const normalizedPath = String(coverPath || '').trim();
  const normalizedRevision = String(coverRevision || '').trim();
  if (!normalizedUrl || !normalizedPath) return false;
  if (readCoverUrlQueryParam(normalizedUrl, 'path') !== normalizedPath) return false;
  return !normalizedRevision || readCoverUrlQueryParam(normalizedUrl, 'v') === normalizedRevision;
}

function buildAlbumRemoteCoverUrl(album, options = {}) {
  const preferThumbnail = options?.preferThumbnail !== false;
  const remoteUrl = String(
    (preferThumbnail
      ? album?.remote_cover_thumbnail_url || album?.remote_cover_url
      : album?.remote_cover_url || album?.remote_cover_thumbnail_url) || '',
  ).trim();
  if (!remoteUrl) return '';
  const signature = getAlbumPathSignature(album) || `${album?.key || ''}::${album?.name || ''}::${album?.album_artist || ''}`;
  return buildRemoteCoverLookupImageUrl(remoteUrl, `album:${signature}:${album?.remote_cover_source || 'remote'}`);
}

function albumHasDisplayCover(album) {
  const signature = getAlbumPathSignature(album) || `${album?.key || ''}::${album?.name || ''}::${album?.album_artist || ''}`;
  const optimistic = state.coverLookup.optimisticAlbumCovers[signature];
  const localCoverPath = String(album?.cover_path || '').trim();
  return Boolean(
    (optimistic && optimistic.src)
    || (localCoverPath && !isKnownFailedLocalDisplayCoverPath(localCoverPath))
    || String(album?.remote_cover_thumbnail_url || album?.remote_cover_url || '').trim()
  );
}

function buildAlbumDisplayCoverUrl(album) {
  const signature = getAlbumPathSignature(album) || `${album?.key || ''}::${album?.name || ''}::${album?.album_artist || ''}`;
  const optimistic = state.coverLookup.optimisticAlbumCovers[signature];
  if (optimistic && optimistic.src) {
    return optimistic.src;
  }
  const localCoverPath = String(album?.cover_path || '').trim();
  if (localCoverPath && !isKnownFailedLocalDisplayCoverPath(localCoverPath)) {
    const coverRevision = String(album?.cover_revision || '').trim();
    const canonicalPreviewUrl = String(album?.cover_preview_url || '').trim();
    const rememberedStartupUrls = globalThis.__ALBUM_HAVEN_STARTUP_COVER_URLS__ instanceof Map
      ? globalThis.__ALBUM_HAVEN_STARTUP_COVER_URLS__
      : new Map();
    if (coverPreviewUrlMatchesAlbum(canonicalPreviewUrl, localCoverPath, coverRevision)) {
      rememberedStartupUrls.set(localCoverPath, canonicalPreviewUrl);
      globalThis.__ALBUM_HAVEN_STARTUP_COVER_URLS__ = rememberedStartupUrls;
    }
    const rememberedStartupUrl = String(rememberedStartupUrls.get(localCoverPath) || '').trim();
    const startupPreviewUrl = coverPreviewUrlMatchesAlbum(canonicalPreviewUrl, localCoverPath, coverRevision)
      ? canonicalPreviewUrl
      : (coverPreviewUrlMatchesAlbum(rememberedStartupUrl, localCoverPath, coverRevision)
        ? rememberedStartupUrl
        : '');
    if (startupPreviewUrl && !state.coverRefreshTokens[localCoverPath]) {
      return startupPreviewUrl;
    }
    return buildCoverUrl(localCoverPath, {
      size: DISPLAY_COVER_MAX_SIZE,
      revision: coverRevision,
    });
  }
  if (String(album?.remote_cover_thumbnail_url || album?.remote_cover_url || '').trim()) {
    return buildAlbumRemoteCoverUrl(album, { preferThumbnail: true });
  }
  return '';
}

function buildAlbumLightboxCoverUrl(album) {
  const signature = getAlbumPathSignature(album) || `${album?.key || ''}::${album?.name || ''}::${album?.album_artist || ''}`;
  const optimistic = state.coverLookup.optimisticAlbumCovers[signature];
  if (optimistic && optimistic.src) {
    return optimistic.src;
  }
  const localCoverPath = String(album?.cover_path || '').trim();
  if (localCoverPath && !isKnownFailedLocalDisplayCoverPath(localCoverPath)) {
    return buildCoverUrl(localCoverPath, { revision: String(album?.cover_revision || '').trim() });
  }
  if (String(album?.remote_cover_url || '').trim() || String(album?.remote_cover_thumbnail_url || '').trim()) {
    return buildAlbumRemoteCoverUrl(album, { preferThumbnail: false });
  }
  return '';
}

function markAlbumCoverPathsFresh(albums) {
  const candidates = Array.isArray(albums) ? albums.filter(Boolean) : [];
  if (!candidates.length) return;
  const refreshToken = Date.now();
  candidates.forEach((album) => {
    const coverPath = String(album?.cover_path || '').trim();
    const coverRevision = String(album?.cover_revision || '').trim();
    if (coverPath) {
      clearFailedLocalDisplayCoverPath(coverPath);
      state.coverRefreshTokens[coverPath] = coverRevision || refreshToken;
    }
    const tracks = Array.isArray(album?.tracks) ? album.tracks : [];
    tracks.forEach((track) => {
      const trackCoverPath = String(track?.cover_path || '').trim();
      const trackCoverRevision = String(track?.cover_revision || '').trim();
      if (trackCoverPath) {
        clearFailedLocalDisplayCoverPath(trackCoverPath);
        state.coverRefreshTokens[trackCoverPath] = trackCoverRevision
          || (trackCoverPath === coverPath ? coverRevision : '')
          || refreshToken;
      }
    });
  });
}

function updateLightboxNavState() {
  const els = getLightboxElements();
  const count = Array.isArray(state.lightbox.items) ? state.lightbox.items.length : 0;
  const canNavigate = count > 1 && state.lightbox.currentIndex >= 0;
  if (els.prev) {
    els.prev.hidden = !canNavigate;
    els.prev.disabled = !canNavigate;
  }
  if (els.next) {
    els.next.hidden = !canNavigate;
    els.next.disabled = !canNavigate;
  }
}

function getLightboxItemSources(item) {
  const fullSource = String(item?.src || '').trim();
  const sources = [
    fullSource,
    item?.previewSrc,
    item?.remoteSrc,
  ]
    .map((source) => String(source || '').trim())
    .filter(Boolean);
  return sources.filter((source, index) => sources.indexOf(source) === index);
}

function cancelActiveLightboxPreloader() {
  const activePreloader = state.lightbox.activePreloader;
  if (!activePreloader) return;
  activePreloader.onload = null;
  activePreloader.onerror = null;
  state.lightbox.activePreloader = null;
}

function setLightboxLoadingPresentation(imageElement, loadingElement, isLoading, alt = '') {
  if (loadingElement) loadingElement.hidden = !isLoading;
  if (!imageElement) return;
  if (isLoading) {
    imageElement.hidden = true;
    imageElement.alt = '';
    if (typeof imageElement.setAttribute === 'function') imageElement.setAttribute('aria-hidden', 'true');
    return;
  }
  imageElement.alt = alt || 'Full-size album cover';
  if (typeof imageElement.removeAttribute === 'function') imageElement.removeAttribute('aria-hidden');
  imageElement.hidden = false;
}

function startLightboxSourcePreload(imageElement, loadToken) {
  if (!imageElement || Number(loadToken || 0) !== Number(state.lightbox.loadToken || 0)) return false;
  const sources = Array.isArray(state.lightbox.activeSources) ? state.lightbox.activeSources : [];
  const sourceIndex = Number(state.lightbox.activeSourceIndex || 0);
  const expectedSource = String(sources[sourceIndex] || '').trim();
  if (!expectedSource) {
    const { loading } = getLightboxElements();
    if (loading) loading.hidden = true;
    if (typeof imageElement.removeAttribute === 'function') imageElement.removeAttribute('src');
    imageElement.hidden = true;
    imageElement.alt = '';
    if (typeof imageElement.setAttribute === 'function') imageElement.setAttribute('aria-hidden', 'true');
    if (imageElement.classList?.add) imageElement.classList.add('is-unavailable');
    return false;
  }
  cancelActiveLightboxPreloader();
  const preloader = new Image();
  state.lightbox.activePreloader = preloader;
  const isCurrentLoad = () => (
    Number(loadToken || 0) === Number(state.lightbox.loadToken || 0)
    && state.lightbox.activePreloader === preloader
    && Number(state.lightbox.activeSourceIndex || 0) === sourceIndex
    && String(state.lightbox.activeSources?.[sourceIndex] || '').trim() === expectedSource
  );
  const continueToNextSource = () => {
    if (!isCurrentLoad()) return;
    preloader.onload = null;
    preloader.onerror = null;
    state.lightbox.activePreloader = null;
    state.lightbox.activeSourceIndex = sourceIndex + 1;
    startLightboxSourcePreload(imageElement, loadToken);
  };
  preloader.onload = () => {
    if (!isCurrentLoad()) return;
    preloader.onload = null;
    preloader.onerror = null;
    const decodeResult = typeof preloader.decode === 'function'
      ? preloader.decode()
      : Promise.resolve();
    Promise.resolve(decodeResult).then(() => {
      if (!isCurrentLoad()) return;
      state.lightbox.activePreloader = null;
      imageElement.src = expectedSource;
      const { loading } = getLightboxElements();
      setLightboxLoadingPresentation(
        imageElement,
        loading,
        false,
        state.lightbox.activeAlt || 'Full-size album cover',
      );
      if (imageElement.classList?.remove) imageElement.classList.remove('is-unavailable');
    }).catch(() => {
      continueToNextSource();
    });
  };
  preloader.onerror = () => {
    continueToNextSource();
  };
  preloader.src = expectedSource;
  return true;
}

function applyLightboxImageItem(item) {
  const els = getLightboxElements();
  if (!els.image || !item) return false;
  cancelActiveLightboxPreloader();
  const loadToken = Number(state.lightbox.loadToken || 0) + 1;
  state.lightbox.loadToken = loadToken;
  state.lightbox.activeFullSource = String(item?.src || '').trim();
  state.lightbox.activeAlt = item.alt || 'Full-size album cover';
  const sources = getLightboxItemSources(item);
  state.lightbox.activeSources = sources;
  state.lightbox.activeSourceIndex = 0;
  setLightboxLoadingPresentation(els.image, els.loading, true);
  if (typeof els.image.removeAttribute === 'function') els.image.removeAttribute('src');
  if (els.image.classList?.remove) els.image.classList.remove('is-unavailable');
  return sources.length ? startLightboxSourcePreload(els.image, loadToken) : false;
}

function showStandaloneLightboxItem(item) {
  state.lightbox.currentIndex = -1;
  if (!applyLightboxImageItem(item)) return false;
  state.lightbox.panX = 0;
  state.lightbox.panY = 0;
  state.lightbox.dragging = false;
  setLightboxZoom(1);
  updateLightboxNavState();
  return true;
}

function showLightboxItem(index) {
  const els = getLightboxElements();
  const items = Array.isArray(state.lightbox.items) ? state.lightbox.items : [];
  if (!els.overlay || !els.image || !items.length) return false;
  if (!Number.isInteger(index) || index < 0 || index >= items.length) return false;
  const item = items[index];
  state.lightbox.currentIndex = index;
  if (!applyLightboxImageItem(item)) return false;
  state.lightbox.panX = 0;
  state.lightbox.panY = 0;
  state.lightbox.dragging = false;
  setLightboxZoom(1);
  updateLightboxNavState();
  return true;
}

function stepLightbox(direction) {
  const items = Array.isArray(state.lightbox.items) ? state.lightbox.items : [];
  if (items.length <= 1) return;
  const currentIndex = Number.isInteger(state.lightbox.currentIndex) ? state.lightbox.currentIndex : 0;
  const nextIndex = currentIndex + direction;
  if (nextIndex < 0 || nextIndex >= items.length) return;
  showLightboxItem(nextIndex);
}

function setLightboxZoom(zoom, options = {}) {
  const els = getLightboxElements();
  if (!els.image) return;
  const clampedZoom = Math.min(5, Math.max(1, Number(zoom) || 1));
  const nextZoom = Math.round(clampedZoom * 1000) / 1000;
  state.lightbox.zoom = nextZoom;
  if (nextZoom <= 1) {
    state.lightbox.panX = 0;
    state.lightbox.panY = 0;
    state.lightbox.zoomBasisRect = null;
    state.lightbox.zoomOriginX = 50;
    state.lightbox.zoomOriginY = 50;
  }
  setLightboxTransform(options);
}

function setLightboxTransform(options = {}) {
  const els = getLightboxElements();
  if (!els.image) return;
  if (options.originX != null && options.originY != null) {
    state.lightbox.zoomOriginX = Number(options.originX);
    state.lightbox.zoomOriginY = Number(options.originY);
  } else if (state.lightbox.zoom <= 1) {
    state.lightbox.zoomOriginX = 50;
    state.lightbox.zoomOriginY = 50;
  }
  els.image.style.transformOrigin = `${state.lightbox.zoomOriginX}% ${state.lightbox.zoomOriginY}%`;
  const targetTransform = `translate(${state.lightbox.panX}px, ${state.lightbox.panY}px) scale(${state.lightbox.zoom})`;
  els.image.style.transform = targetTransform;
  els.image.dataset.lightboxZoom = String(state.lightbox.zoom);
  els.image.dataset.lightboxTargetTransform = targetTransform;
  els.image.dataset.lightboxTargetOrigin = els.image.style.transformOrigin;
  els.image.classList.toggle('is-zoomed', state.lightbox.zoom > 1);
  els.image.classList.toggle('is-dragging', Boolean(state.lightbox.dragging));
}

function startLightboxDrag(event) {
  if (state.lightbox.zoom <= 1) return;
  state.lightbox.dragging = true;
  state.lightbox.dragStartX = Number(event.clientX || 0);
  state.lightbox.dragStartY = Number(event.clientY || 0);
  state.lightbox.dragOriginX = Number(state.lightbox.panX || 0);
  state.lightbox.dragOriginY = Number(state.lightbox.panY || 0);
  setLightboxTransform();
}

function updateLightboxDrag(event) {
  if (!state.lightbox.dragging) return;
  state.lightbox.panX = state.lightbox.dragOriginX + (Number(event.clientX || 0) - state.lightbox.dragStartX);
  state.lightbox.panY = state.lightbox.dragOriginY + (Number(event.clientY || 0) - state.lightbox.dragStartY);
  setLightboxTransform();
}

function stopLightboxDrag() {
  if (!state.lightbox.dragging) return;
  state.lightbox.dragging = false;
  setLightboxTransform();
}

function getUtilityModalElements() {
  return {
    overlay: document.getElementById('utility-modal'),
    close: document.getElementById('utility-modal-close'),
    tabs: Array.from(document.querySelectorAll('[data-utility-tab]')),
    sidebarLabel: document.getElementById('utility-sidebar-label'),
    count: document.getElementById('utility-problematic-count'),
    search: document.getElementById('utility-problematic-search'),
    problemFilterButton: document.getElementById('utility-problem-filter-button'),
    problemFilterMenu: document.getElementById('utility-problem-filter-menu'),
    problemFilterChips: document.getElementById('utility-problem-filter-chips'),
    list: document.getElementById('utility-problematic-list'),
    detail: document.getElementById('utility-problematic-detail'),
  };
}

function getRepairConfirmElements() {
  return {
    overlay: document.getElementById('repair-confirm-modal'),
    dialog: document.querySelector('#repair-confirm-modal .confirm-modal-dialog'),
    title: document.getElementById('repair-confirm-title'),
    text: document.getElementById('repair-confirm-text'),
    cancel: document.getElementById('repair-confirm-cancel'),
    accept: document.getElementById('repair-confirm-accept'),
  };
}

function getRepairProgressElements() {
  return {
    overlay: document.getElementById('repair-progress-overlay'),
    title: document.getElementById('repair-progress-title'),
    text: document.getElementById('repair-progress-text'),
  };
}

function getTagEditorElements() {
  return {
    overlay: document.getElementById('tag-editor-modal'),
    subtitle: document.getElementById('tag-editor-subtitle'),
    list: document.getElementById('tag-editor-track-list'),
    form: document.getElementById('tag-editor-form'),
    artwork: document.getElementById('tag-editor-artwork'),
    autoNumberButton: document.getElementById('tag-editor-auto-number'),
    autoNumberStatus: document.getElementById('tag-editor-auto-number-status'),
    albumInput: document.getElementById('tag-editor-album'),
    applyButton: document.querySelector('[data-open-tag-edit-confirm="1"]'),
  };
}

function getNonAlbumModalElements() {
  return {
    overlay: document.getElementById('non-album-modal'),
    subtitle: document.getElementById('non-album-modal-subtitle'),
    table: document.getElementById('non-album-modal-table'),
    close: document.getElementById('non-album-modal-close'),
  };
}

function getTagEditConfirmElements() {
  return {
    overlay: document.getElementById('tag-edit-confirm-modal'),
    nonAlbumWarning: document.getElementById('tag-edit-non-album-warning'),
  };
}

