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

function revokeCoverLookupPastedImageUrls() {
  const items = Array.isArray(state.coverLookup.modal.pastedImages) ? state.coverLookup.modal.pastedImages : [];
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
  if (!(file instanceof Blob) || !String(file.type || '').startsWith('image/')) {
    return false;
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
  state.coverLookup.modal.pastedImages = [
    nextItem,
    ...(Array.isArray(state.coverLookup.modal.pastedImages) ? state.coverLookup.modal.pastedImages : []),
  ];
  state.coverLookup.modal.pendingLocalPath = '';
  state.coverLookup.modal.selectedRemoteId = '';
  state.coverLookup.modal.pendingPastedImageId = nextItem.id;
  state.coverLookup.modal.statusText = 'Clipboard image added.';
  state.coverLookup.modal.statusTone = 'neutral';
  renderCoverLookupModal();
  syncCoverLookupSelectionUi();
  return true;
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
  const generation = String(candidateSource.generation || '').trim();
  if (generation !== String(modal.candidateGeneration || '').trim()) {
    modal.candidateGeneration = generation;
    modal.remoteSelectionOverrideGeneration = '';
    modal.remoteSelectionOverrideCandidateId = '';
    modal.remoteSelectionOverrideUrl = '';
  }
  const possibleMatches = sanitizeCoverLookupPossibleMatches(candidateSource.candidates);
  modal.possibleMatches = possibleMatches;
  const hasPendingNonRemoteSelection = Boolean(
    String(modal.pendingLocalPath || '')
    || String(modal.pendingPastedImageId || '')
    || (modal.localCovers || []).some((cover) => Boolean(cover?.is_active))
    || String(modal.activeLocalSelectionPath || '')
    || String(getCoverLookupActiveLocalPath() || '')
  );
  const userOverrodeThisGeneration = Boolean(
    generation
    && String(modal.remoteSelectionOverrideGeneration || '') === generation
  );
  const bestCandidateId = String(candidateSource.bestCandidateId || '').trim();
  const bestCandidateIsSelectable = bestCandidateId && possibleMatches.some((candidate) => (
    String(candidate?.id || '') === bestCandidateId
    && String(candidate?.art_kind || 'cover') === 'cover'
    && !Boolean(candidate?.display_only)
  ));
  if (userOverrodeThisGeneration) {
    const overrideCandidateId = String(
      modal.remoteSelectionOverrideCandidateId || modal.selectedRemoteId || '',
    );
    const overrideUrl = normalizeCoverLookupCandidateUrl(
      modal.remoteSelectionOverrideUrl || '',
    ).toLowerCase();
    const selectedOverride = possibleMatches.find((candidate) => (
      String(candidate?.id || '') === overrideCandidateId
      || (
        overrideUrl
        && normalizeCoverLookupCandidateUrl(candidate?.url).toLowerCase() === overrideUrl
      )
    ));
    modal.selectedRemoteId = String(selectedOverride?.id || '');
    return;
  }
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
  const incomingActiveLocalCover = !gallery.remote_cover
    ? incomingLocalCovers.find((cover) => Boolean(cover?.is_active) && cover?.path)
    : null;
  if (incomingActiveLocalCover) {
    state.coverLookup.modal.activeLocalSelectionPath = String(incomingActiveLocalCover.path);
  }
  state.coverLookup.modal.remoteCover = gallery.remote_cover && typeof gallery.remote_cover === 'object' ? gallery.remote_cover : null;
  state.coverLookup.modal.localCovers = incomingLocalCovers;
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
    ) {
      state.coverLookup.modal.selectedRemoteId = '';
      state.coverLookup.modal.remoteSelectionOverrideGeneration = '';
      state.coverLookup.modal.remoteSelectionOverrideCandidateId = '';
      state.coverLookup.modal.remoteSelectionOverrideUrl = '';
    }
  }
  const activeCandidateGeneration = String(
    state.coverLookup.modal.candidateGeneration || '',
  ).trim();
  const userOverrodeActiveGeneration = Boolean(
    activeCandidateGeneration
    && String(state.coverLookup.modal.remoteSelectionOverrideGeneration || '')
      === activeCandidateGeneration
  );
  if (state.coverLookup.modal.remoteCover && !userOverrodeActiveGeneration) {
    state.coverLookup.modal.selectedRemoteId = '';
  }
  if (task) {
    state.coverLookup.modal.statusText = String(task.message || task.progress_label || '');
    state.coverLookup.modal.statusTone = getCoverLookupStatusTone(task);
    logCoverLookupTaskDebug('Gallery payload task update.', task);
  } else if (candidateSnapshot) {
    state.coverLookup.modal.statusText = String(candidateSnapshot.diagnostic || '');
    state.coverLookup.modal.statusTone = candidateSnapshot.status === 'failed' ? 'error' : 'neutral';
  }
}

async function markCoverLookupAutomaticImprovementSeen(candidateSnapshot) {
  const snapshot = normalizeCoverLookupCandidateSnapshot(candidateSnapshot);
  const album = state.coverLookup.modal.album;
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
    state.coverLookup.modal.candidateSnapshot = markedSnapshot;
    album.cover_candidate_snapshot = markedSnapshot;
    if (typeof document !== 'undefined' && typeof document.querySelector === 'function') {
      const lookupButton = document.querySelector('[data-open-track-modal-cover-lookup]');
      if (lookupButton) {
        lookupButton.classList?.remove('has-unseen-automatic-improvement');
        lookupButton.setAttribute?.('aria-label', 'Open cover art look up gallery');
      }
    }
  } catch (error) {
    state.coverLookup.modal.seenCandidateImprovementToken = '';
    console.warn('[AlbumHaven][CoverLookup] Failed to mark automatic candidate update as seen.', error);
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
  return `
    <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
      <path d="M4 14h2.2v6H4zm3.4-3h2.2v9H7.4zm3.4-2h2.2v11h-2.2zm3.4-3h2.2v14h-2.2zm3.4 5H20v9h-2.2z" fill="currentColor"></path>
    </svg>
  `;
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
    submitButton.disabled = searchControlsDisabled || !String(state.coverLookup.modal.manualUrlText || '').trim();
  }
  if (findBetterButton instanceof HTMLButtonElement) {
    findBetterButton.disabled = searchControlsDisabled;
  }
}

function syncCoverLookupSaveButton() {
  const saveButton = document.getElementById('cover-lookup-save-remote-button');
  if (!saveButton) return;
  const selectedRemoteId = String(state.coverLookup.modal.selectedRemoteId || '');
  const pendingPastedImageId = String(state.coverLookup.modal.pendingPastedImageId || '');
  const currentTask = (state.coverLookup.tasks || []).find((item) => String(item?.id || '') === String(state.coverLookup.modal.taskId || '')) || null;
  const savedRemoteCandidateId = String(currentTask?.selected_candidate_id || '');
  const hasRemoteSelection = Boolean(selectedRemoteId) && selectedRemoteId !== savedRemoteCandidateId;
  const hasLocalSelection = hasPendingLocalCoverSelection();
  const hasPastedSelection = Boolean(pendingPastedImageId);
  saveButton.hidden = false;
  saveButton.disabled = !(hasRemoteSelection || hasLocalSelection || hasPastedSelection);
}

function isCompletedCoverLookupTask(task) {
  return ['completed', 'failed', 'canceled'].includes(String(task?.status || ''));
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
    const isActive = !selectedRemoteId && !pendingLocalPath && !pendingPastedImageId;
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

function syncCoverLookupAlbumReferences(updatedAlbums) {
  const candidates = Array.isArray(updatedAlbums) ? updatedAlbums.filter(Boolean) : [];
  if (!candidates.length) return;
  const modalAlbum = state.coverLookup.modal.album;
  if (modalAlbum) {
    const currentSignature = buildTrackPathSignature(modalAlbum);
    const replacement = candidates.find((album) => buildTrackPathSignature(album) === currentSignature);
    if (replacement) {
      state.coverLookup.modal.album = replacement;
    }
  }
  state.coverLookup.tasks = (state.coverLookup.tasks || []).map((task) => {
    const taskAlbum = task && typeof task === 'object' ? task.album_payload : null;
    if (!taskAlbum) return task;
    const signature = buildTrackPathSignature(taskAlbum);
    const replacement = candidates.find((album) => buildTrackPathSignature(album) === signature);
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

function sanitizeCoverLookupPossibleMatches(value) {
  if (!Array.isArray(value)) return [];
  const seenIds = new Set();
  const seenUrls = new Set();
  return value
    .filter((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
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
    .some((task) => ['pending', 'running'].includes(String(task?.status || '')));
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

function renderCoverLookupDrawer() {
  const drawer = document.getElementById('cover-lookup-drawer');
  const body = document.getElementById('cover-lookup-drawer-body');
  const badge = document.getElementById('cover-lookup-drawer-badge');
  const button = document.getElementById('cover-lookup-drawer-button');
  const clearButton = document.getElementById('cover-lookup-drawer-clear');
  if (!drawer || !body || !button || !badge) return;
  const tasks = Array.isArray(state.coverLookup.tasks) ? state.coverLookup.tasks : [];
  drawer.hidden = !state.coverLookup.drawerOpen;
  drawer.classList.toggle('is-open', state.coverLookup.drawerOpen);
  const activeCount = tasks.filter((task) => ['pending', 'running'].includes(String(task?.status || ''))).length;
  const pendingNotificationCount = tasks.filter((task) => isCompletedCoverLookupTask(task) && !Boolean(task?.notification_action_taken)).length;
  const terminalCount = tasks.filter((task) => isCompletedCoverLookupTask(task)).length;
  const badgeCount = activeCount + pendingNotificationCount;
  badge.hidden = badgeCount <= 0;
  badge.textContent = String(badgeCount || '');
  button.classList.toggle('has-active-lookups', badgeCount > 0);
  if (clearButton) {
    clearButton.hidden = terminalCount <= 0;
  }
  const preserveSelectedNotificationText = hasActiveCoverLookupDrawerTextSelection(body);
  if (!tasks.length) {
    if (!preserveSelectedNotificationText) {
      body.innerHTML = '<div class="cover-lookup-drawer-empty">You\'re not looking for anything at the moment. Search for specific album art to see notifications.</div>';
    }
    syncCoverLookupElapsedTimer();
    return;
  }
  const taskMarkup = tasks.map((task) => {
    const progress = Math.max(0, Math.min(100, Number(task?.progress || 0)));
    const status = String(task?.status || '');
    const isCompleted = isCompletedCoverLookupTask(task);
    const isNoResult = status === 'completed' && String(task?.result_kind || '') === 'no-results';
    const statusLabel = isNoResult
      ? 'Completed — no result'
      : isCompleted && task?.notification_action_taken
      ? 'Art chosen'
      : status === 'completed'
        ? 'Completed'
      : (task?.progress_label || status || 'Queued');
    const elapsedStateClass = status === 'failed'
      ? 'is-failed'
      : isCompleted
        ? 'is-completed'
        : 'is-active';
    const elapsedLabel = getCoverLookupTaskElapsedLabel(task, Date.now());
    const line = [task?.artist || '', task?.album || '', task?.year || ''].filter(Boolean).join(' - ');
    return `
      <div class="cover-lookup-task-card">
        <div class="cover-lookup-task-open" role="button" tabindex="0" data-open-cover-lookup-task="${escapeHtml(task.id || '')}">
          <div class="cover-lookup-task-type">COVER ART LOOK UP</div>
          <div class="cover-lookup-task-title">${escapeHtml(line || 'Unknown album')}</div>
          <div class="cover-lookup-task-status">${escapeHtml(statusLabel)}</div>
          <div class="cover-lookup-task-elapsed ${elapsedStateClass}" data-cover-lookup-task-elapsed="${escapeHtml(task.id || '')}" ${elapsedLabel ? '' : 'hidden'}>${escapeHtml(elapsedLabel)}</div>
          <div class="cover-lookup-task-progress"><span style="width:${progress}%"></span></div>
        </div>
        ${['pending', 'running'].includes(status)
          ? `<button class="cover-lookup-task-cancel" type="button" data-cancel-cover-lookup-task="${escapeHtml(task.id || '')}" aria-label="Stop lookup">✕</button>`
          : isCompleted
            ? `<button class="cover-lookup-task-clear" type="button" data-clear-cover-lookup-task="${escapeHtml(task.id || '')}" aria-label="Clear notification" title="Clear notification">
                <span class="cover-lookup-drawer-clear-glyph cover-lookup-task-clear-glyph" aria-hidden="true">
                  <img class="cover-lookup-drawer-clear-glyph-default" src="/static/images/clear-notifications-icon-offwhite.png" alt="">
                  <img class="cover-lookup-drawer-clear-glyph-hover" src="/static/images/clear-notifications-icon.png" alt="">
                </span>
              </button>`
            : ''}
      </div>
    `;
  }).join('');
  if (!preserveSelectedNotificationText) {
    body.innerHTML = taskMarkup;
  }
  syncCoverLookupElapsedTimer();
}

async function clearCompletedCoverLookupTasks() {
  const previousTasks = Array.isArray(state.coverLookup.tasks) ? state.coverLookup.tasks.slice() : [];
  const terminalTaskIds = previousTasks
    .filter((task) => isCompletedCoverLookupTask(task))
    .map((task) => String(task?.id || '').trim())
    .filter(Boolean);
  if (!terminalTaskIds.length) {
    showToast('There were no finished cover lookups to clear.', 'success', 2200);
    return;
  }
  const terminalTaskIdSet = new Set(terminalTaskIds);
  state.coverLookup.tasks = previousTasks.filter(
    (task) => !terminalTaskIdSet.has(String(task?.id || '').trim()),
  );
  renderCoverLookupDrawer();
  stopCoverLookupPollingIfIdle();
  try {
    const response = await fetch('/utilities/cover-lookup/tasks/clear-completed', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ task_ids: terminalTaskIds }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      throw new Error(data.error || 'Failed to clear completed cover lookups');
    }
    state.coverLookup.tasks = mergeCoverLookupTasksWithNotifications(Array.isArray(data.tasks) ? data.tasks : []);
    renderCoverLookupDrawer();
    stopCoverLookupPollingIfIdle();
    showToast(Number(data.removed_count || 0) > 0 ? 'Finished cover lookups cleared.' : 'There were no finished cover lookups to clear.', 'success', 2200);
  } catch (error) {
    state.coverLookup.tasks = previousTasks;
    console.error('[AlbumHaven][CoverLookup] Failed to clear completed tasks.', error);
    renderCoverLookupDrawer();
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
  renderCoverLookupDrawer();
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
    renderCoverLookupDrawer();
    stopCoverLookupPollingIfIdle();
    showToast('Notification cleared.', 'success', 2200);
  } catch (error) {
    state.coverLookup.tasks = previousTasks;
    console.error('[AlbumHaven][CoverLookup] Failed to clear notification.', error);
    renderCoverLookupDrawer();
    stopCoverLookupPollingIfIdle();
    showToast(error.message || 'Failed to clear notification.', 'error', 2800);
  }
}

function buildCoverLookupCard(item, kind = 'local') {
  const resolution = item?.resolution || ((item?.width && item?.height) ? `${item.width}x${item.height}` : 'Unknown');
  const isRemoteKind = kind === 'remote' || kind === 'saved-remote';
  const isPastedKind = kind === 'pasted';
  const isSpotify = String(item?.source || '').trim() === 'spotify';
  const isOtherRemoteArt = isRemoteKind && String(item?.art_kind || 'cover') !== 'cover';
  const previewFallbackImageUrl = '/static/images/remote-preview-unavailable.png';
  const sourceBadge = buildRemoteCoverSourceBadge(item?.source);
  const remoteSourceLabel = isSpotify
    ? 'SPOTIFY'
    : String(item?.source_label || item?.source || '').trim();
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
        : String(item?.path || '') === getCoverLookupActiveLocalPath()
    ))
    : kind === 'pasted'
      ? (!String(state.coverLookup.modal.selectedRemoteId || '') && !String(state.coverLookup.modal.pendingLocalPath || '') && state.coverLookup.modal.pendingPastedImageId === String(item?.id || ''))
    : kind === 'saved-remote'
      ? (
        !String(state.coverLookup.modal.selectedRemoteId || '')
        && !String(state.coverLookup.modal.pendingLocalPath || '')
        && !String(state.coverLookup.modal.activeLocalSelectionPath || '')
      )
      : (!isOtherRemoteArt && state.coverLookup.modal.selectedRemoteId === String(item?.id || ''));
  const itemIdentity = kind === 'local'
    ? String(item?.path || '')
    : kind === 'pasted'
      ? String(item?.id || '')
      : String(item?.id || item?.url || '');
  const itemKeyAttr = itemIdentity
    ? `data-cover-lookup-item-key="${escapeHtml(`${kind}:${itemIdentity}`)}"`
    : '';
  const selectAttr = isOtherRemoteArt
    ? 'data-cover-lookup-other-remote-art="1"'
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
  const previewLoadingAttrs = isRemoteKind
    ? 'loading="lazy" fetchpriority="low"'
    : 'loading="eager"';
  const actionLabel = kind === 'saved-remote'
    ? (isActive ? 'Selected' : 'Linked remote cover')
    : (isActive ? 'Selected' : 'Select');
  const roleAttr = isOtherRemoteArt ? 'role="group"' : 'role="button" tabindex="0"';
  const fallbackPreviewHtml = `
    <span class="cover-lookup-art-preview-fallback">
      <img src="${previewFallbackImageUrl}" alt="Remote preview unavailable" loading="eager" decoding="async">
    </span>
  `;
  return `
    <div class="cover-lookup-art-card-shell">
      <div class="cover-lookup-art-card ${isActive ? 'is-active' : ''} ${isOtherRemoteArt ? 'is-preview-only' : ''}" ${roleAttr} ${selectAttr} ${itemKeyAttr} ${localActiveAttr} ${lightboxDataAttrs}>
        <span class="cover-lookup-art-preview">
          ${fallbackPreviewHtml}
          ${imageUrl ? `<img class="cover-lookup-art-preview-image" src="${imageUrl}" alt="${previewAlt}" ${previewLoadingAttrs} decoding="async" onload="this.closest('.cover-lookup-art-preview')?.classList.remove('has-load-error');" onerror="this.style.display='none'; this.removeAttribute('src'); var preview=this.parentElement; if(preview){ preview.classList.add('has-load-error'); }">` : ''}
          <button class="cover-lookup-art-preview-button" type="button" ${previewAttrs} aria-label="${previewButtonLabel}">
            <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
              <path d="M10.5 4a6.5 6.5 0 1 0 4.07 11.57l4.43 4.43 1.41-1.41-4.43-4.43A6.5 6.5 0 0 0 10.5 4Zm0 2a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9Zm-.75 1.75h1.5v2h2v1.5h-2v2h-1.5v-2h-2v-1.5h2v-2Z" fill="currentColor"></path>
            </svg>
          </button>
          ${isActive ? '<span class="cover-lookup-art-check">&#10003;</span>' : ''}
          ${kind === 'local' ? `<button class="cover-lookup-art-delete" type="button" data-delete-local-cover="${escapeHtml(item.path || '')}" aria-label="Delete local cover art">&#128465;</button>` : ''}
        </span>
        <span class="cover-lookup-art-meta">
          <span class="cover-lookup-art-name">${escapeHtml(item.relative_path || item.filename || item.album || (isPastedKind ? 'Pasted image' : 'Cover art'))}</span>
          <span class="cover-lookup-art-resolution">${escapeHtml(resolution)}</span>
          ${isRemoteKind ? `<span class="cover-lookup-art-source">${sourceBadge}<span>${escapeHtml(remoteSourceLabel)}</span></span>` : ''}
          ${isOtherRemoteArt ? '' : `<span class="cover-lookup-art-action-label">${actionLabel}</span>`}
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
  const localCovers = Array.isArray(modalState.localCovers) ? modalState.localCovers : [];
  const pastedImages = Array.isArray(modalState.pastedImages) ? modalState.pastedImages : [];
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
    els.status.textContent = taskRunning ? '' : (modalState.statusText || '');
    els.status.classList.toggle('is-error', !taskRunning && String(modalState.statusTone || '') === 'error');
  }
  const searchControlsDisabled = Boolean(taskRunning || modalState.manualBusy);
  const searchControlsDisabledAttr = searchControlsDisabled ? 'disabled' : '';
  const manualInputDisabled = searchControlsDisabled;
  const manualInputDisabledAttr = manualInputDisabled ? 'disabled' : '';
  const manualSearchDisabled = searchControlsDisabled || !String(modalState.manualUrlText || '').trim();
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
        ${serviceMatches.length ? `<div class="cover-lookup-subsection-title">From services</div><div class="cover-lookup-gallery">${serviceMatches.map((item) => buildCoverLookupCard(item, 'remote')).join('')}</div>` : ''}
        ${groupedDiscogsMatches.length ? `<div class="cover-lookup-subsection-title">Discogs</div><div class="cover-lookup-gallery" data-cover-lookup-provider-group="discogs">${groupedDiscogsMatches.map((item) => buildCoverLookupCard(item, 'remote')).join('')}</div>` : ''}
        ${groupedArchiveMatches.length ? `<div class="cover-lookup-subsection-title">Cover Art Archive</div><div class="cover-lookup-gallery" data-cover-lookup-provider-group="cover_art_archive">${groupedArchiveMatches.map((item) => buildCoverLookupCard(item, 'remote')).join('')}</div>` : ''}
        ${manualLinkMatches.length ? `<div class="cover-lookup-subsection-title">MANUAL LINKS</div><div class="cover-lookup-gallery">${manualLinkMatches.map((item) => buildCoverLookupCard(item, 'remote')).join('')}</div>` : ''}
        ${manualLinkOtherArtMatches.length ? `<div class="cover-lookup-subsection-title">MANUAL LINKS - OTHER REMOTE ART</div><div class="cover-lookup-gallery">${manualLinkOtherArtMatches.map((item) => buildCoverLookupCard(item, 'remote')).join('')}</div>` : ''}
        ${remoteOtherArtMatches.length ? `<div class="cover-lookup-subsection-title">OTHER COVER ART</div><div class="cover-lookup-gallery">${remoteOtherArtMatches.map((item) => buildCoverLookupCard(item, 'remote')).join('')}</div>` : ''}
        ${showCaaEmptyNotice ? `<div class="cover-lookup-subsection-title">Cover Art Archive</div><div class="cover-lookup-empty">We cannot guarantee Cover Art Archive results. Its API is flaky, you can try doing the same search later and might see good matches here</div>` : ''}
      `
    : (taskRunning ? '' : '<div class="cover-lookup-empty">No remote matches yet.</div>');
  if (modalState.loading) {
    els.body.innerHTML = '<div class="cover-lookup-empty">Loading cover art gallery...</div>';
    els.body.scrollTop = 0;
    if (els.saveRemote) {
      els.saveRemote.hidden = false;
      els.saveRemote.disabled = true;
    }
    return;
  }
  els.body.innerHTML = `
    <section class="cover-lookup-section">
      <h4 class="cover-lookup-section-title">Local Covers</h4>
      <div class="cover-lookup-gallery">${localCovers.length ? localCovers.map((item) => buildCoverLookupCard(item, 'local')).join('') : '<div class="cover-lookup-empty">No local cover art found in this album folder.</div>'}</div>
      ${pastedImages.length ? `<div class="cover-lookup-subsection-title">PASTED IMAGES</div><div class="cover-lookup-gallery">${pastedImages.map((item) => buildCoverLookupCard(item, 'pasted')).join('')}</div>` : ''}
      ${otherArt.length ? `<div class="cover-lookup-subsection-title">Other art</div><div class="cover-lookup-gallery">${otherArt.map((item) => buildCoverLookupCard(item, 'local')).join('')}</div>` : ''}
    </section>
    <section class="cover-lookup-section">
      <h4 class="cover-lookup-section-title">Remote Cover Art</h4>
      <div class="cover-lookup-gallery">${remoteCover ? buildCoverLookupCard(remoteCover, 'saved-remote') : '<div class="cover-lookup-empty">No remote cover is currently selected.</div>'}</div>
    </section>
    <section class="cover-lookup-section">
      <div class="cover-lookup-section-heading">
        <h4 class="cover-lookup-section-title">Possible Matches</h4>
      </div>
      ${progressMarkup}
      ${possibleMatchesMarkup}
        <div class="cover-lookup-manual-add" data-cover-lookup-scroll-key="manual-add">
        <div class="cover-lookup-manual-copy">
          <div class="cover-lookup-manual-description">Search on the internet or manually add album links to improve cover results.</div>
          <div class="cover-lookup-manual-note">Find Better Art will also use anything pasted here.</div>
        </div>
        <div class="cover-lookup-search-shortcuts">
          <a class="cover-lookup-search-chip is-google" href="${googleSearchUrl}" target="_blank" rel="noreferrer"><span class="cover-lookup-search-chip-logo">G</span><span>Google</span></a>
          <a class="cover-lookup-search-chip is-yandex" href="${yandexSearchUrl}" target="_blank" rel="noreferrer"><span class="cover-lookup-search-chip-logo">Y</span><span>Yandex</span></a>
        </div>
        <div class="cover-lookup-manual-row">
          <textarea class="cover-lookup-manual-input" id="cover-lookup-pasted-urls" rows="4" placeholder="You can paste your image or direct link to the album page or jpg here" ${manualInputDisabledAttr}>${escapeHtml(modalState.manualUrlText || '')}</textarea>
        </div>
        <div class="cover-lookup-manual-actions">
          <button class="button cover-lookup-manual-submit" type="button" data-add-cover-lookup-remote="1" ${manualSearchDisabledAttr}>Extract images</button>
        </div>
        </div>
      </section>
    `;
  restoreCoverLookupModalScrollAnchor(els.body, scrollAnchor);
  if (els.saveRemote) {
    syncCoverLookupManualControlsUi();
    syncCoverLookupSaveButton();
  }
}

let coverLookupTasksRequestSequence = 0;

async function loadCoverLookupTasks(options = {}) {
  const requestSequence = ++coverLookupTasksRequestSequence;
  try {
    const response = await fetch('/utilities/cover-lookup/tasks', { headers: { Accept: 'application/json' } });
    const data = await response.json().catch(() => ({}));
    if (requestSequence !== coverLookupTasksRequestSequence) return;
    if (!response.ok || !data.ok) {
      throw new Error(data.error || 'Failed to load cover lookups');
    }
    state.coverLookup.tasks = mergeCoverLookupTasksWithNotifications(Array.isArray(data.tasks) ? data.tasks : []);
    renderCoverLookupDrawer();
    (state.coverLookup.tasks || []).forEach((task) => {
      applyCoverLookupTaskUpdates(task);
    });
    const snapshot = JSON.stringify(state.coverLookup.tasks.map((task) => ({
      id: task.id,
      status: task.status,
      progress: task.progress,
      selected_candidate_id: task.selected_candidate_id,
      possible_match_ids: buildCoverLookupCandidateSnapshot(task),
      updated_albums_count: Array.isArray(task.updated_albums) ? task.updated_albums.length : 0,
    })));
    const modalTaskId = String(state.coverLookup.modal.taskId || '');
    if (modalTaskId && snapshot !== state.coverLookup.tasksSnapshot) {
      const task = state.coverLookup.tasks.find((item) => String(item?.id || '') === modalTaskId);
      if (task) {
        logCoverLookupTaskDebug('Task poll update.', task);
        state.coverLookup.modal.statusText = String(task.message || task.progress_label || '');
        state.coverLookup.modal.statusTone = getCoverLookupStatusTone(task);
        const taskStatus = String(task.status || '');
        const candidateSource = getCoverLookupCandidateSource(
          task,
          state.coverLookup.modal.candidateSnapshot,
        );
        applyCoverLookupCandidateSource(candidateSource);
        if (['completed', 'failed', 'canceled'].includes(taskStatus)) {
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
  } catch (error) {
    if (requestSequence !== coverLookupTasksRequestSequence) return;
    console.warn('[AlbumHaven][CoverLookup] Failed to load lookup tasks.', error);
    if (options.toast !== false) {
      showToast(error.message || 'Failed to load cover lookups.', 'error', 2800);
    }
  }
}

function ensureCoverLookupPolling() {
  if (state.coverLookup.pollingTimer) return;
  state.coverLookup.pollingTimer = window.setInterval(async () => {
    await loadCoverLookupTasks({ toast: false });
    const snapshot = state.coverLookup.modal.candidateSnapshot;
    const modalOpen = !document.getElementById('cover-lookup-modal')?.hidden;
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
  }, 2500);
}

function stopCoverLookupPollingIfIdle() {
  const modalOpen = !document.getElementById('cover-lookup-modal')?.hidden;
  const activeTasks = (state.coverLookup.tasks || []).filter((task) => ['pending', 'running'].includes(String(task?.status || ''))).length;
  const shouldKeepPolling = Boolean(state.coverLookup.drawerOpen || modalOpen || activeTasks > 0);
  if (shouldKeepPolling) return;
  if (state.coverLookup.pollingTimer) {
    window.clearInterval(state.coverLookup.pollingTimer);
    state.coverLookup.pollingTimer = 0;
  }
}

function collectManualCoverLookupUrls() {
  const input = document.getElementById('cover-lookup-pasted-urls');
  const rawText = String(input?.value || state.coverLookup.modal.manualUrlText || '').trim();
  state.coverLookup.modal.manualUrlText = rawText;
  return rawText.split(/\s+/).map((item) => item.trim()).filter(Boolean);
}

function applyCoverLookupTaskUpdates(task, options = {}) {
  if (!task || !Array.isArray(task.updated_albums) || !task.updated_albums.length) return;
  const taskId = String(task.id || '');
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

async function refreshCoverLookupGallery(showLoading = true) {
  const album = state.coverLookup.modal.album;
  if (!album) return;
  state.coverLookup.modal.loading = Boolean(showLoading);
  renderCoverLookupModal();
  try {
    const response = await fetch('/utilities/cover-lookup/gallery', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ album, task_id: state.coverLookup.modal.taskId || '' }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      throw new Error(data.error || 'Failed to load cover art gallery');
    }
    console.log('[AlbumHaven][CoverLookup] Gallery response.', data);
    applyCoverLookupGalleryPayload(data);
    await markCoverLookupAutomaticImprovementSeen(state.coverLookup.modal.candidateSnapshot);
    state.coverLookup.modal.loading = false;
    renderCoverLookupModal();
  } catch (error) {
    state.coverLookup.modal.loading = false;
    console.error('[AlbumHaven][CoverLookup] Failed to load gallery.', error);
    showToast(error.message || 'Failed to load cover art gallery.', 'error', 2800);
  }
}

async function openCoverLookupModal(album, options = {}) {
  const els = getCoverLookupModalElements();
  if (!els.overlay || !album) return;
  const matchingTask = !options.taskId
    ? (state.coverLookup.tasks || []).find((task) => buildTrackPathSignature(task?.album_payload) === buildTrackPathSignature(album))
    : null;
  state.coverLookup.modal.album = album;
  state.coverLookup.modal.taskId = String(options.taskId || matchingTask?.id || '');
  state.coverLookup.modal.remoteCover = null;
  state.coverLookup.modal.localCovers = [];
  revokeCoverLookupPastedImageUrls();
  state.coverLookup.modal.pastedImages = [];
  state.coverLookup.modal.otherArt = [];
  state.coverLookup.modal.pendingLocalPath = '';
  state.coverLookup.modal.pendingPastedImageId = '';
  state.coverLookup.modal.selectedRemoteId = '';
  state.coverLookup.modal.possibleMatches = [];
  state.coverLookup.modal.candidateSnapshot = null;
  state.coverLookup.modal.candidateGeneration = '';
  state.coverLookup.modal.activeLocalSelectionPath = '';
  state.coverLookup.modal.remoteSelectionOverrideGeneration = '';
  state.coverLookup.modal.remoteSelectionOverrideCandidateId = '';
  state.coverLookup.modal.remoteSelectionOverrideUrl = '';
  state.coverLookup.modal.seenCandidateImprovementToken = '';
  state.coverLookup.modal.statusText = '';
  state.coverLookup.modal.statusTone = 'neutral';
  state.coverLookup.modal.manualUrlText = '';
  state.coverLookup.modal.manualBusy = false;
  state.coverLookup.modal.loading = true;
  els.overlay.hidden = false;
  document.body.classList.add('modal-open');
  if (els.saveRemote instanceof HTMLButtonElement) {
    els.saveRemote.hidden = false;
    els.saveRemote.disabled = true;
  }
  renderCoverLookupModal();
  ensureCoverLookupPolling();
  await Promise.all([
    loadCoverLookupTasks({ toast: false, refreshModalGallery: false }),
    refreshCoverLookupGallery(),
  ]);
}

function closeCoverLookupModal() {
  const els = getCoverLookupModalElements();
  if (!els.overlay) return;
  els.overlay.hidden = true;
  state.coverLookup.modal.pendingLocalPath = '';
  state.coverLookup.modal.pendingPastedImageId = '';
  state.coverLookup.modal.selectedRemoteId = '';
  state.coverLookup.modal.remoteCover = null;
  state.coverLookup.modal.activeLocalSelectionPath = '';
  revokeCoverLookupPastedImageUrls();
  state.coverLookup.modal.pastedImages = [];
  state.coverLookup.modal.manualBusy = false;
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
  if (!els.overlay || !path) return;
  state.coverLookup.modal.pendingDeletePath = String(path || '');
  if (els.text) {
    els.text.textContent = 'Are you sure you want to delete this local cover art?';
  }
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
  const modalOpen = !document.getElementById('cover-lookup-modal')?.hidden;
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
    if (!backgroundOnly) {
      state.coverLookup.modal.manualBusy = true;
      renderCoverLookupModal();
    }
    const manualUrls = !backgroundOnly ? collectManualCoverLookupUrls() : [];
    const response = await fetch('/utilities/cover-lookup/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ album, manual_urls: manualUrls }),
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
    await loadCoverLookupTasks({ toast: false });
    if (!backgroundOnly && modalOpen) {
      await refreshCoverLookupGallery(false);
    }
  } catch (error) {
    console.error('[AlbumHaven][CoverLookup] Failed to start lookup.', error);
    showToast(error.message || 'Failed to start cover art lookup.', 'error', 2800);
  } finally {
    if (!backgroundOnly) {
      state.coverLookup.modal.manualBusy = false;
      renderCoverLookupModal();
    }
  }
}

function selectLocalCoverFromLookup(sourcePath) {
  state.coverLookup.modal.pendingLocalPath = String(sourcePath || '');
  state.coverLookup.modal.pendingPastedImageId = '';
  state.coverLookup.modal.selectedRemoteId = '';
  syncCoverLookupSelectionUi();
}

async function saveLocalCoverFromLookup(sourcePath) {
  const album = state.coverLookup.modal.album;
  const taskId = String(state.coverLookup.modal.taskId || '');
  if (!album || !sourcePath) return;
  const previousAlbum = deepCloneJson(album);
  const optimisticAlbum = buildOptimisticCoverUpdatedAlbum(album, sourcePath);
  applyOptimisticLocalCoverSelection(album, sourcePath);
  state.coverLookup.modal.pendingLocalPath = '';
  state.coverLookup.modal.selectedRemoteId = '';
  markTrackModalCoverTransitionPending(album);
  closeCoverLookupModal();
  if (optimisticAlbum) {
    markAlbumCoverPathsFresh([optimisticAlbum]);
    syncCoverLookupAlbumReferences([optimisticAlbum]);
    refreshCoverLookupAlbumArtwork(album, [optimisticAlbum], { updateTrackModal: false });
  }
  try {
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
    markAlbumCoverPathsFresh(updatedAlbums);
    if (updatedAlbums[0]) {
      await preloadCoverLookupAlbumImage(updatedAlbums[0]);
    }
    clearOptimisticAlbumCovers(updatedAlbums);
    syncCoverLookupAlbumReferences(updatedAlbums);
    refreshCoverLookupAlbumArtwork(album, updatedAlbums);
    if (taskId) {
      markCoverLookupTaskActionTaken(taskId, album);
      renderCoverLookupDrawer();
    }
    showToast('Local cover art selected.', 'success', 2200);
  } catch (error) {
    if (previousAlbum) {
      clearOptimisticAlbumCovers([previousAlbum]);
      markAlbumCoverPathsFresh([previousAlbum]);
      syncCoverLookupAlbumReferences([previousAlbum]);
      refreshCoverLookupAlbumArtwork(previousAlbum, [previousAlbum]);
    }
    console.error('[AlbumHaven][CoverLookup] Failed to select local cover.', error);
    showToast(error.message || 'Failed to select local cover art.', 'error', 2800);
  }
}

async function deleteLocalCoverFromLookup(sourcePath) {
  const album = state.coverLookup.modal.album;
  if (!album || !sourcePath) return;
  const previousLocalCovers = Array.isArray(state.coverLookup.modal.localCovers)
    ? state.coverLookup.modal.localCovers.slice()
    : [];
  const previousAlbum = deepCloneJson(album);
  const remainingLocalCovers = previousLocalCovers.filter((item) => String(item?.path || '') !== String(sourcePath || ''));
  const fallbackLocalCoverPath = String(remainingLocalCovers[0]?.path || '').trim();
  const optimisticAlbum = buildOptimisticCoverDeleteUpdatedAlbum(album, sourcePath, fallbackLocalCoverPath);
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
  try {
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
    markAlbumCoverPathsFresh(updatedAlbums);
    syncCoverLookupAlbumReferences(updatedAlbums);
    state.coverLookup.modal.pendingLocalPath = '';
    state.coverLookup.modal.pendingPastedImageId = '';
    state.coverLookup.modal.selectedRemoteId = '';
    refreshCoverLookupAlbumArtwork(album, updatedAlbums);
    if (data.gallery && typeof data.gallery === 'object') {
      applyCoverLookupGalleryPayload(data.gallery);
      renderCoverLookupModal();
    } else {
      await refreshCoverLookupGallery(false);
    }
    showToast('Local cover art deleted.', 'success', 2200);
  } catch (error) {
    state.coverLookup.modal.localCovers = previousLocalCovers;
    if (previousAlbum) {
      markAlbumCoverPathsFresh([previousAlbum]);
      syncCoverLookupAlbumReferences([previousAlbum]);
      refreshCoverLookupAlbumArtwork(previousAlbum, [previousAlbum]);
    }
    renderCoverLookupModal();
    console.error('[AlbumHaven][CoverLookup] Failed to delete local cover.', error);
    showToast(error.message || 'Failed to delete local cover art.', 'error', 2800);
  }
}

function selectRemoteCoverFromLookup(candidateId) {
  state.coverLookup.modal.pendingLocalPath = '';
  state.coverLookup.modal.pendingPastedImageId = '';
  state.coverLookup.modal.selectedRemoteId = String(candidateId || '');
  state.coverLookup.modal.activeLocalSelectionPath = '';
  state.coverLookup.modal.remoteSelectionOverrideGeneration = String(
    state.coverLookup.modal.candidateGeneration
    || state.coverLookup.modal.candidateSnapshot?.search_generation
    || state.coverLookup.modal.taskId
    || '',
  );
  state.coverLookup.modal.remoteSelectionOverrideCandidateId = String(candidateId || '');
  const selectedCandidate = (state.coverLookup.modal.possibleMatches || []).find((candidate) => (
    String(candidate?.id || '') === String(candidateId || '')
  ));
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
  syncCoverLookupSelectionUi();
}

async function saveRemoteCoverFromLookup() {
  const album = state.coverLookup.modal.album;
  const taskId = state.coverLookup.modal.taskId;
  const candidateId = state.coverLookup.modal.selectedRemoteId;
  const snapshotGeneration = String(
    state.coverLookup.modal.candidateSnapshot?.search_generation || '',
  ).trim();
  if (!album || (!taskId && !snapshotGeneration) || !candidateId) return;
  const previousAlbum = deepCloneJson(album);
  const selectedMatch = (state.coverLookup.modal.possibleMatches || []).find((item) => String(item?.id || '') === String(candidateId || ''));
  try {
    if (selectedMatch) {
      applyOptimisticRemoteCoverSelection(album, selectedMatch, '');
    }
    state.coverLookup.modal.manualBusy = false;
    state.coverLookup.modal.pendingLocalPath = '';
    state.coverLookup.modal.selectedRemoteId = '';
    closeCoverLookupModal();
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
    if (selectedMatch && optimisticCoverPath) {
      applyOptimisticRemoteCoverSelection(album, selectedMatch, optimisticCoverPath);
    }
    await loadCoverLookupTasks({ toast: false });
    ensureCoverLookupPolling();
    renderCoverLookupDrawer();
    const successMessage = selectedMatch?.display_only
      ? 'Remote cover art linked.'
      : (data.queued ? 'Saving selected cover art in the background.' : 'Selected cover art saved.');
    showToast(successMessage, 'success', 2400);
  } catch (error) {
    if (previousAlbum) {
      markAlbumCoverPathsFresh([previousAlbum]);
      syncCoverLookupAlbumReferences([previousAlbum]);
      refreshCoverLookupAlbumArtwork(previousAlbum, [previousAlbum]);
    }
    console.error('[AlbumHaven][CoverLookup] Failed to save remote cover.', error);
    showToast(error.message || 'Failed to save selected cover art.', 'error', 2800);
  }
}

async function addRemoteCoverLinksFromLookup() {
  const album = state.coverLookup.modal.album;
  const input = document.getElementById('cover-lookup-pasted-urls');
  const urls = collectManualCoverLookupUrls();
  if (!album || !urls.length) return;
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
      state.coverLookup.modal.statusText = String(data.task.message || data.task.progress_label || '');
      state.coverLookup.modal.statusTone = getCoverLookupStatusTone(data.task);
    }
    await loadCoverLookupTasks({ toast: false });
    renderCoverLookupModal();
    showToast('Remote cover links added.', 'success', 2200);
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
  try {
    applyOptimisticPastedCoverSelection(album, pastedItem);
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
      markCoverLookupTaskActionTaken(taskId, album);
      renderCoverLookupDrawer();
    }
    showToast('Pasted image saved as cover art.', 'success', 2200);
  } catch (error) {
    if (previousAlbum) {
      markAlbumCoverPathsFresh([previousAlbum]);
      syncCoverLookupAlbumReferences([previousAlbum]);
      refreshCoverLookupAlbumArtwork(previousAlbum, [previousAlbum]);
    }
    console.error('[AlbumHaven][CoverLookup] Failed to save pasted image.', error);
    showToast(error.message || 'Failed to save pasted image.', 'error', 2800);
  }
}

async function saveCoverFromLookup() {
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

