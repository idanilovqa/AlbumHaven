function formatDurationCompact(totalSeconds) {
  const seconds = Math.max(0, Math.round(Number(totalSeconds || 0)));
  if (!Number.isFinite(seconds) || seconds <= 0) return 'less than 1s';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${String(secs).padStart(2, '0')}s`;
  }
  return `${secs}s`;
}


function scanStageElapsedDetail(data = {}, stage = '') {
  const elapsed = stage === 'covers'
    ? Number(data.covers_elapsed_seconds)
    : Number(data.scan_stage_elapsed_seconds?.[stage]);
  return Number.isFinite(elapsed) ? `elapsed ${formatDurationCompact(elapsed)}` : '';
}


function buildScanEstimateParts(data = {}) {
  const parts = [];
  const remainingSeconds = Number(data.scan_estimated_remaining_seconds || 0);
  const elapsedSeconds = Number(data.scan_elapsed_seconds || 0);
  const albumFoldersProcessed = Number(data.scan_album_folders_processed || 0);
  const albumFoldersTotal = Number(data.scan_album_folders_total || 0);
  if (remainingSeconds > 0) {
    parts.push(`ETA ${formatDurationCompact(remainingSeconds)}`);
  }
  if (elapsedSeconds > 0) {
    parts.push(`elapsed ${formatDurationCompact(elapsedSeconds)}`);
  }
  if (albumFoldersTotal > 0) {
    parts.push(`${albumFoldersProcessed} of ${albumFoldersTotal} albums`);
  }
  return parts;
}


function buildLoaderStatusLines(data, options = {}) {
  const lines = [];
  if (data.transition_in_progress || options.pendingViewTransition) {
    lines.push({
      title: 'Loading selection',
      detail: String(data.transition_detail || 'Updating the current artist view...'),
    });
    return lines;
  }
  if (data.scan_in_progress) {
    const scanPhase = String(data.scan_phase || '').trim().toLowerCase();
    const currentFile = String(data.scan_current_path || '').split(/[\\/]/).pop();
    const estimateParts = buildScanEstimateParts(data);
    const scanTotal = Number(data.scan_total || 0);
    const scanProcessed = Number(data.scan_processed || 0);
    const scanHasProgress = scanTotal > 0 || scanProcessed > 0 || Boolean(currentFile);
    const scanAdmission = !scanHasProgress && (!scanPhase || scanPhase === 'idle');
    if (scanPhase === 'finalizing') {
      lines.push({
        title: 'Refreshing artist relations',
        detail: 'Finishing artist-family links before publishing the refreshed library.',
      });
    } else if (scanPhase === 'discovering' || (options.scanPageVisible && scanAdmission)) {
      lines.push({
        title: 'Discovering music files',
        detail: `${scanTotal} file${scanTotal === 1 ? '' : 's'} found so far${currentFile ? ` - ${currentFile}` : ''}`,
      });
    } else {
      lines.push(scanHasProgress ? {
      title: 'Scanning music files',
      detail: `${scanProcessed} of ${scanTotal} files processed${currentFile ? ` - ${currentFile}` : ''}`,
    } : {
      title: 'Preparing library scan',
      detail: 'Discovering music files before progress is available...',
    });
    }
    if (scanPhase !== 'discovering' && scanHasProgress && estimateParts.length) {
      lines.push({
        title: 'Scan timing',
        detail: estimateParts.join(' | '),
      });
    }
  }
  if (data.relations_in_progress && String(data.scan_phase || '').trim().toLowerCase() !== 'finalizing') {
    lines.push({
      title: data.relations_phase || 'Building artist families',
      detail: `${Number(data.relations_processed || 0)} of ${Number(data.relations_total || 0)} artists (${data.relations_source || 'local'})`,
    });
  }
  if (data.covers_in_progress || (!data.scan_in_progress && data.covers_phase === 'finished')) {
    const currentFolder = String(data.covers_current_folder || '').split(/[\\/]/).pop();
    lines.push({
      title: data.covers_in_progress ? (data.covers_phase === 'preparing' ? 'Preparing cover search' : 'Fetching covers')
        : data.covers_outcome === 'failed' ? 'Cover search failed'
        : data.covers_outcome === 'cancelled' ? 'Cover search cancelled' : 'Cover search finished',
      detail: buildCoverProgressDetail(data, currentFolder),
    });
    if (data.covers_phase !== 'preparing' && !data.status_connection_lost && data.covers_spotify_quota_exceeded) {
      lines.push({ title: 'Spotify', detail: 'Spotify quota reached — skipped for this run' });
    }
  }
  if (!lines.length) {
    lines.push(options.scanPageVisible ? {
      title: 'No Active Scan Running',
      detail: 'Your local library is ready. Start a scan when you want to check for music changes.',
    } : {
      title: 'Loading library',
      detail: 'Waiting for the first albums to become available...',
    });
  }
  return lines;
}

function buildCoverProgressDetail(data, currentAlbum = '') {
  if (data.status_connection_lost) return 'Progress unavailable — reconnecting. Last reported counts may be outdated.';
  const total = Number(data.covers_total);
  const processed = Number(data.covers_completed ?? data.covers_processed);
  const known = Number.isFinite(total) && total > 0 && Number.isFinite(processed) && processed >= 0;
  const parts = [data.covers_phase === 'preparing' ? 'Preparing cover search' : known
    ? `${processed} of ${total} albums checked (${Math.min(100, Math.round(processed / total * 100))}%)`
    : data.covers_outcome === 'completed' && total === 0 ? 'No albums needed a cover search' : 'Progress unavailable'];
  if (Number.isFinite(Number(data.covers_downloaded)) && data.covers_downloaded != null) {
    parts.push(`${Number(data.covers_downloaded)} covers fetched`);
  }
  if (data.covers_outcome === 'failed') parts.unshift('Cover search failed');
  if (data.covers_outcome === 'cancelled') parts.unshift('Cover search cancelled');
  if (data.covers_elapsed_seconds != null && Number.isFinite(Number(data.covers_elapsed_seconds))) {
    parts.push(`elapsed ${formatDurationCompact(data.covers_elapsed_seconds)}`);
  }
  const eta = Number(data.covers_estimated_remaining_seconds);
  if (data.covers_in_progress && data.covers_phase !== 'preparing') {
    parts.push(data.covers_estimated_remaining_seconds != null && Number.isFinite(eta) && eta >= 0
      ? `ETA ${formatDurationCompact(eta)}` : 'ETA calculating…');
  }
  if (currentAlbum) parts.push(currentAlbum);
  return parts.join(' · ');
}
