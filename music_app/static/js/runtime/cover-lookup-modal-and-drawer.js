function getCoverLookupModalElements() {
  return {
    overlay: document.getElementById('cover-lookup-modal'),
    body: document.getElementById('cover-lookup-modal-body'),
    subtitle: document.getElementById('cover-lookup-modal-subtitle'),
    status: document.getElementById('cover-lookup-modal-status'),
    findBetter: document.getElementById('cover-lookup-find-better-button'),
    saveRemote: document.getElementById('cover-lookup-save-remote-button'),
    pastedUrls: document.getElementById('cover-lookup-pasted-urls'),
  };
}

function loadCoverLookupDrawerHoverIcon(button) {
  const icon = button?.querySelector?.('.cover-lookup-drawer-glyph-hover[data-src]');
  const src = String(icon?.dataset?.src || '').trim();
  if (!src) return false;
  icon.src = src;
  delete icon.dataset.src;
  return true;
}

const coverLookupDrawerButton = document.getElementById?.('cover-lookup-drawer-button');
coverLookupDrawerButton?.addEventListener?.('mouseenter', () => {
  loadCoverLookupDrawerHoverIcon(coverLookupDrawerButton);
});
coverLookupDrawerButton?.addEventListener?.('focus', () => {
  loadCoverLookupDrawerHoverIcon(coverLookupDrawerButton);
});

const MAX_COVER_LOOKUP_STAGED_IMAGES = 8;
const MAX_COVER_LOOKUP_IMAGE_BYTES = 10 * 1024 * 1024;
const COVER_LOOKUP_ALBUM_IMAGE_PRELOAD_TIMEOUT_MS = 2000;
const COVER_LOOKUP_SHEET_DISMISS_DISTANCE = 72;
const COVER_LOOKUP_INTERRUPTION_NOTICE_KEY_PREFIX = 'albumhaven.coverLookup.interruptionNotice.';

function applyCoverLookupTaskModalStatus(task) {
  const modal = state.coverLookup.modal;
  const status = String(task?.status || '');
  if (['pending', 'running'].includes(status)) {
    modal.statusText = String(task?.message || task?.progress_label || '');
    modal.statusTone = getCoverLookupStatusTone(task);
    modal.failureNotice = '';
    return;
  }
  modal.failureNotice = '';
  const taskId = String(task?.id || '').trim();
  if (String(task?.result_kind || '') !== 'interrupted' || !taskId) {
    modal.statusText = String(task?.message || task?.progress_label || '');
    modal.statusTone = getCoverLookupStatusTone(task);
    return;
  }
  modal.statusText = '';
  modal.statusTone = 'neutral';
  const noticeKey = `${COVER_LOOKUP_INTERRUPTION_NOTICE_KEY_PREFIX}${taskId}`;
  if (getLocalStorageItem(noticeKey)) return;
  modal.failureNotice = 'Previous cover lookup was interrupted.';
  setLocalStorageItem(noticeKey, '1');
}

function buildCoverLookupModalStatusHtml(taskRunning) {
  if (taskRunning) return '';
  const modal = state.coverLookup.modal;
  if (modal.failureNotice) {
    return `<span class="cover-lookup-inline-notice">${buildSmallAlertHtml({
      severity: 'warning',
      message: modal.failureNotice,
    })}<button class="icon-button" type="button" data-dismiss-cover-lookup-notice="1" aria-label="Dismiss cover lookup notice">×</button></span>`;
  }
  const statusText = String(modal.statusText || '');
  if (!statusText) return '';
  return String(modal.statusTone || '') === 'error'
    ? buildSmallAlertHtml({ severity: 'error', message: statusText })
    : escapeHtml(statusText);
}

function isCoverLookupMobileSheet(overlay) {
  return Boolean(overlay?.classList?.contains?.('is-mobile-sheet'));
}

function bindCoverLookupMobileSheetSwipe(overlay) {
  const header = overlay?.querySelector?.('.cover-lookup-modal-header');
  if (!header || header.dataset.coverLookupSheetSwipeBound === '1') return;
  header.dataset.coverLookupSheetSwipeBound = '1';
  let startX = 0;
  let startY = 0;
  let dragY = 0;
  const reset = () => {
    dragY = 0;
    overlay.style?.removeProperty?.('--cover-lookup-sheet-drag-y');
  };
  header.addEventListener('touchstart', (event) => {
    if (!isCoverLookupMobileSheet(overlay) || event.touches.length !== 1) return;
    startX = event.touches[0].clientX;
    startY = event.touches[0].clientY;
    dragY = 0;
  }, { passive: true });
  header.addEventListener('touchmove', (event) => {
    if (!isCoverLookupMobileSheet(overlay) || event.touches.length !== 1) return;
    const dx = event.touches[0].clientX - startX;
    const dy = Math.max(0, event.touches[0].clientY - startY);
    if (dy <= Math.abs(dx)) {
      reset();
      return;
    }
    dragY = dy;
    overlay.style?.setProperty?.('--cover-lookup-sheet-drag-y', `${dy}px`);
    event.preventDefault();
  }, { passive: false });
  header.addEventListener('touchend', () => {
    const dismiss = isCoverLookupMobileSheet(overlay) && dragY >= COVER_LOOKUP_SHEET_DISMISS_DISTANCE;
    reset();
    if (dismiss) closeCoverLookupModal();
  });
  header.addEventListener('touchcancel', reset);
}

function revokeCoverLookupPastedImageUrls() {
  const items = [
    ...(Array.isArray(state.coverLookup.modal.pastedImages) ? state.coverLookup.modal.pastedImages : []),
    ...(Array.isArray(state.coverLookup.modal.manualImageAttachments) ? state.coverLookup.modal.manualImageAttachments : []),
  ];
  items.forEach((item) => {
    const objectUrl = String(item?.object_url || '').trim();
    if (objectUrl.startsWith('blob:')) {
      try {
        URL.revokeObjectURL(objectUrl);
      } catch (_error) {
        // Ignore revoked or invalid object URLs.
      }
    }
  });
}

function buildCoverLookupPastedImageId() {
  return `pasted:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Failed to read pasted image.'));
    reader.readAsDataURL(file);
  });
}

async function addPastedImageToCoverLookup(file) {
  if (window.AlbumHavenCapabilities && !window.AlbumHavenCapabilities.allows('library.covers.upload')) return;
  if (!(file instanceof Blob) || !String(file.type || '').startsWith('image/')) {
    throw new Error('Choose an image file.');
  }
  if (Number(file.size || 0) > MAX_COVER_LOOKUP_IMAGE_BYTES) {
    throw new Error('Images must be 10 MB or smaller.');
  }
  const stagedCount = (Array.isArray(state.coverLookup.modal.pastedImages)
    ? state.coverLookup.modal.pastedImages.length : 0)
    + (Array.isArray(state.coverLookup.modal.manualImageAttachments)
      ? state.coverLookup.modal.manualImageAttachments.length : 0);
  if (stagedCount >= MAX_COVER_LOOKUP_STAGED_IMAGES) {
    throw new Error(`You can stage up to ${MAX_COVER_LOOKUP_STAGED_IMAGES} images.`);
  }
  const dataUrl = await fileToDataUrl(file);
  if (!dataUrl) {
    throw new Error('Failed to read pasted image.');
  }
  const objectUrl = URL.createObjectURL(file);
  const nextItem = {
    id: buildCoverLookupPastedImageId(),
    filename: String(file.name || 'Pasted image').trim() || 'Pasted image',
    album: 'Pasted image',
    resolution: 'Clipboard image',
    width: 0,
    height: 0,
    object_url: objectUrl,
    data_url: dataUrl,
    mime_type: String(file.type || 'image/png').trim() || 'image/png',
    size_bytes: Number(file.size || 0) || 0,
  };
  state.coverLookup.modal.manualImageAttachments = [
    ...(Array.isArray(state.coverLookup.modal.manualImageAttachments)
      ? state.coverLookup.modal.manualImageAttachments : []),
    nextItem,
  ];
  state.coverLookup.modal.statusText = '';
  state.coverLookup.modal.statusTone = 'neutral';
  renderCoverLookupModal();
  return true;
}

async function addCoverLookupFiles(files) {
  const candidates = Array.from(files || []);
  let added = 0;
  for (const file of candidates) {
    await addPastedImageToCoverLookup(file);
    added += 1;
  }
  return added;
}

function removePastedImageFromCoverLookup(imageId) {
  const id = String(imageId || '').trim();
  const items = Array.isArray(state.coverLookup.modal.pastedImages)
    ? state.coverLookup.modal.pastedImages : [];
  const removed = items.find(item => String(item?.id || '') === id);
  if (!removed) return false;
  const objectUrl = String(removed.object_url || '').trim();
  if (objectUrl.startsWith('blob:')) URL.revokeObjectURL(objectUrl);
  state.coverLookup.modal.pastedImages = items.filter(item => String(item?.id || '') !== id);
  if (String(state.coverLookup.modal.pendingPastedImageId || '') === id) {
    state.coverLookup.modal.pendingPastedImageId = '';
  }
  renderCoverLookupModal();
  return true;
}

function removeCoverLookupPendingAttachment(imageId) {
  const id = String(imageId || '').trim();
  const items = Array.isArray(state.coverLookup.modal.manualImageAttachments)
    ? state.coverLookup.modal.manualImageAttachments : [];
  const removed = items.find(item => String(item?.id || '') === id);
  if (!removed) return false;
  const objectUrl = String(removed.object_url || '').trim();
  if (objectUrl.startsWith('blob:')) URL.revokeObjectURL(objectUrl);
  state.coverLookup.modal.manualImageAttachments = items.filter(
    item => String(item?.id || '') !== id,
  );
  renderCoverLookupModal();
  return true;
}

function extractCoverLookupPendingAttachments() {
  const attachments = Array.isArray(state.coverLookup.modal.manualImageAttachments)
    ? state.coverLookup.modal.manualImageAttachments : [];
  if (!attachments.length) return 0;
  state.coverLookup.modal.pastedImages = [
    ...attachments,
    ...(Array.isArray(state.coverLookup.modal.pastedImages)
      ? state.coverLookup.modal.pastedImages : []),
  ];
  state.coverLookup.modal.manualImageAttachments = [];
  return attachments.length;
}

async function handleCoverLookupClipboardPaste(clipboardData) {
  const items = Array.from(clipboardData?.items || []);
  const imageItem = items.find((item) => String(item?.type || '').startsWith('image/'));
  if (!imageItem || typeof imageItem.getAsFile !== 'function') {
    return false;
  }
  const file = imageItem.getAsFile();
  if (!(file instanceof Blob)) {
    return false;
  }
  await addPastedImageToCoverLookup(file);
  return true;
}

function getCoverLookupDeleteConfirmElements() {
  return {
    overlay: document.getElementById('cover-lookup-delete-confirm-modal'),
    text: document.getElementById('cover-lookup-delete-confirm-text'),
  };
}

function buildCoverLookupAlbumSubtitle(album) {
  if (!album) return '';
  return [album.album_artist || '', album.name || '', album.year || ''].filter(Boolean).join(' - ');
}

function buildCoverLookupCurrentReleaseLabel(release) {
  return [
    release?.album_artist || '',
    release?.name || '',
    release?.year || '',
    release?.edition || '',
  ].filter(Boolean).join(' · ');
}

function buildTrackPathSignature(album) {
  const tracks = Array.isArray(album?.tracks) ? album.tracks : [];
  return tracks.map((track) => String(track?.path || '')).filter(Boolean).sort().join('::');
}

function buildRemoteCoverLookupPreviewUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  return `/utilities/cover-lookup/remote-image?url=${encodeURIComponent(raw)}`;
}

function buildRemoteCoverLookupImageUrl(url, key = '') {
  const raw = String(url || '').trim();
  if (!raw) return '';
  const params = new URLSearchParams({ url: raw });
  if (key) params.set('key', String(key));
  return `/utilities/cover-lookup/remote-image?${params.toString()}`;
}

function buildRemoteCoverLookupDisplayUrl(item, preferredUrl, key = '') {
  const raw = String(preferredUrl || '').trim();
  if (!raw) return '';
  return buildRemoteCoverLookupImageUrl(raw, key);
}

function buildCoverLookupSearchQuery(album) {
  return [album?.album_artist || '', album?.name || '', album?.year || '', 'album cover']
    .filter(Boolean)
    .join(' ')
    .trim();
}

function buildCoverLookupImageSearchUrl(engine, album) {
  const query = encodeURIComponent(buildCoverLookupSearchQuery(album));
  if (engine === 'yandex') {
    return `https://yandex.com/images/search?text=${query}`;
  }
  return `https://www.google.com/search?tbm=isch&q=${query}`;
}

function logCoverLookupTaskDebug(context, task) {
  if (!task || typeof task !== 'object') return;
  const possibleMatches = Array.isArray(task.possible_matches) ? task.possible_matches : [];
  console.log(`[AlbumHaven][CoverLookup] ${context}`, {
    id: String(task.id || ''),
    status: String(task.status || ''),
    progress: Number(task.progress || 0),
    progress_label: String(task.progress_label || ''),
    message: String(task.message || ''),
    possible_matches_count: possibleMatches.length,
    possible_matches: possibleMatches,
  });
}

function reconcileCoverLookupRemoteSelection(possibleMatches) {
  const matches = Array.isArray(possibleMatches) ? possibleMatches : [];
  const selectedRemoteId = String(state.coverLookup.modal.selectedRemoteId || '');
  const selectedMatchExists = selectedRemoteId
    && matches.some((candidate) => String(candidate?.id || '') === selectedRemoteId);
  if (selectedMatchExists) return;
  state.coverLookup.modal.selectedRemoteId = '';
  if (
    String(state.coverLookup.modal.pendingLocalPath || '')
    || String(state.coverLookup.modal.pendingPastedImageId || '')
  ) {
    return;
  }
  const selectableMatches = matches.filter((candidate) => (
    String(candidate?.id || '').trim()
    && String(candidate?.art_kind || 'cover') === 'cover'
    && !Boolean(candidate?.display_only)
  ));
  if (selectableMatches.length) {
    state.coverLookup.modal.selectedRemoteId = String(selectableMatches[0].id);
  }
}

function normalizeCoverLookupCandidateSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const searchGeneration = String(value.search_generation || '').trim();
  const diagnostic = String(value.diagnostic || '').trim();
  if (!searchGeneration && !diagnostic) return null;
  return {
    ...value,
    search_generation: searchGeneration,
    diagnostic,
    search_kind: String(value.search_kind || '').trim(),
    status: String(value.status || '').trim(),
    revision: Math.max(0, Number(value.revision || 0) || 0),
    updated_at: String(value.updated_at || '').trim(),
    best_candidate_id: String(value.best_candidate_id || '').trim(),
    has_unseen_automatic_improvement: Boolean(
      value.has_unseen_automatic_improvement ?? value.unseen_automatic_improvement,
    ),
    candidates: sanitizeCoverLookupPossibleMatches(value.candidates),
  };
}

function coverLookupCandidateGenerationKey(value) {
  const generation = String(value || '').trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(generation)
    ? generation.replaceAll('-', '').toLowerCase()
    : generation;
}

function getCoverLookupCandidateSource(task, candidateSnapshot) {
  const normalizedTask = task && typeof task === 'object' ? task : null;
  const normalizedSnapshot = normalizeCoverLookupCandidateSnapshot(candidateSnapshot);
  if (!normalizedTask) {
    return normalizedSnapshot ? {
      candidates: normalizedSnapshot.candidates,
      generation: normalizedSnapshot.search_generation,
      bestCandidateId: normalizedSnapshot.best_candidate_id,
      revision: normalizedSnapshot.revision,
      status: normalizedSnapshot.status,
    } : null;
  }
  const taskGeneration = String(normalizedTask.id || '').trim();
  const taskCandidates = sanitizeCoverLookupPossibleMatches(normalizedTask.possible_matches);
  if (
    normalizedSnapshot
    && normalizedSnapshot.search_generation !== taskGeneration
    && taskCandidates.length === 0
  ) {
    return {
      candidates: normalizedSnapshot.candidates,
      generation: normalizedSnapshot.search_generation,
      bestCandidateId: normalizedSnapshot.best_candidate_id,
      revision: normalizedSnapshot.revision,
      status: normalizedSnapshot.status,
    };
  }
  if (
    normalizedSnapshot
    && normalizedSnapshot.search_generation === taskGeneration
    && (
      taskCandidates.length === 0
      || coverLookupCandidateTimestamp(normalizedSnapshot.updated_at)
        > coverLookupCandidateTimestamp(normalizedTask.candidate_updated_at)
    )
  ) {
    return {
      candidates: normalizedSnapshot.candidates,
      generation: normalizedSnapshot.search_generation,
      bestCandidateId: normalizedSnapshot.best_candidate_id,
      revision: normalizedSnapshot.revision,
      status: normalizedSnapshot.status,
    };
  }
  return {
    candidates: taskCandidates,
    generation: taskGeneration,
    bestCandidateId: String(normalizedTask.best_candidate_id || '').trim(),
    revision: Math.max(0, Number(normalizedTask.candidate_revision || 0) || 0),
    status: String(normalizedTask.status || '').trim(),
  };
}

function coverLookupCandidateTimestamp(value) {
  const timestamp = Date.parse(String(value || '').trim());
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function applyCoverLookupCandidateSource(candidateSource) {
  if (!candidateSource) return;
  const modal = state.coverLookup.modal;
  const generation = coverLookupCandidateGenerationKey(candidateSource.generation);
  const overrideGeneration = coverLookupCandidateGenerationKey(modal.remoteSelectionOverrideGeneration);
  const overrideCandidateId = String(
    modal.remoteSelectionOverrideCandidateId || modal.selectedRemoteId || '',
  );
  const overrideUrl = normalizeCoverLookupCandidateUrl(
    modal.remoteSelectionOverrideUrl || '',
  ).toLowerCase();
  const candidateMatchesOverride = (candidate) => (
    overrideUrl
      ? normalizeCoverLookupCandidateUrl(candidate?.url).toLowerCase() === overrideUrl
      : String(candidate?.id || '') === overrideCandidateId
  );
  const retainedOverride = (modal.possibleMatches || []).find(candidateMatchesOverride);
  modal.candidateGeneration = generation;
  let possibleMatches = sanitizeCoverLookupPossibleMatches(candidateSource.candidates);
  const hasExplicitRemoteSelection = Boolean(overrideGeneration && overrideCandidateId);
  if (hasExplicitRemoteSelection) {
    const incomingOverride = possibleMatches.find(candidateMatchesOverride);
    const selectedOverride = overrideGeneration !== generation
      ? (retainedOverride || incomingOverride)
      : incomingOverride;
    if (selectedOverride) {
      const selectedOverrideId = String(selectedOverride.id || '');
      const selectedOverrideUrl = normalizeCoverLookupCandidateUrl(selectedOverride.url).toLowerCase();
      const selectedOverrideIsPresent = possibleMatches.some((candidate) => (
        String(candidate?.id || '') === selectedOverrideId
        && normalizeCoverLookupCandidateUrl(candidate?.url).toLowerCase() === selectedOverrideUrl
      ));
      if (!selectedOverrideIsPresent) {
        possibleMatches = [selectedOverride, ...possibleMatches.filter((candidate) => (
          String(candidate?.id || '') !== selectedOverrideId
          && (
            !selectedOverrideUrl
            || normalizeCoverLookupCandidateUrl(candidate?.url).toLowerCase() !== selectedOverrideUrl
          )
        ))];
      }
    }
    modal.possibleMatches = possibleMatches;
    modal.selectedRemoteId = String(selectedOverride?.id || '');
    return;
  }
  modal.possibleMatches = possibleMatches;
  const hasPendingNonRemoteSelection = Boolean(
    String(modal.pendingLocalPath || '')
    || String(modal.pendingPastedImageId || '')
    || (modal.localCovers || []).some((cover) => Boolean(cover?.is_active))
    || String(modal.activeLocalSelectionPath || '')
    || String(getCoverLookupActiveLocalPath() || '')
  );
  const bestCandidateId = String(candidateSource.bestCandidateId || '').trim();
  const bestCandidateIsSelectable = bestCandidateId && possibleMatches.some((candidate) => (
    String(candidate?.id || '') === bestCandidateId
    && String(candidate?.art_kind || 'cover') === 'cover'
    && !Boolean(candidate?.display_only)
  ));
  if (hasPendingNonRemoteSelection) {
    modal.selectedRemoteId = '';
    return;
  }
  if (bestCandidateIsSelectable) {
    modal.selectedRemoteId = bestCandidateId;
    return;
  }
  reconcileCoverLookupRemoteSelection(possibleMatches);
}

function applyCoverLookupGalleryPayload(gallery) {
  if (!gallery || typeof gallery !== 'object') return;
  const incomingLocalCovers = Array.isArray(gallery.local_covers) ? gallery.local_covers : [];
  const savedSource = String(gallery.selected_source_path || '');
  const candidates = [...incomingLocalCovers, ...(Array.isArray(gallery.other_art) ? gallery.other_art : [])];
  const incomingActiveLocalCover = !gallery.remote_cover
    ? candidates.find(cover => savedSource && String(cover?.path || '') === savedSource)
      || candidates.find(cover => Boolean(cover?.is_active) && cover?.path)
    : null;
  if (incomingActiveLocalCover) {
    state.coverLookup.modal.activeLocalSelectionPath = String(incomingActiveLocalCover.path);
    const revision = String(incomingActiveLocalCover.cover_revision || '').trim();
    if (revision && !state.coverLookup.modal.saving
        && revision === String(state.coverLookup.modal.album?.cover_revision || '').trim()) {
      markAlbumCoverPathsFresh([{ cover_path: incomingActiveLocalCover.path, cover_revision: revision }]);
    }
  }
  state.coverLookup.modal.remoteCover = gallery.remote_cover && typeof gallery.remote_cover === 'object' ? gallery.remote_cover : null;
  // The canonical copy is not a second artwork choice when the server verified
  // an identical source. Keep the real sources visible and the saved source selected.
  state.coverLookup.modal.localCovers = incomingLocalCovers.filter(cover => !(
    incomingActiveLocalCover && String(cover?.path || '') === String(gallery.active_cover_path || '')
    && String(cover?.path || '') !== String(incomingActiveLocalCover.path)
  ));
  state.coverLookup.modal.otherArt = Array.isArray(gallery.other_art) ? gallery.other_art : [];
  const task = gallery.task && typeof gallery.task === 'object' ? gallery.task : null;
  const candidateSnapshot = normalizeCoverLookupCandidateSnapshot(gallery.candidate_snapshot);
  state.coverLookup.modal.candidateSnapshot = candidateSnapshot;
  const candidateSource = getCoverLookupCandidateSource(task, candidateSnapshot);
  if (candidateSource) {
    const previousGeneration = String(state.coverLookup.modal.candidateGeneration || '').trim();
    applyCoverLookupCandidateSource(candidateSource);
    const firstLoadOfGeneration = previousGeneration !== String(candidateSource.generation || '').trim();
    const terminalCandidateSource = ['completed', 'failed', 'canceled'].includes(
      String(candidateSource.status || '').trim(),
    );
    const hasActiveLocalCover = state.coverLookup.modal.localCovers.some((cover) => Boolean(cover?.is_active));
    if (
      firstLoadOfGeneration
      && terminalCandidateSource
      && hasActiveLocalCover
      && !state.coverLookup.modal.remoteCover
      && !state.coverLookup.modal.remoteSelectionOverrideGeneration
    ) {
      state.coverLookup.modal.selectedRemoteId = '';
      state.coverLookup.modal.remoteSelectionOverrideGeneration = '';
      state.coverLookup.modal.remoteSelectionOverrideCandidateId = '';
      state.coverLookup.modal.remoteSelectionOverrideUrl = '';
    }
  }
  const hasExplicitRemoteSelection = Boolean(
    String(state.coverLookup.modal.remoteSelectionOverrideGeneration || '').trim()
    && String(state.coverLookup.modal.remoteSelectionOverrideCandidateId || '').trim()
  );
  if (state.coverLookup.modal.remoteCover && !hasExplicitRemoteSelection) {
    state.coverLookup.modal.selectedRemoteId = '';
  }
  if (task) {
    applyCoverLookupTaskModalStatus(task);
    logCoverLookupTaskDebug('Gallery payload task update.', task);
  } else if (candidateSnapshot) {
    state.coverLookup.modal.statusText = String(candidateSnapshot.diagnostic || '');
    state.coverLookup.modal.statusTone = candidateSnapshot.status === 'failed' ? 'error' : 'neutral';
  }
}

async function markCoverLookupAutomaticImprovementSeen(candidateSnapshot) {
  const snapshot = normalizeCoverLookupCandidateSnapshot(candidateSnapshot);
  const album = state.coverLookup.modal.album;
  const session = coverLookupModalSession;
  const albumSnapshot = album?.cover_candidate_snapshot;
  const modalSnapshot = state.coverLookup.modal.candidateSnapshot;
  const automaticRevision = Math.max(0, Number(snapshot?.automatic_improvement_revision || 0) || 0);
  const seenRevision = Math.max(0, Number(snapshot?.seen_automatic_improvement_revision || 0) || 0);
  if (
    !album
    || !snapshot
    || !Boolean(snapshot.has_unseen_automatic_improvement)
    || automaticRevision <= seenRevision
  ) return;
  const seenToken = `${snapshot.search_generation}:${automaticRevision}`;
  if (String(state.coverLookup.modal.seenCandidateImprovementToken || '') === seenToken) return;
  state.coverLookup.modal.seenCandidateImprovementToken = seenToken;
  const requestOwner = {};
  coverLookupSeenRequests.set(album, requestOwner);
  try {
    const response = await fetch('/utilities/cover-lookup/gallery/mark-seen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ album }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      throw new Error(data.error || 'Failed to mark cover candidate update as seen');
    }
    const markedSnapshot = normalizeCoverLookupCandidateSnapshot(data.candidate_snapshot) || {
      ...snapshot,
      seen_automatic_improvement_revision: automaticRevision,
      has_unseen_automatic_improvement: false,
    };
    const ownsResource = coverLookupSeenRequests.get(album) === requestOwner;
    const ownsModal = ownsResource && session === coverLookupModalSession
      && state.coverLookup.modal.album === album
      && state.coverLookup.modal.seenCandidateImprovementToken === seenToken
      && state.coverLookup.modal.candidateSnapshot === modalSnapshot;
    const overlay = getCoverLookupModalElements().overlay;
    const albumIsOpen = state.coverLookup.modal.album === album && overlay && !overlay.hidden;
    if (ownsResource && album.cover_candidate_snapshot === albumSnapshot
        && (!albumIsOpen || ownsModal)) {
      album.cover_candidate_snapshot = markedSnapshot;
    }
    if (!ownsModal) return;
    state.coverLookup.modal.candidateSnapshot = markedSnapshot;
    if (typeof document !== 'undefined' && typeof document.querySelector === 'function') {
      const lookupButton = document.querySelector('[data-open-track-modal-cover-lookup]');
      if (lookupButton) {
        lookupButton.classList?.remove('has-unseen-automatic-improvement');
        lookupButton.setAttribute?.('aria-label', 'Open cover art look up gallery');
      }
    }
  } catch (error) {
    if (coverLookupSeenRequests.get(album) === requestOwner
        && session === coverLookupModalSession && state.coverLookup.modal.album === album
        && state.coverLookup.modal.seenCandidateImprovementToken === seenToken) {
      state.coverLookup.modal.seenCandidateImprovementToken = '';
    }
    console.warn('[AlbumHaven][CoverLookup] Failed to mark automatic candidate update as seen.', error);
  } finally {
    if (coverLookupSeenRequests.get(album) === requestOwner) coverLookupSeenRequests.delete(album);
  }
}

function getCoverLookupActiveLocalPath() {
  const retainedPath = String(state.coverLookup.modal.activeLocalSelectionPath || '');
  if (retainedPath) return retainedPath;
  if (state.coverLookup.modal.remoteCover && typeof state.coverLookup.modal.remoteCover === 'object') {
    return '';
  }
  const localCandidates = [
    ...(Array.isArray(state.coverLookup.modal.localCovers) ? state.coverLookup.modal.localCovers : []),
    ...(Array.isArray(state.coverLookup.modal.otherArt) ? state.coverLookup.modal.otherArt : []),
  ];
  const activeItem = localCandidates.find((item) => Boolean(item?.is_active) && item?.path);
  if (activeItem?.path) {
    return String(activeItem.path);
  }
  return String(
    state.coverLookup.modal.album?.cover_path
      || state.coverLookup.modal.album?.art_path
      || ''
  );
}

function buildSpotifyGlyph() {
  return `
    <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="currentColor"></circle>
      <path d="M7.2 9.3c3.3-1 6.8-.7 9.8.8" fill="none" stroke="#0b1411" stroke-width="1.6" stroke-linecap="round"></path>
      <path d="M8.1 12.1c2.5-.7 5.2-.5 7.5.6" fill="none" stroke="#0b1411" stroke-width="1.45" stroke-linecap="round"></path>
      <path d="M9 14.8c1.8-.4 3.7-.3 5.3.4" fill="none" stroke="#0b1411" stroke-width="1.3" stroke-linecap="round"></path>
    </svg>
  `;
}

function buildAppleMusicGlyph() {
  return `
    <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
      <path d="M15.8 5.2v9.4a2.8 2.8 0 1 1-1.6-2.53V7.83l-5.2 1.18v7.09a2.8 2.8 0 1 1-1.6-2.53V7.75c0-.74.51-1.37 1.23-1.53l5.94-1.35a1.3 1.3 0 0 1 1.6 1.27Z" fill="currentColor"></path>
    </svg>
  `;
}

function buildDeezerGlyph() {
  // The compact Deezer treatment uses the approved purple heart.
  return `
    <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
      <path d="M12 20.2 4.8 13A4.7 4.7 0 0 1 11.4 6.3l.6.7.6-.7A4.7 4.7 0 0 1 19.2 13Z" fill="currentColor"></path>
    </svg>
  `;
}

function buildCaaGlyph() {
  return '<span aria-hidden="true">CAA</span>';
}

function getRemoteCoverSourceLabel(source, fallback = '') {
  return ({
    apple: 'Apple Music',
    spotify: 'SPOTIFY',
    deezer: 'Deezer',
    bandcamp: 'Bandcamp',
    discogs: 'Discogs',
    cover_art_archive: 'Cover Art Archive',
    youtube_music: 'YouTube Music',
  })[String(source || '').trim().toLowerCase()] || String(fallback || source || '').trim();
}

function buildYouTubeMusicGlyph() {
  return `
    <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="currentColor"></circle>
      <path d="M9.9 8.3 16.5 12l-6.6 3.7Z" fill="#ffffff"></path>
    </svg>
  `;
}

function buildBandcampGlyph() {
  return `
    <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
      <path d="M6 16.8 10.9 7.2H18l-4.9 9.6Z" fill="currentColor"></path>
    </svg>
  `;
}

function buildDiscogsGlyph() {
  return `
    <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="currentColor"></circle>
      <circle cx="12" cy="12" r="5.1" fill="#0b0b0d"></circle>
      <circle cx="12" cy="12" r="2.1" fill="currentColor"></circle>
      <path d="M17.1 8.9a6 6 0 0 1 0 6.2" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round"></path>
      <path d="M6.9 15.1a6 6 0 0 1 0-6.2" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round"></path>
    </svg>
  `;
}

function buildRemoteCoverSourceBadge(source, className = 'cover-lookup-art-source-badge') {
  const normalizedSource = String(source || '').trim();
  if (normalizedSource === 'apple') {
    return `<span class="${className} is-apple" aria-hidden="true">${buildAppleMusicGlyph()}</span>`;
  }
  if (normalizedSource === 'deezer') {
    return `<span class="${className} is-deezer" aria-hidden="true">${buildDeezerGlyph()}</span>`;
  }
  if (normalizedSource === 'spotify') {
    return `<span class="${className} is-spotify" aria-hidden="true">${buildSpotifyGlyph()}</span>`;
  }
  if (normalizedSource === 'youtube_music') {
    return `<span class="${className} is-youtube-music" aria-hidden="true">${buildYouTubeMusicGlyph()}</span>`;
  }
  if (normalizedSource === 'bandcamp') {
    return `<span class="${className} is-bandcamp" aria-hidden="true">${buildBandcampGlyph()}</span>`;
  }
  if (normalizedSource === 'discogs') {
    return `<span class="${className} is-discogs" aria-hidden="true">${buildDiscogsGlyph()}</span>`;
  }
  if (normalizedSource === 'cover_art_archive') {
    return `<span class="${className} is-caa" aria-hidden="true">${buildCaaGlyph()}</span>`;
  }
  return '';
}

function buildTrackModalCoverSourceBadge(source) {
  const normalizedSource = String(source || '').trim();
  if (!normalizedSource) return '';
  return buildRemoteCoverSourceBadge(normalizedSource, 'track-modal-cover-source-badge');
}

function hasPendingLocalCoverSelection() {
  const pendingPath = String(state.coverLookup.modal.pendingLocalPath || '');
  return Boolean(pendingPath && pendingPath !== getCoverLookupActiveLocalPath());
}

function hasPendingPastedCoverSelection() {
  return Boolean(String(state.coverLookup.modal.pendingPastedImageId || '').trim());
}

function coverLookupHasManualLinks() {
  return collectManualCoverLookupUrls().length > 0;
}

function coverLookupHasManualInput() {
  const attachments = Array.isArray(state.coverLookup.modal.manualImageAttachments)
    ? state.coverLookup.modal.manualImageAttachments : [];
  return attachments.length > 0 || Boolean(String(state.coverLookup.modal.manualUrlText || '').trim());
}

function syncCoverLookupManualControlsUi() {
  const input = document.getElementById('cover-lookup-pasted-urls');
  const submitButton = document.querySelector('[data-add-cover-lookup-remote="1"]');
  const findBetterButton = document.getElementById('cover-lookup-find-better-button');
  const task = (state.coverLookup.tasks || []).find((item) => String(item?.id || '') === String(state.coverLookup.modal.taskId || '')) || null;
  const searchControlsDisabled = Boolean(state.coverLookup.modal.manualBusy || (task && ['pending', 'running'].includes(String(task.status || ''))));
  if (input instanceof HTMLTextAreaElement) {
    input.disabled = searchControlsDisabled;
  }
  if (submitButton instanceof HTMLButtonElement) {
    submitButton.disabled = searchControlsDisabled || !coverLookupHasManualInput();
  }
  if (findBetterButton instanceof HTMLButtonElement) {
    findBetterButton.disabled = searchControlsDisabled;
  }
}

function syncCoverLookupSaveButton() {
  const saveButton = document.getElementById('cover-lookup-save-remote-button');
  if (!saveButton) return;
  const localMutationPending = isCoverLookupLocalMutationPending();
  getCoverLookupModalElements().overlay?.querySelectorAll?.('[data-delete-local-cover]').forEach(button => {
    button.disabled = localMutationPending;
  });
  const selectedRemoteId = String(state.coverLookup.modal.selectedRemoteId || '');
  const pendingPastedImageId = String(state.coverLookup.modal.pendingPastedImageId || '');
  const currentTask = (state.coverLookup.tasks || []).find((item) => String(item?.id || '') === String(state.coverLookup.modal.taskId || '')) || null;
  const savedRemoteCandidateId = String(currentTask?.selected_candidate_id || '');
  const hasRemoteSelection = Boolean(selectedRemoteId) && selectedRemoteId !== savedRemoteCandidateId;
  const hasLocalSelection = hasPendingLocalCoverSelection();
  const hasPastedSelection = Boolean(pendingPastedImageId);
  saveButton.hidden = false;
  saveButton.disabled = localMutationPending || Boolean(state.coverLookup.modal.saving) || !(hasRemoteSelection || hasLocalSelection || hasPastedSelection);
  saveButton.textContent = state.coverLookup.modal.saving ? 'Saving…' : 'Save';
}

function isCompletedCoverLookupTask(task) {
  return ['completed', 'failed', 'canceled'].includes(String(task?.status || ''));
}

function isActionedCoverLookupNotification(task) {
  return isCompletedCoverLookupTask(task) && Boolean(task?.notification_action_taken);
}

function isCoverLookupSavePending(task) {
  return ['pending', 'running'].includes(String(task?.status || ''))
    && String(task?.job_kind || '') === 'save_remote_selection';
}

function isActiveCoverLookupSearchTask(task) {
  return ['pending', 'running'].includes(String(task?.status || ''))
    && !isCoverLookupSavePending(task);
}

function getCoverLookupStatusTone(task) {
  if (!task || typeof task !== 'object') {
    return 'neutral';
  }
  const status = String(task.status || '').trim();
  if (status === 'failed') {
    return 'error';
  }
  return 'neutral';
}

function syncCoverLookupSelectionUi() {
  const modal = document.getElementById('cover-lookup-modal');
  if (!modal || modal.hidden) return;
  const selectedRemoteId = String(state.coverLookup.modal.selectedRemoteId || '');
  const pendingLocalPath = String(state.coverLookup.modal.pendingLocalPath || '');
  const pendingPastedImageId = String(state.coverLookup.modal.pendingPastedImageId || '');
  modal.querySelectorAll('[data-select-local-cover]').forEach((card) => {
    const localPath = String(card.getAttribute('data-select-local-cover') || '');
    const shouldBeActive = !selectedRemoteId && !pendingPastedImageId && (
      pendingLocalPath
        ? localPath === pendingLocalPath
        : card.hasAttribute('data-cover-lookup-local-active')
    );
    card.classList.toggle('is-active', shouldBeActive);
    if (shouldBeActive) {
      card.setAttribute('data-cover-lookup-local-active', '1');
    } else {
      card.removeAttribute('data-cover-lookup-local-active');
    }
    let check = card.querySelector('.cover-lookup-art-check');
    if (shouldBeActive && !check) {
      check = document.createElement('span');
      check.className = 'cover-lookup-art-check';
      check.innerHTML = '&#10003;';
      card.querySelector('.cover-lookup-art-preview')?.appendChild(check);
    } else if (!shouldBeActive && check) {
      check.remove();
    }
    const actionLabel = card.querySelector('.cover-lookup-art-action-label');
    if (actionLabel) {
      actionLabel.textContent = shouldBeActive ? 'Selected' : 'Select';
    }
  });
  modal.querySelectorAll('[data-select-remote-cover]').forEach((card) => {
    const isActive = String(card.getAttribute('data-select-remote-cover') || '') === selectedRemoteId;
    card.classList.toggle('is-active', isActive);
    let check = card.querySelector('.cover-lookup-art-check');
    if (isActive && !check) {
      check = document.createElement('span');
      check.className = 'cover-lookup-art-check';
      check.innerHTML = '&#10003;';
      card.querySelector('.cover-lookup-art-preview')?.appendChild(check);
    } else if (!isActive && check) {
      check.remove();
    }
    const actionLabel = card.querySelector('.cover-lookup-art-action-label');
    if (actionLabel) {
      actionLabel.textContent = isActive ? 'Selected' : 'Select';
    }
  });
  modal.querySelectorAll('[data-cover-lookup-saved-remote]').forEach((card) => {
    const isActive = !selectedRemoteId
      && !pendingLocalPath
      && !pendingPastedImageId
      && !String(state.coverLookup.modal.activeLocalSelectionPath || '');
    card.classList.toggle('is-active', isActive);
    let check = card.querySelector('.cover-lookup-art-check');
    if (isActive && !check) {
      check = document.createElement('span');
      check.className = 'cover-lookup-art-check';
      check.innerHTML = '&#10003;';
      card.querySelector('.cover-lookup-art-preview')?.appendChild(check);
    } else if (!isActive && check) {
      check.remove();
    }
    const actionLabel = card.querySelector('.cover-lookup-art-action-label');
    if (actionLabel) {
      actionLabel.textContent = isActive ? 'Selected' : 'Linked remote cover';
    }
  });
  modal.querySelectorAll('[data-select-pasted-cover]').forEach((card) => {
    const isActive = String(card.getAttribute('data-select-pasted-cover') || '') === pendingPastedImageId;
    card.classList.toggle('is-active', isActive);
    let check = card.querySelector('.cover-lookup-art-check');
    if (isActive && !check) {
      check = document.createElement('span');
      check.className = 'cover-lookup-art-check';
      check.innerHTML = '&#10003;';
      card.querySelector('.cover-lookup-art-preview')?.appendChild(check);
    }
    if (!isActive && check) check.remove();
    const actionLabel = card.querySelector('.cover-lookup-art-action-label');
    if (actionLabel) actionLabel.textContent = isActive ? 'Selected' : 'Select';
  });
  syncCoverLookupSaveButton();
}

function refreshCoverLookupAlbumArtwork(originalAlbum, updatedAlbums, options = {}) {
  const candidates = Array.isArray(updatedAlbums) ? updatedAlbums.filter(Boolean) : [];
  if (!candidates.length) return;
  const updatedAlbum = getUpdatedAlbumForTrackPaths(candidates, getAlbumTrackPaths(originalAlbum))
    || getUpdatedAlbumForTrackPaths(candidates, getAlbumTrackPaths(state.coverLookup.modal.album))
    || candidates[0];
  if (!updatedAlbum) return;
  state.ui = state.ui || {};
  state.ui.albumCoverMutationRevision = Number(state.ui.albumCoverMutationRevision || 0) + 1;
  const applyRefresh = () => {
    patchVisibleAlbumsByTrackPath(candidates);
    refreshRenderedAlbumCoverOnly(updatedAlbum);
    if (options.updateTrackModal !== false) {
      updateTrackModalIfStillShowingAlbum(originalAlbum || updatedAlbum, [updatedAlbum]);
    }
  };
  if (typeof preserveDocumentScrollPosition === 'function') {
    preserveDocumentScrollPosition(applyRefresh);
  } else {
    applyRefresh();
  }
}

function markTrackModalCoverTransitionPending(album) {
  if (typeof document === 'undefined') return false;
  const trackModal = document.getElementById('track-modal');
  if (!trackModal || trackModal.hidden) return false;
  const currentAlbum = state.modalReleases?.[state.modalReleaseIndex] || null;
  const expectedPaths = new Set(getAlbumTrackPaths(album));
  const showsExpectedAlbum = Array.from(getAlbumTrackPaths(currentAlbum))
    .some((trackPath) => expectedPaths.has(trackPath));
  if (!showsExpectedAlbum) return false;
  const visual = document.querySelector('#track-modal-cover .track-modal-cover-visual');
  const image = visual?.querySelector?.('img');
  if (!visual || !image) return false;
  image.remove();
  visual.classList?.add('is-loading');
  visual.setAttribute?.('aria-busy', 'true');
  if (!visual.querySelector?.('.cover-placeholder')) {
    const placeholder = document.createElement('span');
    placeholder.className = 'cover-placeholder';
    placeholder.setAttribute('aria-hidden', 'true');
    visual.appendChild(placeholder);
  }
  return true;
}

function findCoverLookupAlbumReplacement(album, candidates) {
  const trackSignature = buildTrackPathSignature(album);
  if (trackSignature) {
    return candidates.find((candidate) => buildTrackPathSignature(candidate) === trackSignature) || null;
  }
  const identityFields = ['album_id', 'id', 'key', 'album_ref', 'request_key', 'identity_key'];
  return candidates.find((candidate) => {
    const sharedFields = identityFields.filter((field) => (
      String(album?.[field] ?? '').trim() && String(candidate?.[field] ?? '').trim()
    ));
    return sharedFields.length > 0 && sharedFields.every((field) => (
      String(candidate[field]).trim() === String(album[field]).trim()
    ));
  }) || null;
}

function syncCoverLookupAlbumReferences(updatedAlbums) {
  const candidates = Array.isArray(updatedAlbums) ? updatedAlbums.filter(Boolean) : [];
  if (!candidates.length) return;
  const modalAlbum = state.coverLookup.modal.album;
  if (modalAlbum) {
    const replacement = findCoverLookupAlbumReplacement(modalAlbum, candidates);
    if (replacement) {
      state.coverLookup.modal.album = replacement;
    }
  }
  state.coverLookup.tasks = (state.coverLookup.tasks || []).map((task) => {
    const taskAlbum = task && typeof task === 'object' ? task.album_payload : null;
    if (!taskAlbum) return task;
    const replacement = findCoverLookupAlbumReplacement(taskAlbum, candidates);
    return replacement ? { ...task, album_payload: replacement } : task;
  });
  persistCoverLookupNotificationTasks(state.coverLookup.tasks || []);
}

function clearOptimisticAlbumCovers(updatedAlbums) {
  const candidates = Array.isArray(updatedAlbums) ? updatedAlbums.filter(Boolean) : [];
  candidates.forEach((album) => {
    const signature = getAlbumPathSignature(album) || `${album?.key || ''}::${album?.name || ''}::${album?.album_artist || ''}`;
    if (signature && state.coverLookup.optimisticAlbumCovers[signature]) {
      delete state.coverLookup.optimisticAlbumCovers[signature];
    }
  });
}

function applyOptimisticLocalCoverSelection(album, sourcePath) {
  if (!album) return;
  const normalizedSourcePath = String(sourcePath || '').trim();
  if (!normalizedSourcePath) return;
  const selectedCandidate = (state.coverLookup.modal.localCovers || []).find((candidate) => (
    String(candidate?.path || '').trim() === normalizedSourcePath
  ));
  const signature = getAlbumPathSignature(album)
    || `${album?.key || ''}::${album?.name || ''}::${album?.album_artist || ''}`;
  if (!signature) return;
  state.coverLookup.optimisticAlbumCovers[signature] = {
    src: buildCoverUrl(normalizedSourcePath, {
      size: 480,
      revision: selectedCandidate?.cover_revision,
    }),
    coverPath: normalizedSourcePath,
  };
}

function preloadCoverLookupAlbumImage(album) {
  const coverPath = String(album?.cover_path || '').trim();
  if (!coverPath || typeof Image !== 'function') return Promise.resolve(false);
  const source = buildCoverUrl(coverPath, {
    size: 480,
    revision: String(album?.cover_revision || '').trim(),
  });
  if (!source) return Promise.resolve(false);
  return new Promise((resolve) => {
    const image = new Image();
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      image.onload = null;
      image.onerror = null;
      resolve(result);
    };
    image.onerror = () => finish(false);
    image.onload = () => {
      const decodeResult = typeof image.decode === 'function'
        ? image.decode()
        : Promise.resolve();
      Promise.resolve(decodeResult).then(
        () => finish(true),
        () => finish(false),
      );
    };
    image.src = source;
  });
}

function preloadCoverLookupAlbumImageWithTimeout(album) {
  const preload = Promise.resolve().then(() => preloadCoverLookupAlbumImage(album));
  if (typeof setTimeout !== 'function') return preload.catch(() => false);
  return new Promise((resolve) => {
    let settled = false;
    let timeoutId = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timeoutId !== null && typeof clearTimeout === 'function') clearTimeout(timeoutId);
      resolve(result);
    };
    timeoutId = setTimeout(() => finish(null), COVER_LOOKUP_ALBUM_IMAGE_PRELOAD_TIMEOUT_MS);
    preload.then(finish, () => finish(false));
  });
}

function buildOptimisticCoverUpdatedAlbum(album, coverPath) {
  if (!album) return null;
  const nextCoverPath = String(coverPath || '').trim();
  if (!nextCoverPath) return null;
  return {
    ...album,
    cover_path: nextCoverPath,
    cover_preview_url: null,
    cover_revision: null,
    remote_cover_url: null,
    remote_cover_thumbnail_url: null,
    remote_cover_source: null,
    remote_cover_source_label: null,
    remote_cover_album_url: null,
    remote_cover_width: null,
    remote_cover_height: null,
    tracks: (Array.isArray(album.tracks) ? album.tracks : []).map((track) => ({
      ...track,
      cover_path: nextCoverPath,
      cover_preview_url: null,
      cover_revision: null,
      remote_cover_url: null,
      remote_cover_thumbnail_url: null,
      remote_cover_source: null,
      remote_cover_source_label: null,
      remote_cover_album_url: null,
      remote_cover_width: null,
      remote_cover_height: null,
    })),
  };
}

function buildOptimisticCoverDeleteUpdatedAlbum(album, removedCoverPath, fallbackCoverPath = '') {
  if (!album) return null;
  const normalizedRemovedPath = String(removedCoverPath || '').trim();
  if (!normalizedRemovedPath) return null;
  const normalizedFallbackPath = String(fallbackCoverPath || '').trim();
  const currentCoverPath = String(album?.cover_path || '').trim();
  if (currentCoverPath && currentCoverPath !== normalizedRemovedPath) {
    return null;
  }
  const nextCoverPath = normalizedFallbackPath || null;
  return {
    ...album,
    cover_path: nextCoverPath,
    cover_preview_url: null,
    cover_revision: null,
    remote_cover_url: null,
    remote_cover_thumbnail_url: null,
    remote_cover_source: null,
    remote_cover_source_label: null,
    remote_cover_album_url: null,
    remote_cover_width: null,
    remote_cover_height: null,
    tracks: (Array.isArray(album.tracks) ? album.tracks : []).map((track) => ({
      ...track,
      cover_path: nextCoverPath,
      cover_preview_url: null,
      cover_revision: null,
      remote_cover_url: null,
      remote_cover_thumbnail_url: null,
      remote_cover_source: null,
      remote_cover_source_label: null,
      remote_cover_album_url: null,
      remote_cover_width: null,
      remote_cover_height: null,
    })),
  };
}

function applyOptimisticRemoteCoverSelection(album, selectedMatch, coverPath) {
  const imageUrl = String(selectedMatch?.url || selectedMatch?.thumbnail_url || '').trim();
  const previewImageUrl = String(selectedMatch?.thumbnail_url || imageUrl || '').trim();
  const previewKey = String(selectedMatch?.id || selectedMatch?.url || '').trim();
  const nextCoverPath = String(coverPath || '').trim();
  const updatedAlbum = nextCoverPath
    ? buildOptimisticCoverUpdatedAlbum(album, nextCoverPath)
    : {
      ...album,
      cover_path: null,
      cover_preview_url: null,
      cover_revision: null,
      remote_cover_url: imageUrl || null,
      remote_cover_thumbnail_url: String(selectedMatch?.thumbnail_url || imageUrl || '').trim() || null,
      remote_cover_source: String(selectedMatch?.source || '').trim() || null,
      remote_cover_source_label: String(selectedMatch?.source_label || '').trim() || null,
      remote_cover_album_url: String(selectedMatch?.album_url || '').trim() || null,
      remote_cover_width: Number(selectedMatch?.width || 0) || null,
      remote_cover_height: Number(selectedMatch?.height || 0) || null,
      tracks: (Array.isArray(album?.tracks) ? album.tracks : []).map((track) => ({
        ...track,
        cover_path: null,
        cover_preview_url: null,
        cover_revision: null,
        remote_cover_url: imageUrl || null,
        remote_cover_thumbnail_url: String(selectedMatch?.thumbnail_url || imageUrl || '').trim() || null,
        remote_cover_source: String(selectedMatch?.source || '').trim() || null,
        remote_cover_source_label: String(selectedMatch?.source_label || '').trim() || null,
        remote_cover_album_url: String(selectedMatch?.album_url || '').trim() || null,
        remote_cover_width: Number(selectedMatch?.width || 0) || null,
        remote_cover_height: Number(selectedMatch?.height || 0) || null,
      })),
    };
  if (!updatedAlbum || !imageUrl) return;
  const signature = getAlbumPathSignature(updatedAlbum) || `${updatedAlbum?.key || ''}::${updatedAlbum?.name || ''}::${updatedAlbum?.album_artist || ''}`;
  state.coverLookup.optimisticAlbumCovers[signature] = {
    src: buildRemoteCoverLookupDisplayUrl(selectedMatch, previewImageUrl, previewKey),
    coverPath: nextCoverPath,
  };
  markAlbumCoverPathsFresh([updatedAlbum]);
  syncCoverLookupAlbumReferences([updatedAlbum]);
  refreshCoverLookupAlbumArtwork(album, [updatedAlbum]);
}

function applyOptimisticPastedCoverSelection(album, pastedItem) {
  if (!album || !pastedItem) return;
  const imageUrl = String(pastedItem?.data_url || pastedItem?.preview_url || '').trim();
  if (!imageUrl) return;
  const updatedAlbum = {
    ...album,
    cover_path: String(album?.cover_path || '').trim() || null,
    cover_preview_url: null,
    cover_revision: null,
    remote_cover_url: String(album?.remote_cover_url || '').trim() || null,
    remote_cover_thumbnail_url: String(album?.remote_cover_thumbnail_url || '').trim() || null,
    remote_cover_source: String(album?.remote_cover_source || '').trim() || null,
    remote_cover_source_label: String(album?.remote_cover_source_label || '').trim() || null,
    remote_cover_album_url: String(album?.remote_cover_album_url || '').trim() || null,
    remote_cover_width: Number(album?.remote_cover_width || 0) || null,
    remote_cover_height: Number(album?.remote_cover_height || 0) || null,
    tracks: (Array.isArray(album?.tracks) ? album.tracks : []).map((track) => ({
      ...track,
      cover_path: String(track?.cover_path || album?.cover_path || '').trim() || null,
      cover_preview_url: null,
      cover_revision: null,
      remote_cover_url: String(track?.remote_cover_url || album?.remote_cover_url || '').trim() || null,
      remote_cover_thumbnail_url: String(track?.remote_cover_thumbnail_url || album?.remote_cover_thumbnail_url || '').trim() || null,
      remote_cover_source: String(track?.remote_cover_source || album?.remote_cover_source || '').trim() || null,
      remote_cover_source_label: String(track?.remote_cover_source_label || album?.remote_cover_source_label || '').trim() || null,
      remote_cover_album_url: String(track?.remote_cover_album_url || album?.remote_cover_album_url || '').trim() || null,
      remote_cover_width: Number(track?.remote_cover_width || album?.remote_cover_width || 0) || null,
      remote_cover_height: Number(track?.remote_cover_height || album?.remote_cover_height || 0) || null,
    })),
  };
  const signature = getAlbumPathSignature(updatedAlbum) || `${updatedAlbum?.key || ''}::${updatedAlbum?.name || ''}::${updatedAlbum?.album_artist || ''}`;
  state.coverLookup.optimisticAlbumCovers[signature] = {
    src: imageUrl,
    coverPath: '',
  };
  markAlbumCoverPathsFresh([updatedAlbum]);
  syncCoverLookupAlbumReferences([updatedAlbum]);
  refreshCoverLookupAlbumArtwork(album, [updatedAlbum]);
  return updatedAlbum;
}

function stopCoverLookupElapsedTimer() {
  const timerId = Number(state.coverLookup.elapsedTimer || 0);
  if (!timerId) return;
  if (typeof window !== 'undefined' && typeof window.clearInterval === 'function') {
    window.clearInterval(timerId);
  }
  state.coverLookup.elapsedTimer = 0;
}

function getCoverLookupTaskElapsedLabel(task, nowMs) {
  if (typeof formatCoverLookupTaskElapsedLabel !== 'function') return '';
  return formatCoverLookupTaskElapsedLabel(task, nowMs);
}

function updateCoverLookupTaskElapsedLabels() {
  const body = document.getElementById('cover-lookup-drawer-body');
  if (!body || typeof body.querySelectorAll !== 'function') return;
  const tasksById = new Map(
    (Array.isArray(state.coverLookup.tasks) ? state.coverLookup.tasks : [])
      .map((task) => [String(task?.id || '').trim(), task])
      .filter(([taskId]) => Boolean(taskId)),
  );
  const nowMs = Date.now();
  body.querySelectorAll('[data-cover-lookup-task-elapsed]').forEach((element) => {
    const taskId = String(element.getAttribute('data-cover-lookup-task-elapsed') || '').trim();
    const elapsedLabel = getCoverLookupTaskElapsedLabel(tasksById.get(taskId), nowMs);
    element.textContent = elapsedLabel;
    element.hidden = !elapsedLabel;
  });
}

function normalizeCoverLookupCandidateUrl(value) {
  let normalized = String(value || '').trim();
  if (!normalized) return '';
  const fragmentIndex = normalized.indexOf('#');
  if (fragmentIndex >= 0) {
    normalized = normalized.slice(0, fragmentIndex);
  }
  if (/^http:\/\/coverartarchive\.org(?=[:/]|$)/i.test(normalized)) {
    normalized = `https://${normalized.slice('http://'.length)}`;
  }
  return normalized;
}

function isSelectableRemoteCoverCandidate(candidate) {
  const artKind = String(candidate?.art_kind || 'cover');
  return artKind === 'cover' || artKind === 'other';
}

function sanitizeCoverLookupPossibleMatches(value) {
  if (!Array.isArray(value)) return [];
  const seenIds = new Set();
  const seenUrls = new Set();
  return value
    .filter((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
      if (window.AlbumHavenCapabilities && !window.AlbumHavenCapabilities.allowsCoverCandidate(item)) return false;
      const candidateIdKey = String(item.id || '').trim().toLowerCase();
      const normalizedUrlKey = normalizeCoverLookupCandidateUrl(item.url).toLowerCase();
      if (!candidateIdKey && !normalizedUrlKey) return false;
      if (candidateIdKey && seenIds.has(candidateIdKey)) return false;
      if (normalizedUrlKey && seenUrls.has(normalizedUrlKey)) return false;
      if (candidateIdKey) seenIds.add(candidateIdKey);
      if (normalizedUrlKey) seenUrls.add(normalizedUrlKey);
      return true;
    })
    .map((item) => {
      const candidateId = String(item.id || '').trim();
      const normalizedUrl = normalizeCoverLookupCandidateUrl(item.url);
      if (candidateId === String(item.id || '') && normalizedUrl === String(item.url || '')) {
        return item;
      }
      return {
        ...item,
        ...(candidateId ? { id: candidateId } : {}),
        ...(normalizedUrl ? { url: normalizedUrl } : {}),
      };
    });
}

function buildCoverLookupCandidateSnapshot(task) {
  return sanitizeCoverLookupPossibleMatches(task?.possible_matches)
    .map((candidate) => String(candidate.id || '').trim() || normalizeCoverLookupCandidateUrl(candidate.url));
}

function syncCoverLookupElapsedTimer() {
  const hasActiveTasks = (Array.isArray(state.coverLookup.tasks) ? state.coverLookup.tasks : [])
    .some((task) => isActiveCoverLookupSearchTask(task));
  if (!state.coverLookup.drawerOpen || !hasActiveTasks) {
    stopCoverLookupElapsedTimer();
    return;
  }
  if (state.coverLookup.elapsedTimer) return;
  if (typeof window === 'undefined' || typeof window.setInterval !== 'function') return;
  state.coverLookup.elapsedTimer = window.setInterval(() => {
    updateCoverLookupTaskElapsedLabels();
  }, 1000);
}

function hasActiveCoverLookupDrawerTextSelection(body) {
  if (!body || typeof body.contains !== 'function') return false;
  if (typeof window === 'undefined' || typeof window.getSelection !== 'function') return false;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount < 1) return false;
  return Boolean(
    selection.anchorNode
    && selection.focusNode
    && body.contains(selection.anchorNode)
    && body.contains(selection.focusNode)
  );
}

function hasActiveCoverLookupDrawerAction(body) {
  if (!body || typeof body.contains !== 'function') return false;
  // Polling must not replace the anchor while a press is still a collapsed selection.
  if (body.querySelector?.('.cover-lookup-task-open:active')) return true;
  const activeElement = typeof document !== 'undefined' ? document.activeElement : null;
  const focusedAction = activeElement && body.contains(activeElement) && activeElement.closest?.('.cover-lookup-task-actions')
    ? activeElement
    : null;
  const hoveredAction = body.querySelector?.('.cover-lookup-task-actions :hover');
  return [focusedAction, hoveredAction].some((action) => {
    if (!action) return false;
    const cancelButton = action.closest?.('[data-cancel-cover-lookup-task]');
    if (!cancelButton) return true;
    const taskId = cancelButton.getAttribute('data-cancel-cover-lookup-task');
    const task = (state.coverLookup.tasks || []).find((candidate) => String(candidate?.id || '') === taskId);
    return ['pending', 'running'].includes(String(task?.status || ''));
  });
}

function findCoverLookupTaskOpenForSelectionNode(node) {
  const element = typeof node?.closest === 'function' ? node : node?.parentElement;
  return element?.closest?.('.cover-lookup-task-open') || null;
}

function handleCoverLookupTaskOpenCopy(event) {
  if (typeof window === 'undefined' || typeof window.getSelection !== 'function') return false;
  if (typeof event?.clipboardData?.setData !== 'function') return false;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount < 1) return false;
  const anchorTaskOpen = findCoverLookupTaskOpenForSelectionNode(selection.anchorNode);
  const focusTaskOpen = findCoverLookupTaskOpenForSelectionNode(selection.focusNode);
  if (!anchorTaskOpen || anchorTaskOpen !== focusTaskOpen) return false;
  event.preventDefault();
  event.clipboardData.setData('text/plain', selection.toString());
  return true;
}

function buildCoverLookupDrawerTerminalSignatures(tasks) {
  return Object.fromEntries((Array.isArray(tasks) ? tasks : []).map((task) => {
    const taskId = String(task?.id || '').trim();
    const status = String(task?.status || '').trim();
    const terminalSignature = isCompletedCoverLookupTask(task)
      ? `${status}|${String(task?.result_kind || '').trim()}|${String(task?.finished_at || '').trim()}`
      : '';
    return [taskId, terminalSignature];
  }).filter(([taskId]) => taskId));
}

function hasPendingCoverLookupDrawerTerminalPublication(tasks) {
  const renderedSignatures = state.coverLookup.drawerRenderedTerminalSignatures;
  if (!renderedSignatures || typeof renderedSignatures !== 'object') return false;
  return (Array.isArray(tasks) ? tasks : []).some((task) => {
    if (!isCompletedCoverLookupTask(task)) return false;
    const taskId = String(task?.id || '').trim();
    if (!taskId) return false;
    const currentSignature = buildCoverLookupDrawerTerminalSignatures([task])[taskId];
    return renderedSignatures[taskId] !== currentSignature;
  });
}

const COVER_LOOKUP_TASK_RENDER_LIMIT = 60;
const COVER_LOOKUP_TASK_OVERSCAN = 10;
const COVER_LOOKUP_TASK_ESTIMATED_HEIGHT = 74;

function getCoverLookupTaskRenderWindow(tasks, body) {
  const rowHeight = Math.max(
    1,
    Number(state.coverLookup.taskEstimatedHeight || COVER_LOOKUP_TASK_ESTIMATED_HEIGHT),
  );
  const maximumStart = Math.max(0, tasks.length - COVER_LOOKUP_TASK_RENDER_LIMIT);
  const visibleStart = Math.floor(Math.max(0, Number(body.scrollTop || 0)) / rowHeight);
  const start = Math.min(maximumStart, Math.max(0, visibleStart - COVER_LOOKUP_TASK_OVERSCAN));
  const end = Math.min(tasks.length, start + COVER_LOOKUP_TASK_RENDER_LIMIT);
  return { start, end, rowHeight };
}

function renderCoverLookupDrawer({ preserveInteraction = true } = {}) {
  const drawer = document.getElementById('cover-lookup-drawer');
  const body = document.getElementById('cover-lookup-drawer-body');
  const badge = document.getElementById('cover-lookup-drawer-badge');
  const button = document.getElementById('cover-lookup-drawer-button');
  const clearButton = document.getElementById('cover-lookup-drawer-clear');
  const summary = document.getElementById('cover-lookup-drawer-summary');
  if (!drawer || !body || !button || !badge) return;
  const tasks = Array.isArray(state.coverLookup.tasks) ? state.coverLookup.tasks : [];
  if (state.coverLookup.drawerOpen && typeof activateTriggerSurface === 'function' && !drawer.classList.contains('is-open')) {
    activateTriggerSurface(drawer, () => {
      state.coverLookup.drawerOpen = false;
      renderCoverLookupDrawer();
      stopCoverLookupPollingIfIdle();
    }, { anchor: button });
  } else if (!state.coverLookup.drawerOpen && typeof clearTriggerAnchor === 'function') {
    clearTriggerAnchor(drawer);
  }
  drawer.hidden = !state.coverLookup.drawerOpen;
  drawer.classList.toggle('is-open', state.coverLookup.drawerOpen);
  const loadedActiveCount = tasks.filter((task) => isActiveCoverLookupSearchTask(task)).length;
  const loadedTerminalCount = tasks.filter((task) => (
    isCompletedCoverLookupTask(task) || isCoverLookupSavePending(task)
  )).length;
  const loadedActionedCount = tasks.filter((task) => isActionedCoverLookupNotification(task)).length;
  const counts = state.coverLookup.notificationCounts;
  const hasAuthoritativeCounts = Number.isFinite(Number(counts?.total_count));
  const activeCount = hasAuthoritativeCounts
    ? Math.max(Number(counts.active_count || 0), loadedActiveCount)
    : loadedActiveCount;
  const terminalCount = hasAuthoritativeCounts
    ? Math.max(Number(counts.finished_count || 0), loadedTerminalCount)
    : loadedTerminalCount;
  const badgeCount = hasAuthoritativeCounts
    ? Math.max(Number(counts.total_count || 0), tasks.length)
    : tasks.length;
  if (summary) {
    summary.textContent = [
      activeCount ? `${activeCount} active` : '',
      terminalCount ? `${terminalCount} finished` : '',
    ].filter(Boolean).join(' · ') || 'No activity';
  }
  badge.hidden = badgeCount <= 0;
  badge.textContent = String(badgeCount || '');
  if (badgeCount > 0) loadCoverLookupDrawerHoverIcon(button);
  button.classList.toggle('has-active-lookups', badgeCount > 0);
  if (clearButton) {
    clearButton.hidden = false;
    clearButton.disabled = loadedActionedCount <= 0;
    clearButton.setAttribute?.('aria-disabled', String(loadedActionedCount <= 0));
  }
  if (!state.coverLookup.drawerOpen) {
    body.innerHTML = '';
    state.coverLookup.taskRenderWindowStart = 0;
    syncCoverLookupElapsedTimer();
    return;
  }

  const preserveTextSelection = preserveInteraction
    && hasActiveCoverLookupDrawerTextSelection(body);
  const preservePressedAction = preserveInteraction && Boolean(
    body.querySelector?.('.cover-lookup-task-open:active')
    || body.querySelector?.('.cover-lookup-task-actions :active')
  );
  const preserveActiveAction = preserveInteraction
    && hasActiveCoverLookupDrawerAction(body)
    && (
      preservePressedAction
      || !hasPendingCoverLookupDrawerTerminalPublication(tasks)
    );
  const preserveSelectedNotificationText = preserveTextSelection || preserveActiveAction;
  if (!tasks.length) {
    if (!preserveSelectedNotificationText) {
      body.innerHTML = state.coverLookup.tasksLoadFailed
        ? '<div class="cover-lookup-drawer-empty">Could not load notifications. Try again.</div>'
        : !state.coverLookup.tasksHydrated
          ? `<div class="cover-lookup-task-card is-loading" role="status" aria-live="polite" aria-label="Loading notifications">
              <span class="cover-lookup-task-cover is-placeholder" aria-hidden="true"></span>
              <span class="cover-lookup-task-copy" aria-hidden="true">
                <span class="cover-lookup-task-loading-line is-title"></span>
                <span class="cover-lookup-task-loading-line"></span>
              </span>
            </div>`
          : '<div class="cover-lookup-drawer-empty">You\'re not looking for anything at the moment. Search for specific album art to see notifications.</div>';
      state.coverLookup.drawerRenderedTerminalSignatures = {};
    }
    syncCoverLookupElapsedTimer();
    return;
  }
  const renderWindow = getCoverLookupTaskRenderWindow(tasks, body);
  state.coverLookup.taskRenderWindowStart = renderWindow.start;
  const visibleTasks = tasks.slice(renderWindow.start, renderWindow.end);
  const taskMarkup = visibleTasks.map((task) => {
    const savePending = isCoverLookupSavePending(task);
    const progress = savePending ? 100 : Math.max(0, Math.min(100, Number(task?.progress || 0)));
    const status = String(task?.status || '');
    const isCompleted = isCompletedCoverLookupTask(task);
    const isNoResult = status === 'completed' && String(task?.result_kind || '') === 'no-results';
    const artChosen = isActionedCoverLookupNotification(task);
    const foundCount = Number.isFinite(Number(task?.possible_match_count))
      ? Math.max(0, Number(task.possible_match_count))
      : Array.isArray(task?.possible_matches)
        ? task.possible_matches.filter(item => String(item?.art_kind || 'cover') === 'cover').length
        : 0;
    const statusLabel = savePending
      ? 'Saving art…'
      : artChosen
      ? 'Art chosen'
      : status === 'failed'
      ? (String(task?.result_kind || '') === 'interrupted' ? 'Lookup interrupted' : 'Lookup failed')
      : status === 'canceled'
      ? 'Canceled'
      : isNoResult
      ? 'No covers found'
      : status === 'completed'
        ? `${foundCount ? `${foundCount} ` : ''}covers found`
      : status === 'pending'
          ? 'Queued'
          : 'Searching';
    const taskStateClass = artChosen
      ? 'is-completed'
      : status === 'failed'
      ? 'is-failed'
      : ['pending', 'running'].includes(status)
        ? 'is-running'
        : 'is-completed';
    const elapsedStateClass = artChosen
      ? 'is-completed'
      : status === 'failed'
      ? 'is-failed'
      : isCompleted
        ? 'is-completed'
        : 'is-active';
    const elapsedLabel = getCoverLookupTaskElapsedLabel(
      savePending ? { ...task, status: 'completed' } : task,
      Date.now(),
    );
    const albumTitle = String(task?.album || '').trim() || 'Unknown album';
    const albumByline = [task?.artist || '', task?.year || ''].filter(Boolean).join(' · ');
    const openLabel = `Open Cover Look Up: ${albumTitle}${albumByline ? ` — ${albumByline}` : ''}`;
    const albumPayload = task?.album_payload || {};
    const payloadUserCoverUrl = String(albumPayload?.cover_selection_origin || '').trim().toLowerCase() === 'user'
      && typeof buildAlbumDisplayCoverUrl === 'function'
      ? String(buildAlbumDisplayCoverUrl(albumPayload) || '').trim()
      : '';
    const currentUserCoverUrl = String(task?.current_user_cover_preview_url || '').trim()
      || payloadUserCoverUrl;
    const possibleMatches = Array.isArray(task?.possible_matches) ? task.possible_matches : [];
    const bestCandidateId = String(task?.best_candidate_id || '').trim();
    const bestCandidate = possibleMatches.find((candidate) => (
      String(candidate?.id || '').trim() === bestCandidateId
      && String(candidate?.art_kind || 'cover').trim() === 'cover'
    )) || possibleMatches.find((candidate) => (
      String(candidate?.art_kind || 'cover').trim() === 'cover'
    ));
    const bestCandidatePreviewUrl = String(
      task?.best_candidate_preview_url
      || bestCandidate?.thumbnail_url
      || bestCandidate?.preview_url
      || bestCandidate?.url
      || '',
    ).trim();
    const coverUrl = currentUserCoverUrl || buildRemoteCoverLookupImageUrl(
      bestCandidatePreviewUrl,
      bestCandidateId || bestCandidate?.id || '',
    );
    const coverMarkup = coverUrl
      ? `<img class="cover-lookup-task-cover" src="${escapeHtml(coverUrl)}" alt="" loading="lazy" decoding="async">`
      : '<span class="cover-lookup-task-cover is-placeholder" aria-hidden="true"></span>';
    return `
      <div class="cover-lookup-task-card ${taskStateClass}">
        <div class="cover-lookup-task-open" role="button" tabindex="0" aria-label="${escapeHtml(openLabel)}" data-open-cover-lookup-task="${escapeHtml(task.id || '')}">
          ${coverMarkup}
          <span class="cover-lookup-task-copy">
            <span class="cover-lookup-task-title">${escapeHtml(albumTitle)}</span>
            <span class="cover-lookup-task-byline">${escapeHtml(albumByline)}</span>
            <span class="cover-lookup-task-meta">
              <span class="cover-lookup-task-status-label ${taskStateClass}">${escapeHtml(statusLabel)}</span>
              <span class="cover-lookup-task-elapsed ${elapsedStateClass}" data-cover-lookup-task-elapsed="${escapeHtml(task.id || '')}" ${elapsedLabel ? '' : 'hidden'}>${escapeHtml(elapsedLabel)}</span>
            </span>
          </span>
        </div>
      <div class="cover-lookup-task-actions">
        ${status === 'failed' && task?.album_payload
          ? ButtonComponent.renderActionButton({
            icon: 'refresh',
            ariaLabel: 'Retry lookup',
            title: 'Retry lookup',
            className: 'cover-lookup-task-retry',
            attributes: { 'data-retry-cover-lookup-task': task.id || '' },
          })
          : ''}
        ${isActiveCoverLookupSearchTask(task)
          ? ButtonComponent.renderActionButton({
            icon: 'close',
            semantic: 'destructive',
            ariaLabel: 'Stop lookup',
            title: 'Stop lookup',
            className: 'cover-lookup-task-cancel',
            attributes: { 'data-cancel-cover-lookup-task': task.id || '' },
          })
          : isCompleted
            ? ButtonComponent.renderActionButton({
              icon: 'delete',
              semantic: 'destructive',
              ariaLabel: 'Delete notification',
              title: 'Delete notification',
              className: 'cover-lookup-task-clear',
              attributes: { 'data-clear-cover-lookup-task': task.id || '' },
            })
            : ''}
      </div>
      <div class="cover-lookup-task-progress" aria-hidden="true"><span style="width:${progress}%"></span></div>
      </div>
    `;
  }).join('');
  if (!preserveSelectedNotificationText) {
    const topSpacerHeight = renderWindow.start * renderWindow.rowHeight;
    const bottomSpacerHeight = (tasks.length - renderWindow.end) * renderWindow.rowHeight;
    body.innerHTML = `
      <div class="cover-lookup-task-spacer" aria-hidden="true" style="height:${topSpacerHeight}px"></div>
      ${taskMarkup}
      <div class="cover-lookup-task-spacer" aria-hidden="true" style="height:${bottomSpacerHeight}px"></div>
    `;
    const measuredCard = body.querySelector?.('.cover-lookup-task-card');
    const measuredHeight = Number(measuredCard?.getBoundingClientRect?.().height || 0);
    const measuredGap = Number.parseFloat(window.getComputedStyle?.(body)?.rowGap || '') || 8;
    if (measuredHeight > 0) state.coverLookup.taskEstimatedHeight = measuredHeight + measuredGap;
    state.coverLookup.drawerRenderedTerminalSignatures = buildCoverLookupDrawerTerminalSignatures(tasks);
  }
  syncCoverLookupElapsedTimer();
}

async function clearCompletedCoverLookupTasks() {
  const previousTasks = Array.isArray(state.coverLookup.tasks) ? state.coverLookup.tasks.slice() : [];
  const terminalTaskIds = previousTasks
    .filter((task) => isActionedCoverLookupNotification(task))
    .map((task) => String(task?.id || '').trim())
    .filter(Boolean);
  if (!terminalTaskIds.length) {
    return;
  }
  const terminalTaskIdSet = new Set(terminalTaskIds);
  state.coverLookup.tasks = previousTasks.filter(
    (task) => !terminalTaskIdSet.has(String(task?.id || '').trim()),
  );
  renderCoverLookupDrawer({ preserveInteraction: false });
  stopCoverLookupPollingIfIdle();
  try {
    const response = await fetch('/utilities/cover-lookup/tasks/clear-completed', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      throw new Error(data.error || 'Failed to clear completed cover lookups');
    }
    state.coverLookup.tasks = mergeCoverLookupTasksWithNotifications(Array.isArray(data.tasks) ? data.tasks : []);
    await loadCoverLookupNotificationCounts({ toast: false });
    renderCoverLookupDrawer();
    stopCoverLookupPollingIfIdle();
  } catch (error) {
    state.coverLookup.tasks = previousTasks;
    console.error('[AlbumHaven][CoverLookup] Failed to clear completed tasks.', error);
    renderCoverLookupDrawer({ preserveInteraction: false });
    stopCoverLookupPollingIfIdle();
    showToast(error.message || 'Failed to clear completed cover lookups.', 'error', 2800);
  }
}

async function clearCoverLookupTaskNotification(taskId) {
  const normalizedTaskId = String(taskId || '').trim();
  if (!normalizedTaskId) return;
  const previousTasks = Array.isArray(state.coverLookup.tasks) ? state.coverLookup.tasks.slice() : [];
  const nextTasks = previousTasks.filter((task) => String(task?.id || '').trim() !== normalizedTaskId);
  if (nextTasks.length === previousTasks.length) return;
  state.coverLookup.tasks = nextTasks;
  if (String(state.coverLookup.modal.taskId || '') === normalizedTaskId) {
    state.coverLookup.modal.taskId = '';
  }
  renderCoverLookupDrawer({ preserveInteraction: false });
  stopCoverLookupPollingIfIdle();
  try {
    const response = await fetch(`/utilities/cover-lookup/task/${encodeURIComponent(normalizedTaskId)}/clear`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      throw new Error(data.error || 'Failed to clear notification');
    }
    state.coverLookup.tasks = mergeCoverLookupTasksWithNotifications(Array.isArray(data.tasks) ? data.tasks : []);
    await loadCoverLookupNotificationCounts({ toast: false });
    renderCoverLookupDrawer();
    stopCoverLookupPollingIfIdle();
  } catch (error) {
    state.coverLookup.tasks = previousTasks;
    console.error('[AlbumHaven][CoverLookup] Failed to clear notification.', error);
    renderCoverLookupDrawer({ preserveInteraction: false });
    stopCoverLookupPollingIfIdle();
    showToast(error.message || 'Failed to clear notification.', 'error', 2800);
  }
}

function releaseDeferredCoverLookupPreviews(root) {
  const images = root?.querySelectorAll?.('[data-cover-lookup-deferred-src]') || [];
  images.forEach((image) => {
    const src = String(image.getAttribute('data-cover-lookup-deferred-src') || '').trim();
    if (!src) return;
    image.src = src;
    image.removeAttribute('data-cover-lookup-deferred-src');
  });
}

function scheduleDeferredCoverLookupPreviews(root) {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const requestFrame = typeof window.requestAnimationFrame === 'function'
      ? callback => window.requestAnimationFrame(callback)
      : typeof window.setTimeout === 'function'
      ? callback => window.setTimeout(callback, 0)
      : callback => callback();
    requestFrame(() => requestFrame(() => releaseDeferredCoverLookupPreviews(root)));
  };
  const priorityImage = root?.querySelector?.('.cover-lookup-art-preview-image[fetchpriority="high"]');
  if (!priorityImage || priorityImage.complete) {
    release();
    return;
  }
  priorityImage.addEventListener('load', release, { once: true });
  priorityImage.addEventListener('error', release, { once: true });
  window.setTimeout?.(release, 500);
}

function buildCoverLookupCard(item, kind = 'local', prioritizeRemotePreview = false) {
  const resolution = item?.resolution || ((item?.width && item?.height) ? `${item.width}x${item.height}` : 'Unknown');
  const isRemoteKind = kind === 'remote' || kind === 'saved-remote';
  const isPastedKind = kind === 'pasted';
  const isOtherRemoteArt = isRemoteKind && String(item?.art_kind || 'cover') !== 'cover';
  const isSelectableOtherRemoteArt = isOtherRemoteArt && isSelectableRemoteCoverCandidate(item);
  const previewFallbackImageUrl = '/static/images/remote-preview-unavailable.png';
  const sourceBadge = buildRemoteCoverSourceBadge(item?.source);
  const remoteSourceLabel = getRemoteCoverSourceLabel(item?.source, item?.source_label);
  const imageUrl = kind === 'remote'
    ? buildRemoteCoverLookupDisplayUrl(item, item?.thumbnail_url || item?.url || '', item?.id || item?.url || '')
    : kind === 'saved-remote'
      ? buildRemoteCoverLookupDisplayUrl(item, item?.thumbnail_url || item?.url || '', `saved:${item?.id || item?.url || ''}`)
      : kind === 'pasted'
        ? String(item?.object_url || item?.data_url || '').trim()
      : buildCoverUrl(item?.path || '', {
        size: 480,
        revision: item?.cover_revision,
      });
  const fullImageUrl = kind === 'remote'
    ? buildRemoteCoverLookupDisplayUrl(item, item?.url || item?.thumbnail_url || '', `full:${item?.id || item?.url || ''}`)
    : kind === 'saved-remote'
      ? buildRemoteCoverLookupDisplayUrl(item, item?.url || item?.thumbnail_url || '', `full:saved:${item?.id || item?.url || ''}`)
      : kind === 'pasted'
        ? String(item?.object_url || item?.data_url || '').trim()
      : buildCoverUrl(item?.path || '', { revision: item?.cover_revision });
  const isActive = kind === 'local'
    ? (!state.coverLookup.modal.selectedRemoteId && (
      String(state.coverLookup.modal.pendingLocalPath || '')
        ? String(state.coverLookup.modal.pendingLocalPath || '') === String(item?.path || '')
        : !String(state.coverLookup.modal.pendingPastedImageId || '')
          && String(item?.path || '') === getCoverLookupActiveLocalPath()
    ))
    : kind === 'pasted'
      ? (!String(state.coverLookup.modal.selectedRemoteId || '') && !String(state.coverLookup.modal.pendingLocalPath || '') && state.coverLookup.modal.pendingPastedImageId === String(item?.id || ''))
    : kind === 'saved-remote'
      ? (
        !String(state.coverLookup.modal.selectedRemoteId || '')
        && !String(state.coverLookup.modal.pendingLocalPath || '')
        && !String(state.coverLookup.modal.pendingPastedImageId || '')
        && !String(state.coverLookup.modal.activeLocalSelectionPath || '')
      )
      : ((!isOtherRemoteArt || isSelectableOtherRemoteArt)
        && state.coverLookup.modal.selectedRemoteId === String(item?.id || ''));
  const itemIdentity = kind === 'local'
    ? String(item?.path || '')
    : kind === 'pasted'
      ? String(item?.id || '')
      : String(item?.id || item?.url || '');
  const itemKeyAttr = itemIdentity
    ? `data-cover-lookup-item-key="${escapeHtml(`${kind}:${itemIdentity}`)}"`
    : '';
  const otherRemoteArtAttr = isOtherRemoteArt ? 'data-cover-lookup-other-remote-art="1"' : '';
  const selectAttr = isOtherRemoteArt && !isSelectableOtherRemoteArt
    ? ''
    : kind === 'pasted'
    ? `data-select-pasted-cover="${escapeHtml(item.id || '')}"`
    : kind === 'local'
    ? `data-select-local-cover="${escapeHtml(item.path || '')}"`
    : kind === 'saved-remote'
      ? 'data-cover-lookup-saved-remote="1"'
      : `data-select-remote-cover="${escapeHtml(item.id || '')}"`;
  const localActiveAttr = kind === 'local' && isActive ? 'data-cover-lookup-local-active="1"' : '';
  const previewAlt = escapeHtml(item.filename || item.album || 'cover art');
  const albumLink = String(item?.album_url || '').trim();
  const previewAttrs = `data-cover-lookup-open-lightbox="1" data-cover-src="${escapeHtml(fullImageUrl)}" data-cover-alt="${previewAlt}"`;
  const lightboxDataAttrs = kind === 'saved-remote'
    ? `data-cover-lookup-open-lightbox="1" data-cover-src="${escapeHtml(fullImageUrl)}" data-cover-alt="${previewAlt}"`
    : `data-cover-src="${escapeHtml(fullImageUrl)}" data-cover-alt="${previewAlt}"`;
  const previewButtonLabel = 'Open full-size cover art';
  const previewLoadingAttrs = isRemoteKind && !prioritizeRemotePreview
    ? 'loading="lazy" fetchpriority="low"'
    : isRemoteKind
      ? 'loading="eager" fetchpriority="high"'
      : 'loading="eager"';
  const previewSourceAttr = kind === 'remote' && !prioritizeRemotePreview
    ? `data-cover-lookup-deferred-src="${escapeHtml(imageUrl)}"`
    : `src="${escapeHtml(imageUrl)}"`;
  const actionLabel = kind === 'saved-remote'
    ? (isActive ? 'Selected' : 'Linked remote cover')
    : (isActive ? 'Selected' : 'Select');
  const roleAttr = isOtherRemoteArt && !isSelectableOtherRemoteArt
    ? 'role="group"'
    : 'role="button" tabindex="0"';
  const fallbackPreviewHtml = `
    <span class="cover-lookup-art-preview-fallback">
      <img src="${previewFallbackImageUrl}" alt="Remote preview unavailable" loading="eager" decoding="async">
    </span>
  `;
  return `
    <div class="cover-lookup-art-card-shell">
      <div class="cover-lookup-art-card ${isActive ? 'is-active' : ''} ${isOtherRemoteArt && !isSelectableOtherRemoteArt ? 'is-preview-only' : ''}" ${roleAttr} ${selectAttr} ${otherRemoteArtAttr} ${itemKeyAttr} ${localActiveAttr} ${lightboxDataAttrs}>
        <span class="cover-lookup-art-preview">
          ${fallbackPreviewHtml}
        ${imageUrl ? `<img class="cover-lookup-art-preview-image" ${previewSourceAttr} alt="${previewAlt}" ${previewLoadingAttrs} decoding="async" onload="this.closest('.cover-lookup-art-preview')?.classList.remove('has-load-error');" onerror="this.style.display='none'; this.removeAttribute('src'); var preview=this.parentElement; if(preview){ preview.classList.add('has-load-error'); }">` : ''}
          <button class="cover-lookup-art-preview-button" type="button" ${previewAttrs} aria-label="${previewButtonLabel}">
            <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
              <path d="M10.5 4a6.5 6.5 0 1 0 4.07 11.57l4.43 4.43 1.41-1.41-4.43-4.43A6.5 6.5 0 0 0 10.5 4Zm0 2a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9Zm-.75 1.75h1.5v2h2v1.5h-2v2h-1.5v-2h-2v-1.5h2v-2Z" fill="currentColor"></path>
            </svg>
          </button>
          ${isActive ? '<span class="cover-lookup-art-check">&#10003;</span>' : ''}
          ${kind === 'local' ? `<button class="cover-lookup-art-delete" type="button" data-delete-local-cover="${escapeHtml(item.path || '')}" aria-label="Delete local cover art">&#128465;</button>` : ''}
          ${isPastedKind ? `<button class="cover-lookup-art-delete" type="button" data-remove-pasted-cover="${escapeHtml(item.id || '')}" aria-label="Remove staged image">&#10005;</button>` : ''}
        </span>
        <span class="cover-lookup-art-meta">
          <span class="cover-lookup-art-name">${escapeHtml(item.relative_path || item.filename || item.album || (isPastedKind ? 'Pasted image' : 'Cover art'))}</span>
          <span class="cover-lookup-art-resolution">${escapeHtml(resolution)}</span>
          ${isRemoteKind ? `<span class="cover-lookup-art-source-row">${sourceBadge}<span class="cover-lookup-art-source">${escapeHtml(remoteSourceLabel)}</span></span>` : ''}
          ${isOtherRemoteArt && !isSelectableOtherRemoteArt ? '' : `<span class="cover-lookup-art-action-label">${actionLabel}</span>`}
        </span>
      </div>
    </div>
  `;
}

function captureCoverLookupModalScrollAnchor(body) {
  if (!body) return null;
  const scrollTop = Number(body.scrollTop || 0);
  if (typeof body.getBoundingClientRect !== 'function' || typeof body.querySelectorAll !== 'function') {
    return { scrollTop, itemKey: '', offsetTop: 0 };
  }
  const viewport = body.getBoundingClientRect();
  const items = Array.from(body.querySelectorAll('[data-cover-lookup-item-key], [data-cover-lookup-scroll-key]'));
  const anchor = items.find((item) => {
    if (typeof item?.getBoundingClientRect !== 'function') return false;
    const rect = item.getBoundingClientRect();
    return rect.bottom > viewport.top && rect.top < viewport.bottom;
  });
  if (!anchor) return { scrollTop, itemKey: '', offsetTop: 0 };
  const itemKey = String(
    anchor.getAttribute('data-cover-lookup-item-key')
      || anchor.getAttribute('data-cover-lookup-scroll-key')
      || '',
  );
  return {
    scrollTop,
    itemKey,
    offsetTop: anchor.getBoundingClientRect().top - viewport.top,
  };
}

function restoreCoverLookupModalScrollAnchor(body, snapshot) {
  if (!body || !snapshot) return;
  body.scrollTop = Number(snapshot.scrollTop || 0);
  const itemKey = String(snapshot.itemKey || '');
  if (!itemKey || typeof body.getBoundingClientRect !== 'function' || typeof body.querySelectorAll !== 'function') return;
  const anchor = Array.from(
    body.querySelectorAll('[data-cover-lookup-item-key], [data-cover-lookup-scroll-key]'),
  ).find((item) => (
    String(item.getAttribute('data-cover-lookup-item-key') || item.getAttribute('data-cover-lookup-scroll-key') || '')
      === itemKey
  ));
  if (!anchor || typeof anchor.getBoundingClientRect !== 'function') return;
  const currentOffsetTop = anchor.getBoundingClientRect().top - body.getBoundingClientRect().top;
  body.scrollTop = Math.max(
    0,
    Number(snapshot.scrollTop || 0) + currentOffsetTop - Number(snapshot.offsetTop || 0),
  );
}

function formatCoverLookupImageCount(count) {
  const safeCount = Math.max(0, Number(count || 0) || 0);
  return `${safeCount} ${safeCount === 1 ? 'image' : 'images'}`;
}

function buildCoverLookupGalleryLoadingCards(section, count) {
  return Array.from({ length: Math.max(1, Number(count || 0) || 0) }, () => `
    <div class="cover-lookup-art-card-shell is-loading" data-cover-lookup-loading-section="${section}" aria-hidden="true">
      <div class="cover-lookup-art-card">
        <span class="cover-lookup-art-preview"></span>
        <span class="cover-lookup-task-loading-line is-title"></span>
        <span class="cover-lookup-task-loading-line"></span>
      </div>
    </div>
  `).join('');
}

function buildCoverLookupGalleryLoadingMarkup(modalState) {
  const remoteCount = Math.max(
    Number(modalState?.expectedRemoteCount || 0) || 0,
    Array.isArray(modalState?.possibleMatches) ? modalState.possibleMatches.length : 0,
  );
  const section = (title, key, count, countKnown = false) => `
    <section class="cover-lookup-section">
      <h4 class="cover-lookup-section-title">${title}${countKnown ? ` ${formatCoverLookupImageCount(count)}` : ''}</h4>
      <div class="cover-lookup-gallery cover-lookup-gallery-loading">
        ${buildCoverLookupGalleryLoadingCards(key, count)}
      </div>
    </section>
  `;
  return `<div role="status" aria-label="Loading cover art">
    ${section('LOCAL', 'local', 1)}
    ${section('OTHER ART', 'other-art', 1)}
    ${section('REMOTE', 'remote', remoteCount, remoteCount > 0)}
  </div>`;
}

function renderCoverLookupModal() {
  const els = getCoverLookupModalElements();
  if (!els.overlay || !els.body) return;
  const modalState = state.coverLookup.modal;
  const scrollAnchor = modalState.loading
    ? null
    : captureCoverLookupModalScrollAnchor(els.body);
  const album = modalState.album;
  if (els.subtitle) {
    els.subtitle.textContent = buildCoverLookupAlbumSubtitle(album);
  }
  const allLocalCovers = Array.isArray(modalState.localCovers) ? modalState.localCovers : [];
  // Compact pages show one choice per initial artwork; desktop retains each
  // file. Keep a draft chosen on desktop visible after the viewport narrows.
  const compact = typeof usesMobilePageLayout === 'function' && usesMobilePageLayout();
  const localCovers = compact ? allLocalCovers.filter(cover => !(
    cover.duplicate_of && cover.path !== modalState.pendingLocalPath
    && allLocalCovers.some(other => other.path === cover.duplicate_of)
  )) : allLocalCovers;
  const pastedImages = Array.isArray(modalState.pastedImages) ? modalState.pastedImages : [];
  const manualImageAttachments = Array.isArray(modalState.manualImageAttachments)
    ? modalState.manualImageAttachments : [];
  const otherArt = Array.isArray(modalState.otherArt) ? modalState.otherArt : [];
  const remoteCover = modalState.remoteCover && typeof modalState.remoteCover === 'object' ? modalState.remoteCover : null;
  const possibleMatches = Array.isArray(modalState.possibleMatches) ? modalState.possibleMatches : [];
  const byLargestArea = (left, right) => {
    const leftArea = Number(left?.area || 0) || ((Number(left?.width || 0) || 0) * (Number(left?.height || 0) || 0));
    const rightArea = Number(right?.area || 0) || ((Number(right?.width || 0) || 0) * (Number(right?.height || 0) || 0));
    if (rightArea !== leftArea) return rightArea - leftArea;
    return (Number(right?.score || 0) || 0) - (Number(left?.score || 0) || 0);
  };
  const serviceMatches = possibleMatches
    .filter((item) => (
      String(item?.lookup_group || 'services') === 'services'
      && String(item?.source || '') !== 'discogs'
      && String(item?.art_kind || 'cover') === 'cover'
    ))
    .slice()
    .sort(byLargestArea);
  const discogsMatches = possibleMatches
    .filter((item) => (
      String(item?.source || '') === 'discogs'
      && String(item?.lookup_group || '') !== 'manual_links'
    ));
  const discogsCoverMatches = discogsMatches
    .filter((item) => String(item?.art_kind || 'cover') === 'cover')
    .slice()
    .sort(byLargestArea);
  const discogsOtherArtMatches = discogsMatches
    .filter((item) => String(item?.art_kind || '') === 'other')
    .slice()
    .sort(byLargestArea);
  const groupedDiscogsMatches = [...discogsCoverMatches, ...discogsOtherArtMatches];
  const manualLinkMatches = possibleMatches
    .filter((item) => String(item?.lookup_group || '') === 'manual_links' && String(item?.art_kind || 'cover') === 'cover')
    .slice()
    .sort(byLargestArea);
  const manualLinkOtherArtMatches = possibleMatches
    .filter((item) => String(item?.lookup_group || '') === 'manual_links' && String(item?.art_kind || '') === 'other')
    .slice()
    .sort(byLargestArea);
  const archiveMatches = possibleMatches.filter((item) => String(item?.lookup_group || '') === 'cover_art_archive');
  const archiveCoverMatches = archiveMatches.filter((item) => String(item?.art_kind || 'cover') === 'cover').slice().sort(byLargestArea);
  const archiveOtherArtMatches = archiveMatches.filter((item) => String(item?.art_kind || '') === 'other').slice().sort(byLargestArea);
  const groupedArchiveMatches = [...archiveCoverMatches, ...archiveOtherArtMatches];
  const remoteOtherArtMatches = possibleMatches
    .filter((item) => (
      String(item?.art_kind || '') === 'other'
      && String(item?.lookup_group || '') !== 'manual_links'
      && !['discogs', 'cover_art_archive'].includes(String(item?.source || ''))
    ))
    .slice()
    .sort(byLargestArea);
  const task = (state.coverLookup.tasks || []).find((item) => String(item?.id || '') === String(modalState.taskId || '')) || null;
  const showCaaEmptyNotice = Boolean(task?.caa_empty_notice) && !archiveMatches.length;
  const taskRunning = Boolean(task && ['pending', 'running'].includes(String(task.status || '')));
  if (els.status) {
    if (!taskRunning && !modalState.failureNotice && String(modalState.statusTone || '') !== 'error') {
      els.status.textContent = String(modalState.statusText || '');
    } else {
      els.status.innerHTML = buildCoverLookupModalStatusHtml(taskRunning);
    }
  }
  const searchControlsDisabled = Boolean(taskRunning || modalState.manualBusy);
  const searchControlsDisabledAttr = searchControlsDisabled ? 'disabled' : '';
  const manualInputDisabled = searchControlsDisabled;
  const manualInputDisabledAttr = manualInputDisabled ? 'disabled' : '';
  const manualSearchDisabled = searchControlsDisabled
    || (!String(modalState.manualUrlText || '').trim() && !manualImageAttachments.length);
  const manualSearchDisabledAttr = manualSearchDisabled ? 'disabled' : '';
  const googleSearchUrl = buildCoverLookupImageSearchUrl('google', album);
  const yandexSearchUrl = buildCoverLookupImageSearchUrl('yandex', album);
  const progressMarkup = taskRunning
    ? `
        <div class="cover-lookup-search-progress" role="status" aria-live="polite">
          <div class="cover-lookup-search-progress-copy">Search is in progress. You can use results as they arrive, browse other pages, and will be notified when we are done.</div>
          <div class="cover-lookup-search-progress-bar" aria-hidden="true">
            <span class="cover-lookup-search-progress-fill" style="width:${Math.max(8, Math.min(100, Number(task.progress || 0)))}%"></span>
          </div>
          <div class="cover-lookup-search-progress-label">${escapeHtml(task.progress_label || 'Searching...')}</div>
        </div>`
    : '';
  const possibleMatchesMarkup = possibleMatches.length
    ? `
        ${serviceMatches.length ? `<div class="cover-lookup-subsection-title">From services</div><div class="cover-lookup-gallery">${serviceMatches.map((item, index) => buildCoverLookupCard(item, 'remote', index === 0)).join('')}</div>` : ''}
        ${groupedDiscogsMatches.length ? `<div class="cover-lookup-subsection-title">Discogs</div><div class="cover-lookup-gallery" data-cover-lookup-provider-group="discogs">${groupedDiscogsMatches.map((item) => buildCoverLookupCard(item, 'remote')).join('')}</div>` : ''}
        ${groupedArchiveMatches.length ? `<div class="cover-lookup-subsection-title">Cover Art Archive</div><div class="cover-lookup-gallery" data-cover-lookup-provider-group="cover_art_archive">${groupedArchiveMatches.map((item) => buildCoverLookupCard(item, 'remote')).join('')}</div>` : ''}
        ${manualLinkMatches.length ? `<div class="cover-lookup-subsection-title">MANUAL LINKS</div><div class="cover-lookup-gallery">${manualLinkMatches.map((item) => buildCoverLookupCard(item, 'remote')).join('')}</div>` : ''}
        ${manualLinkOtherArtMatches.length ? `<div class="cover-lookup-subsection-title">MANUAL LINKS - OTHER REMOTE ART</div><div class="cover-lookup-gallery">${manualLinkOtherArtMatches.map((item) => buildCoverLookupCard(item, 'remote')).join('')}</div>` : ''}
        ${remoteOtherArtMatches.length ? `<div class="cover-lookup-subsection-title">OTHER COVER ART</div><div class="cover-lookup-gallery">${remoteOtherArtMatches.map((item) => buildCoverLookupCard(item, 'remote')).join('')}</div>` : ''}
        ${showCaaEmptyNotice ? `<div class="cover-lookup-subsection-title">Cover Art Archive</div><div class="cover-lookup-empty">We cannot guarantee Cover Art Archive results. Its API is flaky, you can try doing the same search later and might see good matches here</div>` : ''}
      `
    : '';
  if (modalState.loading) {
    els.body.innerHTML = buildCoverLookupGalleryLoadingMarkup(modalState);
    els.body.scrollTop = 0;
    if (els.saveRemote) {
      els.saveRemote.hidden = false;
      els.saveRemote.disabled = true;
    }
    return;
  }
  const currentReleases = Array.isArray(modalState.currentReleases)
    ? modalState.currentReleases : [];
  if (currentReleases.length) {
    els.body.innerHTML = `
      <section class="cover-lookup-section cover-lookup-current-release-choice" role="group" aria-labelledby="cover-lookup-current-release-title">
        <h4 class="cover-lookup-section-title" id="cover-lookup-current-release-title">This album was split—choose the current release</h4>
        <div class="cover-lookup-current-release-list">
          ${currentReleases.map((release) => `
            <button class="cover-lookup-current-release" type="button" data-cover-lookup-current-release="${escapeHtml(release.album_id || '')}">
              <span>${escapeHtml(buildCoverLookupCurrentReleaseLabel(release))}</span>
              <span class="cover-lookup-current-release-count">${escapeHtml(String(release.track_count || 0))} ${Number(release.track_count) === 1 ? 'track' : 'tracks'}</span>
            </button>
          `).join('')}
        </div>
      </section>`;
    els.body.scrollTop = 0;
    if (els.findBetter) els.findBetter.disabled = true;
    if (els.saveRemote) {
      els.saveRemote.hidden = false;
      els.saveRemote.disabled = true;
    }
    return;
  }
  els.body.innerHTML = `
    <section class="cover-lookup-section">
      <h4 class="cover-lookup-section-title">LOCAL · ${formatCoverLookupImageCount(localCovers.length)}</h4>
      <div class="cover-lookup-gallery">${localCovers.length ? localCovers.map((item) => buildCoverLookupCard(item, 'local')).join('') : '<div class="cover-lookup-empty">No local cover art found in this album folder.</div>'}</div>
      ${pastedImages.length ? `<div class="cover-lookup-subsection-title">PASTED IMAGES</div><div class="cover-lookup-gallery">${pastedImages.map((item) => buildCoverLookupCard(item, 'pasted')).join('')}</div>` : ''}
      ${otherArt.length ? `<div class="cover-lookup-subsection-title">Other art</div><div class="cover-lookup-gallery">${otherArt.map((item) => buildCoverLookupCard(item, 'local')).join('')}</div>` : ''}
    </section>
    ${remoteCover ? `<section class="cover-lookup-section">
      <h4 class="cover-lookup-section-title">REMOTE · ${formatCoverLookupImageCount(1)}</h4>
      <div class="cover-lookup-gallery">${buildCoverLookupCard(remoteCover, 'saved-remote')}</div>
    </section>` : ''}
    <section class="cover-lookup-section cover-lookup-results" data-search-started="${Boolean(task || modalState.candidateGeneration || possibleMatches.length)}">
      <div class="cover-lookup-section-heading">
        <h4 class="cover-lookup-section-title">${possibleMatches.length || taskRunning || showCaaEmptyNotice ? `POSSIBLE MATCHES · ${formatCoverLookupImageCount(possibleMatches.length)}` : 'ADD COVER ART'}</h4>
      </div>
      ${progressMarkup}
      ${possibleMatchesMarkup}
        <div class="cover-lookup-manual-add" data-cover-lookup-scroll-key="manual-add">
        <div class="cover-lookup-manual-divider" aria-hidden="true"></div>
        <div class="cover-lookup-subsection-title">MANUAL SEARCH</div>
        <div class="cover-lookup-search-shortcuts">
          <a class="cover-lookup-search-chip is-google" href="${googleSearchUrl}" target="_blank" rel="noreferrer"><img class="cover-lookup-search-chip-logo" src="/static/images/google.ico" alt=""><span>Google</span><span class="cover-lookup-external-marker" aria-hidden="true">↗</span></a>
          <a class="cover-lookup-search-chip is-yandex" href="${yandexSearchUrl}" target="_blank" rel="noreferrer"><img class="cover-lookup-search-chip-logo" src="/static/images/yandex.ico" alt=""><span>Yandex</span><span class="cover-lookup-external-marker" aria-hidden="true">↗</span></a>
        </div>
        <div class="cover-lookup-manual-row" data-cover-lookup-drop-zone="1">
          <div class="cover-lookup-manual-content">
            <div class="cover-lookup-manual-attachments" ${manualImageAttachments.length ? '' : 'hidden'}>
              ${manualImageAttachments.map((item) => `
                <span class="cover-lookup-manual-attachment" data-cover-lookup-pending-attachment="${escapeHtml(item.id || '')}" title="${escapeHtml(item.filename || 'Image')}">
                  <img src="${escapeHtml(item.object_url || item.data_url || '')}" alt="">
                  <button type="button" data-remove-cover-lookup-pending-attachment="${escapeHtml(item.id || '')}" aria-label="Remove ${escapeHtml(item.filename || 'image')}">×</button>
                </span>
              `).join('')}
            </div>
            <textarea class="cover-lookup-manual-input" id="cover-lookup-pasted-urls" rows="1" placeholder="Paste an image or a direct image or album link" ${manualInputDisabledAttr}>${escapeHtml(modalState.manualUrlText || '')}</textarea>
          </div>
          <input type="file" accept="image/*" multiple data-cover-lookup-file-input hidden ${manualInputDisabledAttr}>
          <button class="cover-lookup-manual-open" type="button" data-choose-cover-lookup-files="1" aria-label="Add image" ${manualInputDisabledAttr}><span aria-hidden="true">+</span><span>Add image</span></button>
        </div>
        <div class="cover-lookup-manual-actions">
          <button class="button ui-button ui-button--medium cover-lookup-manual-submit" type="button" data-add-cover-lookup-remote="1" ${manualSearchDisabledAttr}>Extract images</button>
        </div>
        </div>
      </section>
    `;
  restoreCoverLookupModalScrollAnchor(els.body, scrollAnchor);
  scheduleDeferredCoverLookupPreviews(els.body);
  if (els.saveRemote) {
    syncCoverLookupManualControlsUi();
    syncCoverLookupSaveButton();
  }
}

const coverLookupTasksRequestSequences = { replace: 0, refresh: 0, append: 0, active: 0 };

function updateCoverLookupNotificationCounts(data) {
  if (!Number.isFinite(Number(data?.total_count))) return;
  state.coverLookup.notificationCounts = {
    total_count: Math.max(0, Number(data.total_count || 0)),
    active_count: Math.max(0, Number(data.active_count || 0)),
    finished_count: Math.max(0, Number(data.finished_count || 0)),
  };
}

async function loadCoverLookupNotificationCounts(options = {}) {
  try {
    const response = await fetch('/utilities/cover-lookup/tasks/counts', {
      headers: { Accept: 'application/json' },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      throw new Error(data.error || 'Failed to load cover lookup notification counts');
    }
    updateCoverLookupNotificationCounts(data);
    renderCoverLookupDrawer();
  } catch (error) {
    console.warn('[AlbumHaven][CoverLookup] Failed to load notification counts.', error);
    if (options.toast !== false) {
      showToast(error.message || 'Failed to load cover lookup notification counts.', 'error', 2800);
    }
  }
}

function mergeCoverLookupTaskSummaries(incomingTasks, mode) {
  const incoming = mergeCoverLookupTasksWithNotifications(incomingTasks);
  if (mode === 'replace') return incoming;
  const current = Array.isArray(state.coverLookup.tasks) ? state.coverLookup.tasks : [];
  const incomingIds = new Set(incoming.map((task) => String(task?.id || '')).filter(Boolean));
  const remaining = current.filter((task) => !incomingIds.has(String(task?.id || '')));
  if (mode === 'active') {
    const currentIds = new Set(current.map((task) => String(task?.id || '')).filter(Boolean));
    const incomingById = new Map(incoming.map((task) => [String(task?.id || ''), task]));
    const newTasks = incoming.filter((task) => !currentIds.has(String(task?.id || '')));
    return [
      ...newTasks,
      ...current.map((task) => incomingById.get(String(task?.id || '')) || task),
    ];
  }
  return mode === 'append' ? [...remaining, ...incoming] : [...incoming, ...remaining];
}

async function loadCoverLookupTasks(options = {}) {
  const activeOnly = options.activeOnly === true;
  const append = options.append === true;
  const requestMode = activeOnly
    ? 'active'
    : append
      ? 'append'
      : options.mergeFirstPage === true
        ? 'refresh'
        : 'replace';
  const requestSequence = ++coverLookupTasksRequestSequences[requestMode];
  if (!activeOnly && !append) {
    state.coverLookup.tasksLoadFailed = false;
    if (!state.coverLookup.tasksHydrated && !(state.coverLookup.tasks || []).length) {
      renderCoverLookupDrawer({ preserveInteraction: false });
    }
  }
  const previousActiveTaskIds = activeOnly
    ? new Set(
      (state.coverLookup.tasks || [])
        .filter((task) => ['pending', 'running'].includes(String(task?.status || '')))
        .map((task) => String(task?.id || ''))
        .filter(Boolean),
    )
    : new Set();
  try {
    const params = new URLSearchParams({ limit: '50' });
    if (activeOnly) params.set('active_only', 'true');
    if (append && state.coverLookup.tasksNextCursor) {
      params.set('cursor', state.coverLookup.tasksNextCursor);
    }
    const response = await fetch(`/utilities/cover-lookup/tasks?${params.toString()}`, {
      headers: { Accept: 'application/json' },
    });
    const data = await response.json().catch(() => ({}));
    if (requestSequence !== coverLookupTasksRequestSequences[requestMode]) return;
    if (!response.ok || !data.ok) {
      throw new Error(data.error || 'Failed to load cover lookups');
    }
    updateCoverLookupNotificationCounts(data);
    const incomingTasks = Array.isArray(data.tasks) ? data.tasks : [];
    const incomingTaskIds = new Set(
      incomingTasks.map((task) => String(task?.id || '')).filter(Boolean),
    );
    const missingActiveTask = activeOnly
      && Array.from(previousActiveTaskIds).some((taskId) => !incomingTaskIds.has(taskId));
    const nextTasks = mergeCoverLookupTaskSummaries(incomingTasks, requestMode);
    const completesInitialHydration = !activeOnly && !state.coverLookup.tasksHydrated;
    if (!activeOnly) {
      state.coverLookup.tasksHydrated = true;
      state.coverLookup.tasksLoadFailed = false;
    }
    if (requestMode !== 'active') {
      state.coverLookup.tasksNextCursor = String(data.next_cursor || '') || null;
    }
    const snapshot = JSON.stringify(nextTasks.map((task) => ({
      id: task.id,
      status: task.status,
      progress: task.progress,
      progress_label: task.progress_label,
      message: task.message,
      result_kind: task.result_kind,
      artist: task.artist,
      album: task.album,
      year: task.year,
      notification_action_taken: Boolean(task.notification_action_taken),
      current_user_cover_preview_url: String(task.current_user_cover_preview_url || ''),
      possible_match_count: Number(task.possible_match_count || 0),
      candidate_updated_at: String(task.candidate_updated_at || ''),
      job_kind: String(task.job_kind || ''),
      selected_candidate_id: task.selected_candidate_id,
      possible_match_ids: buildCoverLookupCandidateSnapshot(task),
      updated_albums_count: Array.isArray(task.updated_albums) ? task.updated_albums.length : 0,
    })));
    const tasksChanged = snapshot !== state.coverLookup.tasksSnapshot;
    state.coverLookup.tasks = nextTasks;
    if (tasksChanged || completesInitialHydration) renderCoverLookupDrawer();
    nextTasks.forEach((task) => {
      applyCoverLookupTaskUpdates(task);
    });
    const modalTaskId = String(state.coverLookup.modal.taskId || '');
    if (modalTaskId && tasksChanged) {
      const task = nextTasks.find((item) => String(item?.id || '') === modalTaskId);
      if (task) {
        logCoverLookupTaskDebug('Task poll update.', task);
        applyCoverLookupTaskModalStatus(task);
        const taskStatus = String(task.status || '');
        const candidateSource = getCoverLookupCandidateSource(
          task,
          state.coverLookup.modal.candidateSnapshot,
        );
        applyCoverLookupCandidateSource(candidateSource);
      const partialCandidatesAdvanced = ['pending', 'running'].includes(taskStatus)
        && (
          Number(task.possible_match_count || 0) > (candidateSource?.candidates.length || 0)
          || coverLookupCandidateTimestamp(task.candidate_updated_at)
            > coverLookupCandidateTimestamp(state.coverLookup.modal.candidateSnapshot?.updated_at)
        );
      if (partialCandidatesAdvanced) {
        await refreshCoverLookupGallery(false);
      } else if (['completed', 'failed', 'canceled'].includes(taskStatus)) {
          if (options.refreshModalGallery !== false) {
            await refreshCoverLookupGallery(false);
          } else {
            renderCoverLookupModal();
          }
        } else if (Array.isArray(task.updated_albums) && task.updated_albums.length) {
          if (Number(task.progress || 0) >= 100) {
            await refreshCoverLookupGallery(false);
          } else {
            renderCoverLookupModal();
          }
        } else {
          renderCoverLookupModal();
        }
      }
    }
    state.coverLookup.tasksSnapshot = snapshot;
    stopCoverLookupPollingIfIdle();
    if (missingActiveTask) {
      await loadCoverLookupTasks({
        toast: false,
        mergeFirstPage: true,
        refreshModalGallery: options.refreshModalGallery,
      });
    }
  } catch (error) {
    if (requestSequence !== coverLookupTasksRequestSequences[requestMode]) return;
    if (!activeOnly) state.coverLookup.tasksLoadFailed = true;
    console.warn('[AlbumHaven][CoverLookup] Failed to load lookup tasks.', error);
    renderCoverLookupDrawer({ preserveInteraction: false });
    if (options.toast !== false) {
      showToast(error.message || 'Failed to load cover lookups.', 'error', 2800);
    }
  }
}

let coverLookupPollingRequest = null;
let coverLookupBackgroundPollTicks = 0;
let coverLookupPollInFlight = false;
let coverLookupHistoryRequest = null;

async function loadNextCoverLookupTaskPage(options = {}) {
  if (!state.coverLookup.tasksNextCursor) return;
  if (coverLookupHistoryRequest) return coverLookupHistoryRequest;
  const request = loadCoverLookupTasks({ ...options, append: true });
  coverLookupHistoryRequest = request;
  try {
    return await request;
  } finally {
    if (coverLookupHistoryRequest === request) coverLookupHistoryRequest = null;
  }
}

function handleCoverLookupDrawerScroll(event) {
  const body = event?.currentTarget || document.getElementById('cover-lookup-drawer-body');
  if (!body || !state.coverLookup.drawerOpen) return Promise.resolve();
  const tasks = Array.isArray(state.coverLookup.tasks) ? state.coverLookup.tasks : [];
  const nextWindow = getCoverLookupTaskRenderWindow(tasks, body);
  if (nextWindow.start !== Number(state.coverLookup.taskRenderWindowStart || 0)) {
    renderCoverLookupDrawer({ preserveInteraction: false });
  }
  const remaining = Number(body.scrollHeight || 0)
    - Number(body.scrollTop || 0)
    - Number(body.clientHeight || 0);
  const prefetchThreshold = Math.max(600, Number(body.clientHeight || 0) * 2);
  if (remaining > prefetchThreshold || !state.coverLookup.tasksNextCursor) return Promise.resolve();
  return loadNextCoverLookupTaskPage({ toast: false });
}

async function loadCoverLookupTasksForPolling(options = {}) {
  if (coverLookupPollingRequest) return coverLookupPollingRequest;
  const request = loadCoverLookupTasks({ ...options, activeOnly: true });
  coverLookupPollingRequest = request;
  try {
    return await request;
  } finally {
    if (coverLookupPollingRequest === request) {
      coverLookupPollingRequest = null;
    }
  }
}

function ensureCoverLookupPolling() {
  if (state.coverLookup.pollingTimer) return;
  state.coverLookup.pollingTimer = window.setInterval(async () => {
    if (coverLookupPollInFlight) return;
    const modalOpen = !document.getElementById('cover-lookup-modal')?.hidden;
    if (!modalOpen) {
      coverLookupBackgroundPollTicks += 1;
      if (coverLookupBackgroundPollTicks < 25) return;
      coverLookupBackgroundPollTicks = 0;
    } else {
      coverLookupBackgroundPollTicks = 0;
    }
    coverLookupPollInFlight = true;
    try {
      await loadCoverLookupTasksForPolling({ toast: false });
      const snapshot = state.coverLookup.modal.candidateSnapshot;
      const hasMatchingActiveTask = (state.coverLookup.tasks || []).some((task) => (
        String(task?.id || '') === String(state.coverLookup.modal.taskId || '')
        && ['pending', 'running'].includes(String(task?.status || ''))
      ));
      if (
        modalOpen
        && !hasMatchingActiveTask
        && ['pending', 'running'].includes(String(snapshot?.status || ''))
      ) {
        await refreshCoverLookupGallery(false);
      }
    } finally {
      coverLookupPollInFlight = false;
    }
  }, 100);
}

function stopCoverLookupPollingIfIdle() {
  const modalOpen = !document.getElementById('cover-lookup-modal')?.hidden;
  const activeTasks = (state.coverLookup.tasks || []).filter((task) => ['pending', 'running'].includes(String(task?.status || ''))).length;
  const shouldKeepPolling = Boolean(state.coverLookup.drawerOpen || modalOpen || activeTasks > 0);
  if (shouldKeepPolling) return;
  if (state.coverLookup.pollingTimer) {
    window.clearInterval(state.coverLookup.pollingTimer);
    state.coverLookup.pollingTimer = 0;
    coverLookupBackgroundPollTicks = 0;
  }
}

function collectManualCoverLookupUrls() {
  const input = document.getElementById('cover-lookup-pasted-urls');
  const rawText = String(input?.value || state.coverLookup.modal.manualUrlText || '').trim();
  state.coverLookup.modal.manualUrlText = rawText;
  return rawText.split(/\s+/).map((item) => item.trim()).filter(Boolean);
}

function applyCoverLookupTaskUpdates(task, options = {}) {
  const taskId = String(task?.id || '');
  const pendingRemoteSave = coverLookupPendingRemoteSaves.get(taskId);
  const taskStatus = String(task?.status || '');
  if (pendingRemoteSave && ['failed', 'canceled'].includes(taskStatus)) {
    coverLookupPendingRemoteSaves.delete(taskId);
    if (
      pendingRemoteSave.optimisticCover
      && state.coverLookup.optimisticAlbumCovers[pendingRemoteSave.signature] === pendingRemoteSave.optimisticCover
    ) {
      clearOptimisticAlbumCovers([pendingRemoteSave.previousAlbum]);
      markAlbumCoverPathsFresh([pendingRemoteSave.previousAlbum]);
      syncCoverLookupAlbumReferences([pendingRemoteSave.previousAlbum]);
      refreshCoverLookupAlbumArtwork(pendingRemoteSave.previousAlbum, [pendingRemoteSave.previousAlbum]);
    }
    if (taskStatus === 'failed') {
      showToast(task.message || task.progress_label || 'Failed save selected cover art.', 'error', 5000);
    }
    return;
  }
  if (pendingRemoteSave && taskStatus === 'completed') {
    coverLookupPendingRemoteSaves.delete(taskId);
  }
  if (!task || !Array.isArray(task.updated_albums) || !task.updated_albums.length) return;
  const signature = JSON.stringify({
    status: String(task.status || ''),
    progress: Number(task.progress || 0),
    updatedCount: task.updated_albums.length,
    finishedAt: String(task.finished_at || ''),
  });
  const previousSignature = state.coverLookup.appliedTaskUpdateSignatures[taskId] || '';
  if (!options.force && signature === previousSignature) return;
  state.coverLookup.appliedTaskUpdateSignatures[taskId] = signature;
  clearOptimisticAlbumCovers(task.updated_albums);
  markAlbumCoverPathsFresh(task.updated_albums);
  syncCoverLookupAlbumReferences(task.updated_albums);
  refreshCoverLookupAlbumArtwork(task.album_payload || state.coverLookup.modal.album || null, task.updated_albums);
}

let coverLookupGalleryRequest = 0;
let coverLookupModalSession = 0;
const coverLookupPendingLocalMutations = new Set();
const coverLookupPendingRemoteSaves = new Map();
const coverLookupSeenRequests = new WeakMap();

function isCoverLookupLocalMutationPending(album = state.coverLookup.modal.album) {
  return coverLookupPendingLocalMutations.size > 0
    && coverLookupPendingLocalMutations.has(buildTrackPathSignature(album));
}

async function finishCoverLookupLocalMutation(mutationKey, session) {
  coverLookupPendingLocalMutations.delete(mutationKey);
  if (buildTrackPathSignature(state.coverLookup.modal.album) !== mutationKey) return;
  state.coverLookup.modal.saving = false;
  syncCoverLookupSaveButton();
  const overlay = getCoverLookupModalElements().overlay;
  if (session !== coverLookupModalSession && overlay && !overlay.hidden) {
    await refreshCoverLookupGallery(false);
  }
}

async function refreshCoverLookupGallery(showLoading = true) {
  const album = state.coverLookup.modal.album;
  if (!album) return;
  const request = ++coverLookupGalleryRequest;
  const isCurrent = () => request === coverLookupGalleryRequest;
  state.coverLookup.modal.loading = Boolean(showLoading);
  renderCoverLookupModal();
  try {
    const response = await fetch('/utilities/cover-lookup/gallery', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ album, task_id: state.coverLookup.modal.taskId || '' }),
    });
    const data = await response.json().catch(() => ({}));
    if (!isCurrent()) return;
    if (!response.ok || !data.ok) {
      if (
        data.resolution_kind === 'album_split'
        && Array.isArray(data.current_releases)
        && data.current_releases.length > 1
      ) {
        state.coverLookup.modal.currentReleases = data.current_releases;
        state.coverLookup.modal.loading = false;
        renderCoverLookupModal();
        return;
      }
      throw new Error(data.error || 'Failed to load cover art gallery');
    }
    console.log('[AlbumHaven][CoverLookup] Gallery response.', data);
    state.coverLookup.modal.currentReleases = [];
    applyCoverLookupGalleryPayload(data);
    state.coverLookup.modal.loading = false;
    renderCoverLookupModal();
    void markCoverLookupAutomaticImprovementSeen(state.coverLookup.modal.candidateSnapshot);
  } catch (error) {
    if (!isCurrent()) return;
    state.coverLookup.modal.loading = false;
    console.error('[AlbumHaven][CoverLookup] Failed to load gallery.', error);
    renderCoverLookupModal();
    showToast(error.message || 'Failed to load cover art gallery.', 'error', 2800);
  }
}

async function chooseCoverLookupCurrentRelease(albumId) {
  const release = (state.coverLookup.modal.currentReleases || []).find((candidate) => (
    String(candidate?.album_id || '') === String(albumId || '')
  ));
  if (!release) return;
  const overlay = getCoverLookupModalElements().overlay;
  await openCoverLookupModal(release, {
    mobileSheet: Boolean(overlay && isCoverLookupMobileSheet(overlay)),
  });
}

async function openCoverLookupModal(album, options = {}) {
  if (window.AlbumHavenCapabilities && !window.AlbumHavenCapabilities.allows('library.covers.lookup')) return;
  coverLookupModalSession += 1;
  const els = getCoverLookupModalElements();
  if (!els.overlay || !album) return;
  const mobileSheet = Boolean(options.mobileSheet) && (
    typeof usesMobilePageLayout === 'function'
      ? usesMobilePageLayout()
      : Number(window.innerWidth || 0) > 0 && Number(window.innerWidth) <= 900
  );
  els.overlay.classList?.toggle?.('is-mobile-sheet', mobileSheet);
  if (!mobileSheet && typeof presentMobileCoverLookupPage === 'function') presentMobileCoverLookupPage(album);
  if (mobileSheet) bindCoverLookupMobileSheetSwipe(els.overlay);
  const requestedTaskId = String(options.taskId || '');
  const albumTrackSignature = buildTrackPathSignature(album);
  const matchingTask = (state.coverLookup.tasks || []).find((task) => (
    requestedTaskId
      ? String(task?.id || '') === requestedTaskId
      : albumTrackSignature
        && buildTrackPathSignature(task?.album_payload) === albumTrackSignature
  ));
  const cachedCandidates = sanitizeCoverLookupPossibleMatches(matchingTask?.possible_matches);
  const expectedRemoteCount = Math.max(
    Number(matchingTask?.possible_match_count || 0) || 0,
    cachedCandidates.length,
  );
  const hasCachedPreview = cachedCandidates.some((candidate) => (
    String(candidate?.thumbnail_url || candidate?.url || '').trim()
  ));
  state.coverLookup.modal.album = album;
  state.coverLookup.modal.taskId = String(requestedTaskId || matchingTask?.id || '');
  state.coverLookup.modal.remoteCover = null;
  state.coverLookup.modal.localCovers = [];
  revokeCoverLookupPastedImageUrls();
  state.coverLookup.modal.pastedImages = [];
  state.coverLookup.modal.manualImageAttachments = [];
  state.coverLookup.modal.otherArt = [];
  state.coverLookup.modal.pendingLocalPath = '';
  state.coverLookup.modal.pendingPastedImageId = '';
  state.coverLookup.modal.selectedRemoteId = '';
  state.coverLookup.modal.possibleMatches = cachedCandidates;
  state.coverLookup.modal.currentReleases = [];
  state.coverLookup.modal.candidateSnapshot = null;
  state.coverLookup.modal.candidateGeneration = cachedCandidates.length
    ? String(matchingTask?.id || '')
    : '';
  state.coverLookup.modal.expectedRemoteCount = expectedRemoteCount;
  state.coverLookup.modal.activeLocalSelectionPath = '';
  state.coverLookup.modal.remoteSelectionOverrideGeneration = '';
  state.coverLookup.modal.remoteSelectionOverrideCandidateId = '';
  state.coverLookup.modal.remoteSelectionOverrideUrl = '';
  state.coverLookup.modal.seenCandidateImprovementToken = '';
  state.coverLookup.modal.statusText = '';
  state.coverLookup.modal.statusTone = 'neutral';
  state.coverLookup.modal.failureNotice = '';
  state.coverLookup.modal.manualUrlText = '';
  state.coverLookup.modal.manualBusy = false;
  state.coverLookup.modal.loading = !hasCachedPreview;
  state.coverLookup.modal.saving = false;
  els.overlay.hidden = false;
  document.body.classList.add('modal-open');
  if (els.saveRemote instanceof HTMLButtonElement) {
    els.saveRemote.hidden = false;
    els.saveRemote.disabled = true;
  }
  renderCoverLookupModal();
  await refreshCoverLookupGallery(!hasCachedPreview);
  if (!els.overlay.hidden) ensureCoverLookupPolling();
}

function closeCoverLookupModal() {
  coverLookupGalleryRequest += 1;
  coverLookupModalSession += 1;
  const els = getCoverLookupModalElements();
  if (!els.overlay) return;
  const mobileSheet = isCoverLookupMobileSheet(els.overlay);
  if (!mobileSheet && typeof dismissMobilePage === 'function' && dismissMobilePage('cover-lookup')) return;
  els.overlay.hidden = true;
  els.overlay.classList?.remove?.('is-mobile-sheet');
  els.overlay.style?.removeProperty?.('--cover-lookup-sheet-drag-y');
  state.coverLookup.modal.pendingLocalPath = '';
  state.coverLookup.modal.pendingPastedImageId = '';
  state.coverLookup.modal.selectedRemoteId = '';
  state.coverLookup.modal.remoteCover = null;
  state.coverLookup.modal.activeLocalSelectionPath = '';
  revokeCoverLookupPastedImageUrls();
  state.coverLookup.modal.pastedImages = [];
  state.coverLookup.modal.manualImageAttachments = [];
  state.coverLookup.modal.manualBusy = false;
  state.coverLookup.modal.saving = false;
  state.coverLookup.modal.album = null;
  state.coverLookup.modal.taskId = '';
  state.coverLookup.modal.localCovers = [];
  state.coverLookup.modal.otherArt = [];
  state.coverLookup.modal.possibleMatches = [];
  state.coverLookup.modal.currentReleases = [];
  state.coverLookup.modal.candidateSnapshot = null;
  state.coverLookup.modal.candidateGeneration = '';
  state.coverLookup.modal.expectedRemoteCount = 0;
  state.coverLookup.modal.statusText = '';
  state.coverLookup.modal.statusTone = 'neutral';
  state.coverLookup.modal.failureNotice = '';
  state.coverLookup.modal.manualUrlText = '';
  if (els.body) els.body.innerHTML = '';
  if (els.saveRemote instanceof HTMLButtonElement) {
    els.saveRemote.hidden = false;
    els.saveRemote.disabled = true;
  }
  const trackModalOpen = !document.getElementById('track-modal')?.hidden;
  const utilityModalOpen = !document.getElementById('utility-modal')?.hidden;
  if (!trackModalOpen && !utilityModalOpen) {
    document.body.classList.remove('modal-open');
  }
  stopCoverLookupPollingIfIdle();
}

function openCoverLookupDeleteConfirm(path) {
  const els = getCoverLookupDeleteConfirmElements();
  if (!els.overlay || !path || isCoverLookupLocalMutationPending()) return;
  state.coverLookup.modal.pendingDeletePath = String(path || '');
  if (els.text) {
    els.text.textContent = 'Are you sure you want to delete this local cover art?';
  }
  els.overlay.style.zIndex = '4700';
  els.overlay.hidden = false;
  document.body.classList.add('modal-open');
}

function closeCoverLookupDeleteConfirm() {
  const els = getCoverLookupDeleteConfirmElements();
  if (!els.overlay) return;
  els.overlay.hidden = true;
  state.coverLookup.modal.pendingDeletePath = '';
  const trackModalOpen = !document.getElementById('track-modal')?.hidden;
  const utilityModalOpen = !document.getElementById('utility-modal')?.hidden;
  const coverLookupOpen = !document.getElementById('cover-lookup-modal')?.hidden;
  if (!trackModalOpen && !utilityModalOpen && !coverLookupOpen) {
    document.body.classList.remove('modal-open');
  }
}

async function startCoverLookupForAlbum(album, options = {}) {
  if (!album) return;
  const backgroundOnly = Boolean(options?.backgroundOnly);
  const triggerButton = backgroundOnly ? options?.triggerButton : null;
  const triggerWasDisabled = Boolean(triggerButton?.disabled);
  if (!backgroundOnly) {
    const selectedLocalCard = document.getElementById('cover-lookup-modal-body')
      ?.querySelector?.('[data-select-local-cover][data-cover-lookup-local-active]');
    const selectedLocalPath = String(
      selectedLocalCard?.getAttribute?.('data-select-local-cover') || '',
    );
    if (
      selectedLocalPath
      && !String(state.coverLookup.modal.selectedRemoteId || '')
      && !String(state.coverLookup.modal.pendingPastedImageId || '')
    ) {
      state.coverLookup.modal.activeLocalSelectionPath = selectedLocalPath;
    }
  }
  try {
    if (triggerButton) {
      triggerButton.disabled = true;
      triggerButton.setAttribute?.('aria-busy', 'true');
    }
    if (!backgroundOnly) {
      state.coverLookup.modal.manualBusy = true;
      state.coverLookup.modal.statusText = 'Starting cover search…';
      state.coverLookup.modal.statusTone = 'neutral';
      renderCoverLookupModal();
      showToast('Starting cover search…', 'info', 2200, { placement: 'top-center' });
    }
    const manualUrls = !backgroundOnly ? collectManualCoverLookupUrls() : [];
    const response = await fetch('/utilities/cover-lookup/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        album,
        task_id: String(options?.taskId || state.coverLookup.modal.taskId || ''),
        manual_urls: manualUrls,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      throw new Error(data.error || 'Failed to start cover lookup');
    }
    console.log('[AlbumHaven][CoverLookup] Start lookup response.', data);
    const acceptedTask = data.task && typeof data.task === 'object' ? data.task : null;
    if (acceptedTask?.id) {
      const acceptedTaskId = String(acceptedTask.id);
      state.coverLookup.tasks = mergeCoverLookupTasksWithNotifications([
        ...(state.coverLookup.tasks || []).filter((task) => String(task?.id || '') !== acceptedTaskId),
        acceptedTask,
      ]);
      if (!backgroundOnly) {
        state.coverLookup.modal.taskId = acceptedTaskId;
      }
      renderCoverLookupDrawer();
    }
    if (!backgroundOnly) {
      state.coverLookup.modal.statusText = String(acceptedTask?.progress_label || 'Searching...');
      state.coverLookup.modal.statusTone = 'neutral';
      state.coverLookup.modal.manualBusy = false;
      renderCoverLookupModal();
    }
    showToast(
      'Cover art lookup started.',
      'success',
      5000,
      { placement: 'top-center' },
    );
    if (backgroundOnly) {
      await loadCoverLookupTasks({ toast: false, mergeFirstPage: true });
    }
  } catch (error) {
    console.error('[AlbumHaven][CoverLookup] Failed to start lookup.', error);
    showToast(error.message || 'Failed to start cover art lookup.', 'error', 2800);
  } finally {
    if (triggerButton) {
      triggerButton.disabled = triggerWasDisabled;
      triggerButton.removeAttribute?.('aria-busy');
    }
    if (!backgroundOnly) {
      state.coverLookup.modal.manualBusy = false;
      renderCoverLookupModal();
    }
  }
}

function selectLocalCoverFromLookup(sourcePath) {
  if (window.AlbumHavenCapabilities?.clientSurface === 'tv') return;
  state.coverLookup.modal.pendingLocalPath = String(sourcePath || '');
  state.coverLookup.modal.pendingPastedImageId = '';
  state.coverLookup.modal.selectedRemoteId = '';
  state.coverLookup.modal.remoteSelectionOverrideGeneration = '';
  state.coverLookup.modal.remoteSelectionOverrideCandidateId = '';
  state.coverLookup.modal.remoteSelectionOverrideUrl = '';
  syncCoverLookupSelectionUi();
}

async function saveLocalCoverFromLookup(sourcePath) {
  const session = coverLookupModalSession;
  const ownsModal = () => coverLookupModalSession === session;
  const album = state.coverLookup.modal.album;
  const taskId = String(state.coverLookup.modal.taskId || '');
  if (!album || !sourcePath || state.coverLookup.modal.saving || isCoverLookupLocalMutationPending(album)) return;
  const mutationKey = buildTrackPathSignature(album);
  const previousAlbum = deepCloneJson(album);
  const optimisticAlbum = buildOptimisticCoverUpdatedAlbum(album, sourcePath);
  coverLookupPendingLocalMutations.add(mutationKey);
  coverLookupGalleryRequest += 1;
  try {
    state.coverLookup.modal.saving = true;
    syncCoverLookupSaveButton();
    applyOptimisticLocalCoverSelection(album, sourcePath);
    markTrackModalCoverTransitionPending(album);
    if (optimisticAlbum) {
      markAlbumCoverPathsFresh([optimisticAlbum]);
      syncCoverLookupAlbumReferences([optimisticAlbum]);
      refreshCoverLookupAlbumArtwork(album, [optimisticAlbum], { updateTrackModal: false });
    }
    const response = await fetch('/utilities/cover-lookup/local-select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ album, source_path: sourcePath, task_id: taskId }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      throw new Error(data.error || 'Failed to select local cover art');
    }
    const updatedAlbums = Array.isArray(data.updated_albums) && data.updated_albums.length
      ? data.updated_albums
      : [data.updated_album].filter(Boolean);
    if (buildTrackPathSignature(state.coverLookup.modal.album) === mutationKey) coverLookupGalleryRequest += 1;
    markAlbumCoverPathsFresh(updatedAlbums);
    const preloadResult = updatedAlbums[0]
      ? await preloadCoverLookupAlbumImageWithTimeout(updatedAlbums[0])
      : false;
    if (preloadResult !== null) clearOptimisticAlbumCovers(updatedAlbums);
    syncCoverLookupAlbumReferences(updatedAlbums);
    refreshCoverLookupAlbumArtwork(album, updatedAlbums);
    if (taskId) {
      markCoverLookupTaskActionTaken(taskId, updatedAlbums[0] || album);
      renderCoverLookupDrawer();
    }
    if (ownsModal()) closeCoverLookupModal();
  } catch (error) {
    if (buildTrackPathSignature(state.coverLookup.modal.album) === mutationKey) coverLookupGalleryRequest += 1;
    if (previousAlbum) {
      clearOptimisticAlbumCovers([previousAlbum]);
      markAlbumCoverPathsFresh([previousAlbum]);
      syncCoverLookupAlbumReferences([previousAlbum]);
      refreshCoverLookupAlbumArtwork(previousAlbum, [previousAlbum]);
    }
    console.error('[AlbumHaven][CoverLookup] Failed to select local cover.', error);
    showToast(error.message || 'Failed to select local cover art.', 'error', 2800);
  } finally {
    await finishCoverLookupLocalMutation(mutationKey, session);
  }
}

async function deleteLocalCoverFromLookup(sourcePath) {
  const session = coverLookupModalSession;
  const ownsModal = () => coverLookupModalSession === session;
  const album = state.coverLookup.modal.album;
  if (!album || !sourcePath || isCoverLookupLocalMutationPending(album)) return;
  const mutationKey = buildTrackPathSignature(album);
  const previousLocalCovers = Array.isArray(state.coverLookup.modal.localCovers)
    ? state.coverLookup.modal.localCovers.slice()
    : [];
  const previousAlbum = deepCloneJson(album);
  const remainingLocalCovers = previousLocalCovers.filter((item) => String(item?.path || '') !== String(sourcePath || ''));
  const fallbackLocalCoverPath = String(remainingLocalCovers[0]?.path || '').trim();
  const optimisticAlbum = buildOptimisticCoverDeleteUpdatedAlbum(album, sourcePath, fallbackLocalCoverPath);
  coverLookupPendingLocalMutations.add(mutationKey);
  coverLookupGalleryRequest += 1;
  try {
    closeCoverLookupDeleteConfirm();
    state.coverLookup.modal.localCovers = remainingLocalCovers;
    if (String(state.coverLookup.modal.pendingLocalPath || '') === String(sourcePath || '')) {
      state.coverLookup.modal.pendingLocalPath = '';
    }
    if (String(state.coverLookup.modal.activeLocalSelectionPath || '') === String(sourcePath || '')) {
      state.coverLookup.modal.activeLocalSelectionPath = '';
    }
    state.coverLookup.modal.pendingPastedImageId = '';
    state.coverLookup.modal.selectedRemoteId = '';
    if (optimisticAlbum) {
      markAlbumCoverPathsFresh([optimisticAlbum]);
      syncCoverLookupAlbumReferences([optimisticAlbum]);
      refreshCoverLookupAlbumArtwork(album, [optimisticAlbum]);
    }
    renderCoverLookupModal();
    const response = await fetch('/utilities/cover-lookup/local-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ album, source_path: sourcePath }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      throw new Error(data.error || 'Failed to delete local cover art');
    }
    const updatedAlbums = Array.isArray(data.updated_albums) ? data.updated_albums : [data.updated_album].filter(Boolean);
    if (buildTrackPathSignature(state.coverLookup.modal.album) === mutationKey) coverLookupGalleryRequest += 1;
    markAlbumCoverPathsFresh(updatedAlbums);
    syncCoverLookupAlbumReferences(updatedAlbums);
    refreshCoverLookupAlbumArtwork(album, updatedAlbums);
    if (ownsModal()) {
      if (data.gallery && typeof data.gallery === 'object') {
        applyCoverLookupGalleryPayload(data.gallery);
        renderCoverLookupModal();
      } else {
        await refreshCoverLookupGallery(false);
      }
    }
  } catch (error) {
    if (buildTrackPathSignature(state.coverLookup.modal.album) === mutationKey) coverLookupGalleryRequest += 1;
    if (ownsModal()) state.coverLookup.modal.localCovers = previousLocalCovers;
    if (previousAlbum) {
      markAlbumCoverPathsFresh([previousAlbum]);
      syncCoverLookupAlbumReferences([previousAlbum]);
      refreshCoverLookupAlbumArtwork(previousAlbum, [previousAlbum]);
    }
    if (ownsModal()) renderCoverLookupModal();
    console.error('[AlbumHaven][CoverLookup] Failed to delete local cover.', error);
    showToast(error.message || 'Failed to delete local cover art.', 'error', 2800);
  } finally {
    await finishCoverLookupLocalMutation(mutationKey, session);
  }
}

function selectRemoteCoverFromLookup(candidateId) {
  const selectedCandidate = (state.coverLookup.modal.possibleMatches || []).find((candidate) => (
    String(candidate?.id || '') === String(candidateId || '')
  ));
  if (!isSelectableRemoteCoverCandidate(selectedCandidate)) return;
  if (window.AlbumHavenCapabilities && !window.AlbumHavenCapabilities.allowsCoverCandidate(selectedCandidate)) return;
  state.coverLookup.modal.pendingLocalPath = '';
  state.coverLookup.modal.pendingPastedImageId = '';
  state.coverLookup.modal.selectedRemoteId = String(candidateId || '');
  state.coverLookup.modal.activeLocalSelectionPath = '';
  const selectionAlbumSignature = buildTrackPathSignature(state.coverLookup.modal.album);
  const selectedCandidateUrl = normalizeCoverLookupCandidateUrl(
    selectedCandidate?.url,
  ).toLowerCase();
  const selectionOwnerTaskId = String((state.coverLookup.tasks || []).find((task) => (
    buildTrackPathSignature(task?.album_payload) === selectionAlbumSignature
    && Array.isArray(task?.possible_matches)
    && task.possible_matches.some((candidate) => (
      selectedCandidateUrl
        ? normalizeCoverLookupCandidateUrl(candidate?.url).toLowerCase() === selectedCandidateUrl
        : String(candidate?.id || '') === String(candidateId || '')
    ))
  ))?.id || '').trim();
  state.coverLookup.modal.remoteSelectionOverrideGeneration = String(
    selectionOwnerTaskId
    || state.coverLookup.modal.candidateGeneration
    || state.coverLookup.modal.candidateSnapshot?.search_generation
    || state.coverLookup.modal.taskId
    || '',
  );
  state.coverLookup.modal.remoteSelectionOverrideCandidateId = String(candidateId || '');
  state.coverLookup.modal.remoteSelectionOverrideUrl = normalizeCoverLookupCandidateUrl(
    selectedCandidate?.url,
  );
  syncCoverLookupSelectionUi();
}

function selectPastedCoverFromLookup(imageId) {
  state.coverLookup.modal.pendingLocalPath = '';
  state.coverLookup.modal.selectedRemoteId = '';
  state.coverLookup.modal.pendingPastedImageId = String(imageId || '');
  state.coverLookup.modal.activeLocalSelectionPath = '';
  state.coverLookup.modal.remoteSelectionOverrideGeneration = '';
  state.coverLookup.modal.remoteSelectionOverrideCandidateId = '';
  state.coverLookup.modal.remoteSelectionOverrideUrl = '';
  syncCoverLookupSelectionUi();
}

async function saveRemoteCoverFromLookup() {
  const session = coverLookupModalSession;
  const ownsModal = () => coverLookupModalSession === session;
  const album = state.coverLookup.modal.album;
  const candidateId = state.coverLookup.modal.selectedRemoteId;
  const selectionOwnerGeneration = String(
    state.coverLookup.modal.remoteSelectionOverrideGeneration || '',
  ).trim();
  const taskId = selectionOwnerGeneration || state.coverLookup.modal.taskId;
  const snapshotGeneration = selectionOwnerGeneration || String(
    state.coverLookup.modal.candidateSnapshot?.search_generation || '',
  ).trim();
  if (!album || (!taskId && !snapshotGeneration) || !candidateId || state.coverLookup.modal.saving) return;
  const previousAlbum = deepCloneJson(album);
  const selectedMatch = (state.coverLookup.modal.possibleMatches || []).find((item) => String(item?.id || '') === String(candidateId || ''));
  if (!isSelectableRemoteCoverCandidate(selectedMatch)) return;
  if (window.AlbumHavenCapabilities && !window.AlbumHavenCapabilities.allowsCoverCandidate(selectedMatch)) return;
  state.coverLookup.modal.saving = true;
  syncCoverLookupSaveButton();
  try {
    const requestPayload = { album, task_id: taskId, candidate_id: candidateId };
    if (snapshotGeneration) requestPayload.snapshot_generation = snapshotGeneration;
    const response = await fetch('/utilities/cover-lookup/save-remote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestPayload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      throw new Error(data.error || 'Failed to save selected cover art');
    }
    const optimisticCoverPath = String(data.optimistic_cover_path || '').trim();
    const previousOptimisticCovers = { ...(state.coverLookup.optimisticAlbumCovers || {}) };
    if (selectedMatch) {
      applyOptimisticRemoteCoverSelection(album, selectedMatch, optimisticCoverPath);
    }
    const acceptedTaskId = String(data.task?.id || taskId || '').trim();
    if (acceptedTaskId && selectedMatch) {
      const optimisticEntry = Object.entries(state.coverLookup.optimisticAlbumCovers || {})
        .find(([signature, cover]) => previousOptimisticCovers[signature] !== cover);
      coverLookupPendingRemoteSaves.set(acceptedTaskId, {
        previousAlbum,
        signature: optimisticEntry?.[0] || '',
        optimisticCover: optimisticEntry?.[1],
      });
    }
    if (ownsModal()) {
      state.coverLookup.modal.saving = false;
      state.coverLookup.modal.manualBusy = false;
      state.coverLookup.modal.pendingLocalPath = '';
      state.coverLookup.modal.selectedRemoteId = '';
      closeCoverLookupModal();
    }
    await loadCoverLookupTasks({ toast: false });
    ensureCoverLookupPolling();
    renderCoverLookupDrawer();
  } catch (error) {
    if (ownsModal()) {
      state.coverLookup.modal.saving = false;
      syncCoverLookupSaveButton();
    }
    console.error('[AlbumHaven][CoverLookup] Failed to save remote cover.', error);
    showToast(error.message || 'Failed to save selected cover art.', 'error', 2800);
  }
}

async function addRemoteCoverLinksFromLookup() {
  const album = state.coverLookup.modal.album;
  const input = document.getElementById('cover-lookup-pasted-urls');
  const urls = collectManualCoverLookupUrls();
  const attachmentCount = Array.isArray(state.coverLookup.modal.manualImageAttachments)
    ? state.coverLookup.modal.manualImageAttachments.length : 0;
  if (!album || (!urls.length && !attachmentCount)) return;
  extractCoverLookupPendingAttachments();
  if (!urls.length) {
    state.coverLookup.modal.statusText = '';
    state.coverLookup.modal.statusTone = 'neutral';
    renderCoverLookupModal();
    return;
  }
  try {
    state.coverLookup.modal.manualBusy = true;
    renderCoverLookupModal();
    const response = await fetch('/utilities/cover-lookup/add-remote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ album, task_id: state.coverLookup.modal.taskId || '', urls }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      throw new Error(data.error || 'Failed to add remote cover links');
    }
    if (input) {
      input.value = '';
    }
    state.coverLookup.modal.manualUrlText = '';
    if (data.task?.id) {
      state.coverLookup.modal.taskId = String(data.task.id);
    }
    if (data.gallery && typeof data.gallery === 'object') {
      state.coverLookup.modal.remoteCover = data.gallery.remote_cover && typeof data.gallery.remote_cover === 'object' ? data.gallery.remote_cover : null;
      state.coverLookup.modal.localCovers = Array.isArray(data.gallery.local_covers) ? data.gallery.local_covers : [];
      state.coverLookup.modal.otherArt = Array.isArray(data.gallery.other_art) ? data.gallery.other_art : [];
    }
    if (data.task && typeof data.task === 'object') {
      state.coverLookup.modal.possibleMatches = Array.isArray(data.task.possible_matches) ? data.task.possible_matches : [];
      applyCoverLookupTaskModalStatus(data.task);
    }
    await loadCoverLookupTasks({ toast: false });
    renderCoverLookupModal();
    showToast(
      extractedImageCount
        ? `Extracted ${extractedImageCount} image${extractedImageCount === 1 ? '' : 's'} and added remote links.`
        : 'Remote cover links added.',
      'success',
      2200,
    );
  } catch (error) {
    state.coverLookup.modal.statusText = String(error?.message || 'Nothing was found in the pasted links.');
    state.coverLookup.modal.statusTone = 'error';
    console.error('[AlbumHaven][CoverLookup] Failed to add remote links.', error);
    showToast(error.message || 'Failed to add remote cover links.', 'error', 3000);
  } finally {
    state.coverLookup.modal.manualBusy = false;
    renderCoverLookupModal();
  }
}

async function savePastedCoverFromLookup(imageId) {
  const album = state.coverLookup.modal.album;
  const taskId = String(state.coverLookup.modal.taskId || '');
  const pastedItem = (state.coverLookup.modal.pastedImages || []).find((item) => String(item?.id || '') === String(imageId || ''));
  if (!album || !pastedItem?.data_url) return;
  const previousAlbum = deepCloneJson(album);
  const previousTask = taskId
    ? deepCloneJson((state.coverLookup.tasks || []).find((task) => String(task?.id || '') === taskId) || null)
    : null;
  try {
    const optimisticAlbum = applyOptimisticPastedCoverSelection(album, pastedItem);
    if (taskId && optimisticAlbum) {
      markCoverLookupTaskActionTaken(taskId, optimisticAlbum, { persist: false });
      renderCoverLookupDrawer();
    }
    state.coverLookup.modal.manualBusy = false;
    state.coverLookup.modal.pendingLocalPath = '';
    state.coverLookup.modal.selectedRemoteId = '';
    state.coverLookup.modal.pendingPastedImageId = '';
    closeCoverLookupModal();
    const response = await fetch('/utilities/cover-lookup/pasted-image-save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        album,
        image_id: String(pastedItem.id || ''),
        data_url: String(pastedItem.data_url || ''),
        mime_type: String(pastedItem.mime_type || ''),
        filename: String(pastedItem.filename || 'pasted-image'),
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      throw new Error(data.error || 'Failed to save pasted image.');
    }
    const updatedAlbums = Array.isArray(data.updated_albums) ? data.updated_albums : [data.updated_album].filter(Boolean);
    clearOptimisticAlbumCovers(updatedAlbums);
    markAlbumCoverPathsFresh(updatedAlbums);
    syncCoverLookupAlbumReferences(updatedAlbums);
    refreshCoverLookupAlbumArtwork(album, updatedAlbums);
    if (taskId) {
      markCoverLookupTaskActionTaken(taskId, updatedAlbums[0] || album);
      renderCoverLookupDrawer();
    }
  } catch (error) {
    if (previousAlbum) {
      markAlbumCoverPathsFresh([previousAlbum]);
      syncCoverLookupAlbumReferences([previousAlbum]);
      refreshCoverLookupAlbumArtwork(previousAlbum, [previousAlbum]);
    }
    if (previousTask) {
      state.coverLookup.tasks = (state.coverLookup.tasks || []).map((task) => (
        String(task?.id || '') === taskId ? previousTask : task
      ));
      renderCoverLookupDrawer();
    }
    console.error('[AlbumHaven][CoverLookup] Failed to save pasted image.', error);
    showToast(error.message || 'Failed to save pasted image.', 'error', 2800);
  }
}

async function saveCoverFromLookup() {
  if (isCoverLookupLocalMutationPending()) return;
  if (String(state.coverLookup.modal.selectedRemoteId || '')) {
    await saveRemoteCoverFromLookup();
    return;
  }
  if (String(state.coverLookup.modal.pendingPastedImageId || '')) {
    await savePastedCoverFromLookup(state.coverLookup.modal.pendingPastedImageId);
    return;
  }
  if (hasPendingLocalCoverSelection()) {
    await saveLocalCoverFromLookup(state.coverLookup.modal.pendingLocalPath);
  }
}
