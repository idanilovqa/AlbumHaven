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
    parts.push(`${albumFoldersProcessed} of ${albumFoldersTotal} album folders`);
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
  if (data.covers_in_progress) {
    const currentFolder = String(data.covers_current_folder || '').split(/[\\/]/).pop();
    lines.push({
      title: 'Updating cover art',
      detail: `${Number(data.covers_processed || 0)} of ${Number(data.covers_total || 0)} folders checked${currentFolder ? ` - ${currentFolder}` : ''}`,
    });
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
