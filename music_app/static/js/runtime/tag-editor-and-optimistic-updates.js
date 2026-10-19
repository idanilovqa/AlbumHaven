// Document-lifetime restrictive provenance survives Search runtime replacement.
// These weak associations never confer playback or preference/read authority.
const SearchAlbumPresentationProvenance = (() => {
  const origins = new WeakSet(), attempts = new WeakMap();
  const object = value => value !== null && typeof value === 'object';
  const tracks = album => Array.isArray(album?.tracks) ? album.tracks : [];
  const mark = album => {
    if (!object(album)) return;
    origins.add(album);
    for (const row of [...tracks(album), ...(Array.isArray(album.track_rows) ? album.track_rows : [])]) {
      if (object(row)) origins.add(row);
    }
  };
  const has = value => object(value) && origins.has(value);
  function bridge(input, output) {
    if (!has(input) || !object(output)) return output;
    mark(output);
    if (String(input.key || input.album_ref || '') === String(output.key || output.album_ref || '')
      && input.tracks === output.tracks && input.track_rows === output.track_rows
      && tracks(input).every((track, index) => track === tracks(output)[index])) {
      const attempt = attempts.get(input);
      if (attempt?.isCurrent()) attempts.set(output, attempt);
    }
    return output;
  }
  return Object.freeze({mark, has, bridge,
    attach(album, attempt) {mark(album); attempts.set(album, attempt);},
    detach(album, attempt) {if (attempts.get(album) === attempt) attempts.delete(album);},
    attempt(album) {return object(album) ? attempts.get(album) || null : null;},
    read(album, track, source) {
      const attempt = object(album) && attempts.get(album);
      return attempt?.isCurrent() ? attempt.read?.(track, source) || null : null;
    },
    rendered(album, list, receipt) {attempts.get(album)?.rendered(album, list, receipt);},
  });
})();

const albumTrackCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

function getPositiveAlbumTrackSortNumber(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function compareAlbumTrackSortNumbers(left, right) {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left - right;
}

function compareAlbumTrackExactText(left, right) {
  const leftText = String(left || '');
  const rightText = String(right || '');
  if (leftText === rightText) return 0;
  return leftText < rightText ? -1 : 1;
}
function getAlbumTrackFilename(track) {
  const path = String(track?.path || '');
  return path.split(/[\\/]/).pop() || String(track?.title || track?.key || '');
}

function getAlbumTrackDisplayNumber(track, index) {
  const taggedTrackNumber = getPositiveAlbumTrackSortNumber(track?.track_number);
  if (taggedTrackNumber !== null) return taggedTrackNumber;

  const filenameMatch = getAlbumTrackFilename(track).match(/^\s*(\d+)(?=\D|$)/);
  const filenameTrackNumber = getPositiveAlbumTrackSortNumber(filenameMatch?.[1]);
  if (filenameTrackNumber !== null) return filenameTrackNumber;

  return index + 1;
}

function compareAlbumTracks(left, right) {
  const discCompare = compareAlbumTrackSortNumbers(
    getPositiveAlbumTrackSortNumber(left?.disc_number),
    getPositiveAlbumTrackSortNumber(right?.disc_number),
  );
  if (discCompare) return discCompare;

  const trackCompare = compareAlbumTrackSortNumbers(
    getPositiveAlbumTrackSortNumber(left?.track_number),
    getPositiveAlbumTrackSortNumber(right?.track_number),
  );
  if (trackCompare) return trackCompare;

  const filenameCompare = albumTrackCollator.compare(
    getAlbumTrackFilename(left),
    getAlbumTrackFilename(right),
  );
  if (filenameCompare) return filenameCompare;

  const pathCompare = compareAlbumTrackExactText(left?.path, right?.path);
  if (pathCompare) return pathCompare;

  return compareAlbumTrackExactText(
    left?.key || left?.track_ref,
    right?.key || right?.track_ref,
  );
}

function orderAlbumTracks(tracks) {
  return (Array.isArray(tracks) ? tracks : []).slice().sort(compareAlbumTracks);
}

function getOrderedSelectedTrackIndexes(tracks, selectedPaths) {
  const orderedTracks = orderAlbumTracks(tracks);
  const selectedPathSet = new Set(
    (Array.isArray(selectedPaths) ? selectedPaths : [])
      .map((path) => String(path || ''))
      .filter(Boolean),
  );
  const indexes = orderedTracks
    .map((track, index) => (
      selectedPathSet.has(String(track?.path || '')) ? index : -1
    ))
    .filter((index) => index >= 0);
  return { indexes, orderedTracks, selectedPathSet };
}

function buildSelectedTrackNumberValues(tracks, selectedPaths, startAt) {
  const { indexes, orderedTracks, selectedPathSet } = getOrderedSelectedTrackIndexes(
    tracks,
    selectedPaths,
  );
  const start = Number(startAt);
  const contiguous = indexes.length >= 2
    && indexes.length === selectedPathSet.size
    && indexes.every((index, offset) => index === indexes[0] + offset);
  if (!contiguous || !Number.isInteger(start) || start < 1) return {};

  const numberedTrackCountByDisc = new Map();
  return indexes.reduce((values, index) => {
    const track = orderedTracks[index];
    const path = String(track?.path || '');
    const discKey = getPositiveAlbumTrackSortNumber(track?.disc_number);
    const discOffset = numberedTrackCountByDisc.get(discKey) || 0;
    if (path) values[path] = String(start + discOffset);
    numberedTrackCountByDisc.set(discKey, discOffset + 1);
    return values;
  }, {});
}

function deriveTagEditorAutoNumberStart(tracks, selectedPaths) {
  const { indexes, orderedTracks } = getOrderedSelectedTrackIndexes(tracks, selectedPaths);
  const firstIndex = indexes[0];
  const firstTrack = Number.isInteger(firstIndex) ? orderedTracks[firstIndex] : null;
  if (!firstTrack) return '1';
  const filenameMatch = getAlbumTrackFilename(firstTrack).match(/^\s*(\d+)(?=\D|$)/);
  const filenameNumber = getPositiveAlbumTrackSortNumber(filenameMatch?.[1]);
  if (filenameNumber !== null) return String(filenameNumber);
  return String(Number.isInteger(firstIndex) && firstIndex >= 0 ? firstIndex + 1 : 1);
}

function restoreTagEditorAutoNumberValues() {
  const snapshots = state.tagEditor.autoNumberTrackNumberSnapshots || {};
  Object.entries(snapshots).forEach(([path, snapshot]) => {
    const values = { ...(state.tagEditor.values[path] || {}) };
    if (snapshot?.hasValue) {
      values.track_number = snapshot.value;
    } else {
      delete values.track_number;
    }
    state.tagEditor.values[path] = values;
  });
  state.tagEditor.autoNumberActive = false;
  state.tagEditor.autoNumberAppliedSelectionSignature = '';
  state.tagEditor.autoNumberTrackNumberSnapshots = {};
  return Object.keys(snapshots).length > 0;
}

function syncTagEditorAutoNumberControls() {
  if (
    typeof document === 'undefined'
    || typeof document.getElementById !== 'function'
    || typeof getSelectedTagEditorPaths !== 'function'
  ) return;
  const controls = document.getElementById('tag-editor-auto-number-controls');
  const startInput = document.getElementById('tag-editor-auto-number-start');
  const button = document.getElementById('tag-editor-auto-number');
  if (!controls || !startInput || !button) return;
  const tracks = Array.isArray(state.tagEditor.tracks) ? state.tagEditor.tracks : [];
  const selectedPaths = getSelectedTagEditorPaths(tracks);
  const { indexes, orderedTracks, selectedPathSet } = getOrderedSelectedTrackIndexes(
    tracks,
    selectedPaths,
  );
  const eligible = indexes.length >= 2
    && indexes.length === selectedPathSet.size
    && indexes.every((index, offset) => index === indexes[0] + offset);
  const selectionSignature = indexes
    .map((index) => String(orderedTracks[index]?.path || ''))
    .join('\n');
  const appliedSelectionMatches = Boolean(state.tagEditor.autoNumberActive)
    && selectionSignature === String(
      state.tagEditor.autoNumberAppliedSelectionSignature || '',
    );
  controls.hidden = !eligible;
  button.disabled = !eligible;
  button.setAttribute('aria-pressed', appliedSelectionMatches ? 'true' : 'false');
  if (!eligible) {
    state.tagEditor.autoNumberSelectionSignature = '';
    return;
  }
  const selectionChanged = selectionSignature !== String(
    state.tagEditor.autoNumberSelectionSignature || '',
  );
  const rememberedStart = Number(state.tagEditor.autoNumberStartValue);
  const currentStart = Number(startInput.value);
  const preservedStart = Number.isInteger(rememberedStart) && rememberedStart > 0
    ? rememberedStart
    : currentStart;
  const nextStart = !selectionChanged && Number.isInteger(preservedStart) && preservedStart > 0
    ? String(preservedStart)
    : deriveTagEditorAutoNumberStart(tracks, selectedPaths);
  state.tagEditor.autoNumberSelectionSignature = selectionSignature;
  state.tagEditor.autoNumberStartValue = nextStart;
  startInput.value = nextStart;
}

function tagEditsExplicitlyChangeAlbumArtist(tagEdits) {
  return Boolean(
    tagEdits
    && typeof tagEdits === 'object'
    && !Array.isArray(tagEdits)
    && Object.values(tagEdits).some((edits) => (
      edits
      && typeof edits === 'object'
      && Object.prototype.hasOwnProperty.call(edits, 'album_artist')
    )),
  );
}

const MOUNTED_GALLERY_REPLACEMENT_TAG_FIELDS = new Set([
  'album',
  'album_artist',
  'year',
  'edition',
  'exception_type',
]);

function tagEditsRequireMountedGalleryChildReplacement(tagEdits) {
  return Boolean(
    tagEdits
    && typeof tagEdits === 'object'
    && !Array.isArray(tagEdits)
    && Object.values(tagEdits).some((edits) => (
      edits
      && typeof edits === 'object'
      && Object.keys(edits).some((field) => (
        MOUNTED_GALLERY_REPLACEMENT_TAG_FIELDS.has(field)
      ))
    )),
  );
}

function settleTagEditorSessionMutationClaim(tagEditor = state.tagEditor) {
  const claim = tagEditor?.sessionMutationClaim;
  if (!claim) return;
  tagEditor.sessionMutationClaim = null;
  settleTagEditViewMutation(claim);
}

function scheduleTagEditorRenderAfterPaint(tagEditor, els) {
  const render = () => {
    if (state.tagEditor !== tagEditor || !els.overlay || els.overlay.hidden) return;
    renderTagEditor();
    syncTagEditorAutoNumberControls();
    if (els.list) els.list.hidden = false;
    if (els.form) els.form.hidden = false;
    els.overlay.removeAttribute?.('aria-busy');
  };
  if (typeof scheduleBrowserAnimationFrame !== 'function') {
    render();
    return;
  }
  scheduleBrowserAnimationFrame(() => scheduleBrowserAnimationFrame(render));
}

let tagEditorSheetLayer = null, tagConfirmSheetLayer = null;
function openTagEditor(album, options = {}) {
  if (typeof isMobileClient === 'function' && isMobileClient()) return false;
  const els = getTagEditorElements();
  if (!els.overlay || !album) return;
  bindOverlayPointerOrigin(els.overlay);
  const tracksMode = options.tracksMode || 'problematic';
  const tracks = orderAlbumTracks(getTagEditorTracks(album, tracksMode));
  if (!tracks.length) {
    showRepairAlert(tracksMode === 'all' ? 'No tracks to edit.' : 'No problematic tracks to edit.', 'error');
    return;
  }
  const values = {};
  tracks.forEach((track) => {
    const path = String(track.path || '');
    values[path] = getTrackTagInitialValues(track, album);
  });
  settleTagEditorSessionMutationClaim();
  const tagEditor = {
    album,
    tracks,
    selectedPaths: [String(tracks[0].path || '')].filter(Boolean),
    anchorPath: String(tracks[0].path || ''),
    dragSelecting: false,
    dragAnchorPath: '',
    reorder: null,
    values,
    sessionMutationClaim: claimTagEditViewMutation(album),
    autoNumberStartValue: '',
    autoNumberSelectionSignature: '',
    autoNumberActive: false,
    autoNumberAppliedSelectionSignature: '',
    autoNumberTrackNumberSnapshots: {},
  };
  state.tagEditor = tagEditor;
  if (els.list) els.list.hidden = true;
  if (els.form) els.form.hidden = true;
  if (els.applyButton) els.applyButton.disabled = true;
  els.overlay.setAttribute?.('aria-busy', 'true');
  tagEditorSheetLayer?.();
  const parent = typeof getTopmostOpenModal === 'function' ? getTopmostOpenModal() : null;
  tagEditorSheetLayer = window.AlbumHavenBottomSheet?.acquireChildLayer(els.overlay, parent) || null;
  els.overlay.hidden = false;
  document.body.classList.add('modal-open');
  scheduleTagEditorRenderAfterPaint(tagEditor, els);
}

function autoNumberSelectedTagEditorTracks() {
  const tracks = Array.isArray(state.tagEditor.tracks) ? state.tagEditor.tracks : [];
  const selectedPaths = getSelectedTagEditorPaths(tracks);
  const { indexes, orderedTracks } = getOrderedSelectedTrackIndexes(tracks, selectedPaths);
  const selectionSignature = indexes
    .map((index) => String(orderedTracks[index]?.path || ''))
    .join('\n');
  const appliedSelectionMatches = Boolean(state.tagEditor.autoNumberActive)
    && selectionSignature === String(
      state.tagEditor.autoNumberAppliedSelectionSignature || '',
    );
  if (appliedSelectionMatches) {
    restoreTagEditorAutoNumberValues();
    renderTagEditor({ preserveTrackList: true });
    syncTagEditorAutoNumberControls();
    return;
  }
  const els = typeof getTagEditorElements === 'function' ? getTagEditorElements() : {};
  const startInput = els.autoNumberStart || (
    typeof document !== 'undefined' && typeof document.getElementById === 'function'
      ? document.getElementById('tag-editor-auto-number-start')
      : null
  );
  const trackNumbersByPath = buildSelectedTrackNumberValues(
    tracks,
    selectedPaths,
    startInput?.value,
  );
  const numberedPaths = Object.keys(trackNumbersByPath);
  if (numberedPaths.length < 2) return;

  const trackNumberSnapshots = {};
  numberedPaths.forEach((path) => {
    const currentValues = state.tagEditor.values[path] || {};
    trackNumberSnapshots[path] = {
      hasValue: Object.prototype.hasOwnProperty.call(currentValues, 'track_number'),
      value: currentValues.track_number,
    };
    state.tagEditor.values[path] = {
      ...currentValues,
      track_number: trackNumbersByPath[path],
    };
  });
  state.tagEditor.autoNumberActive = true;
  state.tagEditor.autoNumberAppliedSelectionSignature = selectionSignature;
  state.tagEditor.autoNumberTrackNumberSnapshots = trackNumberSnapshots;
  renderTagEditor({ preserveTrackList: true });
  syncTagEditorAutoNumberControls();
}

function closeTagEditorFromBackdrop() {
  const changedUpdates = buildChangedTagEditorUpdates(
    state.tagEditor.album,
    state.tagEditor.tracks || [],
    state.tagEditor.values || {},
  );
  if (!Object.keys(changedUpdates).length) closeTagEditor();
}

function closeTagEditor() {
  if (typeof clearTagEditorReorderCue === 'function') clearTagEditorReorderCue();
  const els = getTagEditorElements();
  if (!els.overlay) return;
  settleTagEditorSessionMutationClaim();
  els.overlay.hidden = true;
  const layer = tagEditorSheetLayer; tagEditorSheetLayer = null; layer?.();
  const trackModalOpen = !document.getElementById('track-modal')?.hidden;
  const utilityModalOpen = !document.getElementById('utility-modal')?.hidden;
  const confirmOpen = !document.getElementById('tag-edit-confirm-modal')?.hidden;
  if (!trackModalOpen && !utilityModalOpen && !confirmOpen) {
    document.body.classList.remove('modal-open');
  }
}

function openTagEditConfirmModal() {
  const els = getTagEditConfirmElements();
  if (!els.overlay) return;
  const album = state.tagEditor.album;
  const updates = buildChangedTagEditorUpdates(
    album,
    state.tagEditor.tracks || [],
    state.tagEditor.values || {},
  );
  if (els.nonAlbumWarning) {
    els.nonAlbumWarning.hidden = !nonAlbumRarityWarningFingerprint(album, updates);
  }
  const galleryScroll = document.getElementById('albums-scroll');
  state.tagEditor.originGalleryScrollPosition = galleryScroll
    && Number.isFinite(Number(galleryScroll.scrollTop))
    && Number.isFinite(Number(galleryScroll.scrollLeft))
    ? {
      scrollLeft: Number(galleryScroll.scrollLeft),
      scrollTop: Number(galleryScroll.scrollTop),
    }
    : null;
  tagConfirmSheetLayer?.();
  const parent = typeof getTopmostOpenModal === 'function' ? getTopmostOpenModal() : null;
  tagConfirmSheetLayer = window.AlbumHavenBottomSheet?.acquireChildLayer(els.overlay, parent) || null;
  els.overlay.hidden = false;
  document.body.classList.add('modal-open');
}

function closeTagEditConfirmModal() {
  const els = getTagEditConfirmElements();
  if (!els.overlay) return;
  els.overlay.hidden = true;
  const layer = tagConfirmSheetLayer; tagConfirmSheetLayer = null; layer?.();
  const trackModalOpen = !document.getElementById('track-modal')?.hidden;
  const utilityModalOpen = !document.getElementById('utility-modal')?.hidden;
  const tagEditorOpen = !document.getElementById('tag-editor-modal')?.hidden;
  if (!trackModalOpen && !utilityModalOpen && !tagEditorOpen) {
    document.body.classList.remove('modal-open');
  }
}

function readTagEditOriginViewStateRevision() {
  return Number(state.ui?.viewStateRevision || 0);
}

function readProblematicMutationOriginKey() {
  const utilityModal = typeof document !== 'undefined'
    && typeof document.getElementById === 'function'
    ? document.getElementById('utility-modal')
    : null;
  if (
    !utilityModal
    || utilityModal.hidden
    || state.utility?.activeTab !== 'problematic-files'
  ) return '';
  return String(state.utility?.selectedProblematicKey || '').trim();
}

function tagEditOriginStillOwnsView(originatingViewStateRevision) {
  return readTagEditOriginViewStateRevision() === Number(originatingViewStateRevision || 0);
}

async function confirmRepairSelectedAlbum() {
  if (state.utility.pendingRepairAction === 'saved-loop-delete') {
    const id = state.utility.pendingSavedLoopDeleteId;
    if (!id || state.utility.savedLoopDeleteBusy || state.utility.allowedActions?.['library.loops.delete'] !== true) return;
    state.utility.savedLoopDeleteBusy = true;
    const confirm = getRepairConfirmElements();
    if (confirm.accept) confirm.accept.disabled = true;
    try {
      if (await deleteSavedLoop(id, { confirmed: true }) === true) closeRepairConfirmModal();
    } finally {
      state.utility.savedLoopDeleteBusy = false;
      if (confirm.accept) confirm.accept.disabled = false;
    }
    return;
  }
  if (state.utility.pendingRepairAction === 'suggestions') return confirmProblemSuggestions();
  if (state.utility.pendingRepairAction === 'revert-rule') {
    const pending = state.utility.pendingRuleRevert;
    if (!pending || state.utility.ruleRevertBusy) return;
    state.utility.ruleRevertBusy = true;
    const confirm = getRepairConfirmElements();
    if (confirm.accept) confirm.accept.disabled = true;
    try {
      const succeeded = pending.kind === 'version-exception'
        ? await revertVersionException(pending.key)
        : await queueProblemExclusionRevert(pending.item);
      if (succeeded === true) { closeRepairConfirmModal(); state.utility.pendingRuleRevert = null; }
    } finally {
      state.utility.ruleRevertBusy = false;
      if (confirm.accept) confirm.accept.disabled = false;
    }
    return;
  }
  const album = (state.utility.problematicFiles || []).find((item) => item.key === state.utility.pendingRepairKey) || getSelectedProblematicAlbum();
  if (!album) {
    showToast('No album selected for repair.', 'error', 3200);
    closeRepairConfirmModal();
    return;
  }
  const action = state.utility.pendingRepairAction || 'repair';
  const selectedRows = action === 'repair' ? getSelectedRepairRowKeys() : [];
  const ignoredRows = action === 'detected' ? getIgnoredRepairRowKeys() : [];
  const separateRows = action === 'separate-release' ? getSelectedSeparateReleaseKeys() : [];
  if (action === 'detected') {
    if (!ignoredRows.length) {
      showToast('No suggested actions are selected.', 'error', 3200);
      closeRepairConfirmModal();
      return;
    }
    const exclusionItems = ignoredRows.map((rowKey) => {
      if (typeof buildProblemExclusionItemFromAlbum === 'function') {
        return buildProblemExclusionItemFromAlbum(album, rowKey);
      }
      const row = (Array.isArray(album.album_problem_rows) ? album.album_problem_rows : [])
        .find((candidate) => String(candidate?.row_key || '') === String(rowKey || ''));
      return row ? {
        ...row,
        row_key: String(rowKey || ''),
        scope: 'album',
        album_key: String(album.key || ''),
        artist: String(album.album_artist || album.raw_album_artist || ''),
        album: String(album.name || album.raw_name || ''),
        year: String(album.year || ''),
        problem_reason: String(row.reason || ''),
      } : null;
    }).filter(Boolean);
    if (exclusionItems.length !== ignoredRows.length) {
      showToast('Unable to identify the selected problem exclusion.', 'error', 3200);
      closeRepairConfirmModal();
      return;
    }
    await queueProblemExclusionCreate({ album, items: exclusionItems });
    return;
  }
  const selectedPaths = new Set(selectedRows.map((value) => String(value).split('::')[0]).filter(Boolean));
  const actionPaths = new Set(selectedRows.map((value) => String(value).split('::')[0]).filter(Boolean));
  if (!selectedRows.length && !separateRows.length) {
    showToast('No suggested actions are selected.', 'error', 3200);
    closeRepairConfirmModal();
    return;
  }
  const progressCount = action === 'repair'
    ? selectedPaths.size
    : Math.max(actionPaths.size, separateRows.length ? (Array.isArray(album.tracks) ? album.tracks.length : 1) : 0);
  const originatingViewStateRevision = readTagEditOriginViewStateRevision();
  showRepairProgressOverlay(progressCount);
  try {
    const response = await fetch('/utilities/repair-album', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmed: true, album, selected_rows: selectedRows, ignored_rows: [], separate_release_keys: separateRows }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      throw new Error(data.error || 'Failed to repair local tags');
    }
    closeRepairConfirmModal();
    const updatedAlbums = Array.isArray(data.updated_albums)
      ? data.updated_albums
      : [data.updated_album].filter(Boolean);
    if (tagEditOriginStillOwnsView(originatingViewStateRevision)) {
      const reconciledUpdatedAlbums = applyUpdatedAlbumsToCurrentView(
        updatedAlbums,
        { originalAlbum: album, preserveScroll: true },
      );
      updateOpenTrackModalAfterTagEdit(album, reconciledUpdatedAlbums);
    }
    const requestedFileCount = selectedPaths.size;
    const repairedCount = Number(data.changed_count || 0);
    const fileWord = requestedFileCount === 1 ? 'file' : 'files';
    const message = requestedFileCount
      ? `Applied selected repairs to ${repairedCount} of ${requestedFileCount} ${fileWord}.`
      : 'Updated ignored suggestions.';
    console.log('[AlbumHaven][Utilities] Tags repair completed.', { message, response: data });
    hideRepairProgressOverlay();
    showRepairAlert('Tag changes queued. Finalizing library view...', 'success', null);
    if (data.save_task_id) {
      watchSaveTask(data.save_task_id, {
        originalAlbum: album,
        originatingViewStateRevision,
        problematicMutationOriginKey: String(
          state.utility?.selectedProblematicKey || '',
        ).trim(),
      });
    } else if (Object.prototype.hasOwnProperty.call(data, 'updated_problematic_album')) {
      applyRepairResultToProblematicFiles(album, data.updated_problematic_album || null);
    }
  } catch (error) {
    console.error('[AlbumHaven][Utilities] Failed to repair local tags.', error);
    showRepairAlert(error.message || 'Failed to repair local tags.', 'error');
  } finally {
    hideRepairProgressOverlay();
  }
}

function buildTagEditUpdateFingerprint(updates) {
  return JSON.stringify(
    Object.keys(updates || {}).sort().map((path) => [
      path,
      Object.keys(updates[path] || {}).sort().map((field) => [
        field,
        String(updates[path]?.[field] ?? '').trim(),
      ]),
    ]),
  );
}

function nonAlbumRarityWarningFingerprint(album, updates) {
  const tracks = [
    ...(Array.isArray(state.tagEditor.tracks) ? state.tagEditor.tracks : []),
    ...(Array.isArray(album?.tracks) ? album.tracks : []),
  ];
  const albumByPath = new Map(
    tracks
      .map((track) => [
        String(track?.path || ''),
        String(track?.album || '').trim(),
      ])
      .filter(([path]) => path),
  );
  const requiresWarning = Object.entries(updates || {}).some(([path, edits]) => {
    const effectiveAlbum = Object.prototype.hasOwnProperty.call(edits || {}, 'album')
      ? String(edits?.album || '').trim()
      : String(albumByPath.get(String(path || '')) || '').trim();
    return (
      /\bnon[\s-]*album\s+rarity\b/i.test(String(edits?.exception_type || '').trim())
      && Boolean(effectiveAlbum)
    );
  });
  return requiresWarning ? buildTagEditUpdateFingerprint(updates) : '';
}

const TAG_EDIT_SAVE_TASK_WATCH_SETTLEMENT_MS = 300;
let pendingProblematicOptimisticEditGeneration = 0;

function buildInverseTagEditorUpdates(album, tracks, updates) {
  const originalTracksByPath = new Map([
    ...(Array.isArray(album?.tracks) ? album.tracks : []),
    ...(Array.isArray(tracks) ? tracks : []),
  ].map((track) => [String(track?.path || ''), track]));
  return Object.fromEntries(Object.entries(updates || {}).map(([path, edits]) => {
    const originalTrack = originalTracksByPath.get(String(path || '')) || {};
    const originalValues = getTrackTagInitialValues(originalTrack, album);
    const inverseEdits = Object.fromEntries(Object.keys(edits || {}).map((field) => [
      field,
      originalValues[field],
    ]));
    return [path, inverseEdits];
  }));
}

function registerPendingProblematicOptimisticEdit(originalAlbum, optimisticAlbums, tagEdits) {
  pendingProblematicOptimisticEditGeneration += 1;
  const utility = state.utility || (state.utility = {});
  const registry = utility.pendingProblematicSaveTasks
    || (utility.pendingProblematicSaveTasks = {});
  const key = `optimistic-tag-edit-${pendingProblematicOptimisticEditGeneration}`;
  let resolveTask;
  let resolveAccepted;
  const promise = new Promise((resolve) => {
    resolveTask = resolve;
  });
  const acceptedPromise = new Promise((resolve) => {
    resolveAccepted = resolve;
  });
  const entry = {
    promise,
    acceptedPromise,
    optimisticAlbums: Array.isArray(optimisticAlbums) ? optimisticAlbums : [],
    trackPaths: Array.from(new Set(
      Object.keys(tagEdits || {}).map((path) => String(path || '')).filter(Boolean),
    )),
  };
  registry[key] = entry;
  let accepted = false;
  let settled = false;
  return {
    entry,
    key,
    accept() {
      if (accepted) return;
      accepted = true;
      resolveAccepted();
    },
    settle() {
      if (settled) return;
      settled = true;
      if (!accepted) {
        accepted = true;
        resolveAccepted();
      }
      if (registry[key] === entry) delete registry[key];
      resolveTask();
    },
  };
}

function scheduleTagEditSaveTaskWatch(taskId, options) {
  const normalizedTaskId = String(taskId || '').trim();
  const utility = state.utility || (state.utility = {});
  const registry = utility.pendingProblematicSaveTasks
    || (utility.pendingProblematicSaveTasks = {});
  const pendingProblematicEntry = options?.pendingProblematicEntry || null;
  const trackPaths = Array.from(new Set([
    ...(Array.isArray(options?.originalAlbum?.tracks)
      ? options.originalAlbum.tracks.map((track) => String(track?.path || ''))
      : []),
    ...Object.keys(options?.tagEdits || {}).map((path) => String(path || '')),
  ].filter(Boolean)));
  let resolveTrackedTask;
  const trackedTask = pendingProblematicEntry?.entry?.promise || new Promise((resolve) => {
    resolveTrackedTask = resolve;
  });
  if (normalizedTaskId && !pendingProblematicEntry) {
    registry[normalizedTaskId] = {
      promise: trackedTask,
      trackPaths,
      optimisticAlbums: Array.isArray(options?.optimisticAlbums)
        ? options.optimisticAlbums
        : [],
    };
  }
  const startWatch = () => {
    let watchResult;
    try {
      watchResult = watchSaveTask(taskId, options);
    } catch (error) {
      watchResult = Promise.reject(error);
    }
    Promise.resolve(watchResult)
      .catch((error) => {
        console.error('[AlbumHaven][SaveTask] Unexpected save-task watcher failure.', error);
      })
      .finally(() => {
        if (!pendingProblematicEntry && registry[normalizedTaskId]?.promise === trackedTask) {
          delete registry[normalizedTaskId];
        }
        if (pendingProblematicEntry) {
          pendingProblematicEntry.settle();
        } else {
          resolveTrackedTask();
        }
      });
  };
  if (typeof scheduleBrowserAnimationFrame !== 'function') {
    startWatch();
    return;
  }
  scheduleBrowserAnimationFrame(() => {
    scheduleBrowserAnimationFrame(() => {
      if (typeof scheduleBrowserTimeout === 'function') {
        scheduleBrowserTimeout(
          startWatch,
          TAG_EDIT_SAVE_TASK_WATCH_SETTLEMENT_MS,
        );
      } else {
        startWatch();
      }
    });
  });
}

async function confirmManualTagEdit() {
  const album = state.tagEditor.album;
  const updates = buildChangedTagEditorUpdates(album, state.tagEditor.tracks || [], state.tagEditor.values || {});
  const editedPaths = Object.keys(updates).filter(Boolean);
  if (!album || !editedPaths.length) {
    showRepairAlert('No tag edits to apply.', 'error');
    closeTagEditConfirmModal();
    return;
  }

  const problematicMutationOriginKey = readProblematicMutationOriginKey();
  const inverseUpdates = buildInverseTagEditorUpdates(
    album,
    state.tagEditor.tracks || [],
    updates,
  );
  closeTagEditConfirmModal();
  if (typeof claimLocalViewStateNavigation === 'function') {
    claimLocalViewStateNavigation();
  }
  const originatingViewStateRevision = readTagEditOriginViewStateRevision();
  const originatingViewRequestUrl = typeof buildApiUrl === 'function'
    ? String(buildApiUrl(state.view) || '').trim()
    : '';
  const originatingSearchContext = { ...(state.view?.search_context || {}) };
  const tagEditMutationClaim = claimTagEditViewMutation(album, editedPaths, updates);
  settleTagEditorSessionMutationClaim();
  const optimisticUpdatedAlbums = buildOptimisticUpdatedAlbumsFromEdits(album, updates);
  // Tag regrouping has no canonical inventory generation receipt. Its output
  // cannot inherit personal taste from tags, paths, or the old album identity.
  for (const optimisticAlbum of optimisticUpdatedAlbums) {
    delete optimisticAlbum.album_preference;
    delete optimisticAlbum.album_rating;
    delete optimisticAlbum.favorite;
    delete optimisticAlbum.is_favorite;
  }
  const pendingProblematicEntry = registerPendingProblematicOptimisticEdit(
    album,
    optimisticUpdatedAlbums,
    updates,
  );
  const provisionalProblematicMutation = (
    problematicMutationOriginKey
    && typeof claimProblematicSaveTaskMutation === 'function'
  )
    ? claimProblematicSaveTaskMutation(
      pendingProblematicEntry.key,
      album,
      problematicMutationOriginKey,
    )
    : null;
  const absoluteScrollPosition = state.tagEditor.originGalleryScrollPosition
    && Number.isFinite(Number(state.tagEditor.originGalleryScrollPosition.scrollTop))
    && Number.isFinite(Number(state.tagEditor.originGalleryScrollPosition.scrollLeft))
    ? {
      scrollLeft: Number(state.tagEditor.originGalleryScrollPosition.scrollLeft),
      scrollTop: Number(state.tagEditor.originGalleryScrollPosition.scrollTop),
    }
    : null;
  const renderOptions = {
    preserveScroll: true,
    preserveAbsoluteScroll: true,
    preserveMountedGalleryChildren: true,
    ...(absoluteScrollPosition ? { absoluteScrollPosition } : {}),
  };
  closeTagEditor();
  const reconciledOptimisticAlbums = applyUpdatedAlbumsToCurrentView(
    optimisticUpdatedAlbums,
    {
      skipRender: true,
      originalAlbum: album,
      tagEdits: updates,
    },
  );
  if (typeof applyTagEditsToNonAlbumView === 'function') {
    applyTagEditsToNonAlbumView(album, updates);
  }
  updateOpenTrackModalAfterTagEdit(album, reconciledOptimisticAlbums, {
    tagEditMutationClaim,
  });
  renderView(renderOptions);
  showRepairAlert('Writing tag changes...', 'success', null);
  let failedLogHistoryEntryId = '';
  try {
    const requestPayload = { confirmed: true, album, updates };
    if (problematicMutationOriginKey) {
      requestPayload.problematic_files_origin = true;
    }
    const response = await fetch('/utilities/edit-tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestPayload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      if (data.log_entry) {
        failedLogHistoryEntryId = String(data.log_entry.id || '');
        try {
          await prependUtilityLogHistoryEntry(data.log_entry);
        } catch (historyError) {
          console.warn('[AlbumHaven][Utilities] Could not persist the failed tag edit in browser history.', historyError);
        }
      }
      throw new Error(data.error || 'Failed to apply tag edits');
    }
    const updatedAlbums = Array.isArray(data.updated_albums)
      ? data.updated_albums
      : [data.updated_album].filter(Boolean);
    const saveTaskCompleted = Boolean(data.save_task_id)
      && String(data.save_task_status || '').trim().toLowerCase() === 'completed';
    const responseIsTerminal = !data.save_task_id || saveTaskCompleted;
    const completedResponseNeedsCanonicalRefresh = saveTaskCompleted
      && Boolean(data.requires_view_refresh);
    const committedValues = data.committed_values
      && typeof data.committed_values === 'object'
      && !Array.isArray(data.committed_values)
      ? data.committed_values
      : null;
    const authoritativeTagEdits = committedValues || updates;
    const responseOwnsVisibleResources = tagEditOriginStillOwnsView(originatingViewStateRevision)
      && tagEditViewMutationStillOwnsResources(tagEditMutationClaim);
    if (committedValues && responseOwnsVisibleResources) {
      installCommittedTagValues(album, committedValues);
    }
    if (
      responseIsTerminal
      && updatedAlbums.length
      && responseOwnsVisibleResources
      && !completedResponseNeedsCanonicalRefresh
    ) {
      const reconciledUpdatedAlbums = applyUpdatedAlbumsToCurrentView(
        updatedAlbums,
        {
          skipRender: true,
          originalAlbum: album,
          preserveScroll: true,
          tagEdits: authoritativeTagEdits,
        },
      );
      updateOpenTrackModalAfterTagEdit(album, reconciledUpdatedAlbums);
      renderView(renderOptions);
    }
    const saveTaskWatchOptions = {
      originalAlbum: album,
      originatingViewStateRevision,
      originatingViewRequestUrl,
      originatingSearchContext,
      tagEditMutationClaim,
      tagEdits: authoritativeTagEdits,
      preserveAbsoluteScroll: true,
      absoluteScrollPosition,
      problematicMutationOriginKey,
      optimisticAlbums: optimisticUpdatedAlbums,
      pendingProblematicEntry,
    };
    if (
      provisionalProblematicMutation
      && data.save_task_id
      && String(provisionalProblematicMutation.taskId || '') === pendingProblematicEntry.key
    ) {
      provisionalProblematicMutation.taskId = String(data.save_task_id);
    }
    if (completedResponseNeedsCanonicalRefresh) {
      pendingProblematicEntry.accept();
      await watchSaveTask(data.save_task_id, {
        ...saveTaskWatchOptions,
        terminalPayload: data,
      });
    } else if (data.save_task_id && !saveTaskCompleted) {
      pendingProblematicEntry.accept();
      scheduleTagEditSaveTaskWatch(data.save_task_id, saveTaskWatchOptions);
    } else if (
      Object.prototype.hasOwnProperty.call(data, 'updated_problematic_album')
      && responseOwnsVisibleResources
    ) {
      applyRepairResultToProblematicFiles(album, data.updated_problematic_album);
    }
    showRepairAlert(
      responseIsTerminal ? 'Tag changes saved.' : 'Tag changes queued. Finalizing library view...',
      'success',
      2000,
    );
    if (responseIsTerminal) {
      pendingProblematicEntry.accept();
      pendingProblematicEntry.settle();
      if (
        provisionalProblematicMutation
        && !completedResponseNeedsCanonicalRefresh
        && typeof settleProblematicSaveTaskMutation === 'function'
      ) {
        await settleProblematicSaveTaskMutation(
          String(provisionalProblematicMutation.taskId || ''),
          { reconcileSelection: true },
        );
      }
      if (!completedResponseNeedsCanonicalRefresh) {
        settleTagEditViewMutation(tagEditMutationClaim);
      }
    }
  } catch (error) {
    pendingProblematicEntry.settle();
    if (
      provisionalProblematicMutation
      && typeof settleProblematicSaveTaskMutation === 'function'
    ) {
      await settleProblematicSaveTaskMutation(
        String(provisionalProblematicMutation.taskId || ''),
      );
    }
    console.error('[AlbumHaven][Utilities] Failed to apply manual tag edits.', error);
    if (
      tagEditOriginStillOwnsView(originatingViewStateRevision)
      && tagEditViewMutationStillOwnsResources(tagEditMutationClaim)
    ) {
      const restoredAlbums = applyUpdatedAlbumsToCurrentView(
        [album],
        {
          skipRender: true,
          originalAlbum: album,
          preserveScroll: true,
          tagEdits: inverseUpdates,
        },
      );
      if (typeof applyTagEditsToNonAlbumView === 'function') {
        applyTagEditsToNonAlbumView(album, inverseUpdates);
      }
      updateOpenTrackModalAfterTagEdit(album, restoredAlbums);
      renderView(renderOptions);
    }
    showRepairAlert(
      'Failed to edit tags.',
      'error',
      null,
      {
        logHistoryEntryId: failedLogHistoryEntryId,
        logHistoryLink: Boolean(failedLogHistoryEntryId),
      },
    );
    releaseFailedTagEditViewMutation(tagEditMutationClaim);
  }
}


function flattenVisibleAlbums() {
  const sources = [state.view.primary_artist_groups, state.view.family_artist_groups, state.view.artist_groups];
  const seenGroups = new Set();
  const albums = [];
  sources.forEach((groups) => {
    (groups || []).forEach((group) => {
      const marker = `${group.artist}::${(group.albums || []).length}`;
      if (seenGroups.has(marker) && groups === state.view.artist_groups) return;
      seenGroups.add(marker);
      (group.albums || []).forEach((album) => albums.push(album));
    });
  });
  return albums;
}

function getVariantKeywordPattern() {
  return /(instrumental|remix|remaster|edition|special|deluxe|revisited|rerecord|version(?=\s*[\)\]\}]))/i;
}


function findVariantSuffixIndex(name) {
  const raw = String(name || '').trim();
  if (!raw) return -1;

  const keywordPattern = getVariantKeywordPattern();

  const bracketPatterns = [
    /\s*\(([^)]*)\)\s*$/i,
    /\s*\[([^\]]*)\]\s*$/i,
    /\s*\{([^}]*)\}\s*$/i,
  ];
  for (const pattern of bracketPatterns) {
    const match = raw.match(pattern);
    if (match && keywordPattern.test(match[1] || '')) {
      return match.index;
    }
  }

  const separatedPattern = /\s*[-:–—]\s*.*$/;
  const separatedMatch = raw.match(separatedPattern);
  if (separatedMatch && keywordPattern.test(separatedMatch[0] || '')) {
    return separatedMatch.index;
  }

  const wordPattern = /\S+/g;
  const words = [];
  let match;
  while ((match = wordPattern.exec(raw)) !== null) {
    words.push({
      text: match[0],
      index: match.index,
    });
  }

  for (let i = 1; i < words.length; i += 1) {
    const word = words[i].text || '';
    const bareWord = word.replace(/^[\(\[\{]+|[\)\]\}]+$/g, '');
    const nextWord = i + 1 < words.length ? (words[i + 1].text || '') : '';
    const startsVariant =
      keywordPattern.test(bareWord) ||
      (/^[\(\[\{]/.test(nextWord) && keywordPattern.test(nextWord));

    if (!startsVariant) continue;

    return words[i].index;
  }

  return -1;
}

function normalizeAlbumBaseName(name) {
  let text = String(name || '').trim();
  if (!text) return '';
  text = text
    .replace(/\s*\((?:19|20)\d{2}[^)]*\)$/i, '')
    .replace(/\s*\[(?:19|20)\d{2}[^\]]*\]$/i, '')
    .replace(/\s*\{(?:19|20)\d{2}[^}]*\}$/i, '');

  let previous = null;
  while (text && text !== previous) {
    previous = text;
    const suffixIndex = findVariantSuffixIndex(text);
    if (suffixIndex > 0) {
      text = text.slice(0, suffixIndex).trim();
    }
  }

  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function isInstrumentalVariant(album) {
  const name = String((album && album.name) || '').toLowerCase();
  return /instrumental/i.test(name);
}

function extractVariantLabel(album, baseName, isFirst) {
  const yearSuffix = album.year ? ` - ${album.year}` : '';
  const instrumental = isInstrumentalVariant(album);

  const rawName = String(album.name || '').trim();
  const suffixIndex = findVariantSuffixIndex(rawName);

  let variant = '';
  if (suffixIndex > 0) {
    variant = rawName.slice(suffixIndex).trim();
  } else {
    const base = String(baseName || '').trim();
    variant = rawName;
    if (base) {
      const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      variant = variant.replace(new RegExp(`^${escapedBase}\\s*`, 'i'), '').trim();
    }
  }

  variant = variant
    .replace(/^[-:–—]+\s*/, '')
    .replace(/^\((.*)\)$/, '$1')
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/^\{(.*)\}$/, '$1')
    .trim();

  const editionText = String(album.edition || '').trim();

  if (editionText) {
    if (instrumental && !/instrumental/i.test(editionText)) {
      return `${editionText} Instrumental${yearSuffix}`;
    }
    return `${editionText}${yearSuffix}`;
  }

  if (isFirst && !instrumental && !variant) {
    return `Original${yearSuffix}`;
  }

  if (!variant) {
    if (instrumental) return `Instrumental${yearSuffix}`;
    return album.year ? String(album.year) : 'Alternate Release';
  }

  return `${variant}${yearSuffix}`;
}

function isPlainAlbumVariant(album) {
  if (!album) return false;
  if (isInstrumentalVariant(album)) return false;
  if (String(album.edition || '').trim()) return false;
  return findVariantSuffixIndex(String(album.name || '').trim()) <= 0;
}

function pickOriginalAlbumVariant(albums, targetBase, rootKey = '') {
  const candidates = (albums || []).filter((item) => (
    isPlainAlbumVariant(item) && normalizeAlbumBaseName(item.name) === targetBase
  ));
  if (!candidates.length) {
    const rootedAlbum = (albums || []).find((item) => String(item?.key || '') === String(rootKey || ''));
    return rootedAlbum || null;
  }
  return sortAlbumVariants(candidates)[0] || null;
}

function compareAlbumVariants(a, b) {
  const ay = Number(a.year) || 0;
  const by = Number(b.year) || 0;
  if (ay !== by) return ay - by;

  const aPlain = isPlainAlbumVariant(a) ? 0 : 1;
  const bPlain = isPlainAlbumVariant(b) ? 0 : 1;
  if (aPlain !== bPlain) return aPlain - bPlain;

  const aReleaseDate = String(a.release_date || '');
  const bReleaseDate = String(b.release_date || '');
  if (aReleaseDate !== bReleaseDate) {
    if (!aReleaseDate) return 1;
    if (!bReleaseDate) return -1;
    return aReleaseDate.localeCompare(bReleaseDate, undefined, { sensitivity: 'base' });
  }

  const aInstrumental = isInstrumentalVariant(a) ? 1 : 0;
  const bInstrumental = isInstrumentalVariant(b) ? 1 : 0;
  if (aInstrumental !== bInstrumental) return aInstrumental - bInstrumental;

  const aEdition = String(a.edition || '');
  const bEdition = String(b.edition || '');
  const editionCmp = aEdition.localeCompare(bEdition, undefined, { sensitivity: 'base' });
  if (editionCmp !== 0) return editionCmp;

  return String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });
}

function sortAlbumVariants(albums) {
  return [...albums].sort(compareAlbumVariants);
}

function getManualVersionLinks() {
  const links = state.view?.manual_version_links;
  return links && typeof links === 'object' ? links : {};
}

function resolveManualVersionRoot(albumKey, manualVersionLinks = getManualVersionLinks()) {
  let current = String(albumKey || '');
  const seen = new Set();
  while (current && !seen.has(current)) {
    seen.add(current);
    const parent = String(manualVersionLinks[current] || '');
    if (!parent) break;
    current = parent;
  }
  return current;
}

function getManualVersionFamilyKeys(albumKey, manualVersionLinks = getManualVersionLinks()) {
  const key = String(albumKey || '');
  if (!key) return new Set();
  const root = resolveManualVersionRoot(key, manualVersionLinks);
  const familyKeys = new Set([key, root]);
  Object.entries(manualVersionLinks).forEach(([childKey]) => {
    if (resolveManualVersionRoot(childKey, manualVersionLinks) === root) {
      familyKeys.add(String(childKey || ''));
    }
  });
  return new Set([...familyKeys].filter(Boolean));
}

function prioritizeManualVersionOrder(albums, rootKey, manualFamilyKeys) {
  const root = String(rootKey || '');
  const manualKeys = manualFamilyKeys instanceof Set ? manualFamilyKeys : new Set();
  const rootAlbums = [];
  const regularAlbums = [];
  const manualChildren = [];

  albums.forEach((item) => {
    const key = String(item?.key || '');
    if (key && key === root) {
      rootAlbums.push(item);
      return;
    }
    if (key && manualKeys.has(key)) {
      manualChildren.push(item);
      return;
    }
    regularAlbums.push(item);
  });

  return [...rootAlbums, ...regularAlbums, ...manualChildren];
}

function albumReleaseIdentity(album) {
  if (!album || typeof album !== 'object') return '';
  const key = String(album.key || '').trim();
  if (key) return `key:${key}`;
  const artist = String(album.album_artist || '').trim().toLowerCase();
  const name = String(album.name || '').trim().toLowerCase();
  const edition = String(album.edition || '').trim().toLowerCase();
  const year = String(album.year || '').trim().toLowerCase();
  return [artist, name, edition, year].some(Boolean)
    ? `fallback:${artist}::${name}::${edition}::${year}`
    : '';
}

function replaceMatchingReleaseCandidate(albums, preferredAlbum) {
  const preferredIdentity = albumReleaseIdentity(preferredAlbum);
  if (!preferredIdentity) {
    return Array.isArray(albums) ? [...albums] : [];
  }

  let replaced = false;
  const nextAlbums = (Array.isArray(albums) ? albums : []).map((item) => {
    if (albumReleaseIdentity(item) !== preferredIdentity) {
      return item;
    }
    replaced = true;
    return preferredAlbum;
  });

  if (!replaced) {
    nextAlbums.push(preferredAlbum);
  }
  return nextAlbums;
}

function getAlbumReleaseSet(album) {
  const visibleAlbums = flattenVisibleAlbums();
  const sameArtistAlbums = visibleAlbums.filter((item) => String(item.album_artist || '') === String(album.album_artist || ''));
  const ignoredVersionKeys = new Set(Array.isArray(state.view.ignored_version_keys) ? state.view.ignored_version_keys.map(String) : []);
  const manualVersionLinks = getManualVersionLinks();
  const manualFamilyKeys = getManualVersionFamilyKeys(String(album.key || ''), manualVersionLinks);
  const hasManualFamily = manualFamilyKeys.size > 1;
  if (ignoredVersionKeys.has(String(album.key || '')) && !hasManualFamily) {
    return {
      releases: [SearchAlbumPresentationProvenance.bridge(album, {
        ...album,
        tabLabel: extractVariantLabel(album, album.name || 'Album', true),
      })],
      selectedIndex: 0,
    };
  }
  const targetBase = normalizeAlbumBaseName(album.name);
  const grouped = [];
  if (hasManualFamily) {
    visibleAlbums.forEach((item) => {
      if (manualFamilyKeys.has(String(item.key || ''))) {
        grouped.push(item);
      }
    });
  }
  sameArtistAlbums.forEach((item) => {
    if (
      normalizeAlbumBaseName(item.name) === targetBase
      && !ignoredVersionKeys.has(String(item.key || ''))
    ) {
      grouped.push(item);
    }
  });
  const deduped = [];
  const seen = new Set();
  grouped.forEach((item) => {
    const key = item.key || `${item.album_artist}::${item.name}::${item.year || ''}::${item.edition || ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(item);
    }
  });
  const dedupedWithPreferredAlbum = replaceMatchingReleaseCandidate(deduped, album);
  const rootKey = hasManualFamily ? resolveManualVersionRoot(String(album.key || ''), manualVersionLinks) : '';
  const sortedVariants = prioritizeManualVersionOrder(
    sortAlbumVariants(dedupedWithPreferredAlbum.length ? dedupedWithPreferredAlbum : [album]),
    rootKey,
    manualFamilyKeys,
  );
  const rootAlbum = pickOriginalAlbumVariant(sortedVariants, targetBase, rootKey) || sortedVariants[0] || album;
  const variants = [
    rootAlbum,
    ...sortedVariants.filter((item) => String(item?.key || '') !== String(rootAlbum?.key || '')),
  ];
  const baseDisplayName = rootAlbum?.name || variants[0]?.name || album.name || 'Album';
  const releases = variants.map((item, index) => {
    const copy = SearchAlbumPresentationProvenance.bridge(item, {
      ...item, tabLabel: extractVariantLabel(item, baseDisplayName, index === 0),
    });
    // Same-label/manual-family alternatives get suppression, never a witness.
    if (SearchAlbumPresentationProvenance.has(album)) SearchAlbumPresentationProvenance.mark(copy);
    return copy;
  });
  const selectedIndex = Math.max(0, releases.findIndex((item) => item.key === album.key));
  return { releases, selectedIndex };
}

function isPlainDuplicateVersionTab(release, index, releases) {
  if (index <= 0 || !release || !Array.isArray(releases) || !releases.length) return false;
  const original = releases[0] || {};
  const releaseName = String(release.name || '').trim();
  const originalName = String(original.name || '').trim();
  if (!releaseName || releaseName.localeCompare(originalName, undefined, { sensitivity: 'base' }) !== 0) return false;
  if (String(release.edition || '').trim()) return false;
  if (isInstrumentalVariant(release)) return false;
  if (findVariantSuffixIndex(releaseName) > 0) return false;
  return true;
}

async function ignoreAlbumVersion(albumKey) {
  const key = String(albumKey || '');
  if (!key) return;
  try {
    const response = await fetch('/versions/ignore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ album_key: key }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      throw new Error(data.error || 'Failed to update version setting');
    }
    mergeViewPayload({
      ignored_version_keys: Array.isArray(data.ignored_version_keys) ? data.ignored_version_keys : [],
    }, { trackSidebarReveal: false });
    state.utility.rulesLoaded = false;
    hideVersionContextMenu();
    const currentAlbum = state.modalReleases[state.modalReleaseIndex] || null;
    if (currentAlbum) {
      const releaseSet = getAlbumReleaseSet(currentAlbum);
      state.modalReleases = releaseSet.releases;
      state.modalReleaseIndex = Math.min(releaseSet.selectedIndex, Math.max(0, state.modalReleases.length - 1));
      renderTrackModalRelease(state.modalReleases[state.modalReleaseIndex]);
    }
    await fetchAndRender(buildApiUrl(state.view), false);
    showToast('Album will no longer be counted as a version.', 'success', 2600);
  } catch (error) {
    console.error('[AlbumHaven][Versions] Failed to ignore album version.', error);
    showToast(error.message || 'Failed to update version setting.', 'error', 3200);
  }
}

function refreshOpenTrackModalVersionState(preferredAlbumKey = '') {
  const trackModal = document.getElementById('track-modal');
  if (!trackModal || trackModal.hidden) return;
  const currentKey = String(preferredAlbumKey || state.modalReleases[state.modalReleaseIndex]?.key || '');
  const visibleAlbums = flattenVisibleAlbums();
  const currentAlbum = visibleAlbums.find((item) => String(item.key || '') === currentKey)
    || state.modalReleases[state.modalReleaseIndex]
    || visibleAlbums[0]
    || null;
  if (!currentAlbum) return;
  const releaseSet = getAlbumReleaseSet(currentAlbum);
  state.modalReleases = releaseSet.releases;
  state.modalReleaseIndex = Math.min(releaseSet.selectedIndex, Math.max(0, state.modalReleases.length - 1));
  renderTrackModalRelease(state.modalReleases[state.modalReleaseIndex]);
}

async function markAlbumVersion(albumKey, parentAlbumKey) {
  const childKey = String(albumKey || '');
  const targetKey = String(parentAlbumKey || '');
  if (!childKey || !targetKey || childKey === targetKey) return;
  try {
    const response = await fetch('/versions/mark', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ album_key: childKey, parent_album_key: targetKey }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      throw new Error(data.error || 'Failed to mark album as a version');
    }
    mergeViewPayload({
      manual_version_links: data.manual_version_links && typeof data.manual_version_links === 'object'
        ? data.manual_version_links
        : {},
    }, { trackSidebarReveal: false });
    refreshOpenTrackModalVersionState(childKey);
    await fetchAndRender(buildApiUrl(state.view), false);
    showToast('Album marked as a version.', 'success', 2600);
  } catch (error) {
    console.error('[AlbumHaven][Versions] Failed to mark album as a version.', error);
    showToast(error.message || 'Failed to mark album as a version.', 'error', 3200);
    throw error;
  }
}

async function unmarkAlbumVersion(albumKey) {
  const key = String(albumKey || '');
  if (!key) return;
  try {
    const response = await fetch('/versions/unmark', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ album_key: key }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      throw new Error(data.error || 'Failed to unmark album version');
    }
    mergeViewPayload({
      manual_version_links: data.manual_version_links && typeof data.manual_version_links === 'object'
        ? data.manual_version_links
        : {},
    }, { trackSidebarReveal: false });
    refreshOpenTrackModalVersionState(key);
    await fetchAndRender(buildApiUrl(state.view), false);
    showToast('Album is no longer manually marked as a version.', 'success', 2600);
  } catch (error) {
    console.error('[AlbumHaven][Versions] Failed to unmark album version.', error);
    showToast(error.message || 'Failed to unmark album version.', 'error', 3200);
    throw error;
  }
}

async function revertVersionException(albumKey) {
  const key = String(albumKey || '');
  if (!key) return;
  try {
    const response = await fetch('/utilities/rules/version-exceptions/revert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ album_key: key }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      throw new Error(data.error || 'Failed to revert rule');
    }
    state.utility.rules = Array.isArray(data.rules) ? data.rules : [];
    state.utility.rulesLoaded = true;
    if (Array.isArray(data.ignored_version_keys)) {
      mergeViewPayload({
        ignored_version_keys: data.ignored_version_keys,
      }, { trackSidebarReveal: false });
    }
    renderUtilityModalContent();
    await fetchAndRender(buildApiUrl(state.view), false);
    showToast('Rule reverted.', 'success', 2400);
    return true;
  } catch (error) {
    console.error('[AlbumHaven][Utilities] Failed to revert rule.', error);
    showToast(error.message || 'Failed to revert rule.', 'error', 3200);
    return false;
  }
}

async function revertProblemIgnore(item) {
  if (!item || !String(item.row_key || '').trim()) return;
  await queueProblemExclusionRevert(item);
}

function renderTrackModalTabs(els) {
  if (!els.tabs) return;
  const releases = state.modalReleases || [];
  if (releases.length <= 1) {
    els.tabs.hidden = true;
    els.tabs.innerHTML = '';
    hideVersionContextMenu();
    return;
  }
  els.tabs.hidden = false;
  const restoreTabFocus = els.tabs.contains?.(document.activeElement);
  els.tabs.innerHTML = buildInPageTabsHtml({
    id: 'album-edition-tabs',
    label: 'Album editions',
    selectedKey: String(state.modalReleaseIndex),
    tabs: releases.map((release, index) => ({ key: String(index), label: release.tabLabel })),
  });
  const tablist = els.tabs.querySelector('.in-page-tabs');
  tablist?.querySelectorAll('[data-in-page-tab]').forEach((button, index) => {
    button.dataset.trackTabIndex = String(index);
    if (isPlainDuplicateVersionTab(releases[index], index, releases)) {
      button.dataset.versionContextKey = releases[index].key || '';
    }
  });
  mountInPageTabs(tablist);
  if (restoreTabFocus) tablist?.querySelector('[aria-selected="true"]')?.focus();
  renderVersionContextMenu();
}

function ensureVersionContextMenu() {
  let menu = document.getElementById('track-modal-version-context-menu');
  if (menu) return menu;
  menu = document.createElement('div');
  menu.id = 'track-modal-version-context-menu';
  menu.className = 'track-modal-version-context-menu';
  menu.hidden = true;
  menu.innerHTML = '<button type="button" data-ignore-version-context="1">Don\'t count as a version</button>';
  document.body.appendChild(menu);
  return menu;
}

function renderVersionContextMenu() {
  const menu = ensureVersionContextMenu();
  const stateMenu = state.modalVersionContextMenu || {};
  if (!stateMenu.visible || !stateMenu.albumKey) {
    menu.hidden = true;
    return;
  }
  menu.style.left = `${stateMenu.x}px`;
  menu.style.top = `${stateMenu.y}px`;
  menu.dataset.albumKey = stateMenu.albumKey;
  menu.hidden = false;
}

function showVersionContextMenu(albumKey, x, y) {
  state.modalVersionContextMenu = {
    albumKey: String(albumKey || ''),
    x,
    y,
    visible: true,
  };
  renderVersionContextMenu();
}

function hideVersionContextMenu() {
  state.modalVersionContextMenu = {
    albumKey: '',
    x: 0,
    y: 0,
    visible: false,
  };
  const menu = document.getElementById('track-modal-version-context-menu');
  if (menu) menu.hidden = true;
}

function buildTrackModalCoverVisualHtml({
  albumName,
  localCoverPath,
  remoteCoverUrl,
}) {
  return `
    <span class="track-modal-cover-visual is-loading">
      <span class="cover-placeholder" aria-hidden="true"></span>
      <img
        alt="Album cover for ${escapeHtml(albumName)}"
        data-cover-path="${escapeHtml(localCoverPath)}"
        data-remote-cover-url="${escapeHtml(remoteCoverUrl)}"
        data-cover-visual-state="pending"
        aria-hidden="true"
        onload="handleTrackModalCoverImageLoad(this)"
        onerror="handleAlbumDisplayCoverImageError(this)">
    </span>
  `;
}

function handleTrackModalCoverImageLoad(imageElement) {
  if (!(imageElement instanceof HTMLImageElement)) return;
  if (typeof handleAlbumDisplayCoverImageLoad === 'function') {
    handleAlbumDisplayCoverImageLoad(imageElement);
  }
  const visual = imageElement.closest('.track-modal-cover-visual');
  if (visual instanceof HTMLElement) {
    visual.classList.remove('is-loading');
  }
}

function getAlbumDuplicateSources(album) {
  return Array.isArray(album?.duplicate_sources) ? album.duplicate_sources.filter((source) => source && Array.isArray(source.tracks)) : [];
}

function getTrackModalDuplicateSourceIndex(album, duplicateSources) {
  const albumKey = String(album?.key || '');
  const savedIndex = Number(state.modalDuplicateSourceIndices?.[albumKey]);
  if (Number.isInteger(savedIndex) && savedIndex >= 0 && savedIndex < duplicateSources.length) {
    return savedIndex;
  }
  return 0;
}

function setTrackModalDuplicateSourceIndex(albumKey, sourceIndex) {
  const key = String(albumKey || '');
  if (!key) return;
  if (!state.modalDuplicateSourceIndices || typeof state.modalDuplicateSourceIndices !== 'object') {
    state.modalDuplicateSourceIndices = {};
  }
  state.modalDuplicateSourceIndices[key] = sourceIndex;
}

function getTrackModalAlbumRequestKey(album) {
  if (typeof getAlbumRequestKey === 'function') {
    return String(getAlbumRequestKey(album) || '').trim();
  }
  return String(album?.key || album?.album_ref || '').trim();
}

function getTrackModalAlbumIdentity(album) {
  if (typeof getAlbumIdentity === 'function') {
    return String(getAlbumIdentity(album) || '').trim();
  }
  return getTrackModalAlbumRequestKey(album);
}

function canConfirmMissingAlbumRemoval(album) {
  return Boolean(album?.allowed_actions?.['library.inventory.manage']);
}

function buildMissingAlbumRemovalConfirmation(album) {
  const albumName = String(album?.name || 'this album').trim() || 'this album';
  return {
    title: 'Remove album?',
    message: `Remove “${albumName}” from Album Haven? Its local files are already missing. This removes the album and its Album Haven data. It does not delete files from disk.`,
    cancelLabel: 'Cancel',
    acceptLabel: 'Remove album',
    danger: true,
  };
}

const applyMissingAlbumRemovalToViewDefault = function applyMissingAlbumRemovalToViewDefault(albumKey, payload = {}) {
  const normalizedKey = String(albumKey || '').trim();
  if (!normalizedKey || !state?.view) return false;
  const groupFields = ['artist_groups', 'primary_artist_groups', 'family_artist_groups'];
  groupFields.forEach((field) => {
    const groups = Array.isArray(state.view[field]) ? state.view[field] : [];
    state.view[field] = groups.flatMap((group) => {
      const albums = Array.isArray(group?.albums) ? group.albums : [];
      const retainedAlbums = albums.filter((album) => {
        const matches = String(getTrackModalAlbumRequestKey(album) || album?.key || '').trim() === normalizedKey;
        return !matches;
      });
      return retainedAlbums.length ? [{ ...group, albums: retainedAlbums }] : [];
    });
  });

  // Mounted groups can be filtered or partial. The canonical view refresh owns
  // whole-library sidebar membership and counts.
  if (Number.isFinite(Number(payload.album_count))) {
    state.view.album_count = Number(payload.album_count);
  }
  if (Number.isFinite(Number(payload.artist_count))) {
    state.view.artist_count = Number(payload.artist_count);
  }
  if (state.gallery) {
    if (typeof rebuildAlbumIndex === 'function') rebuildAlbumIndex(state.view.artist_groups || []);
    else state.gallery.albumIndex?.delete?.(normalizedKey);
  }
  if (state.utility) {
    state.utility.problematicFiles = (Array.isArray(state.utility.problematicFiles)
      ? state.utility.problematicFiles
      : []).filter((album) => String(album?.key || '').trim() !== normalizedKey);
    if (String(state.utility.selectedProblematicKey || '').trim() === normalizedKey) {
      state.utility.selectedProblematicKey = '';
    }
  }
  if (typeof renderView === 'function') {
    const renderOptions = typeof payload?.constructor === 'function'
      ? new payload.constructor()
      : {};
    renderOptions.preserveScroll = true;
    renderView(renderOptions);
  }
  return true;
};
if (typeof applyMissingAlbumRemovalToView !== 'function') {
  var applyMissingAlbumRemovalToView = applyMissingAlbumRemovalToViewDefault;
}

async function confirmMissingAlbumRemoval(album, options = {}) {
  if (!album || String(album?.inventory_status || '').trim().toLowerCase() !== 'missing') return false;
  if (!canConfirmMissingAlbumRemoval(album)) {
    if (typeof showToast === 'function') {
      showToast('Ask an owner or administrator to remove this album.', 'info', 3200);
    }
    return false;
  }
  const accepted = await showAppConfirmDialog(buildMissingAlbumRemovalConfirmation(album));
  if (!accepted) return false;
  const albumKey = getTrackModalAlbumRequestKey(album) || String(album?.key || '').trim();
  try {
    const response = await fetch(`/api/library/albums/${encodeURIComponent(albumKey)}/confirm-removal`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });
    let payload = {};
    try {
      payload = await response.json();
    } catch (_error) {
      payload = {};
    }
    const pendingRefreshRequest = state.ui?.pendingViewRequest || (
      state.busy && state.ui?.activeViewRequestUrl
        ? { url: state.ui.activeViewRequestUrl, push: state.ui.activeViewRequestPush }
        : null
    );
    if (response.status === 409) {
      if (typeof fetchAndRender === 'function' && typeof buildUrl === 'function') {
        const refreshOptions = typeof album?.constructor === 'function'
          ? new album.constructor()
          : {};
        refreshOptions.preserveScroll = true;
        if (pendingRefreshRequest) {
          Object.assign(refreshOptions, pendingRefreshRequest.options, {
            preserveScroll: pendingRefreshRequest.options?.preserveScroll ?? true,
            interruptCurrent: true,
            restartIfSameUrl: true,
          });
          if (typeof claimLocalViewStateNavigation === 'function') claimLocalViewStateNavigation();
        }
        await fetchAndRender(
          pendingRefreshRequest?.url || buildUrl(state.view),
          Boolean(pendingRefreshRequest?.push),
          refreshOptions,
        );
      }
      if (typeof loadProblematicFiles === 'function') await loadProblematicFiles(true);
      const modal = typeof getTrackModalElements === 'function' ? getTrackModalElements() : null;
      const currentAlbum = typeof getCurrentTrackModalAlbum === 'function' ? getCurrentTrackModalAlbum() : null;
      if (modal?.overlay && !modal.overlay.hidden
        && getTrackModalAlbumRequestKey(currentAlbum) === albumKey) {
        invalidateHydratedTrackModalAlbumDetails([currentAlbum]);
        const loadToken = invalidatePendingTrackModalLoad();
        const refreshedAlbum = await loadTrackModalAlbumDetails(albumKey);
        if (refreshedAlbum && !modal.overlay.hidden
          && loadToken === state.ui.pendingTrackModalLoadToken
          && getTrackModalAlbumRequestKey(getCurrentTrackModalAlbum()) === albumKey) {
          openTrackModal(refreshedAlbum, { coverLightboxGallery: state.ui.trackModalCoverLightboxGallery,
            presentationRestrictions: typeof getTrackModalPresentationRestrictions === 'function' ? getTrackModalPresentationRestrictions() : undefined,
            sourcePageOwner: typeof getTrackModalSourcePageOwner === 'function' ? getTrackModalSourcePageOwner() : undefined });
        }
      }
      const conflictMessage = String(
        payload.error || payload.detail || 'Album Haven found this album again.'
      ).trim() || 'Album Haven found this album again.';
      if (typeof showToast === 'function') showToast(conflictMessage, 'info', 3200);
      return false;
    }
    if (!response.ok) {
      throw new Error(payload.detail || payload.error || 'Unable to remove album from Album Haven.');
    }
    const refreshRequest = pendingRefreshRequest || {
      url: typeof buildUrl === 'function' ? buildUrl(state.view) : '', push: false,
    };
    if (typeof claimLocalViewStateNavigation === 'function') claimLocalViewStateNavigation();
    applyMissingAlbumRemovalToView(albumKey, payload);
    const modal = typeof getTrackModalElements === 'function' ? getTrackModalElements() : null;
    const currentAlbum = typeof getCurrentTrackModalAlbum === 'function' ? getCurrentTrackModalAlbum() : null;
    if (modal?.overlay && !modal.overlay.hidden
      && getTrackModalAlbumRequestKey(currentAlbum) === albumKey
      && typeof closeTrackModal === 'function') closeTrackModal();
    if (refreshRequest.url && typeof fetchAndRender === 'function') {
      await fetchAndRender(refreshRequest.url, Boolean(refreshRequest.push), {
        ...refreshRequest.options,
        preserveScroll: refreshRequest.options?.preserveScroll ?? true,
        interruptCurrent: true,
        restartIfSameUrl: true,
      });
    }
    if (typeof loadProblematicFiles === 'function') await loadProblematicFiles(true);
    if (typeof showToast === 'function') showToast('Album removed from Album Haven.', 'success', 3200);
    return true;
  } catch (error) {
    console.error('[AlbumHaven][Library] Missing album removal failed.', error);
    if (typeof showToast === 'function') {
      showToast(error?.message || 'Unable to remove album from Album Haven.', 'error', 3200);
    }
    return false;
  }
}

let trackModalAlbumPreferenceLease = null;
let trackModalAlbumPreferenceRenderGeneration = 0;
const uncertainAlbumPreferenceCommands = new Set();
function getTrackModalAlbumPreferenceLease() {return trackModalAlbumPreferenceLease;}
function disposeTrackModalAlbumPreferences(expected = trackModalAlbumPreferenceLease, {preserveFocus = false} = {}) {
  const lease = expected;
  if (!lease || trackModalAlbumPreferenceLease !== lease) return;
  // Claim exactly this owner before abort/unsubscribe can synchronously reenter.

  trackModalAlbumPreferenceLease = null;
  if (lease.submitted && !lease.settled) uncertainAlbumPreferenceCommands.add(lease.commandKey);
  if (!preserveFocus) lease.focusIntent?.dispose();
  lease.controller?.abort(); lease.unsubscribe?.(); lease.observer?.disconnect();
  lease.root.removeEventListener('click', lease.click);
  lease.root.removeEventListener('change', lease.change);
  lease.root.replaceChildren();
}
function createTrackModalAlbumPreferenceFocus(lease, action) {
  if (!['favorite', 'rating', 'clear', 'refresh'].includes(action)) return null;
  lease.focusIntent?.dispose();
  const intent = {album: lease.album, scope: lease.scope, action, root: lease.root, owner: lease, eligible: true,
    dispose() {intent.eligible = false; document.removeEventListener('focusin', focus); document.removeEventListener('pointerdown', pointer, true);}};
  const focus = event => {
    if (!intent.root?.contains(event.target) && event.target !== document.body && event.target !== document.documentElement) intent.eligible = false;
  };
  const pointer = event => {if (!intent.root?.contains(event.target)) intent.eligible = false;};
  document.addEventListener('focusin', focus); document.addEventListener('pointerdown', pointer, true);
  lease.focusIntent = intent;
  return intent;
}
function captureTrackModalAlbumPreferenceFocus(album, lease = trackModalAlbumPreferenceLease) {
  if (!lease || trackModalAlbumPreferenceLease !== lease || lease.album !== album || !lease.isCurrent?.()) return null;
  if (trackModalAlbumPreferenceLease !== lease) return null;
  const action = lease.root.contains(document.activeElement) ? document.activeElement?.dataset?.albumPreferenceAction : null;
  if (action) createTrackModalAlbumPreferenceFocus(lease, action);
  const intent = lease.focusIntent;
  if (!intent?.eligible) return null;
  intent.owner = null;
  return intent;
}
function refreshOwnAlbumPreferenceCaches(album, preference, scope, isCurrent) {
  if (!isCurrent() || !runtimeAlbumPreferenceScopeIsCurrent(scope) || !isCurrent()) return false;
  const candidates = [album, ...(typeof flattenVisibleAlbums === 'function' ? flattenVisibleAlbums() : [])];
  const matched = [];
  for (const candidate of new Set(candidates)) {
    const current = runtimeAlbumPreferenceForAlbum(candidate, scope);
    if (!isCurrent()) return false;
    if (!current || current.album_ref !== preference.album_ref) continue;
    matched.push(candidate);
    const next = copyRuntimeAlbumProgress(candidate.album_preference, {...preference,
      allowed_actions: {...preference.allowed_actions}}, candidate, scope);
    const retained = retainRuntimeAlbumPreferenceReceipt(next, candidate, scope);
    if (!isCurrent()) return false;
    candidate.album_preference = retained; candidate.album_rating = next.rating;
    if (candidate.gallery_list_block?.summary) candidate.gallery_list_block = {...candidate.gallery_list_block,
      summary: {...candidate.gallery_list_block.summary, album_preference: next, album_rating: next.rating}};
  }
  if (!isCurrent()) return false;
  invalidateHydratedTrackModalAlbumDetails(matched);
  return isCurrent();
}
function renderOwnTrackModalAlbumPreferences(album, header, retainedFocus = null, renderGeneration = trackModalAlbumPreferenceRenderGeneration) {
  const scope = captureRuntimeAlbumPreferenceScope();
  let preference = runtimeAlbumPreferenceForAlbum(album, scope, false);
  const verifiedRead = runtimeAlbumPreferenceForAlbum(album, scope) !== null;
  if (renderGeneration !== trackModalAlbumPreferenceRenderGeneration) {retainedFocus?.dispose(); return;}
  const root = document.createElement('div'); root.className = 'playlists__note';
  header.appendChild(root);
  if (!preference || preference.taste_state !== 'available') {
    retainedFocus?.dispose(); root.textContent = 'Your rating and favorite are unavailable.'; return;
  }
  const commandKey = JSON.stringify([scope.actor, scope.library, scope.context, preference.album_ref]);
  const lease = {root, album, scope, commandKey, pending: false, submitted: false, settled: false,
    needsRead: !verifiedRead || uncertainAlbumPreferenceCommands.has(commandKey), notice: '',
    albumKey: getTrackModalAlbumRequestKey(album), albumRef: preference.album_ref,
    loadToken: state.ui.pendingTrackModalLoadToken, viewRevision: typeof readViewStateRevision === 'function' ? readViewStateRevision() : null};
  const ownsRoot = () => trackModalAlbumPreferenceLease === lease && root.isConnected
    && renderGeneration === trackModalAlbumPreferenceRenderGeneration;
  const current = () => {
    if (!ownsRoot()) return false;
    const valid = runtimeAlbumPreferenceScopeIsCurrent(scope) && ownsRoot() && !album.read_only_subject
      && getCurrentTrackModalAlbum() === album && isTrackModalContentVisible()
      && getTrackModalAlbumRequestKey(album) === lease.albumKey
      && runtimeAlbumPreferenceGeneration(album, scope) === lease.albumRef
      && album.album_preference?.context_ref === scope.context
      && state.ui.pendingTrackModalLoadToken === lease.loadToken
      && (typeof readViewStateRevision !== 'function' || readViewStateRevision() === lease.viewRevision);
    return valid && ownsRoot();
  };
  lease.isCurrent = current;
  const paint = () => {
    if (!current()) return;
    const focusAction = root.contains(document.activeElement) ? document.activeElement?.dataset?.albumPreferenceAction : null;
    if (focusAction) createTrackModalAlbumPreferenceFocus(lease, focusAction);
    const rating = lease.pending && lease.desire && Object.hasOwn(lease.desire, 'rating') ? lease.desire.rating : preference.rating;
    const favorite = lease.pending && lease.desire && Object.hasOwn(lease.desire, 'favorite') ? lease.desire.favorite : preference.is_favorite;
    const disabled = lease.pending || lease.needsRead || preference.can_edit !== true;
    const ratingHtml = buildGalleryRatingHtml({value: rating ?? 0, maximum: 10,
      label: rating === null ? 'Your album is unrated' : `Your album rating ${rating}/10`, compact: true});
    if (!current()) return;
    root.innerHTML = `<span>Your rating: ${ratingHtml}</span> ${ButtonComponent.renderButton({label: favorite ? 'Favorite: Yes' : 'Favorite: No',
      size: 'small', disabled, ariaLabel: favorite ? 'Remove album from favorites' : 'Add album to favorites',
      attributes: {'data-album-preference-action': 'favorite', 'aria-pressed': String(favorite)}})}
      <label>Your rating <select aria-label="Your album rating" data-album-preference-action="rating"${disabled ? ' disabled' : ''}>
      <option value=""${rating === null ? ' selected' : ''}>Unrated</option>${Array.from({length: 10}, (_, i) => i + 1)
        .map(value => `<option value="${value}"${rating === value ? ' selected' : ''}>${value}</option>`).join('')}</select></label>
      ${ButtonComponent.renderButton({label: 'Clear', size: 'small', disabled, ariaLabel: 'Clear your album rating', attributes: {'data-album-preference-action': 'clear'}})}
      ${lease.needsRead ? ButtonComponent.renderButton({label: 'Refresh preferences', size: 'small', disabled: lease.pending,
        attributes: {'data-album-preference-action': 'refresh'}}) : ''}<span role="status" aria-live="polite" tabindex="-1" data-album-preference-status>${escapeHtml(lease.notice || (preference.can_edit !== true ? 'Your album preferences are read-only.' : ''))}</span>`;
    root.setAttribute('aria-busy', String(lease.pending));
    const intent = lease.focusIntent;
    // Keep the initiating intent while disabled. At settlement its action may
    // disappear (Refresh succeeded) or stay disabled (a read is still needed).
    if (!lease.pending && intent?.eligible) {
      const enabledAction = action => {
        const control = root.querySelector(`[data-album-preference-action="${action}"]`);
        return control && !control.disabled ? control : null;
      };
      const target = enabledAction(intent.action)
        || (lease.needsRead ? enabledAction('refresh')
          : enabledAction('favorite') || enabledAction('rating') || enabledAction('clear'))
        || root.querySelector('[data-album-preference-status]');
      if (target && !target.disabled && current() && intent.eligible
        && trackModalAlbumPreferenceLease === lease && target.isConnected && root.contains(target)) target.focus();
    }
  };
  const reconcile = async () => {
    if (!current() || lease.pending) return false;
    lease.pending = true; lease.controller = new AbortController(); paint();
    try {
      // Deliberately bypass the hydrated cache. An uncertain POST is never replayed.
      const fresh = await fetchTrackModalAlbumDetails(lease.albumKey,
        {signal: lease.controller.signal, isCurrent: current});
      if (!current()) return false;
      const next = runtimeAlbumPreferenceForAlbum(fresh, scope);
      if (!next || next.album_ref !== lease.albumRef) throw new Error('Album preferences are unavailable.');
      const accepted = copyRuntimeAlbumProgress(fresh.album_preference, next, fresh, scope);
      if (!current()) return false;
      const retained = retainRuntimeAlbumPreferenceReceipt(accepted, album, scope);
      if (!current()) return false;
      album.album_preference = retained; album.album_rating = accepted.rating;
      preference = accepted; uncertainAlbumPreferenceCommands.delete(commandKey); lease.needsRead = false;
      lease.submitted = false; lease.settled = true;
      invalidateHydratedTrackModalAlbumDetails([album]);
      return true;
    } catch (_error) {
      if (current()) {lease.needsRead = true; lease.notice = 'Refresh preferences before trying again.';}
      return false;
    } finally {if (current()) {lease.pending = false; paint();}}
  };
  const submit = async patch => {
    if (!current() || lease.pending || lease.needsRead) return;
    const latest = runtimeAlbumPreferenceForAlbum(album, scope);
    if (!current() || !latest || latest.album_ref !== lease.albumRef || latest.can_edit !== true
      || latest.allowed_actions.can_manage_album_preferences !== true) return;
    // The installed session-csrf-fetch owner supplies the actual cookie token
    // as X-Album-Haven-CSRF. Never substitute the private context for CSRF.
    if (!String(document.cookie || '').split(';').some(part => /^\s*__Host-album_haven_csrf=.+$/.test(part))) {
      lease.notice = 'Reload to restore this session.'; paint(); return;
    }
    lease.pending = true; lease.desire = patch; lease.controller = new AbortController();
    lease.submitted = true; lease.settled = false; lease.notice = 'Saving…';
    uncertainAlbumPreferenceCommands.add(commandKey); paint();
    try {
      const response = await scope.transport.request('/album-preferences', {method: 'POST', expected: scope.context,
        signal: lease.controller.signal, isCurrent: current,
        body: {album_ref: lease.albumRef, expected_revision: latest.preference_revision, patch}});
      if (!current()) return;
      if (!isRuntimePlainObject(response) || Object.keys(response).length !== 2
        || response.context_ref !== scope.context || response.album_preference?.context_ref !== response.context_ref) throw new Error('Invalid preference response.');
      const next = normalizeRuntimeAlbumPreference(response.album_preference, scope);
      if (!next || next.album_ref !== lease.albumRef || next.taste_state !== 'available'
        || next.preference_revision < latest.preference_revision
        || Object.hasOwn(patch, 'rating') && next.rating !== patch.rating
        || Object.hasOwn(patch, 'favorite') && next.is_favorite !== patch.favorite) throw new Error('Invalid preference response.');
      const accepted = copyRuntimeAlbumProgress(album.album_preference, next, album, scope);
      if (!current()) return;
      if (!refreshOwnAlbumPreferenceCaches(album, accepted, scope, current) || !current()) return;
      preference = accepted; lease.settled = true; lease.needsRead = false;
      uncertainAlbumPreferenceCommands.delete(commandKey); lease.notice = 'Saved.';
      // Actor-scoped gallery reads refresh existing taste-bearing presentation.
      // Inventory/metadata caches are not invalidated as personal-state stores.
      if (typeof fetchAndRender === 'function' && typeof buildUrl === 'function') {
        Promise.resolve().then(async () => {
          if (!current()) return;
          await fetchAndRender(buildUrl(state.view), false,
            {preserveScroll: true, interruptCurrent: true, restartIfSameUrl: true});
        }).catch(() => {});
      }
    } catch (error) {
      if (!current()) return;
      lease.needsRead = true;
      lease.notice = error?.status === 409 ? 'Preferences changed. Refreshing before another edit.'
        : 'The save could not be confirmed. Refreshing preferences.';
      // Reconciliation immediately owns the pending paint; do not briefly
      // restore a recovery button between the POST and its automatic read.
      lease.pending = false;
      await reconcile();
    } finally {
      if (current()) {lease.pending = false; lease.desire = null; paint();}
    }
  };
  lease.click = event => {
    const action = event.target.closest('[data-album-preference-action]')?.dataset.albumPreferenceAction;
    if (action === 'favorite') void submit({favorite: !preference.is_favorite});
    if (action === 'clear') void submit({rating: null});
    if (action === 'refresh') void reconcile();
  };
  lease.change = event => {
    if (event.target.dataset.albumPreferenceAction !== 'rating') return;
    const value = event.target.value === '' ? null : Number(event.target.value);
    if (value === null || Number.isInteger(value) && value >= 1 && value <= 10) void submit({rating: value});
  };
  trackModalAlbumPreferenceLease = lease;
  if (retainedFocus?.eligible && retainedFocus.album === album
    && runtimeAlbumPreferenceScopeIsCurrent(retainedFocus.scope) && trackModalAlbumPreferenceLease === lease
    && retainedFocus.scope.actor === scope.actor && retainedFocus.scope.library === scope.library
    && retainedFocus.scope.context === scope.context) {
    lease.focusIntent = retainedFocus; retainedFocus.root = root; retainedFocus.owner = lease;
  } else retainedFocus?.dispose();
  if (trackModalAlbumPreferenceLease !== lease) return;
  root.addEventListener('click', lease.click); root.addEventListener('change', lease.change);
  lease.unsubscribe = scope.transport.subscribe(() => {if (!current()) disposeTrackModalAlbumPreferences(lease);});
  const shell = document.getElementById('app-shell');
  lease.observer = typeof MutationObserver === 'function' ? new MutationObserver(() => {
    if (!current()) disposeTrackModalAlbumPreferences(lease);
  }) : null;
  if (shell) lease.observer?.observe(shell, {attributes: true,
    attributeFilter: ['data-native-account-id', 'data-native-library-id', 'data-private-ui-context']});
  // Existing openTrackModal renders before unhiding the shell. Admit handlers
  // immediately, then paint only after that owner completes its synchronous open.
  Promise.resolve().then(() => {paint(); if (current() && lease.needsRead) void reconcile();});
}

function renderTrackModalRelease(album, albumPreferenceFocus = null) {
  const albumPreferenceRenderGeneration = ++trackModalAlbumPreferenceRenderGeneration;
  disposeTrackModalAlbumPreferences();
  if (typeof reconcileTrackModalSelectionAlbum === 'function') reconcileTrackModalSelectionAlbum(album);
  let els = getTrackModalElements();
  if (!els.overlay || !album) return;
  const renderAlbumArtbox = typeof buildAlbumArtboxHtml === 'function'
    ? buildAlbumArtboxHtml
    : (config = {}) => String(config.coverHtml || '<div class="cover-placeholder">No cover art</div>');
  const resolvedAlbumKey = getTrackModalAlbumRequestKey(album) || getTrackModalAlbumIdentity(album) || String(album?.key || '');
  const albumKey = escapeHtml(resolvedAlbumKey);
  const albumMissing = String(album?.inventory_status || '').trim().toLowerCase() === 'missing';
  const candidateSnapshot = album?.cover_candidate_snapshot && typeof album.cover_candidate_snapshot === 'object'
    ? album.cover_candidate_snapshot
    : null;
  const hasUnseenAutomaticImprovement = Boolean(
    candidateSnapshot
    && String(candidateSnapshot.search_kind || '') === 'automatic'
    && candidateSnapshot.has_unseen_automatic_improvement
  );
  const coverLookupClass = hasUnseenAutomaticImprovement
    ? 'track-modal-cover-tool is-lookup has-unseen-automatic-improvement'
    : 'track-modal-cover-tool is-lookup';
  const coverLookupLabel = hasUnseenAutomaticImprovement
    ? 'Open cover art look up gallery; new automatic cover candidate available'
    : 'Open cover art look up gallery';
  const coverToolsHtml = `
    ${ButtonComponent.renderActionButton({
      icon: 'search',
      ariaLabel: coverLookupLabel,
      title: 'Cover Art Look Up',
      className: coverLookupClass,
      attributes: {
        'data-open-track-modal-cover-lookup': '1',
        'data-album-key': albumKey,
      },
    })}
    ${ButtonComponent.renderActionButton({
      icon: 'bolt',
      ariaLabel: 'Fetch cover art now',
      title: 'Fast Cover Fetch',
      className: 'track-modal-cover-tool is-fast-fetch',
      attributes: {
        'data-track-modal-fast-cover-fetch': '1',
        'data-album-key': albumKey,
      },
    })}
  `;
  const coverSourceBadge = typeof buildTrackModalCoverSourceBadge === 'function'
    ? buildTrackModalCoverSourceBadge(album?.remote_cover_source || '')
    : '';
  const albumDetailsLayout = String(
    document.documentElement?.getAttribute('data-album-details-layout') || 'classic_bar'
  ).trim().toLowerCase();
  if (els.header) {
    els.header.innerHTML = buildAlbumDetailsHeaderHtml({
      layout: albumDetailsLayout,
      artist: album.album_artist || '',
      album: album.name || 'Album',
      year: album.year || '',
      releaseType: album.release_type || 'ALBUM',
      tags: [album.edition || '', albumMissing ? 'Missing' : ''].filter(Boolean),
      actionsHtml: buildAlbumDetailsHeaderActionsHtml({ missing: albumMissing }),
    });
    if (album.read_only_subject) {
      const summary = document.createElement('div'); summary.className = 'playlists__note';
      const available = album.taste_state === 'available';
      const value = available && Number.isInteger(album.album_rating) && album.album_rating >= 1 && album.album_rating <= 10
        ? album.album_rating : null;
      const rating = available ? buildGalleryRatingHtml({value: value ?? 0, maximum: 10,
        label: value === null ? 'Subject album unrated' : `Subject album rating ${value}/10`, compact: true}) : 'Unavailable';
      summary.innerHTML = `Rating: ${rating} · Favorite: ${available && album.favorite === true ? 'Yes' : available && album.favorite === false ? 'No' : 'Unavailable'}`;
      els.header.appendChild(summary);
    } else {
      renderOwnTrackModalAlbumPreferences(album, els.header, albumPreferenceFocus, albumPreferenceRenderGeneration);
    }
    els = getTrackModalElements();
  }
  if (els.folder) {
    els.folder.dataset.album = '';
    els.folder.dataset.albumKey = resolvedAlbumKey;
  }
  if (els.editTags) {
    els.editTags.dataset.album = '';
    els.editTags.dataset.albumKey = resolvedAlbumKey;
  }
  if (els.missingWarning) {
    els.missingWarning.hidden = !albumMissing;
    els.missingWarning.innerHTML = albumMissing
      ? buildMissingAlbumDetailsHtml({
        canRemove: canConfirmMissingAlbumRemoval(album),
        albumKey,
      })
      : '';
  }
  if (albumMissing) {
    els.cover.innerHTML = `
      <div class="track-modal-cover-shell">
        ${renderAlbumArtbox({ state: 'missing', label: `${album.name || 'Album'} artwork unavailable` })}
      </div>
    `;
  } else if (albumHasDisplayCover(album)) {
    const coverSrc = buildAlbumDisplayCoverUrl(album);
    const lightboxSrc = typeof buildAlbumLightboxCoverUrl === 'function'
      ? buildAlbumLightboxCoverUrl(album)
      : coverSrc;
    const canInspectHtmlElements = typeof HTMLElement !== 'undefined' && typeof HTMLImageElement !== 'undefined';
    const existingCoverImage = canInspectHtmlElements && els.cover instanceof HTMLElement
      ? els.cover.querySelector('img')
      : null;
    const existingProductionSrc = canInspectHtmlElements && existingCoverImage instanceof HTMLImageElement
      ? String(existingCoverImage.getAttribute('data-production-cover-src') || '').trim()
      : '';
    const reusableCoverImage = canInspectHtmlElements && existingCoverImage instanceof HTMLImageElement
      && (
        existingProductionSrc === coverSrc
        ||
        existingCoverImage.getAttribute('src') === coverSrc
        || existingCoverImage.currentSrc === new URL(coverSrc, window.location.href).href
      )
      ? existingCoverImage
      : null;
    const localCoverPathRaw = String(album?.cover_path || '').trim();
    const remoteCoverUrlRaw = String(album?.remote_cover_thumbnail_url || album?.remote_cover_url || '').trim();
    const localCoverPath = escapeHtml(localCoverPathRaw);
    const remoteCoverUrl = escapeHtml(remoteCoverUrlRaw);
    const artworkAllowed = typeof canViewTrackModalArtwork !== 'function' || canViewTrackModalArtwork();
    const lightboxGalleryAttribute = state.ui?.trackModalCoverLightboxGallery === false
      ? ''
      : ' data-lightbox-gallery="visible"';
    els.cover.innerHTML = `
      <div class="track-modal-cover-shell">
      ${renderAlbumArtbox({
        state: 'ready',
        label: `Album cover for ${album.name}`,
        coverHtml: `<button class="track-modal-cover-button" type="button"${artworkAllowed ? ' data-open-lightbox="1"' : ' disabled aria-disabled="true"'} data-cover-src="${escapeHtml(lightboxSrc)}" data-cover-preview-src="${escapeHtml(coverSrc)}" data-cover-alt="${escapeHtml(`Album cover for ${album.name}`)}" data-album-key="${albumKey}"${lightboxGalleryAttribute}><span class="track-modal-cover-image-slot"></span></button>`,
        overlayHtml: coverToolsHtml,
      })}
      ${coverSourceBadge}
      </div>
    `;
    const coverImageSlot = typeof els.cover?.querySelector === 'function'
      ? els.cover.querySelector('.track-modal-cover-image-slot')
      : null;
    if (canInspectHtmlElements && coverImageSlot instanceof HTMLElement) {
      let modalCoverImage = null;
      if (reusableCoverImage instanceof HTMLImageElement) {
        const visual = document.createElement('span');
        visual.classList.add('track-modal-cover-visual');
        const coverIsPending = (
          reusableCoverImage.getAttribute('data-cover-visual-state') !== 'ready'
          || !reusableCoverImage.complete
          || reusableCoverImage.naturalWidth <= 0
        );
        if (coverIsPending) {
          visual.classList.add('is-loading');
          const placeholder = document.createElement('span');
          placeholder.classList.add('cover-placeholder');
          placeholder.setAttribute('aria-hidden', 'true');
          visual.appendChild(placeholder);
        }
        reusableCoverImage.setAttribute('data-cover-path', localCoverPathRaw);
        reusableCoverImage.setAttribute('data-remote-cover-url', remoteCoverUrlRaw);
        reusableCoverImage.setAttribute('alt', `Album cover for ${String(album?.name || '')}`);
        visual.appendChild(reusableCoverImage);
        coverImageSlot.replaceWith(visual);
        modalCoverImage = reusableCoverImage;
      } else {
        coverImageSlot.outerHTML = buildTrackModalCoverVisualHtml({
          albumName: String(album?.name || ''),
          localCoverPath: localCoverPathRaw,
          remoteCoverUrl: remoteCoverUrlRaw,
        });
        modalCoverImage = els.cover.querySelector('.track-modal-cover-visual img');
      }
      if (
        !reusableCoverImage
        && modalCoverImage instanceof HTMLImageElement
        && typeof loadGalleryCoverPreviewImage === 'function'
      ) {
        const ownsCurrentModalCover = () => {
          if (!(typeof isTrackModalContentVisible === 'function' ? isTrackModalContentVisible() : !els.overlay.hidden) || !modalCoverImage.isConnected) return false;
          if (els.cover.querySelector('.track-modal-cover-visual img') !== modalCoverImage) return false;
          const currentAlbum = state.modalReleases[state.modalReleaseIndex] || null;
          return getTrackModalAlbumRequestKey(currentAlbum) === resolvedAlbumKey;
        };
        void loadGalleryCoverPreviewImage(modalCoverImage, coverSrc, {
          isCurrent: ownsCurrentModalCover,
        }).catch((error) => {
          if (!ownsCurrentModalCover()) return;
          console.error('[AlbumHaven][Covers] Failed to load the track-modal cover preview.', error);
          handleAlbumDisplayCoverImageError(modalCoverImage);
        });
      }
    }
  } else {
    els.cover.innerHTML = `
      <div class="track-modal-cover-shell">
      ${renderAlbumArtbox({
        state: 'empty',
        label: `${album.name || 'Album'} has no cover art`,
        overlayHtml: coverToolsHtml,
      })}
      </div>
    `;
  }
  const duplicateSources = albumMissing ? [] : getAlbumDuplicateSources(album);
  const duplicateSourceIndex = getTrackModalDuplicateSourceIndex(album, duplicateSources);
  const activeDuplicateSource = duplicateSources[duplicateSourceIndex] || null;
  const tracks = Array.isArray(activeDuplicateSource?.tracks)
    ? activeDuplicateSource.tracks
    : (Array.isArray(album.tracks) ? album.tracks : []);
  const grouped = groupAlbumTracks(tracks);
  const bonusGroups = grouped.groups.filter((group) => group.isBonus);
  const mainGroups = grouped.groups.filter((group) => !group.isBonus);
  const mainSeconds = mainGroups.reduce((sum, group) => sum + group.tracks.reduce((inner, track) => inner + (Number(track.duration_seconds) || 0), 0), 0);
  const bonusSeconds = bonusGroups.reduce((sum, group) => sum + group.tracks.reduce((inner, track) => inner + (Number(track.duration_seconds) || 0), 0), 0);
  const totalLength = activeDuplicateSource?.total_duration_display || album.total_duration_display || formatAlbumDuration(album.total_duration_seconds);
  const mainLength = mainSeconds > 0 ? (formatTrackDuration(mainSeconds) || formatAlbumDuration(mainSeconds)) : '';
  const bonusLength = bonusSeconds > 0 ? (formatTrackDuration(bonusSeconds) || formatAlbumDuration(bonusSeconds)) : '';
  if (els.duplicateWarning && els.duplicateTabs) {
    if (duplicateSources.length > 1) {
      els.duplicateWarning.hidden = false;
      els.duplicateWarning.innerHTML = buildOnPageAlertHtml({
        severity: 'warning', title: 'Duplicate album files', message: 'Album seems to have duplicate files:',
        actionsHtml: duplicateSources.map((source, index) => ButtonComponent.renderButton({
          label: `Folder ${index + 1}`,
          variant: index === duplicateSourceIndex ? 'primary' : 'secondary',
          title: String(source.folder_path || source.folder_name || `Folder ${index + 1}`),
          attributes: {
            'data-open-track-modal-duplicate-folder': '1',
            'data-album-key': resolvedAlbumKey,
            'data-duplicate-source-index': String(index),
            'aria-pressed': String(index === duplicateSourceIndex),
          },
        })).join(''),
      });
      els.duplicateTabs.hidden = false;
      els.duplicateTabs.innerHTML = duplicateSources.map((source, index) => {
        const isActive = index === duplicateSourceIndex;
        const sourceTitle = escapeHtml(String(source.folder_path || source.folder_name || `Location ${index + 1}`));
        return `
          <button
            class="track-modal-duplicate-tab ${isActive ? 'is-active' : ''}"
            type="button"
            data-track-duplicate-source-index="${index}"
            title="${sourceTitle}">
            Files ${index + 1}
          </button>
        `;
      }).join('');
    } else {
      els.duplicateWarning.hidden = true;
      els.duplicateWarning.innerHTML = '';
      els.duplicateTabs.hidden = true;
      els.duplicateTabs.innerHTML = '';
    }
  }
  if (typeof syncMobileAlbumComposition === 'function') syncMobileAlbumComposition(album);
  const searchRenderRows = [];
  // Invalidate old node associations before any external mount callback.
  SearchAlbumPresentationProvenance.rendered(album, els.list, null);
  els.list.innerHTML = albumMissing ? '' : buildTrackListHtml(tracks, album, totalLength, searchRenderRows);
  const searchRenderReceipt = Object.freeze({album, list: els.list, rows: Object.freeze(searchRenderRows),
    nodes: Object.freeze([...els.list.querySelectorAll('.album-track-table__row')])});
  SearchAlbumPresentationProvenance.rendered(album, els.list, searchRenderReceipt);
  if (typeof NativePlaytables !== 'undefined') {
    if (albumMissing) NativePlaytables.retire('album-tracks');
    else if (isTrackModalContentVisible()) NativePlaytables.mount('album-tracks', els.list);
  }
  if (els.footer) {
    els.footer.textContent = '';
    els.footer.hidden = true;
  }
  renderTrackModalTabs(els);
  if (typeof decorateTrackModalSelection === 'function') decorateTrackModalSelection();
  refreshTrackModalPlaybackState();
  if (typeof attachSharedPlayer === 'function') attachSharedPlayer();
}


function formatDiscDisplayLabel(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  if (/\b(?:disc|cd)\b/i.test(cleaned)) {
    return cleaned;
  }
  return `${cleaned} Disc`;
}

function getTrackDiscLabel(track) {
  const raw = String((track && track.disc_number_raw) || '').trim();
  if (raw) {
    const firstPart = raw.split('/')[0].trim();
    if (firstPart) {
      if (/^\d+$/.test(firstPart)) {
        return `CD${firstPart}`;
      }
      return formatDiscDisplayLabel(firstPart);
    }
  }
  const numeric = Number(track && track.disc_number);
  if (Number.isFinite(numeric) && numeric > 0) {
    return `CD${numeric}`;
  }
  return '';
}

function isBonusDiscTrack(track) {
  const rawDisc = String((track && track.disc_number_raw) || '').trim();
  if (!rawDisc) return false;
  return /\b(bonus|extra|extras|instrumental|instrumentals|demo|demos|outtake|outtakes|rarity|rarities|interview|alternate version|alternate take)\b/i.test(rawDisc);
}


function groupAlbumTracks(tracks) {
  const safeTracks = orderAlbumTracks(tracks);

  const explicitDiscs = Array.from(new Set(
    safeTracks
      .map((track) => Number(track.disc_number))
      .filter((disc) => Number.isInteger(disc) && disc > 0)
  )).sort((a, b) => a - b);

  const explicitLabels = Array.from(new Set(
    safeTracks
      .map((track) => getTrackDiscLabel(track))
      .filter(Boolean)
  ));

  const hasExplicitCd1 = explicitDiscs.includes(1);
  const hasLaterExplicitDiscs = explicitDiscs.some((disc) => disc > 1);
  const inferredCd1FromMissingTags = hasLaterExplicitDiscs && !hasExplicitCd1;

  const groups = new Map();

  safeTracks.forEach((track) => {
    const numericDisc = Number(track.disc_number);
    let discLabel = getTrackDiscLabel(track);
    let effectiveDisc = Number.isInteger(numericDisc) && numericDisc > 0 ? numericDisc : null;

    if (!discLabel && inferredCd1FromMissingTags) {
      discLabel = 'CD1';
      effectiveDisc = 1;
    }

    const key = discLabel || (effectiveDisc ? `CD${effectiveDisc}` : 'single');
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        discNumber: effectiveDisc,
        discLabel: key === 'single' ? '' : key,
        isBonus: false,
        tracks: [],
      });
    }
    const group = groups.get(key);
    group.isBonus = group.isBonus || isBonusDiscTrack(track);
    group.tracks.push(track);
  });

  const orderedKeys = Array.from(groups.keys()).sort((a, b) => {
    const ga = groups.get(a);
    const gb = groups.get(b);
    if (a === 'single') return -1;
    if (b === 'single') return 1;
    if (ga.discNumber != null && gb.discNumber != null && ga.discNumber !== gb.discNumber) {
      return ga.discNumber - gb.discNumber;
    }
    if (ga.discNumber != null && gb.discNumber == null) return -1;
    if (ga.discNumber == null && gb.discNumber != null) return 1;
    return String(ga.discLabel || '').localeCompare(String(gb.discLabel || ''), undefined, { sensitivity: 'base' });
  });

  const multiDisc = orderedKeys.length > 1;

  return {
    multiDisc,
    inferredCd1FromMissingTags,
    groups: orderedKeys.map((key) => ({
      discNumber: groups.get(key).discNumber,
      discLabel: groups.get(key).discLabel,
      isBonus: Boolean(groups.get(key).isBonus),
      tracks: groups.get(key).tracks,
    })),
  };
}


function buildTrackListHtml(tracks, album = null, totalLength = null, searchRenderRows = null) {
  const privateRows = [];
  const grouped = groupAlbumTracks(tracks);
  const playback = getPlayerPlaybackSnapshot();
  const currentTrackPath = String(state.player.current?.path || '');
  const trackRows = Array.isArray(album?.track_rows) ? album.track_rows : [];
  const trackRowByPath = new Map(
    trackRows
      .map((row) => {
        const rowPath = String(row?.path || row?.track_ref || '').trim();
        return rowPath ? [rowPath, row] : null;
      })
      .filter(Boolean)
  );

  const query = String(state.view?.query || '').trim().toLocaleLowerCase();
  const componentGroups = grouped.groups.map((group) => {
    let discLabel = String(group.discLabel || '').trim();
    if (!discLabel && Number.isInteger(group.discNumber) && group.discNumber > 0) {
      discLabel = `CD ${group.discNumber}`;
    }
    discLabel = discLabel.replace(/^CD\s*(\d+)$/i, 'CD $1');
    if (group.isBonus) {
      discLabel = group.discSubtitle || (discLabel && !/^CD\s*\d+$/i.test(discLabel) ? discLabel : 'Bonus CD');
    } else if (group.discSubtitle) {
      discLabel = `${discLabel} • ${group.discSubtitle}`;
    }
    const componentTracks = group.tracks.map((track, index) => {
      const src = `/track?path=${encodeURIComponent(track.path)}`;
      const duration = formatTrackDuration(track.duration_seconds);
      const trackPath = String(track.path || '');
      const isCurrentTrack = currentTrackPath && currentTrackPath === trackPath;
      const isActivelyPlaying = isCurrentTrack && !playback.paused && !playback.ended;
      const currentTimeDisplay = isCurrentTrack
        ? `${formatLoopTime(playback.currentTime || 0)} / ${duration || formatTrackDuration(playback.duration) || '0:00'}`
        : duration;
      const trackValue = getAlbumTrackDisplayNumber(track, index);
      const trackRow = trackRowByPath.get(trackPath) || null;
      const source = trackRow || track;
      // Keep the exact response row: a render-time clone cannot inherit a
      // request's private preference receipt. Native playback still uses track.
      privateRows.push(source);
      searchRenderRows?.push(Object.freeze({track, source}));
      const searchOrigin = SearchAlbumPresentationProvenance.has(album)
        || SearchAlbumPresentationProvenance.has(track) || SearchAlbumPresentationProvenance.has(source);
      const witness = searchOrigin ? SearchAlbumPresentationProvenance.read(album, track, source) : null;
      const displayTitle = String(trackRow?.title || track.title || '').trim();
      const secondaryArtist = String(trackRow?.secondary_artist || '').trim();
      return {
        path: trackPath, inventory_track_ref: source.inventory_track_ref,
        subjectTasteState: album?.read_only_subject ? source.taste_state : 'unavailable',
        subjectRating: album?.read_only_subject ? source.rating : null, subjectLove: album?.read_only_subject ? source.love_tier : null,
        src,
        title: displayTitle,
        playbackTitle: String(track.title || '').trim(),
        artist: track.artist || track.album_artist || '',
        albumArtist: track.album_artist || album?.album_artist || '',
        album: track.album || album?.name || '',
        coverPath: track.cover_path || album?.cover_path || '',
        durationSeconds: Number(track.duration_seconds) || 0,
        duration: currentTimeDisplay || duration,
        originalDuration: duration,
        trackNumber: trackValue,
        secondaryArtist,
        isCurrent: Boolean(isCurrentTrack),
        isPlaying: Boolean(isActivelyPlaying),
        isProblematic: Boolean(track.is_problematic),
        isSearchMatch: searchOrigin ? witness?.state === 'known' && witness.matches_search === true
          : Boolean(query && displayTitle.toLocaleLowerCase().includes(query)),
      };
    });
    return {
      discNumber: group.discNumber,
      discLabel,
      isBonus: Boolean(group.isBonus),
      tracks: componentTracks,
    };
  });
  if (typeof buildAlbumTrackTableHtml !== 'function') {
    return componentGroups.flatMap((group) => group.tracks).map((track) => (
      `<div data-track-row-path="${escapeHtml(track.path)}"><button class="play-track-button" data-src="/track?path=${encodeURIComponent(track.path)}" data-track-path="${escapeHtml(track.path)}" data-track-title="${escapeHtml(track.playbackTitle || track.title)}" data-track-artist="${escapeHtml(track.artist)}" data-track-album-artist="${escapeHtml(track.albumArtist)}" data-track-album="${escapeHtml(track.album)}" data-track-cover="${escapeHtml(track.coverPath)}" data-track-duration-seconds="${track.durationSeconds}" type="button">${ButtonComponent.renderIconSvg(track.isPlaying ? 'pause' : 'play', { className: `album-track-table__play-icon ui-icon--${track.isPlaying ? 'pause' : 'play'}` })}</button><span class="track-title">${escapeHtml(track.title)}${track.secondaryArtist ? `<span class="track-artist-name">${escapeHtml(track.secondaryArtist)}</span>` : ''}</span></div>`
    )).join('');
  }
  const hasBonusDisc = componentGroups.some((group) => group.isBonus);
  if (typeof NativePlaytables !== 'undefined') NativePlaytables.prepare('album-tracks', album, componentGroups, privateRows, () => {
    const lease = getTrackModalSelectionLease(), overlay = document.getElementById('track-modal');
    const retained = typeof mobilePageState !== 'undefined' && mobilePageState.pages.some(page => page.kind === 'album');
    return getCurrentTrackModalAlbum() === album && isTrackModalSourceActionCurrent()
      && (lease ? lease.isCurrent() && lease.canOpen() : Boolean(overlay?.isConnected && (!overlay.hidden || retained)));
  }, () => {
    const lease = getTrackModalSelectionLease();
    if (lease) return lease.retainNavigation?.() || null;
    const source = getTrackModalSourcePageOwner(), view = state.view;
    return source ? source.isCurrent : () => state.view === view && album.source_readable !== false
      && !(Object.hasOwn(album.allowed_actions || {}, 'can_read') && album.allowed_actions.can_read !== true);
  }, {columns: albumTrackTableColumns({groups: componentGroups, subjectTaste: Boolean(album?.read_only_subject)})});
  const durationForGroups = (isBonus) => componentGroups
    .filter((group) => group.isBonus === isBonus)
    .reduce((total, group) => total + group.tracks.reduce((seconds, track) => (
      seconds + (Number.isFinite(track.durationSeconds) ? Math.max(0, track.durationSeconds) : 0)
    ), 0), 0);
  return buildAlbumTrackTableHtml({
    groups: componentGroups,
    selection: 'multiple', subjectTaste: Boolean(album?.read_only_subject),

    multiDisc: grouped.multiDisc,
    totalLength: totalLength ?? (album?.total_duration_display || formatAlbumDuration(album?.total_duration_seconds)),
    mainLength: hasBonusDisc && durationForGroups(false) > 0 ? (formatTrackDuration(durationForGroups(false)) || formatAlbumDuration(durationForGroups(false))) : '',
    bonusLength: hasBonusDisc && durationForGroups(true) > 0 ? (formatTrackDuration(durationForGroups(true)) || formatAlbumDuration(durationForGroups(true))) : '',
    playingAnimation: document.documentElement?.getAttribute('data-album-playing-row-animation') !== 'disabled',
  });
}

function buildPlayerTrackPayload(track, album = null) {
  if (!track) return null;
  return {
    src: `/track?path=${encodeURIComponent(track.path)}`,
    path: String(track.path || ''), inventory_track_ref: track.inventory_track_ref || null,
    title: track.title || 'Track',
    artist: track.artist || track.album_artist || '',
    albumArtist: track.album_artist || album?.album_artist || '',
    album: track.album || '',
    coverPath: track.cover_path || '',
    durationSeconds: Number(track.duration_seconds) || 0,
  };
}

function getAlbumPlaybackQueueRef(album) {
  if (typeof getAlbumIdentity === 'function') {
    return String(getAlbumIdentity(album) || album?.key || '').trim();
  }
  return String(album?.key || '').trim();
}

function getAlbumPlaybackContext(album) {
  if (album?.playback_context && typeof album.playback_context === 'object') {
    return album.playback_context;
  }
  const playbackContext = state?.view?.playback_context;
  if (!playbackContext || typeof playbackContext !== 'object') return null;
  const albumRef = getAlbumPlaybackQueueRef(album);
  const orderedAlbumRefs = Array.isArray(playbackContext.ordered_album_refs)
    ? playbackContext.ordered_album_refs.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  if (!albumRef || !orderedAlbumRefs.includes(albumRef)) return null;
  return playbackContext;
}

function buildQueueTracksForAlbum(album, startingTrackPath = '') {
  const tracks = Array.isArray(album?.tracks) ? album.tracks : [];
  const grouped = groupAlbumTracks(tracks);
  const matchingGroup = grouped.groups.find((group) => (
    Array.isArray(group.tracks) && group.tracks.some((track) => String(track.path || '') === String(startingTrackPath || ''))
  ));
  const fallbackGroup = grouped.groups.find((group) => Array.isArray(group.tracks) && group.tracks.length);
  const queueTracks = Array.isArray((matchingGroup || fallbackGroup)?.tracks)
    ? (matchingGroup || fallbackGroup).tracks.map((track) => buildPlayerTrackPayload(track, album)).filter(Boolean)
    : [];
  const currentIndex = queueTracks.findIndex((track) => String(track.path || '') === String(startingTrackPath || ''));
  return {
    tracks: queueTracks,
    currentIndex: currentIndex >= 0 ? currentIndex : 0,
  };
}

function buildAlbumPlaybackQueueState(album, startingTrackPath = '', playbackContext = null) {
  const queueState = buildQueueTracksForAlbum(album, startingTrackPath);
  if (!queueState.tracks.length) return null;
  return {
    tracks: queueState.tracks,
    currentIndex: queueState.currentIndex,
    playbackContext: playbackContext || null,
    albumRef: getAlbumPlaybackQueueRef(album),
    albumSnapshot: album,
  };
}

function canPlaybackContextAlbumContinue(playbackContext, albumRef) {
  const normalizedAlbumRef = String(albumRef || '').trim();
  if (!normalizedAlbumRef) return false;
  const albums = Array.isArray(playbackContext?.albums) ? playbackContext.albums : [];
  const albumEntry = albums.find((item) => String(item?.album_ref || '').trim() === normalizedAlbumRef);
  if (albumEntry) {
    return Boolean(albumEntry.can_play);
  }
  return true;
}

function findPlaybackContextAlbumByRef(albumRef) {
  const normalizedAlbumRef = String(albumRef || '').trim();
  if (!normalizedAlbumRef) return null;
  return flattenVisibleAlbums().find((album) => (
    getAlbumPlaybackQueueRef(album) === normalizedAlbumRef
  )) || null;
}

function resolveNextPlaybackContextQueue(queue) {
  const playbackContext = queue?.playbackContext;
  if (
    typeof canEmitPlaybackSessionSideEffects === 'function'
    && !canEmitPlaybackSessionSideEffects()
  ) {
    return null;
  }
  const resolvedEndBehavior = typeof resolveGalleryPlaybackEndBehavior === 'function'
    ? resolveGalleryPlaybackEndBehavior(playbackContext)
    : String(playbackContext?.end_behavior || '').trim().toLowerCase();
  if (!playbackContext || resolvedEndBehavior !== 'continue') {
    return null;
  }
  const orderedAlbumRefs = Array.isArray(playbackContext.ordered_album_refs)
    ? playbackContext.ordered_album_refs.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  if (!orderedAlbumRefs.length) return null;
  const currentAlbumRef = String(queue.albumRef || '').trim();
  const currentIndex = orderedAlbumRefs.findIndex((value) => value === currentAlbumRef);
  if (currentIndex < 0) return null;
  for (let index = currentIndex + 1; index < orderedAlbumRefs.length; index += 1) {
    const nextAlbumRef = orderedAlbumRefs[index];
    if (!canPlaybackContextAlbumContinue(playbackContext, nextAlbumRef)) {
      continue;
    }
    const nextAlbum = findPlaybackContextAlbumByRef(nextAlbumRef);
    if (!nextAlbum) {
      continue;
    }
    const nextQueue = buildAlbumPlaybackQueueState(nextAlbum, '', playbackContext);
    if (!nextQueue) {
      continue;
    }
    return nextQueue;
  }
  return null;
}

function setAlbumPlaybackQueue(album, startingTrackPath) {
  state.player.playbackQueue = buildAlbumPlaybackQueueState(
    album,
    startingTrackPath,
    getAlbumPlaybackContext(album),
  );
}

function peekNextQueuedTrack() {
  if (typeof ExplicitQueueRuntime !== 'undefined' && ExplicitQueueRuntime.ownsProgression()) return ExplicitQueueRuntime.peek();
  return peekNextOrdinaryQueuedTrack();
}

function peekNextOrdinaryQueuedTrack() {
  const queue = state.player.playbackQueue;
  if (!queue || !Array.isArray(queue.tracks) || !queue.tracks.length) return null;
  const currentPath = String(state.player.current?.path || '');
  const playlistIndex = typeof playlistQueueNextIndex === 'function' ? playlistQueueNextIndex(queue, currentPath) : null;
  if (playlistIndex !== null) return playlistIndex < 0 ? null : queue.tracks[playlistIndex];
  const currentIndex = queue.tracks.findIndex((track) => String(track.path || '') === currentPath);
  const resolvedIndex = currentIndex >= 0 ? currentIndex : Number(queue.currentIndex) || 0;
  const nextIndex = resolvedIndex + 1;
  if (nextIndex >= queue.tracks.length) {
    return resolveNextPlaybackContextQueue(queue)?.tracks?.[0] || null;
  }
  return queue.tracks[nextIndex];
}

function getNextQueuedTrack() {
  if (typeof ExplicitQueueRuntime !== 'undefined' && ExplicitQueueRuntime.ownsProgression()) return ExplicitQueueRuntime.consume();
  return getNextOrdinaryQueuedTrack();
}

function getNextOrdinaryQueuedTrack() {
  const queue = state.player.playbackQueue;
  if (queue?.playlistId && typeof playlistQueueNextIndex === 'function') {
    const index = playlistQueueNextIndex(queue, String(state.player.current?.path || ''));
    if (index === null || index < 0) {state.player.playbackQueue = null; return null;}
    queue.currentIndex = index; return queue.tracks[index];
  }
  const nextTrack = peekNextOrdinaryQueuedTrack();
  if (!queue || !Array.isArray(queue.tracks) || !queue.tracks.length || !nextTrack) {
    if (queue && Array.isArray(queue.tracks)) {
      const currentPath = String(state.player.current?.path || '');
      const currentIndex = queue.tracks.findIndex((track) => String(track.path || '') === currentPath);
      const resolvedIndex = currentIndex >= 0 ? currentIndex : Number(queue.currentIndex) || 0;
      if (resolvedIndex + 1 >= queue.tracks.length) {
        state.player.playbackQueue = resolveNextPlaybackContextQueue(queue);
      }
    }
    return state.player.playbackQueue?.tracks?.[0] || null;
  }
  const currentPath = String(state.player.current?.path || '');
  const currentIndex = queue.tracks.findIndex((track) => String(track.path || '') === currentPath);
  const resolvedIndex = currentIndex >= 0 ? currentIndex : Number(queue.currentIndex) || 0;
  const nextIndex = resolvedIndex + 1;
  if (nextIndex >= queue.tracks.length) {
    state.player.playbackQueue = resolveNextPlaybackContextQueue(queue);
    return state.player.playbackQueue?.tracks?.[0] || null;
  }
  queue.currentIndex = nextIndex;
  return nextTrack;
}

function refreshTrackModalPlaybackState() {
  const trackModal = typeof getTrackModalContentRoot === 'function' ? getTrackModalContentRoot() : document.getElementById('track-modal');
  if (!trackModal || (typeof isTrackModalContentVisible === 'function' ? !isTrackModalContentVisible() : trackModal.hidden)) return;
  const playback = getPlayerPlaybackSnapshot();
  const currentTrackPath = String(state.player.current?.path || '');
  const activeCurrent = formatTrackDuration(Math.floor(playback.currentTime || 0)) || '0:00';
  const activeDuration = formatTrackDuration(playback.duration) || '0:00';

  const selection = typeof getTrackModalSelectionLease === 'function' ? getTrackModalSelectionLease() : null;
  const rows = selection ? selection.dialog.querySelectorAll('[data-track-row-path]')
    : document.querySelectorAll('#track-modal [data-track-row-path]');
  let durationGrew = false;
  rows.forEach((row) => {
    const rowPath = String(row.getAttribute('data-track-row-path') || '');
    const isCurrentTrack = currentTrackPath && currentTrackPath === rowPath;
    const isActivelyPlaying = isCurrentTrack && !playback.paused && !playback.ended;
    row.classList.toggle('is-current', isCurrentTrack);
    row.classList.toggle('is-playing', isActivelyPlaying);
    row.classList.toggle('album-track-table__row--current', isCurrentTrack);
    row.classList.toggle('album-track-table__row--playing', isActivelyPlaying);
    row.classList.toggle(
      'album-track-table__row--animated',
      Boolean(isActivelyPlaying && document.documentElement?.getAttribute('data-album-playing-row-animation') !== 'disabled'),
    );
    if (row.dataset) row.dataset.trackPlaying = isActivelyPlaying ? 'true' : '';

    const button = row.querySelector('.play-track-button');
    if (button) {
      const iconName = isActivelyPlaying ? 'pause' : 'play';
      const label = isActivelyPlaying ? 'Pause track' : 'Play track';
      if (button.getAttribute('aria-label') !== label) {
        button.innerHTML = ButtonComponent.renderIconSvg(iconName, {
          className: `album-track-table__play-icon ui-icon--${iconName}`,
        });
        button.setAttribute('aria-label', label);
      }
    }

    const durationEl = row.querySelector('[data-track-duration-path]');
    if (durationEl) {
      const originalDuration = durationEl.dataset.originalDuration || '';
      const displayedTime = isCurrentTrack ? `${activeCurrent} / ${activeDuration || originalDuration || '0:00'}` : originalDuration;
      durationGrew ||= displayedTime.length > (durationEl.textContent || '').length;
      durationEl.innerHTML = displayedTime ? escapeHtml(displayedTime) : '';
    }
  });
  // Tabular digits need a new measurement only when the visible text grows.
  if (durationGrew && typeof NativePlaytables !== 'undefined') NativePlaytables.refresh?.('album-tracks');
}

function refreshNonAlbumModalPlaybackState() {
  const nonAlbumModal = document.getElementById('non-album-modal');
  if (!nonAlbumModal || nonAlbumModal.hidden) return;
  const playback = getPlayerPlaybackSnapshot();
  const currentTrackPath = String(state.player.current?.path || '');
  const activeCurrent = formatTrackDuration(Math.floor(playback.currentTime || 0)) || '0:00';
  const activeDuration = formatTrackDuration(playback.duration) || '0:00';

  let durationGrew = false;
  document.querySelectorAll('#non-album-modal [data-track-row-path]').forEach((row) => {
    const rowPath = String(row.getAttribute('data-track-row-path') || '');
    const isCurrentTrack = currentTrackPath && currentTrackPath === rowPath;
    const isActivelyPlaying = isCurrentTrack && !playback.paused && !playback.ended;
    row.classList.toggle('is-current', isCurrentTrack);
    row.classList.toggle('is-playing', isActivelyPlaying);
    row.classList.toggle('album-track-table__row--current', isCurrentTrack);
    row.classList.toggle('album-track-table__row--playing', isActivelyPlaying);
    row.classList.toggle(
      'album-track-table__row--animated',
      Boolean(isActivelyPlaying && document.documentElement?.getAttribute('data-album-playing-row-animation') !== 'disabled'),
    );
    if (row.dataset) row.dataset.trackPlaying = isActivelyPlaying ? 'true' : '';

    const button = row.querySelector('.play-track-button');
    if (button) {
      const iconName = isActivelyPlaying ? 'pause' : 'play';
      const label = isActivelyPlaying ? 'Pause track' : 'Play track';
      if (button.getAttribute('aria-label') !== label) {
        button.innerHTML = ButtonComponent.renderIconSvg(iconName, {
          className: `album-track-table__play-icon ui-icon--${iconName}`,
        });
        button.setAttribute('aria-label', label);
      }
    }

    const durationEl = row.querySelector('[data-track-duration-path]');
    if (durationEl) {
      const originalDuration = durationEl.dataset.originalDuration || '';
      const displayedTime = isCurrentTrack ? `${activeCurrent} / ${activeDuration || originalDuration || '0:00'}` : originalDuration;
      durationGrew ||= displayedTime.length > (durationEl.textContent || '').length;
      durationEl.innerHTML = displayedTime ? escapeHtml(displayedTime) : '';
    }
  });
  if (durationGrew && typeof NativePlaytables !== 'undefined') NativePlaytables.refresh?.('loose-tracks');
}


function openProblemSuggestionsConfirm() {
  const album = getSelectedProblematicAlbum();
  const proposals = getApplicableProblemSuggestions();
  if (!album?.allowed_actions?.['library.files.edit_tags'] || !proposals.length || state.utility.proposalApplyBusy) return;
  state.utility.pendingProblemSuggestions = { albumKey: album.key, ids: proposals.map(item => item.id), proposals: proposals.map(item => ({ ...item })) };
  state.utility.pendingRepairKey = album.key;
  state.utility.pendingRepairAction = 'suggestions';
  openRepairConfirmModal();
}

async function confirmProblemSuggestions() {
  const pending = state.utility.pendingProblemSuggestions;
  const album = getSelectedProblematicAlbum();
  if (!pending || state.utility.proposalApplyBusy) return;
  const visible = getVisibleProblemSuggestions();
  const proposals = pending.ids.map(id => visible.find(item => item.id === id));
  if (!album?.allowed_actions?.['library.files.edit_tags'] || album.key !== pending.albumKey || proposals.some(item => !item)) {
    showToast('These edits are no longer available. Review the current suggestions.', 'error', 3200);
    return;
  }
  const updates = {};
  for (const proposal of proposals) {
    const target = updates[proposal.path] ||= {};
    for (const [field, value] of Object.entries(proposal.updates || {})) {
      if (Object.prototype.hasOwnProperty.call(target, field) && target[field] !== value) {
        showToast('Selected edits conflict. Review the current suggestions.', 'error', 3200);
        return;
      }
      target[field] = value;
    }
  }
  const originatingViewStateRevision = readTagEditOriginViewStateRevision();
  state.utility.proposalApplyBusy = true;
  const modal = getRepairConfirmElements();
  if (modal.accept) modal.accept.disabled = true;
  if (modal.cancel) modal.cancel.disabled = true;
  try {
    const response = await fetch('/utilities/edit-tags', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmed: true, album, proposal_ids: pending.ids, updates, problematic_files_origin: true }),
    });
    const data = await response.json().catch(() => ({}));
    state.utility.proposalOutcomes = Array.isArray(data.proposal_outcomes) ? data.proposal_outcomes : [];
    const committedIds = new Set(state.utility.proposalOutcomes.filter(item => item.status === 'committed').map(item => item.id));
    if (!response.ok || !data.ok || pending.ids.some(id => !committedIds.has(id)) || (data.save_task_id && data.save_task_status !== 'completed')) {
      pending.ids.forEach(id => { (state.utility.proposalSelections ||= {})[id] = true; });
      throw new Error(data.error || 'Suggested edits were not committed.');
    }
    closeRepairConfirmModal();
    const mutation = data.save_task_id ? claimProblematicSaveTaskMutation(data.save_task_id, album, pending.albumKey) : null;
    const previousItems = state.utility.problematicFiles;
    const refreshed = await loadProblematicFiles(true, { render: false });
    if (!refreshed) {
      state.utility.problematicFiles = previousItems;
      if (mutation) await settleProblematicSaveTaskMutation(data.save_task_id);
      throw new Error('Edits were saved, but Problems could not refresh. Reload before retrying.');
    }
    pending.ids.forEach(id => { if (state.utility.proposalSelections) delete state.utility.proposalSelections[id]; });
    if (mutation) await settleProblematicSaveTaskMutation(data.save_task_id, { reconcileSelection: true });
    else {
      const selectedKey = state.utility.selectedProblematicKey;
      if ((state.utility.problematicFiles || []).some(item => item.key === selectedKey)) await loadProblematicAlbumDetail(selectedKey, true, { render: false });
      renderUtilityModalContent();
    }
    if (tagEditOriginStillOwnsView(originatingViewStateRevision) && Array.isArray(data.updated_albums) && data.updated_albums.length) {
      updateOpenTrackModalAfterTagEdit(album, applyUpdatedAlbumsToCurrentView(data.updated_albums, { originalAlbum: album, preserveScroll: true }));
    }
    showToast('Suggested edits applied.', 'success', 2400);
  } catch (error) {
    console.error('[AlbumHaven][Utilities] Suggested edits failed.', error);
    showToast(error.message || 'Unable to apply suggested edits.', 'error', 4000);
  } finally {
    state.utility.proposalApplyBusy = false;
    if (modal.accept) modal.accept.disabled = false;
    if (modal.cancel) modal.cancel.disabled = false;
    syncProblemSuggestionSelection();
  }
}
