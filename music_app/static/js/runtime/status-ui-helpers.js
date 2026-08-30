function buildStatusIndicatorTitleParts(data = {}) {
  const progressText = {
    value: '',
  };
  const parts = [];
  if (data.scan_in_progress) {
    const scanPhase = String(data.scan_phase || '').trim().toLowerCase();
    const scanTotal = Number(data.scan_total || 0);
    const scanProcessed = Number(data.scan_processed || 0);
    const hasScanProgress = scanTotal > 0 || scanProcessed > 0 || Boolean(data.scan_current_path);
    if (scanPhase === 'discovering') {
      parts.push('Discovering music files');
      parts.push(`Found so far: ${scanTotal}`);
      if (data.scan_current_path) {
        parts.push(`Current file: ${data.scan_current_path}`);
      }
    } else if (hasScanProgress) {
      progressText.value = `${scanProcessed} / ${scanTotal}`;
      parts.push(`Library scan: ${progressText.value}`);
      if (Number(data.scan_estimated_remaining_seconds || 0) > 0) {
        parts.push(`Estimated time left: ${formatDurationCompact(data.scan_estimated_remaining_seconds)}`);
      }
      if (Number(data.scan_elapsed_seconds || 0) > 0) {
        parts.push(`Elapsed: ${formatDurationCompact(data.scan_elapsed_seconds)}`);
      }
      if (Number(data.scan_album_folders_total || 0) > 0) {
        parts.push(`Album folders: ${Number(data.scan_album_folders_processed || 0)} / ${Number(data.scan_album_folders_total || 0)}`);
      }
      if (data.scan_current_path) {
        parts.push(`Current file: ${data.scan_current_path}`);
      }
    } else {
      parts.push('Preparing library scan');
      parts.push('Discovering music files before progress is available');
    }
  }
  if (data.relations_in_progress) {
    if (!progressText.value) {
      progressText.value = `${Number(data.relations_processed || 0)} / ${Number(data.relations_total || 0)}`;
    }
    parts.push(`${data.relations_phase}: ${Number(data.relations_processed || 0)} / ${Number(data.relations_total || 0)} (${data.relations_source})`);
  }
  if (data.covers_in_progress) {
    if (!progressText.value) {
      progressText.value = `${Number(data.covers_processed || 0)} / ${Number(data.covers_total || 0)}`;
    }
    parts.push(`Updating cover art: ${Number(data.covers_processed || 0)} / ${Number(data.covers_total || 0)} covers updated`);
    parts.push(`Downloaded covers: ${Number(data.covers_downloaded || 0)}`);
    if (data.covers_current_folder) {
      parts.push(`Current album folder: ${data.covers_current_folder}`);
    }
  }
  if (!parts.length) {
    parts.push('Library ready');
  }
  if (typeof data.album_total === 'number') {
    parts.push(`Total albums: ${data.album_total}`);
  }
  if (data.last_scan_display) {
    parts.push(`Last scan: ${data.last_scan_display}`);
  }
  return parts;
}

function buildStatusIndicatorTitleText(data = {}) {
  return buildStatusIndicatorTitleParts(data).join('\n');
}

function freezeStatusIndicatorTitleSnapshot(indicator, fallbackTitle = '') {
  if (!indicator || !indicator.dataset) return;
  const liveTitle = String(indicator.getAttribute?.('title') || indicator.title || fallbackTitle || '');
  indicator.dataset.hoverTitleFrozen = '1';
  indicator.dataset.hoverTitleSnapshot = liveTitle;
}

function releaseStatusIndicatorTitleSnapshot(indicator) {
  if (!indicator || !indicator.dataset) return;
  const pendingTitle = String(indicator.dataset.pendingTitle || '');
  indicator.dataset.hoverTitleFrozen = '';
  indicator.dataset.hoverTitleSnapshot = '';
  if (pendingTitle) {
    indicator.title = pendingTitle;
  }
}

function ensureStatusIndicatorHoverSnapshotBehavior(indicator) {
  if (!indicator || indicator.__albumHavenHoverSnapshotBound) return;
  indicator.addEventListener('mouseenter', () => {
    freezeStatusIndicatorTitleSnapshot(indicator);
  });
  indicator.addEventListener('mouseleave', () => {
    releaseStatusIndicatorTitleSnapshot(indicator);
  });
  indicator.addEventListener('focus', () => {
    freezeStatusIndicatorTitleSnapshot(indicator);
  });
  indicator.addEventListener('blur', () => {
    releaseStatusIndicatorTitleSnapshot(indicator);
  });
  indicator.__albumHavenHoverSnapshotBound = true;
}

function resolveStatusIndicatorTitleText(indicator, data = {}) {
  const nextTitle = buildStatusIndicatorTitleText(data);
  if (!indicator || !indicator.dataset) {
    return nextTitle;
  }
  indicator.dataset.pendingTitle = nextTitle;
  if (indicator.dataset.hoverTitleFrozen === '1') {
    return String(indicator.dataset.hoverTitleSnapshot || nextTitle);
  }
  return nextTitle;
}

function ensureStatusContextMenu() {
  let menu = document.getElementById('status-context-menu');
  if (menu) return menu;
  menu = document.createElement('div');
  menu.id = 'status-context-menu';
  menu.className = 'status-context-menu';
  menu.hidden = true;
  menu.innerHTML = '<button type="button" class="status-context-menu-item" data-status-role="scan-action" data-status-action="full-rescan">Full Rescan</button><button type="button" class="status-context-menu-item" data-status-role="cover-action" data-status-action="fetch-covers">Fetch Album Covers</button>';
  document.body.appendChild(menu);
  return menu;
}

function resolvePrimaryStatusContextAction(status = {}, options = {}) {
  const scanBusy = Boolean(status.scan_in_progress);
  const relationBusy = Boolean(status.relations_in_progress);
  const coverBusy = Boolean(status.covers_in_progress);
  const anyBusy = scanBusy || relationBusy || coverBusy;
  if (anyBusy) {
    return {
      action: 'go-to-scan-page',
      label: 'Go to Scan Page',
      disabled: false,
    };
  }
  return {
    action: 'full-rescan',
    label: 'Full Rescan',
    disabled: false,
  };
}

function syncStatusContextButtonPresentation(button, presentation) {
  if (!button) return;
  if (button.getAttribute('data-status-action') !== presentation.action) {
    button.setAttribute('data-status-action', presentation.action);
  }
  if (button.textContent !== presentation.label) {
    button.textContent = presentation.label;
  }
  const disabled = Boolean(presentation.disabled);
  if (button.disabled !== disabled) {
    button.disabled = disabled;
  }
}

function syncStatusContextMenu() {
  const menu = ensureStatusContextMenu();
  const primaryButton = menu.querySelector('[data-status-role="scan-action"]');
  const fetchOrCancelButton = menu.querySelector('[data-status-role="cover-action"]');
  if (primaryButton) {
    const scanPageVisible = Boolean(state.ui?.scanPageReturnContext);
    const primaryAction = resolvePrimaryStatusContextAction(state.status || {}, { scanPageVisible });
    syncStatusContextButtonPresentation(primaryButton, primaryAction);
  }
  if (!fetchOrCancelButton) return menu;
  const scanBusy = Boolean(state.status?.scan_in_progress || state.status?.relations_in_progress);
  const coverBusy = Boolean(state.status?.covers_in_progress);
  const coverQueued = Boolean(state.status?.pending_cover_refresh_after_scan);
  const initialFullScanBusy = scanBusy && Number(state.status?.album_total || 0) <= 0;
  if (coverBusy) {
    syncStatusContextButtonPresentation(fetchOrCancelButton, {
      action: 'cancel-cover-scan',
      label: 'Cancel Album Cover Scan',
      disabled: false,
    });
  } else if (coverQueued) {
    syncStatusContextButtonPresentation(fetchOrCancelButton, {
      action: 'fetch-covers-queued',
      label: 'Fetching Covers Is Queued',
      disabled: true,
    });
  } else if (initialFullScanBusy) {
    syncStatusContextButtonPresentation(fetchOrCancelButton, {
      action: 'fetch-covers',
      label: 'Fetch Album Covers',
      disabled: true,
    });
  } else {
    syncStatusContextButtonPresentation(fetchOrCancelButton, {
      action: 'fetch-covers',
      label: 'Fetch Album Covers',
      disabled: false,
    });
  }
  return menu;
}

function hideStatusContextMenu() {
  const menu = document.getElementById('status-context-menu');
  if (!menu) return;
  menu.hidden = true;
}

function showStatusContextMenu(x, y) {
  const menu = syncStatusContextMenu();
  menu.hidden = false;
  const padding = 8;
  const menuRect = menu.getBoundingClientRect();
  const clamped = clampPositionToViewport(x, y, menuRect.width, menuRect.height, padding);
  menu.style.left = `${clamped.left}px`;
  menu.style.top = `${clamped.top}px`;
}

function startStatusIndicatorImmediately(overrides = {}) {
  updateStatusIndicator({
    ...state.status,
    scan_in_progress: Boolean(state.status?.scan_in_progress),
    relations_in_progress: Boolean(state.status?.relations_in_progress),
    covers_in_progress: Boolean(state.status?.covers_in_progress),
    scan_processed: Number(state.status?.scan_processed || 0),
    scan_total: Number(state.status?.scan_total || 0),
    relations_processed: Number(state.status?.relations_processed || 0),
    relations_total: Number(state.status?.relations_total || 0),
    covers_processed: Number(state.status?.covers_processed || 0),
    covers_total: Number(state.status?.covers_total || 0),
    covers_downloaded: Number(state.status?.covers_downloaded || 0),
    ...overrides,
  });
}

function updateStatusIndicator(data) {
  const normalizedStatus = applyStatusPayload(data);
  syncStatusContextMenu();
  const indicator = document.getElementById('scan-indicator');
  if (!indicator) return;
  ensureStatusIndicatorHoverSnapshotBehavior(indicator);
  const progressEl = document.getElementById('scan-indicator-progress');
  const scanBusy = Boolean(normalizedStatus.scan_in_progress);
  const relBusy = Boolean(normalizedStatus.relations_in_progress);
  const coverBusy = Boolean(normalizedStatus.covers_in_progress);
  const busy = scanBusy || relBusy || coverBusy;
  indicator.classList.remove('is-idle', 'is-busy', 'is-done');
  indicator.classList.add(busy ? 'is-busy' : 'is-done');

  indicator.title = resolveStatusIndicatorTitleText(indicator, normalizedStatus);
  if (progressEl) {
    progressEl.textContent = '';
    progressEl.style.display = 'none';
  }

  renderLibraryLoader(normalizedStatus);
}
