function buildUtilityLogHistoryListItem(item, selected) {
  const timestamp = formatLogHistoryTimestamp(item?.timestamp);
  const count = Number(item?.file_count || 0);
  const summary = [item.artist, item.album, item.title].filter(Boolean).join(' - ');
  return `
    <button class="utility-list-item ${selected ? 'is-active' : ''}" type="button" data-utility-log-history-id="${escapeHtml(item.id || '')}">
      <span class="utility-list-item-title">${escapeHtml(item.action || 'Activity')}</span>
      <span class="utility-list-item-meta">${escapeHtml(summary || 'Unknown album')}</span>
      <span class="utility-list-item-issues">${escapeHtml(timestamp || `${count} files`)}</span>
    </button>
  `;
}

function buildUtilityLogHistoryDetail(item) {
  if (!item) {
    return `
      <div class="utility-empty-state">Select a log entry to inspect the saved file changes.</div>
      <div class="confirm-modal-actions">
        <button class="button button-secondary" type="button" data-export-log-history="1">Export Logs</button>
      </div>
    `;
  }
  const files = Array.isArray(item.files) ? item.files : [];
  const downloaded = Number(item.downloaded || 0);
  const notTouched = Number(item.not_touched ?? item.skipped ?? 0);
  const notFound = Number(item.not_found ?? item.failed ?? 0);
  const processed = Number(item.processed || 0);
  const summaryParts = [
    item.artist || '',
    item.album || '',
    item.title || '',
    item.file_count ? `${item.file_count} file${Number(item.file_count) === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  const coverSummaryParts = [];
  if (processed || downloaded || notTouched || notFound) {
    coverSummaryParts.push(`Checked: ${processed}`);
    coverSummaryParts.push(`Downloaded: ${downloaded}`);
    coverSummaryParts.push(`Not touched: ${notTouched}`);
    coverSummaryParts.push(`Not found: ${notFound}`);
  }
  return `
    <div class="utility-rule-detail">
      <h3 class="utility-rule-title">${escapeHtml(item.action || 'Activity')}</h3>
      <p class="utility-rule-description">${escapeHtml(formatLogHistoryTimestamp(item.timestamp) || '')}</p>
      <p class="utility-rule-description">${escapeHtml(item.source_label || 'This browser')}</p>
      <div class="utility-rule-album-list">
        <div class="utility-rule-group-meta">${escapeHtml(summaryParts.join(' - '))}</div>
        ${coverSummaryParts.length ? `<div class="utility-rule-album-meta">${escapeHtml(coverSummaryParts.join(' | '))}</div>` : ''}
        ${item.error ? `<div class="utility-rule-album-meta">${escapeHtml(item.error)}</div>` : ''}
        ${files.length
          ? `<div class="utility-log-history-files">${files.map((path) => `<div class="utility-log-history-file">${escapeHtml(path)}</div>`).join('')}</div>`
          : '<div class="utility-empty-state compact">No downloaded cover paths recorded.</div>'}
      </div>
      <div class="confirm-modal-actions">
        <button class="button button-secondary" type="button" data-export-log-history="1">Export Logs</button>
      </div>
    </div>
  `;
}

function getSelectedUtilityLoop() {
  return (state.utility.loops || []).find((item) => String(item.id || '') === String(state.utility.selectedLoopId || '')) || null;
}

function getSelectedUtilityLoopGroup() {
  const groups = groupUtilityLoops(state.utility.loops || []);
  const selectedGroupKey = String(state.utility.selectedLoopGroupKey || '');
  if (selectedGroupKey) {
    const direct = groups.find((group) => String(group?.key || '') === selectedGroupKey);
    if (direct) return direct;
  }
  const selectedLoop = getSelectedUtilityLoop();
  const selectedKey = selectedLoop ? buildUtilityLoopGroupKey(selectedLoop) : '';
  return groups.find((group) => String(group?.key || '') === selectedKey) || null;
}

function buildUtilityLoopEntry(loop) {
  const mediaSrc = `/loops/media/${encodeURIComponent(loop.id || '')}`;
  const loopId = escapeHtml(loop.id || '');
  const repeatEnabled = Boolean(state.utility.loopRepeatEnabled) && String(state.utility.selectedLoopId || '') === String(loop.id || '');
  return `
    <section class="utility-loop-entry ${repeatEnabled ? 'is-active' : ''}" data-utility-loop-entry="${escapeHtml(loop.id || '')}">
      <div class="utility-loop-heading">
        <div>
          <h3 class="utility-detail-title">${escapeHtml(loop.name || 'Saved loop')}</h3>
        </div>
        <button class="icon-button utility-loop-remove" type="button" data-delete-saved-loop="${escapeHtml(loop.id || '')}" aria-label="Remove loop" title="Remove loop">&#128465;</button>
      </div>
      <div class="utility-loop-shell" data-utility-loop-shell="${escapeHtml(loop.id || '')}">
        <audio class="utility-loop-audio" data-loop-audio="${escapeHtml(loop.id || '')}" data-original-src="${mediaSrc}" src="${mediaSrc}" preload="none"></audio>
        <div class="loop-play-control-cluster utility-loop-play-cluster">
          <button class="loop-play-control-button utility-loop-play" type="button" data-loop-play="${escapeHtml(loop.id || '')}" aria-label="Play or pause">&#9654;</button>
          <span class="loop-play-control-actions utility-loop-actions">
            ${buildLoopEditActionControl({ ownerId: `saved-loop-${loopId}`, enterLabel: 'Create another loop', createLabel: 'Create loop', cancelLabel: 'Cancel loop creation' })}
          </span>
        </div>
        <div class="utility-loop-main" data-saved-loop-main-surface="${loopId}">
          <div class="utility-loop-player-top-row" data-loop-player-top-row>
            <div class="utility-loop-control utility-loop-pitch-control" data-loop-pitch-control="${loopId}" data-loop-pitch-controls="${loopId}" aria-label="Pitch shift">
              <button type="button" data-loop-pitch-step="-1" aria-label="Lower pitch">-</button>
              <span data-loop-pitch-value>0 pst</span>
              <button type="button" data-loop-pitch-step="1" aria-label="Raise pitch">+</button>
            </div>
            <div class="utility-loop-time" data-loop-time="${loopId}">0:00 / 0:00</div>
          </div>
          <div class="utility-loop-timeline-wrap">
            <input class="utility-loop-timeline" type="range" data-loop-timeline="${escapeHtml(loop.id || '')}" min="0" max="100" step="0.01" value="0" aria-label="Playback position">
            <div class="loop-range-surface" data-loop-range-owner="saved-loop-${loopId}" data-loop-range-surface hidden>
              <canvas class="utility-saved-loop-waveform" data-loop-range-waveform aria-hidden="true"></canvas>
              <div class="loop-range-selection"></div>
              <button class="loop-range-handle is-start" type="button" role="slider" data-loop-range-handle="start" aria-label="Loop start"></button>
              <button class="loop-range-handle is-end" type="button" role="slider" data-loop-range-handle="end" aria-label="Loop end"></button>
            </div>
          </div>
        </div>
        <button class="utility-loop-repeat ${repeatEnabled ? 'is-active' : ''}" type="button" data-toggle-loop-repeat="${escapeHtml(loop.id || '')}" aria-pressed="${repeatEnabled ? 'true' : 'false'}" aria-label="${repeatEnabled ? 'Disable repeat' : 'Enable repeat'}" title="${repeatEnabled ? 'Disable repeat' : 'Enable repeat'}">&#8635;</button>
        <div class="utility-loop-speed-control" data-loop-speed-control="${escapeHtml(loop.id || '')}" aria-label="Playback speed">
          <button class="utility-loop-speed-step" type="button" data-loop-speed-step="-0.05" aria-label="Decrease speed">-</button>
          <button class="utility-loop-speed-value" type="button" data-loop-speed-value-button="${escapeHtml(loop.id || '')}" aria-label="Playback speed">1x</button>
          <button class="utility-loop-speed-step" type="button" data-loop-speed-step="0.05" aria-label="Increase speed">+</button>
          <div class="utility-loop-speed-menu" data-loop-speed-menu="${escapeHtml(loop.id || '')}" hidden>
            <button type="button" data-loop-speed-option="0.25">0.25x</button>
            <button type="button" data-loop-speed-option="0.50">0.5x</button>
            <button type="button" data-loop-speed-option="0.75">0.75x</button>
            <button type="button" data-loop-speed-option="1.00">1x</button>
            <button type="button" data-loop-speed-option="1.25">1.25x</button>
            <button type="button" data-loop-speed-option="1.50">1.5x</button>
            <button type="button" data-loop-speed-option="1.75">1.75x</button>
            <button type="button" data-loop-speed-option="2.00">2x</button>
          </div>
        </div>
      </div>
    </section>
  `;
}

function buildUtilityLoopDetail(loopGroup, selectedLoop = null) {
  const group = loopGroup;
  if (!group || !Array.isArray(group.loops) || !group.loops.length) {
    return '<div class="utility-empty-state">Select a saved song to inspect its loops.</div>';
  }
  const representative = group.representativeLoop || group.loops[0];
  const coverHtml = representative.cover_path
    ? `<img class="utility-detail-cover-image" src="/cover?path=${encodeURIComponent(representative.cover_path)}" alt="Artwork for ${escapeHtml(representative.title || representative.name || 'loop')}">`
    : '<div class="utility-detail-cover-placeholder">No artwork</div>';
  const loopsToRender = selectedLoop ? [selectedLoop] : group.loops;
  const headerTitle = representative.title || representative.name || 'Saved loops';
  const artistLine = representative.artist || '';
  const albumLine = representative.album || '';
  const yearLine = representative.year ? String(representative.year) : '';
  return `
    <div class="utility-loop-detail utility-loop-group-detail">
      <div class="utility-loop-detail-header">
        <div class="utility-detail-cover utility-loop-sticky-cover">${coverHtml}</div>
        <div class="utility-loop-group-summary">
          <div>
            <h3 class="utility-detail-title">${escapeHtml(headerTitle)}</h3>
            <div class="utility-detail-meta">${escapeHtml(artistLine || 'Unknown artist')}</div>
            <div class="utility-detail-meta">${escapeHtml(albumLine || 'Unknown album')}</div>
            ${yearLine ? `<div class="utility-detail-meta">${escapeHtml(yearLine)}</div>` : ''}
          </div>
          <div class="utility-detail-meta">${escapeHtml(selectedLoop ? '1 loop selected' : `${group.loops.length} saved loop${group.loops.length === 1 ? '' : 's'}`)}</div>
        </div>
      </div>
      <div class="utility-loop-group-main">
        <div class="utility-loop-entry-list">${loopsToRender.map((loop) => buildUtilityLoopEntry(loop)).join('')}</div>
      </div>
    </div>
  `;
}

function buildUtilityAppearanceListItem(key, title, subtitle, selected) {
  return `
    <button class="utility-list-item ${selected ? 'is-active' : ''}" type="button" data-utility-appearance-key="${escapeHtml(key)}">
      <span class="utility-list-item-title">${escapeHtml(title)}</span>
      <span class="utility-list-item-meta">${escapeHtml(subtitle)}</span>
    </button>
  `;
}

function buildUtilityAppearanceDetail() {
  const appearance = state.player.appearance || getDefaultPlayerAppearance();
  const waveformSelected = appearance.seekbarMode === 'waveform';
  return `
    <div class="utility-rule-detail">
      <h3 class="utility-rule-title">Seekbar</h3>
      <p class="utility-rule-description">Choose the player seekbar style. Waveform keeps loop selection and seek behavior intact.</p>
      <div class="appearance-section">
        <label class="appearance-option">
          <input type="radio" name="seekbar-mode" value="default" ${waveformSelected ? '' : 'checked'} data-appearance-seekbar-mode="default">
          <span>Default seekbar</span>
        </label>
        <label class="appearance-option">
          <input type="radio" name="seekbar-mode" value="waveform" ${waveformSelected ? 'checked' : ''} data-appearance-seekbar-mode="waveform">
          <span>Waveform seekbar</span>
        </label>
      </div>
      <div class="appearance-color-grid ${waveformSelected ? '' : 'is-disabled'}">
        <label class="appearance-color-field">
          <span>Waveform fill</span>
          <input type="color" value="${escapeHtml(appearance.waveformFillColor)}" data-appearance-color="fill" ${waveformSelected ? '' : 'disabled'}>
        </label>
        <label class="appearance-color-field">
          <span>Waveform edge</span>
          <input type="color" value="${escapeHtml(appearance.waveformEdgeColor)}" data-appearance-color="edge" ${waveformSelected ? '' : 'disabled'}>
        </label>
      </div>
    </div>
  `;
}

function buildUtilityIntegrationListItem(item, selected) {
  const status = String(item?.status_label || '').trim() || (item?.connected
    ? 'Connected'
    : (item?.api_configured ? 'Not connected' : 'Server setup required'));
  return `
    <button class="utility-list-item ${selected ? 'is-active' : ''}" type="button" data-utility-integration-key="${escapeHtml(item?.key || '')}">
      <span class="utility-list-item-title">${escapeHtml(item?.title || 'Integration')}</span>
      <span class="utility-list-item-meta">${escapeHtml(item?.description || '')}</span>
      <span class="utility-list-item-issues">${escapeHtml(status)}</span>
    </button>
  `;
}

function buildLastfmTimeZoneOptions(selectedTimeZone) {
  const selected = String(selectedTimeZone || '').trim();
  const detectedTimeZone = getDetectedBrowserTimeZone();
  const supported = new Set(getSupportedBrowserTimeZones());
  if (detectedTimeZone) supported.add(detectedTimeZone);
  if (selected) supported.add(selected);
  return Array.from(supported)
    .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }))
    .map((timeZone) => `<option value="${escapeHtml(timeZone)}" ${timeZone === selected ? 'selected' : ''}>${escapeHtml(timeZone)}</option>`)
    .join('');
}

function buildUtilityIntegrationDetail(item) {
  if (item?.key === 'library') {
    return buildUtilityLibrarySettingsDetail(item);
  }
  if (item?.key === 'local_playlist_import') {
    const importState = state.utility?.localPlaylistImport || {};
    const supportedExtensions = Array.isArray(item.supported_extensions) ? item.supported_extensions : [];
    const targetOptions = Array.isArray(item.target_options) ? item.target_options : [];
    const lastAnalysis = importState.lastAnalysis && typeof importState.lastAnalysis === 'object' ? importState.lastAnalysis : null;
    const blockedTargets = Array.isArray(lastAnalysis?.target_recommendation?.blocked_targets)
      ? lastAnalysis.target_recommendation.blocked_targets
      : [];
    const targetRows = targetOptions.length
      ? targetOptions.map((target) => `
        <div class="utility-rule-album-row">
          <div class="utility-rule-album-main">
            <div class="utility-rule-album-title">${escapeHtml(target.title || target.key || 'Target')}</div>
            <div class="utility-rule-album-meta">${escapeHtml(target.description || '')}</div>
          </div>
        </div>
      `).join('')
      : '<div class="utility-empty-state compact">Target rules will land here later.</div>';
    const blockedRows = blockedTargets.length
      ? blockedTargets.map((blocked) => `<div class="utility-rule-album-meta">Album Top unavailable: ${escapeHtml(blocked.reason || '')}</div>`).join('')
      : '';
    const analysisHtml = lastAnalysis ? `
      <section class="utility-rule-album-list">
        <div class="utility-rule-album-title">${escapeHtml(lastAnalysis.status?.label || 'Preview contract ready')}</div>
        <div class="utility-rule-album-meta">${escapeHtml(lastAnalysis.status?.detail || '')}</div>
        <div class="utility-rule-album-meta">${escapeHtml(lastAnalysis.source?.filename || '')}</div>
        <div class="utility-rule-album-meta">${escapeHtml(lastAnalysis.source?.source_kind || '')}</div>
        <div class="utility-rule-album-meta">${escapeHtml(lastAnalysis.source?.parser_mode || '')}</div>
        <div class="utility-rule-album-meta">Recommended target: ${escapeHtml(lastAnalysis.target_recommendation?.recommended_target || 'playlist')}</div>
        ${blockedRows}
      </section>
    ` : '<div class="utility-empty-state compact">Select a local playlist file to prepare the analyze/preview contract.</div>';
    const completionPreview = lastAnalysis?.local_library_completion && typeof lastAnalysis.local_library_completion === 'object'
      ? lastAnalysis.local_library_completion
      : (item.local_library_completion && typeof item.local_library_completion === 'object' ? item.local_library_completion : {});
    const importStatus = item.import_status && typeof item.import_status === 'object' ? item.import_status : {};
    return `
      <div class="utility-rule-detail">
        <h3 class="utility-rule-title">${escapeHtml(item.title || 'Import Local Playlist')}</h3>
        <p class="utility-rule-description">${escapeHtml(item.description || '')}</p>
        <div class="utility-rule-album-meta">${escapeHtml(item.status_label || 'Analyze/preview contract ready')}</div>
        <div class="utility-rule-album-meta">Supports: ${escapeHtml(supportedExtensions.join(', ') || 'No playlist formats configured yet.')}</div>
        <div class="utility-loop-create-row">
          <input type="file" data-local-playlist-import-file accept="${escapeHtml(supportedExtensions.join(','))}">
          <button class="button" type="button" data-analyze-local-playlist="1" ${importState.analyzeBusy ? 'disabled' : ''}>${importState.analyzeBusy ? 'Analyzing...' : 'Analyze playlist'}</button>
        </div>
        <div class="utility-rule-album-meta">${escapeHtml(importState.selectedFileName || 'No file selected')}</div>
        ${importState.error ? `<div class="utility-rule-album-meta">${escapeHtml(importState.error)}</div>` : ''}
        ${analysisHtml}
        ${buildUtilityCollapsibleSection('local-playlist-import-targets', 'Target direction', targetRows)}
        ${buildUtilityCollapsibleSection('local-playlist-import-completion', completionPreview.label || 'Completion preview direction reserved', `<div class="utility-rule-album-meta">${escapeHtml(completionPreview.detail || '')}</div>`)}
        ${buildUtilityCollapsibleSection('local-playlist-import-status', importStatus.label || 'Final import execution lands later', `<div class="utility-rule-album-meta">${escapeHtml(importStatus.detail || '')}</div>`)}
      </div>
    `;
  }
  if (item?.key === 'foobar') {
    const sourceFamilies = Array.isArray(item.source_families) ? item.source_families : [];
    const referenceAssets = Array.isArray(item.reference_assets) ? item.reference_assets : [];
    const writeBackScopes = Array.isArray(item.write_back_scopes) ? item.write_back_scopes : [];
    const continuousSync = item.continuous_sync && typeof item.continuous_sync === 'object' ? item.continuous_sync : {};
    const sourceFamilyRows = sourceFamilies.length
      ? sourceFamilies.map((family) => `
        <div class="utility-rule-album-row">
          <div class="utility-rule-album-main">
            <div class="utility-rule-album-title">${escapeHtml(family.title || 'Source family')}</div>
            <div class="utility-rule-album-meta">${escapeHtml(family.description || '')}</div>
          </div>
        </div>
      `).join('')
      : '<div class="utility-empty-state compact">Source-family contract details will land here later.</div>';
    const writeBackLabels = writeBackScopes.length
      ? writeBackScopes.map((scope) => `<span class="utility-track-problem-chip utility-rule-problem-chip">${escapeHtml(scope)}</span>`).join('')
      : '<span class="utility-rule-album-meta">No write-back scopes configured.</span>';
    const assetRows = referenceAssets.length
      ? referenceAssets.map((asset) => `
        <div class="utility-rule-album-row">
          <div class="utility-rule-album-main">
            <div class="utility-rule-album-title">${escapeHtml(asset.title || asset.filename || 'Reference asset')}</div>
            <div class="utility-rule-album-meta">${escapeHtml(asset.description || '')}</div>
          </div>
          <div class="confirm-modal-actions">
            <a class="button button-secondary" href="${escapeHtml(asset.view_url || '#')}" target="_blank" rel="noreferrer">View</a>
            <a class="button button-secondary" href="${escapeHtml(asset.download_url || '#')}" target="_blank" rel="noreferrer">Download</a>
          </div>
        </div>
      `).join('')
      : '<div class="utility-empty-state compact">No reference assets are available yet.</div>';
    return `
      <div class="utility-rule-detail">
        <h3 class="utility-rule-title">${escapeHtml(item.title || 'Foobar2000')}</h3>
        <p class="utility-rule-description">${escapeHtml(item.description || 'Help-first Foobar setup guidance.')}</p>
        <div class="utility-rule-album-list">
          <div class="utility-rule-album-meta">${escapeHtml(item.status_label || 'How To and reference assets ready')}</div>
          <div class="utility-rule-album-meta">${escapeHtml(continuousSync.label || 'Continuous Foobar sync')}: ${escapeHtml(continuousSync.enabled ? 'Enabled' : (continuousSync.default_state || 'off'))}</div>
          <div class="utility-rule-album-meta">When off: ${escapeHtml(continuousSync.disabled_behavior || 'One-time import only')}</div>
          <div class="utility-rule-album-meta">When enabled later: ${escapeHtml(continuousSync.cadence_when_enabled || 'Once a week')}</div>
          <div class="utility-rule-album-meta">Problems first surface in ${escapeHtml(item.problem_surface || 'Utilities > Problematic Files')}.</div>
          ${item.help_route ? `<div class="utility-rule-album-meta">Foobar help contract: <a href="${escapeHtml(item.help_route)}" target="_blank" rel="noreferrer">${escapeHtml(item.help_route)}</a></div>` : ''}
        </div>
        <div class="utility-divider" aria-hidden="true"></div>
        <div class="utility-rule-album-list">
          <div class="utility-rule-album-meta">SOURCE FAMILIES</div>
          ${sourceFamilyRows}
        </div>
        <div class="utility-divider" aria-hidden="true"></div>
        <div class="utility-rule-album-list">
          <div class="utility-rule-album-meta">V1 WRITE-BACK SCOPE</div>
          <div class="utility-rule-problem-labels">${writeBackLabels}</div>
        </div>
        <div class="utility-divider" aria-hidden="true"></div>
        <div class="utility-rule-album-list">
          <div class="utility-rule-album-meta">REFERENCE ASSETS</div>
          ${assetRows}
        </div>
      </div>
    `;
  }
  if (!item || item.key !== 'lastfm') {
    return '<div class="utility-empty-state">Select an integration.</div>';
  }
  const draft = state.utility.integrationDrafts?.lastfm || { username: '', password: '', timezone: '' };
  const username = draft.username || item.username || '';
  const historyCount = Number(item.listen_history_count || 0);
  const pendingCount = Number(item.pending_scrobble_count || 0);
  const connectedAt = item.connected_at ? (formatLogHistoryTimestamp(item.connected_at) || item.connected_at) : '';
  const selectedTimeZone = String(draft.timezone || item.user_timezone || getDetectedBrowserTimeZone() || 'UTC');
  const headerText = item.connected
    ? `Last.FM · Connected as ${item.username || 'Connected'}${connectedAt ? ` (${connectedAt})` : ''}`
    : 'Last.FM';
  return `
    <div class="utility-rule-detail">
      <h3 class="utility-rule-title lastfm-header-title">${item.connected ? '<span class="lastfm-status-check" aria-hidden="true">&#10003;</span>' : ''}${escapeHtml(headerText)}</h3>
      <p class="utility-rule-description">Connect your LastFM account to scrobble and import your listening history</p>
      <div class="utility-rule-album-list">
        <div class="utility-rule-album-meta">Scrobbled: ${escapeHtml(String(historyCount))}. Queued: ${escapeHtml(String(pendingCount))}</div>
        ${item.api_configured
          ? ''
          : '<div class="utility-rule-album-meta">The server still needs `LASTFM_API_KEY` and `LASTFM_API_SECRET` configured before this integration can connect.</div>'}
      </div>
      <form class="lastfm-integration-form" data-lastfm-integration-form="1">
        <div class="lastfm-credentials-grid">
          <label class="lastfm-inline-field">
            <span>Username</span>
            <input type="text" value="${escapeHtml(username)}" data-lastfm-field="username" autocomplete="username" placeholder="Username or email" ${(item.api_configured && !item.connected) ? '' : 'disabled'}>
          </label>
          <label class="lastfm-inline-field">
            <span>Password</span>
            <input type="password" value="${escapeHtml(draft.password || '')}" data-lastfm-field="password" autocomplete="current-password" placeholder="${item.connected ? 'Disconnect to reconnect' : 'Password'}" ${(item.api_configured && !item.connected) ? '' : 'disabled'}>
          </label>
        </div>
        <div class="confirm-modal-actions">
          <button class="button" type="submit" data-save-lastfm-integration="1" ${(item.api_configured && !item.connected) ? '' : 'disabled'}>Connect Last.FM</button>
          <button class="button button-secondary" type="button" data-disconnect-lastfm-integration="1" ${item.connected ? '' : 'disabled'}>Disconnect</button>
        </div>
      </form>
      <div class="utility-divider" aria-hidden="true"></div>
      <div class="utility-rule-album-list">
        <div class="utility-rule-album-meta">TIMEZONE</div>
      </div>
      <div class="lastfm-credentials-grid">
        <label class="lastfm-inline-field">
          <span>Timezone</span>
          <select data-lastfm-field="timezone">
            ${buildLastfmTimeZoneOptions(selectedTimeZone)}
          </select>
        </label>
      </div>
      <div class="confirm-modal-actions">
        <button class="button button-secondary" type="button" data-save-lastfm-timezone="1" ${selectedTimeZone ? '' : 'disabled'}>Save timezone</button>
      </div>
    </div>
  `;
}

function buildVersionExceptionRuleDetail(rule) {
  const albums = Array.isArray(rule?.albums) ? rule.albums : [];
  const rows = albums.length
    ? albums.map((album) => {
      const title = [album.album_artist, album.name, album.year].filter(Boolean).join(' - ');
      return `
        <div class="utility-rule-album-row">
          <div class="utility-rule-album-main">
            <div class="utility-rule-album-title">${escapeHtml(title || album.key || 'Unknown album')}</div>
            <div class="utility-rule-album-meta">${escapeHtml(album.edition ? `Edition: ${album.edition}` : 'Excluded from album version tabs')}</div>
          </div>
          <button class="button utility-rule-revert" type="button" data-revert-version-exception="${escapeHtml(album.key || '')}">Revert rule</button>
        </div>
      `;
    }).join('')
    : '<div class="utility-empty-state">No albums currently use this rule.</div>';
  return `
    <div class="utility-rule-detail">
      <h3 class="utility-rule-title">${escapeHtml(rule?.title || 'Version exceptions')}</h3>
      <p class="utility-rule-description">${escapeHtml(rule?.description || 'Albums listed here are not counted as versions of another album with the same title.')}</p>
      <div class="utility-rule-album-list">${rows}</div>
    </div>
  `;
}

function buildUtilityCompactTable(config) {
  if (typeof buildCompactDataTable !== 'function') {
    throw new Error('CompactDataTable is not registered.');
  }
  return buildCompactDataTable(config);
}

function buildProblemIgnoresRuleDetail(rule) {
  const albumItems = Array.isArray(rule?.album_items) ? rule.album_items : [];
  const fileItems = Array.isArray(rule?.file_items) ? rule.file_items : [];
  if (albumItems.length || fileItems.length) {
    const columns = 'minmax(220px,.42fr) minmax(180px,.58fr) 88px';
    const columnsConfig = (targetLabel) => [
      { key: 'target', label: targetLabel },
      { key: 'reason', label: 'Reason' },
      { key: 'action', label: 'Actions', header: 'screen-reader', action: true },
    ];
    const table = (items, targetLabel, ariaLabel, id, scope) => buildUtilityCompactTable({
      id,
      ariaLabel,
      columns,
      columnsConfig: columnsConfig(targetLabel),
      headers: 'visible',
      density: 'compact',
      overflow: 'local',
      mobile: 'stack',
      frame: 'outline',
      actionTrackWidth: '88px',
      rows: items.map((item) => {
        const albumDisplay = [item.artist, item.album || item.title, item.year]
          .map((value) => String(value || '').trim())
          .filter(Boolean)
          .join(' - ');
        return {
          key: String(item.row_key || ''),
          ariaBusy: Boolean(item.pending),
          cells: {
            target: `<div class="utility-rule-album-title">${escapeHtml(
              scope === 'album' ? (albumDisplay || 'Unknown album') : (item.filename || 'Unknown file'),
            )}</div>${scope === 'file' && item.album ? `<div class="utility-rule-album-meta">${escapeHtml(item.album)}</div>` : ''}`,
            reason: `<span class="utility-track-problem-chip utility-rule-problem-chip">${escapeHtml(item.problem_reason || item.reason || '')}</span>`,
            action: `<button class="button utility-rule-revert" type="button" data-revert-problem-ignore="${escapeHtml(item.row_key || '')}" ${item.pending ? 'aria-busy="true" disabled' : ''}>Revert rule</button>`,
          },
        };
      }),
    });
    return `
      <div class="utility-rule-detail utility-problem-exclusions-detail">
        <h3 class="utility-rule-title">${escapeHtml(rule?.title || 'Problem exclusions')}</h3>
        <p class="utility-rule-description">${escapeHtml(rule?.description || 'Album or file problems excluded from Problematic Files.')}</p>
        <section class="utility-problem-exclusion-group">
          <h4 class="utility-detail-section-title">ALBUM EXCLUSIONS</h4>
          ${albumItems.length ? table(albumItems, 'Artist / Album', 'Album exclusions', 'problem-exclusions-album', 'album') : '<div class="utility-empty-state compact">No album exclusions.</div>'}
        </section>
        <section class="utility-problem-exclusion-group">
          <h4 class="utility-detail-section-title">FILE EXCLUSIONS</h4>
          ${fileItems.length ? table(fileItems, 'Filename', 'File exclusions', 'problem-exclusions-file', 'file') : '<div class="utility-empty-state compact">No file exclusions.</div>'}
        </section>
      </div>
    `;
  }
  const items = Array.isArray(rule?.items) ? rule.items : [];
  const groups = groupProblemIgnoreItems(items);
  const rows = groups.length
    ? groups.map((group) => {
      const content = `
        <div class="utility-rule-album-list">
          ${group.items.map((item) => {
            const title = item.filename || item.row_key || 'Unknown file';
            const reason = String(item.problem_reason || '').trim();
            return `
              <div class="utility-rule-album-row utility-rule-problem-row">
                <div class="utility-rule-album-main">
                  <div class="utility-rule-album-title">${escapeHtml(title)}</div>
                  ${reason ? `<div class="utility-rule-problem-labels"><span class="utility-track-problem-chip utility-rule-problem-chip">${escapeHtml(reason)}</span></div>` : ''}
                </div>
                <button class="button utility-rule-revert" type="button" data-revert-problem-ignore="${escapeHtml(item.row_key || '')}" ${item.pending ? 'aria-busy="true" disabled' : ''}>Revert rule</button>
              </div>
            `;
          }).join('')}
        </div>
      `;
      return buildUtilityCollapsibleSection(
        `rule-problem-ignore:${group.key}`,
        getProblemIgnoreGroupTitle(group),
        content,
      );
    }).join('')
    : '<div class="utility-empty-state">No album or file problems are currently excluded.</div>';
  return `
    <div class="utility-rule-detail">
      <h3 class="utility-rule-title">${escapeHtml(rule?.title || 'Problem exclusions')}</h3>
      <p class="utility-rule-description">${escapeHtml(rule?.description || 'Album or file problems excluded from Problematic Files.')}</p>
      <div class="utility-rule-album-list">${rows}</div>
    </div>
  `;
}

function buildUtilityRuleDetail(rule) {
  if (!rule) {
    return '<div class="utility-empty-state">Select a rule to inspect where it is applied.</div>';
  }
  if (rule.key === 'version-exceptions') {
    return buildVersionExceptionRuleDetail(rule);
  }
  if (rule.key === 'problem-ignores') {
    return buildProblemIgnoresRuleDetail(rule);
  }
  return '<div class="utility-empty-state">No detail view is available for this rule yet.</div>';
}

function openAlbumOnDiscogs(album) {
  if (!album) {
    showRepairAlert('No album selected for Discogs search.', 'error');
    return;
  }
  window.open(buildDiscogsSearchUrl(album), '_blank', 'noopener,noreferrer');
}

function buildUtilityCollapsibleSection(sectionKey, title, contentHtml) {
  const collapsed = Boolean(state.utility.collapsedSections?.[sectionKey]);
  const cardClass = String(sectionKey || '').startsWith('rule-problem-ignore:') ? ' utility-detail-section-card' : '';
  return `
    <div class="utility-detail-section${cardClass} ${collapsed ? 'is-collapsed' : ''}">
      <button class="utility-section-toggle" type="button" data-utility-section-toggle="${escapeHtml(sectionKey)}" aria-expanded="${collapsed ? 'false' : 'true'}">
        <span class="utility-detail-section-title">${escapeHtml(title)}</span>
        <span class="utility-section-chevron" aria-hidden="true">›</span>
      </button>
      <div class="utility-section-content" ${collapsed ? 'hidden' : ''}>
        ${contentHtml}
      </div>
    </div>
  `;
}

function buildDetectedProblemsHtml(album) {
  const rows = Array.isArray(album?.track_problem_rows) ? album.track_problem_rows : [];
  const albumRows = Array.isArray(album?.album_problem_rows)
    ? album.album_problem_rows
    : (Array.isArray(album?.problem_reasons) ? album.problem_reasons : []).map((reason) => ({
      reason,
      row_key: '',
    }));
  const separateCandidate = album?.separate_release_candidate || null;
  const separateKey = String(separateCandidate?.key || '');
  const separateSelected = Boolean(separateKey && state.utility.separateReleaseSelections[separateKey]);
  const hasExclusionSelection = getIgnoredRepairRowKeys().length > 0;
  const hasProblemRows = albumRows.length || rows.length;
  const actionHtml = (albumRows.length || rows.length || separateKey) ? `
    <div class="utility-detected-actions">
      ${separateKey ? `
        <label class="utility-separate-release-choice ${separateSelected ? 'is-active' : ''}">
          <input type="checkbox" data-separate-release-key="${escapeHtml(separateKey)}" ${separateSelected ? 'checked' : ''}>
          <span>Separate releases</span>
          <small>${escapeHtml((separateCandidate.years || []).join(' / '))}</small>
        </label>
        <button class="button utility-detail-apply" type="button" data-open-separate-release-confirm="1" ${separateSelected ? '' : 'disabled'}>Apply separate releases</button>
      ` : ''}
      ${hasProblemRows ? `<button class="button utility-detail-apply" type="button" data-open-exclusion-confirm="1" ${hasExclusionSelection ? '' : 'disabled'}>Exclude the problem</button>` : ''}
    </div>
  ` : '';
  const albumProblemMarkup = albumRows.map((item) => {
    const rowKey = String(item?.row_key || '');
    const selected = Boolean(rowKey && state.utility.problemExclusionSelections?.[rowKey]);
    return `<button class="utility-track-problem-chip utility-problem-exclusion-pill ${selected ? 'is-active' : ''}" type="button" data-problem-exclusion-scope="album" data-problem-exclusion-row-key="${escapeHtml(rowKey)}" data-problem-exclusion-reason="${escapeHtml(item?.reason || '')}" aria-pressed="${selected ? 'true' : 'false'}" ${rowKey ? '' : 'disabled'}>${escapeHtml(item?.display_reason || item?.reason || '')}</button>`;
  }).join('');
  const trackTable = buildUtilityCompactTable({
    id: 'problematic-track-problems',
    ariaLabel: 'Track-level problems',
    columns: 'minmax(220px,.42fr) minmax(300px,.58fr)',
    columnsConfig: [
      { key: 'filename', label: 'Filename' },
      { key: 'reason', label: 'Reason' },
    ],
    headers: 'visible',
    density: 'compact',
    overflow: 'local',
    mobile: 'preserve',
    frame: 'inset',
    rows: rows.map((row, rowIndex) => ({
      key: String(row.path || ''),
      dataAttributes: { 'problematic-track-path': String(row.path || '') },
      cells: {
        filename: `<span class="utility-track-problem-file" data-problematic-track-path="${escapeHtml(row.path || '')}" title="${escapeHtml(row.path || row.filename || '')}">${escapeHtml(row.filename || getFilenameFromPath(row.path) || 'Unknown file')}</span>`,
        reason: `<span class="utility-track-problem-labels">${(Array.isArray(row.reasons) ? row.reasons : []).map((reason) => {
          const match = (Array.isArray(row.ignorable_reasons) ? row.ignorable_reasons : []).find((item) => item.reason === reason);
          const rowKey = String(match?.row_key || '');
          const selected = Boolean(rowKey && state.utility.problemExclusionSelections?.[rowKey]);
          return `<button class="utility-track-problem-chip utility-problem-exclusion-pill ${selected ? 'is-active' : ''}" type="button" data-problem-exclusion-scope="file" data-problem-exclusion-row-key="${escapeHtml(rowKey)}" data-problem-exclusion-reason="${escapeHtml(reason)}" data-problem-exclusion-row-index="${rowIndex}" aria-pressed="${selected ? 'true' : 'false'}" ${rowKey ? '' : 'disabled'}>${escapeHtml(reason)}</button>`;
        }).join('')}</span>`,
      },
    })),
  });
  const trackProblemMarkup = rows.length ? `
    <div class="utility-track-problem-table">
      <div class="utility-problem-level-heading"><span>TRACK-LEVEL PROBLEMS</span><span class="utility-problem-count">${escapeHtml(rows.length)}</span></div>
      ${trackTable}
    </div>
  ` : '';
  return `
    <div class="sr-only" data-problem-exclusion-status role="status" tabindex="-1">${albumRows.length || rows.length ? '' : 'No problems remain.'}</div>
    <div class="utility-album-problem-list">
      <div class="utility-problem-level-heading"><span>ALBUM-LEVEL PROBLEMS</span></div>
      <div class="utility-album-problem-content">${albumProblemMarkup}</div>
    </div>
    ${trackProblemMarkup}
    ${actionHtml}
  `;
}

function buildProblematicAlbumDetail(album) {
  if (!album) {
    return '<div class="utility-empty-state">Select an album to inspect its problematic tags.</div>';
  }
  const reasons = Array.isArray(album.problem_reasons) ? album.problem_reasons : [];
  const repairRows = Array.isArray(album.repair_preview_rows) ? album.repair_preview_rows : [];
  const showRepairedDisplay = !album.has_encoding_repairs || state.utility.showRepairedDisplay;
  const displayName = getProblematicAlbumDisplayValue(album, 'album', showRepairedDisplay) || 'Unknown Album';
  const displayArtist = getProblematicAlbumDisplayValue(album, 'album_artist', showRepairedDisplay) || 'Unknown Artist';
  const fileTypes = getProblematicAlbumFileTypes(album);
  const fileTypeText = fileTypes.length ? fileTypes.join(', ') : 'Unknown';
  const repairButtonLabel = getSelectedRepairFileCount() > 1
    ? `Repair tags (${getSelectedRepairFileCount()} files)`
    : 'Repair tags';
  const hasCoverProblemReason = reasons.includes('Missing cover art') || reasons.includes('Poor art quality');
  const coverSrc = buildAlbumDisplayCoverUrl(album);
  const moveActions = getAvailableAlbumMoveActions(album);
  const moveActionsHtml = moveActions.length
    ? `
      <div class="utility-rule-album-list">
        ${moveActions.map((actionConfig) => `
          <div class="utility-rule-album-row">
            <div class="utility-rule-album-main">
              <div class="utility-rule-album-title">${escapeHtml(getAlbumMoveActionLabel(actionConfig))}</div>
              <div class="utility-rule-album-meta">${escapeHtml(actionConfig.destinationPath || `Server-planned ${actionConfig.targetLabel} destination`)}</div>
            </div>
            <button
              class="button utility-detail-move"
              type="button"
              data-move-problematic-album="${escapeHtml(actionConfig.action)}"
            >${escapeHtml(getAlbumMoveActionLabel(actionConfig))}</button>
          </div>
        `).join('')}
      </div>
    `
    : '';
  const cover = coverSrc
    ? `<img class="utility-detail-cover-image" src="${coverSrc}" alt="Album cover for ${escapeHtml(displayName)}" data-cover-path="${escapeHtml(String(album?.cover_path || '').trim())}" data-remote-cover-url="${escapeHtml(String(album?.remote_cover_thumbnail_url || album?.remote_cover_url || '').trim())}" onerror="handleAlbumDisplayCoverImageError(this)">`
    : '<div class="utility-detail-cover-placeholder">No cover art</div>';
  return `
    <div class="utility-detail-header">
      <div class="utility-detail-cover">${cover}</div>
      <div class="utility-detail-summary">
        <h3 class="utility-detail-title">${escapeHtml(displayName)}</h3>
        <div class="utility-detail-meta">${escapeHtml(displayArtist)}</div>
        <div class="utility-detail-meta">Year: ${escapeHtml(album.year ?? 'Unknown')}</div>
        <div class="utility-detail-meta">Tracks: ${Array.isArray(album.tracks) ? album.tracks.length : 0}</div>
        ${album.has_encoding_repairs ? `
          <button class="utility-repair-toggle ${showRepairedDisplay ? 'is-active' : ''}" type="button" data-toggle-problematic-display-repair="1" aria-pressed="${showRepairedDisplay ? 'true' : 'false'}">
            ${showRepairedDisplay ? 'Converted tags' : 'Original tags'}
          </button>
        ` : ''}
        <button class="button utility-detail-open" type="button" data-open-problematic-album-folder="1">Open In File Explorer</button>
        ${hasCoverProblemReason ? '<button class="button utility-detail-fetch-cover" type="button" data-fetch-problematic-cover="1">Fetch cover</button>' : ''}
        <button class="button utility-detail-edit-tags" type="button" data-open-tag-editor="1">Edit Tags</button>
        <button class="button utility-detail-discogs" type="button" data-find-on-discogs="1">Find on Discogs</button>
      </div>
    </div>
    ${moveActionsHtml ? buildUtilityCollapsibleSection('moves', 'Move Album', moveActionsHtml) : ''}
    ${buildUtilityCollapsibleSection('detected', 'Detected Problems', buildDetectedProblemsHtml(album))}
    ${repairRows.length ? buildUtilityCollapsibleSection('suggested', 'Suggested Edits', `
        <div class="utility-repair-preview-list">
          ${repairRows.map((row) => {
            const rowKey = String(row.row_key || '');
            const selection = state.utility.repairSelections[rowKey] || 'repair';
            const displayTrackTitle = getProblematicTrackDisplayTitle(album, row, showRepairedDisplay);
            const fileType = getRepairRowFileType(row);
            return `
              <div class="utility-repair-preview-item">
                <div class="utility-repair-preview-main">
                  <span class="utility-repair-preview-track">${escapeHtml(displayTrackTitle)}</span>
                  ${fileType ? `<span class="utility-repair-file-type">${escapeHtml(fileType)}</span>` : ''}
                  <span class="utility-repair-preview-field">${escapeHtml(formatRepairFieldLabel(row.field))}</span>
                  <span class="utility-repair-preview-original">${escapeHtml(row.original || '')}</span>
                  <span class="utility-repair-preview-arrow">></span>
                  <span class="utility-repair-preview-repaired">${escapeHtml(row.repaired || '')}</span>
                </div>
                <div class="utility-repair-choice-group">
                  <button class="utility-repair-choice ${selection === 'ignore' ? 'is-active' : ''}" type="button" data-repair-choice="ignore" data-repair-row-key="${escapeHtml(rowKey)}">Ignore</button>
                  <button class="utility-repair-choice ${selection === 'repair' ? 'is-active' : ''}" type="button" data-repair-choice="repair" data-repair-row-key="${escapeHtml(rowKey)}">Repair</button>
                </div>
              </div>
            `;
          }).join('')}
        </div>
        <button class="button utility-detail-repair" type="button" data-open-repair-confirm="1" data-repair-action="repair">${escapeHtml(repairButtonLabel)}</button>
    `) : ''}
    ${buildUtilityCollapsibleSection('details', 'Album Details', `
      <div class="utility-detail-grid">
        <div><span class="utility-detail-label">Album</span>${escapeHtml(displayName)}</div>
        <div><span class="utility-detail-label">Artist</span>${escapeHtml(displayArtist)}</div>
        <div><span class="utility-detail-label">Year</span>${escapeHtml(album.year ?? 'Unknown')}</div>
        <div><span class="utility-detail-label">Edition</span>${escapeHtml(album.edition || 'N/A')}</div>
        <div><span class="utility-detail-label">File types</span>${escapeHtml(fileTypeText)}</div>
      </div>
    `)}
  `;
}

function getSelectedProblematicAlbum() {
  return (state.utility.problematicFiles || []).find((item) => item.key === state.utility.selectedProblematicKey) || null;
}

function getAlbumTrackPaths(album) {
  const explicitTrackPaths = Array.isArray(album?.track_paths) ? album.track_paths : [];
  if (explicitTrackPaths.length) {
    return new Set(explicitTrackPaths.map((path) => String(path || '')).filter(Boolean));
  }
  return new Set((Array.isArray(album?.tracks) ? album.tracks : [])
    .map((track) => String(track.path || ''))
    .filter(Boolean));
}

function albumsHaveExactTrackMembership(left, right) {
  const leftPaths = getAlbumTrackPaths(left);
  const rightPaths = getAlbumTrackPaths(right);
  return (
    leftPaths.size > 0
    && leftPaths.size === rightPaths.size
    && Array.from(leftPaths).every((path) => rightPaths.has(path))
  );
}

function finalizedAlbumsPreserveOriginalMembership(originalAlbum, finalizedAlbums) {
  if (!originalAlbum || !Array.isArray(finalizedAlbums)) return false;
  return finalizedAlbums.some(
    (album) => albumsHaveExactTrackMembership(originalAlbum, album),
  );
}

function finalizedAlbumsCoverExpectedTrackPaths(originalAlbum, optimisticAlbums, finalizedAlbums) {
  const expectedAlbums = Array.isArray(optimisticAlbums) && optimisticAlbums.length
    ? optimisticAlbums
    : [originalAlbum].filter(Boolean);
  const expectedPaths = new Set();
  expectedAlbums.forEach((album) => {
    getAlbumTrackPaths(album).forEach((path) => expectedPaths.add(path));
  });
  if (!expectedPaths.size || !Array.isArray(finalizedAlbums)) return false;
  const finalizedPaths = new Set();
  finalizedAlbums.forEach((album) => {
    getAlbumTrackPaths(album).forEach((path) => finalizedPaths.add(path));
  });
  return Array.from(expectedPaths).every((path) => finalizedPaths.has(path));
}

function albumsShareTrackPath(left, rightPaths) {
  if (!rightPaths?.size) return false;
  return Array.from(getAlbumTrackPaths(left))
    .some((path) => rightPaths.has(path));
}

function findAlbumByTrackPaths(albums, trackPaths) {
  if (!trackPaths?.size) return null;
  return (albums || []).find((album) => albumsShareTrackPath(album, trackPaths)) || null;
}

function findVisibleAlbumByTrackPaths(trackPaths) {
  if (!trackPaths?.size) return null;
  const matches = flattenVisibleAlbums()
    .filter((album) => albumsShareTrackPath(album, trackPaths));
  const isValidDisplayRating = (value) => {
    const rating = Number(value);
    return Number.isInteger(rating) && rating >= 1 && rating <= 10;
  };
  const preferenceRatingMatch = matches.find((album) => (
    isValidDisplayRating(album?.album_preference?.rating)
  ));
  const legacyRatingMatch = matches.find((album) => (
    isValidDisplayRating(album?.album_rating)
  ));
  const preferenceDataMatch = matches.find((album) => {
    const preference = album?.album_preference;
    return Boolean(
      preference
      && typeof preference === 'object'
      && !Array.isArray(preference)
      && Object.values(preference).some((value) => value != null && value !== ''),
    );
  });
  return preferenceRatingMatch
    || legacyRatingMatch
    || preferenceDataMatch
    || matches[0]
    || null;
}

function findVisibleAlbumByTrackPath(trackPath) {
  const targetPath = String(trackPath || '');
  if (!targetPath) return null;
  return flattenVisibleAlbums().find((album) => (
    Array.isArray(album?.tracks) && album.tracks.some((track) => String(track.path || '') === targetPath)
  )) || null;
}

function resolveActiveQueueAlbumSnapshot(trackPath) {
  const targetPath = String(trackPath || '');
  const queue = state.player?.playbackQueue;
  const albumSnapshot = queue?.albumSnapshot;
  if (!targetPath || !albumSnapshot || typeof albumSnapshot !== 'object') return null;

  const queueAlbumRef = String(queue.albumRef || '').trim();
  const snapshotAlbumRef = typeof getAlbumIdentity === 'function'
    ? String(getAlbumIdentity(albumSnapshot) || '').trim()
    : '';
  if (!queueAlbumRef || snapshotAlbumRef !== queueAlbumRef) return null;

  const queueHasTrack = Array.isArray(queue.tracks)
    && queue.tracks.some((track) => String(track?.path || '') === targetPath);
  if (!queueHasTrack || !getAlbumTrackPaths(albumSnapshot).has(targetPath)) return null;
  return albumSnapshot;
}

function resolveAlbumForPlayerTrack(track) {
  const targetPath = String(track?.path || '');
  const targetAlbum = String(track?.album || '').trim();
  const targetArtist = String(track?.artist || '').trim();
  const targetAlbumArtist = String(track?.albumArtist || track?.artist || '').trim();

  const candidateSources = [
    flattenVisibleAlbums(),
    Array.isArray(state.modalReleases) ? state.modalReleases : [],
    Array.isArray(state.utility.problematicFiles) ? state.utility.problematicFiles : [],
  ];

  for (const source of candidateSources) {
    const exactTrackMatch = (source || []).find((album) => (
      Array.isArray(album?.tracks) && album.tracks.some((item) => String(item.path || '') === targetPath)
    ));
    if (exactTrackMatch) return exactTrackMatch;
  }

  const activeQueueAlbum = resolveActiveQueueAlbumSnapshot(targetPath);
  if (activeQueueAlbum) return activeQueueAlbum;

  const normalizedAlbum = targetAlbum.toLowerCase();
  const normalizedArtists = new Set([targetArtist, targetAlbumArtist].map((value) => value.toLowerCase()).filter(Boolean));
  if (!normalizedAlbum || !normalizedArtists.size) return null;

  for (const source of candidateSources) {
    const albumMatch = (source || []).find((album) => {
      const albumName = String(album?.name || album?.album || '').trim().toLowerCase();
      const albumArtist = String(album?.album_artist || album?.artist || '').trim().toLowerCase();
      return albumName === normalizedAlbum && normalizedArtists.has(albumArtist);
    });
    if (albumMatch) return albumMatch;
  }
  return null;
}

function getUpdatedAlbumForTrackPaths(updatedAlbums, trackPaths) {
  const candidates = Array.isArray(updatedAlbums) ? updatedAlbums : [];
  return findAlbumByTrackPaths(candidates, trackPaths);
}

function getAlbumPathSignature(album) {
  return Array.from(getAlbumTrackPaths(album)).sort().join('|');
}

function collectVisibleAlbumsUnique() {
  const sources = [state.view.primary_artist_groups, state.view.family_artist_groups, state.view.artist_groups];
  const seen = new Set();
  const seenRuntimeAliases = new Set();
  const albums = [];
  sources.forEach((groups) => {
    (groups || []).forEach((group) => {
      (group.albums || []).forEach((album) => {
        const runtimeAliases = getAlbumRuntimeIdentityAliases(album);
        if (Array.from(runtimeAliases).some((alias) => seenRuntimeAliases.has(alias))) return;
        const signature = getAlbumPathSignature(album) || `${album?.key || ''}::${album?.name || ''}::${album?.album_artist || ''}`;
        if (!signature || seen.has(signature)) return;
        seen.add(signature);
        runtimeAliases.forEach((alias) => seenRuntimeAliases.add(alias));
        albums.push(album);
      });
    });
  });
  return albums;
}

function getAlbumRuntimeIdentityAliases(album) {
  return new Set([
    album?.key,
    album?.album_ref,
    album?.request_key,
    album?.identity_key,
    typeof getAlbumRequestKey === 'function' ? getAlbumRequestKey(album) : '',
    typeof getAlbumIdentity === 'function' ? getAlbumIdentity(album) : '',
  ].map((value) => String(value || '').trim()).filter(Boolean));
}

let tagEditViewMutationGeneration = 0;
const tagEditViewMutationResourceClaims = new Map();
const settledTagEditViewMutations = new Set();

function claimTagEditViewMutation(album, editedTrackPaths = [], updates = {}) {
  tagEditViewMutationGeneration += 1;
  const generation = tagEditViewMutationGeneration;
  const resourceKeys = new Set();
  getAlbumRuntimeIdentityAliases(album).forEach((alias) => {
    resourceKeys.add(`album:${alias.toLocaleLowerCase()}`);
  });
  const sourceRelease = {
    albumArtist: String(album?.album_artist || album?.artist || '').trim().toLocaleLowerCase(),
    albumName: String(album?.name || album?.album || '').trim().toLocaleLowerCase(),
    edition: String(album?.edition || '').trim().toLocaleLowerCase(),
    year: String(album?.year ?? '').trim().toLocaleLowerCase(),
  };
  const addReleaseResource = (release) => {
    if (!release.albumArtist || !release.albumName) return;
    resourceKeys.add(
      `release:${release.albumArtist}::${release.albumName}::${release.edition}::${release.year}`,
    );
  };
  addReleaseResource(sourceRelease);
  Object.values(updates || {}).forEach((edits) => {
    if (!edits || typeof edits !== 'object') return;
    addReleaseResource({
      albumArtist: Object.prototype.hasOwnProperty.call(edits, 'album_artist')
        ? String(edits.album_artist || '').trim().toLocaleLowerCase()
        : sourceRelease.albumArtist,
      albumName: Object.prototype.hasOwnProperty.call(edits, 'album')
        ? String(edits.album || '').trim().toLocaleLowerCase()
        : sourceRelease.albumName,
      edition: Object.prototype.hasOwnProperty.call(edits, 'edition')
        ? String(edits.edition || '').trim().toLocaleLowerCase()
        : sourceRelease.edition,
      year: Object.prototype.hasOwnProperty.call(edits, 'year')
        ? String(edits.year ?? '').trim().toLocaleLowerCase()
        : sourceRelease.year,
    });
  });
  [
    ...getAlbumTrackPaths(album),
    ...(Array.isArray(editedTrackPaths) ? editedTrackPaths : []),
  ].forEach((path) => {
    const normalizedPath = String(path || '').trim().toLocaleLowerCase();
    if (normalizedPath) resourceKeys.add(`path:${normalizedPath}`);
  });
  resourceKeys.forEach((resourceKey) => {
    const claims = tagEditViewMutationResourceClaims.get(resourceKey) || [];
    claims.push(generation);
    tagEditViewMutationResourceClaims.set(resourceKey, claims);
  });
  return {
    generation,
    resourceKeys: Array.from(resourceKeys),
  };
}

function tagEditViewMutationStillOwnsResources(claim) {
  const generation = Number(claim?.generation || 0);
  const resourceKeys = Array.isArray(claim?.resourceKeys) ? claim.resourceKeys : [];
  if (!generation || !resourceKeys.length) return true;
  return resourceKeys.every(
    (resourceKey) => {
      const claims = tagEditViewMutationResourceClaims.get(String(resourceKey || '')) || [];
      return claims[claims.length - 1] === generation;
    },
  );
}

function pruneSettledTagEditViewMutationClaims() {
  tagEditViewMutationResourceClaims.forEach((claims, resourceKey) => {
    while (claims.length > 1 && settledTagEditViewMutations.has(claims[0])) {
      claims.shift();
    }
    if (claims.length && claims.every((value) => settledTagEditViewMutations.has(value))) {
      tagEditViewMutationResourceClaims.delete(resourceKey);
    }
  });
  const retainedGenerations = new Set(
    Array.from(tagEditViewMutationResourceClaims.values()).flat(),
  );
  settledTagEditViewMutations.forEach((value) => {
    if (!retainedGenerations.has(value)) settledTagEditViewMutations.delete(value);
  });
}

function settleTagEditViewMutation(claim) {
  const generation = Number(claim?.generation || 0);
  if (!generation) return;
  settledTagEditViewMutations.add(generation);
  pruneSettledTagEditViewMutationClaims();
}

function releaseFailedTagEditViewMutation(claim) {
  const generation = Number(claim?.generation || 0);
  if (!generation) return;
  tagEditViewMutationResourceClaims.forEach((claims, resourceKey) => {
    const remainingClaims = claims.filter((value) => value !== generation);
    if (remainingClaims.length) {
      tagEditViewMutationResourceClaims.set(resourceKey, remainingClaims);
    } else {
      tagEditViewMutationResourceClaims.delete(resourceKey);
    }
  });
  settledTagEditViewMutations.delete(generation);
  pruneSettledTagEditViewMutationClaims();
}

function albumsShareRuntimeIdentityAlias(left, right) {
  const leftAliases = getAlbumRuntimeIdentityAliases(left);
  if (!leftAliases.size) return false;
  return Array.from(getAlbumRuntimeIdentityAliases(right))
    .some((alias) => leftAliases.has(alias));
}

function albumLogicalReleaseBaseMatches(left, right) {
  const normalize = (value) => String(value ?? '').trim().toLocaleLowerCase();
  const leftArtist = normalize(left?.album_artist || left?.artist);
  const rightArtist = normalize(right?.album_artist || right?.artist);
  const leftName = normalize(left?.name || left?.album);
  const rightName = normalize(right?.name || right?.album);
  if (!leftArtist || !rightArtist || !leftName || !rightName) return false;
  return leftArtist === rightArtist
    && leftName === rightName
    && normalize(left?.year) === normalize(right?.year);
}

function albumsHaveCompatibleLogicalEdition(candidate, visibleAlbum) {
  const candidateEdition = String(candidate?.edition || '').trim().toLocaleLowerCase();
  const visibleEdition = String(visibleAlbum?.edition || '').trim().toLocaleLowerCase();
  if (!candidateEdition) return true;
  return Boolean(visibleEdition) && candidateEdition === visibleEdition;
}

function albumsShareLogicalReleaseIdentity(left, right) {
  return albumLogicalReleaseBaseMatches(left, right)
    && albumsHaveCompatibleLogicalEdition(left, right)
    && albumsHaveCompatibleLogicalEdition(right, left);
}

function formatCanonicalAlbumDuration(seconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  const totalMinutes = Math.floor(totalSeconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours) return `${hours}h ${minutes}m`;
  return `${totalMinutes}m ${String(totalSeconds % 60).padStart(2, '0')}s`;
}

function albumIsDemonstrablyFullyHydrated(album) {
  const tracks = Array.isArray(album?.tracks) ? album.tracks : [];
  if (album?.preview_only === true || !tracks.length) return false;
  const declaredTrackCount = Number(album?.track_count_preview);
  if (
    Number.isFinite(declaredTrackCount)
    && declaredTrackCount > 0
    && declaredTrackCount !== tracks.length
  ) return false;
  const declaredMembershipPaths = Array.isArray(album?.track_paths)
    ? new Set(album.track_paths.map((path) => String(path || '')).filter(Boolean))
    : new Set();
  if (!declaredMembershipPaths.size) return true;
  if (declaredMembershipPaths.size !== tracks.length) return false;
  return tracks.every((track) => declaredMembershipPaths.has(String(track?.path || '')));
}

function mergeVisibleAlbumWithOptimisticCandidate(visibleAlbum, candidate, options = {}) {
  const visibleMembershipPaths = getAlbumTrackPaths(visibleAlbum);
  const candidateMembershipPaths = getAlbumTrackPaths(candidate);
  const replaceCompactMembership = (
    options.replaceCompactMembership === true
    && visibleAlbum?.preview_only === true
    && albumIsDemonstrablyFullyHydrated(candidate)
  );
  const tracks = [];
  const trackIndexesByPath = new Map();
  const appendTrack = (track, incoming = false) => {
    const path = String(track?.path || '');
    if (path && trackIndexesByPath.has(path)) {
      if (incoming) tracks[trackIndexesByPath.get(path)] = track;
      return;
    }
    if (path) trackIndexesByPath.set(path, tracks.length);
    tracks.push(track);
  };
  if (!replaceCompactMembership) {
    (Array.isArray(visibleAlbum?.tracks) ? visibleAlbum.tracks : [])
      .forEach((track) => appendTrack(track));
  }
  (Array.isArray(candidate?.tracks) ? candidate.tracks : [])
    .forEach((track) => appendTrack(track, true));

  const mergedAlbum = {
    ...candidate,
    ...visibleAlbum,
    tracks,
  };
  if (replaceCompactMembership) {
    mergedAlbum.preview_only = false;
    mergedAlbum.track_paths = Array.from(candidateMembershipPaths);
    mergedAlbum.track_count_preview = tracks.length;
  } else if (visibleAlbum?.preview_only === true) {
    const mergedMembershipPaths = new Set([
      ...visibleMembershipPaths,
      ...candidateMembershipPaths,
    ]);
    const visibleDeclaredTrackCount = Number(visibleAlbum?.track_count_preview);
    const candidateAddsDistinctMembership = Array.from(candidateMembershipPaths)
      .filter((path) => !visibleMembershipPaths.has(path)).length;
    mergedAlbum.preview_only = true;
    if (mergedMembershipPaths.size) {
      mergedAlbum.track_paths = Array.from(mergedMembershipPaths);
      mergedAlbum.track_count_preview = Math.max(
        mergedMembershipPaths.size,
        Number.isFinite(visibleDeclaredTrackCount)
          ? visibleDeclaredTrackCount + candidateAddsDistinctMembership
          : 0,
      );
    }
  }
  const shouldRecomputeDuration = tracks.some((track) => Number(track?.duration_seconds || 0) > 0)
    || Object.prototype.hasOwnProperty.call(visibleAlbum || {}, 'total_duration_seconds')
    || Object.prototype.hasOwnProperty.call(candidate || {}, 'total_duration_seconds');
  if (shouldRecomputeDuration) {
    const totalDurationSeconds = tracks.reduce(
      (sum, track) => {
        const duration = Number(track?.duration_seconds || 0);
        return sum + (Number.isFinite(duration) ? Math.max(0, duration) : 0);
      },
      0,
    );
    mergedAlbum.total_duration_seconds = totalDurationSeconds;
    mergedAlbum.total_duration_display = formatCanonicalAlbumDuration(totalDurationSeconds);
  }
  if (visibleAlbum?.preview_only !== true
      && tracks.length
      && (Object.prototype.hasOwnProperty.call(visibleAlbum || {}, 'track_count_preview')
        || Object.prototype.hasOwnProperty.call(candidate || {}, 'track_count_preview'))) {
    mergedAlbum.track_count_preview = tracks.length;
  }
  return mergedAlbum;
}

function preserveVisibleAlbumRuntimeIdentity(visibleAlbum, candidate) {
  const reconciledAlbum = {
    ...visibleAlbum,
    ...candidate,
  };
  ['key', 'album_ref', 'request_key', 'identity_key'].forEach((field) => {
    const stableValue = String(visibleAlbum?.[field] || '').trim();
    if (stableValue) reconciledAlbum[field] = visibleAlbum[field];
  });
  return reconciledAlbum;
}

function coalesceUniqueVisibleLogicalAlbumCandidates(
  candidates,
  visibleAlbums,
  originalAlbum = null,
) {
  return (candidates || []).map((candidate) => {
    const logicalMatches = (visibleAlbums || []).filter((visibleAlbum) => (
      albumLogicalReleaseBaseMatches(candidate, visibleAlbum)
      && albumsHaveCompatibleLogicalEdition(candidate, visibleAlbum)
    ));
    const runtimeMatches = logicalMatches.filter((logicalMatch) => (
      albumsShareRuntimeIdentityAlias(logicalMatch, candidate)
    ));
    const effectiveMatches = runtimeMatches.length ? runtimeMatches : logicalMatches;
    if (effectiveMatches.length !== 1) return candidate;
    const logicalMatch = effectiveMatches[0];
    if (
      originalAlbum
      && logicalMatch?.preview_only === true
      && albumIsDemonstrablyFullyHydrated(candidate)
      && albumsShareLogicalReleaseIdentity(candidate, originalAlbum)
    ) {
      return preserveVisibleAlbumRuntimeIdentity(logicalMatch, candidate);
    }
    if (albumsShareTrackPath(logicalMatch, getAlbumTrackPaths(candidate))) {
      return preserveVisibleAlbumRuntimeIdentity(logicalMatch, candidate);
    }
    if (albumsShareRuntimeIdentityAlias(logicalMatch, candidate)) {
      const visibleTrackPaths = getAlbumTrackPaths(logicalMatch);
      const candidateTrackPaths = getAlbumTrackPaths(candidate);
      const visibleDeclaredTrackCount = Number(logicalMatch?.track_count_preview);
      const previewHasNoDeclaredMembership = (
        logicalMatch?.preview_only === true
        && !visibleTrackPaths.size
        && !(
          Number.isFinite(visibleDeclaredTrackCount)
          && visibleDeclaredTrackCount > 0
        )
      );
      if (
        (!visibleTrackPaths.size || !candidateTrackPaths.size)
        && (
          logicalMatch?.preview_only !== true
          || previewHasNoDeclaredMembership
        )
      ) return candidate;
    }
    return mergeVisibleAlbumWithOptimisticCandidate(logicalMatch, candidate);
  });
}

function enrichChangedLogicalReleaseFromHydratedAlbumIndex(candidate, originalAlbum) {
  if (
    !candidate
    || !originalAlbum
    || albumsShareLogicalReleaseIdentity(candidate, originalAlbum)
  ) {
    return candidate;
  }
  const hydratedMatches = new Set();
  const collectHydratedMatch = (album) => {
    if (
      album
      && album !== candidate
      && album?.preview_only !== true
      && getAlbumTrackPaths(album).size
      && albumsShareLogicalReleaseIdentity(candidate, album)
    ) {
      hydratedMatches.add(album);
    }
  };
  getAlbumRuntimeIdentityAliases(candidate).forEach((alias) => {
    if (typeof getCachedHydratedTrackModalAlbum === 'function') {
      collectHydratedMatch(getCachedHydratedTrackModalAlbum(alias));
    }
    if (typeof state.gallery?.albumIndex?.get === 'function') {
      collectHydratedMatch(state.gallery.albumIndex.get(alias));
    }
  });
  if (hydratedMatches.size !== 1) return candidate;
  const enrichedAlbum = mergeVisibleAlbumWithOptimisticCandidate(
    Array.from(hydratedMatches)[0],
    candidate,
  );
  enrichedAlbum.tracks = orderAlbumTracks(enrichedAlbum.tracks);
  if (Object.prototype.hasOwnProperty.call(enrichedAlbum, 'track_count_preview')) {
    enrichedAlbum.track_count_preview = enrichedAlbum.tracks.length;
  }
  return enrichedAlbum;
}

function enrichFinalizedAlbumsWithCanonicalVisibleProjections(
  finalizedAlbums,
  visibleAlbums,
  options = {},
) {
  const coalescedAlbums = coalesceUniqueVisibleLogicalAlbumCandidates(
    finalizedAlbums,
    visibleAlbums,
  );
  return coalescedAlbums.map((coalescedAlbum, index) => {
    const finalizedAlbum = finalizedAlbums[index];
    const canonicalMatches = (visibleAlbums || []).filter((visibleAlbum) => (
      albumLogicalReleaseBaseMatches(finalizedAlbum, visibleAlbum)
      && albumsHaveCompatibleLogicalEdition(finalizedAlbum, visibleAlbum)
      && (
        albumsShareTrackPath(visibleAlbum, getAlbumTrackPaths(finalizedAlbum))
        || albumsShareRuntimeIdentityAlias(finalizedAlbum, visibleAlbum)
      )
    ));
    if (canonicalMatches.length !== 1) return coalescedAlbum;
    const canonicalCompactAlbum = canonicalMatches[0];
    const finalizedAlbumCanReplaceCompactMembership = (
      canonicalCompactAlbum?.preview_only === true
      && albumIsDemonstrablyFullyHydrated(finalizedAlbum)
    );
    const callerAllowsCompactMembershipReplacement = (
      typeof options.replaceCompactMembership === 'function'
        ? options.replaceCompactMembership(finalizedAlbum, canonicalCompactAlbum) === true
        : !Object.prototype.hasOwnProperty.call(options, 'replaceCompactMembership')
          || options.replaceCompactMembership === true
    );
    const enrichedAlbum = mergeVisibleAlbumWithOptimisticCandidate(
      canonicalCompactAlbum,
      finalizedAlbum,
      {
        replaceCompactMembership: (
          finalizedAlbumCanReplaceCompactMembership
          && callerAllowsCompactMembershipReplacement
        ),
      },
    );
    if (Array.isArray(finalizedAlbum?.tracks) && finalizedAlbum.tracks.length) {
      enrichedAlbum.preview_only = false;
    }
    return enrichedAlbum;
  });
}

function enrichFinalizedAlbumsWithOptimisticModalTracks(finalizedAlbums, optimisticAlbums) {
  return (finalizedAlbums || []).map((finalizedAlbum) => {
    if (Array.isArray(finalizedAlbum?.tracks) && finalizedAlbum.tracks.length) {
      return finalizedAlbum;
    }
    const matchingOptimisticAlbums = (optimisticAlbums || []).filter((optimisticAlbum) => (
      albumsShareLogicalReleaseIdentity(finalizedAlbum, optimisticAlbum)
      && Array.isArray(optimisticAlbum?.tracks)
      && optimisticAlbum.tracks.length
    ));
    if (matchingOptimisticAlbums.length !== 1) return finalizedAlbum;
    const finalizedPaths = getAlbumTrackPaths(finalizedAlbum);
    const optimisticAlbum = matchingOptimisticAlbums[0];
    const optimisticTracks = Array.isArray(optimisticAlbum?.tracks)
      ? optimisticAlbum.tracks
      : [];
    const declaredTrackCount = Number(optimisticAlbum?.track_count_preview);
    const declaredMembershipSize = getAlbumTrackPaths(optimisticAlbum).size;
    const optimisticAlbumIsFullyHydrated = (
      optimisticAlbum?.preview_only !== true
      && (!Number.isFinite(declaredTrackCount) || declaredTrackCount <= optimisticTracks.length)
      && (!declaredMembershipSize || declaredMembershipSize <= optimisticTracks.length)
    );
    if (!optimisticAlbumIsFullyHydrated) return finalizedAlbum;
    const hydratedTracks = optimisticAlbum.tracks.filter((track) => (
      !finalizedPaths.size || finalizedPaths.has(String(track?.path || ''))
    ));
    if (!hydratedTracks.length) return finalizedAlbum;
    return {
      ...mergeVisibleAlbumWithOptimisticCandidate(
        finalizedAlbum,
        { ...optimisticAlbum, tracks: hydratedTracks },
      ),
      preview_only: false,
    };
  });
}

function compareAlbumsWithinGalleryGroup(left, right) {
  const yearCompare = Number(left?.year ?? 9999) - Number(right?.year ?? 9999);
  if (yearCompare) return yearCompare;
  const nameCompare = String(left?.name || '').localeCompare(String(right?.name || ''), undefined, { sensitivity: 'base' });
  if (nameCompare) return nameCompare;
  return String(left?.edition || '').localeCompare(String(right?.edition || ''), undefined, { sensitivity: 'base' });
}

function groupAlbumsForCurrentView(albums) {
  const buckets = new Map();
  (albums || []).forEach((album) => {
    const artist = String(album?.album_artist || '').trim() || 'Unknown Artist';
    if (!buckets.has(artist)) {
      buckets.set(artist, {
        artist,
        artist_display: artist,
        albums: [],
      });
    }
    buckets.get(artist).albums.push(album);
  });
  return Array.from(buckets.values())
    .map((group) => ({
      ...group,
      albums: (group.albums || []).slice().sort(compareAlbumsWithinGalleryGroup),
    }))
    .sort((left, right) => String(left.artist || '').localeCompare(String(right.artist || ''), undefined, { sensitivity: 'base' }));
}

function resolveSelectedArtistFamilyDisplayModeForRuntimeView(view = state.view || {}) {
  return String(
    view?.selected_artist_family_display_mode
      ?? view?.artist_page?.family_display_mode
      ?? 'grouped',
  ).trim().toLowerCase() === 'chronological' ? 'chronological' : 'grouped';
}

function buildSelectedArtistChronologicalGroupsForRuntime(primaryGroups, familyGroups) {
  const seenAlbumKeys = new Set();
  const sortAlbums = (left, right) => {
    const normalizeReleaseDate = (album) => {
      const releaseDate = String(album?.release_date || '').trim();
      if (!releaseDate) return '';
      const parts = releaseDate.split('-');
      if (!parts.length || parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) {
        return '';
      }
      const year = parts[0].padStart(4, '0');
      const month = (parts[1] || '99').padStart(2, '0');
      const day = (parts[2] || '99').padStart(2, '0');
      return `${year}-${month}-${day}`;
    };
    const normalizeYear = (album) => {
      if (album?.year === null || album?.year === undefined || album?.year === '') return 9999;
      const year = Number(album.year);
      return Number.isInteger(year) ? year : 9999;
    };
    const leftYear = normalizeYear(left);
    const rightYear = normalizeYear(right);
    const leftReleaseKey = normalizeReleaseDate(left) || `${String(leftYear).padStart(4, '0')}-99-99`;
    const rightReleaseKey = normalizeReleaseDate(right) || `${String(rightYear).padStart(4, '0')}-99-99`;
    if (leftReleaseKey !== rightReleaseKey) return leftReleaseKey.localeCompare(rightReleaseKey);
    if (leftYear !== rightYear) return leftYear - rightYear;
    const nameCompare = String(left?.name || '').localeCompare(String(right?.name || ''), undefined, { sensitivity: 'base' });
    if (nameCompare) return nameCompare;
    return String(left?.key || '').localeCompare(String(right?.key || ''), undefined, { sensitivity: 'base' });
  };
  const albums = [...(Array.isArray(primaryGroups) ? primaryGroups : []), ...(Array.isArray(familyGroups) ? familyGroups : [])]
    .flatMap((group) => (Array.isArray(group?.albums) ? group.albums : []))
    .filter((album) => {
      const albumKey = String(album?.key || '').trim();
      if (!albumKey) return true;
      if (seenAlbumKeys.has(albumKey)) return false;
      seenAlbumKeys.add(albumKey);
      return true;
    })
    .sort(sortAlbums);
  if (!albums.length) return [];
  return [{
    artist: 'Chronological',
    artist_display: 'Chronological',
    albums,
  }];
}

function replaceAlbumsInGroupsByTrackPath(groups, updatedAlbums) {
  if (!Array.isArray(groups) || !Array.isArray(updatedAlbums) || !updatedAlbums.length) return groups;
  return groups.map((group) => ({
    ...group,
    albums: (group.albums || []).map((album) => {
      const updatedAlbum = getUpdatedAlbumForTrackPaths(updatedAlbums, getAlbumTrackPaths(album));
      return updatedAlbum || album;
    }),
  }));
}

function patchVisibleAlbumsByTrackPath(updatedAlbums) {
  const candidates = Array.isArray(updatedAlbums) ? updatedAlbums.filter(Boolean) : [];
  if (!candidates.length) return;
  mergeViewPayload({
    artist_groups: replaceAlbumsInGroupsByTrackPath(state.view.artist_groups, candidates),
    primary_artist_groups: replaceAlbumsInGroupsByTrackPath(state.view.primary_artist_groups, candidates),
    family_artist_groups: replaceAlbumsInGroupsByTrackPath(state.view.family_artist_groups, candidates),
  }, { trackSidebarReveal: false });
}

function preserveDocumentScrollPosition(callback) {
  if (typeof callback !== 'function') return;
  const scrollEl = document.scrollingElement || document.documentElement || document.body;
  const galleryScrollEl = document.getElementById('albums-scroll');
  const viewportScroll = getViewportScrollPosition();
  const left = Number(scrollEl?.scrollLeft || viewportScroll.x || 0);
  const top = Number(scrollEl?.scrollTop || viewportScroll.y || 0);
  const galleryLeft = Number(galleryScrollEl?.scrollLeft || 0);
  const galleryTop = Number(galleryScrollEl?.scrollTop || 0);
  const restore = () => {
    if (scrollEl) {
      scrollEl.scrollLeft = left;
      scrollEl.scrollTop = top;
    }
    if (galleryScrollEl) {
      galleryScrollEl.scrollLeft = galleryLeft;
      galleryScrollEl.scrollTop = galleryTop;
    }
    window.scrollTo(left, top);
  };
  callback();
  restore();
  scheduleBrowserAnimationFrame(restore);
}

function albumMatchesRuntimeReplacementIdentity(album, replacementIdentityAliases) {
  if (!replacementIdentityAliases?.size) return false;
  return [
    album?.key,
    album?.album_ref,
    typeof getAlbumRequestKey === 'function' ? getAlbumRequestKey(album) : '',
    typeof getAlbumIdentity === 'function' ? getAlbumIdentity(album) : '',
  ].some((value) => replacementIdentityAliases.has(String(value || '').trim()));
}

function patchAlbumGroupsPreservingMembership(
  groups,
  candidates,
  originalAlbum,
  removalPaths,
  replacementIdentityAliases,
  allowUnmatchedFallback = false,
  allowArbitraryGroupFallback = allowUnmatchedFallback,
) {
  if (!Array.isArray(groups)) return [];
  const originalPaths = getAlbumTrackPaths(originalAlbum);
  const placementsByGroup = new Map();
  const placeCandidate = (candidate) => {
    let placement = null;
    const findPlacement = (predicate) => {
      for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
        const albums = Array.isArray(groups[groupIndex]?.albums)
          ? groups[groupIndex].albums
          : [];
        const albumIndex = albums.findIndex(predicate);
        if (albumIndex >= 0) return { groupIndex, albumIndex };
      }
      return null;
    };
    placement = findPlacement((album) => (
      albumsShareRuntimeIdentityAlias(album, candidate)
      || albumsShareLogicalReleaseIdentity(album, candidate)
    ));
    if (!placement) {
      const logicalPlacements = [];
      groups.forEach((group, groupIndex) => {
        const albums = Array.isArray(group?.albums) ? group.albums : [];
        albums.forEach((album, albumIndex) => {
          if (
            albumLogicalReleaseBaseMatches(candidate, album)
            && albumsHaveCompatibleLogicalEdition(candidate, album)
          ) {
            logicalPlacements.push({ groupIndex, albumIndex });
          }
        });
      });
      if (logicalPlacements.length === 1) [placement] = logicalPlacements;
    }
    if (!placement) {
      const candidatePaths = getAlbumTrackPaths(candidate);
      placement = findPlacement((album) => albumsShareTrackPath(album, candidatePaths));
    }
    if (!placement && originalAlbum) {
      placement = findPlacement((album) => (
        albumsShareRuntimeIdentityAlias(album, originalAlbum)
        || albumsShareLogicalReleaseIdentity(album, originalAlbum)
        || albumsShareTrackPath(album, originalPaths)
      ));
    }
    if (!placement && allowUnmatchedFallback) {
      const candidateArtist = String(candidate?.album_artist || '').trim();
      const groupIndex = groups.findIndex(
        (group) => String(group?.artist || '').trim() === candidateArtist,
      );
      if (groupIndex >= 0) {
        placement = {
          groupIndex,
          albumIndex: (groups[groupIndex]?.albums || []).length,
        };
      }
    }
    if (!placement && allowArbitraryGroupFallback && groups.length) {
      placement = {
        groupIndex: 0,
        albumIndex: (groups[0]?.albums || []).length,
      };
    }
    if (!placement) return;
    const groupPlacements = placementsByGroup.get(placement.groupIndex) || new Map();
    const slot = groupPlacements.get(placement.albumIndex) || [];
    slot.push(candidate);
    groupPlacements.set(placement.albumIndex, slot);
    placementsByGroup.set(placement.groupIndex, groupPlacements);
  };
  (candidates || []).forEach(placeCandidate);
  return groups.map((group, groupIndex) => {
    const albums = Array.isArray(group?.albums) ? group.albums : [];
    const candidatesByIndex = placementsByGroup.get(groupIndex) || new Map();
    const nextAlbums = [];
    albums.forEach((album, index) => {
      const replacements = candidatesByIndex.get(index);
      if (replacements?.length) {
        nextAlbums.push(...replacements.slice().sort(compareAlbumsWithinGalleryGroup));
      }
      const removeAlbum = Boolean(replacements?.length)
        || albumsShareTrackPath(album, removalPaths)
        || albumMatchesRuntimeReplacementIdentity(album, replacementIdentityAliases);
      if (!removeAlbum) nextAlbums.push(album);
    });
    const trailingReplacements = candidatesByIndex.get(albums.length);
    if (trailingReplacements?.length) {
      nextAlbums.push(...trailingReplacements.slice().sort(compareAlbumsWithinGalleryGroup));
    }
    nextAlbums.sort(compareAlbumsWithinGalleryGroup);
    return {
      ...group,
      artist_display: String(group?.artist_display || group?.artist || ''),
      albums: nextAlbums,
    };
  }).filter((group) => group.albums.length);
}

function getExplicitAlbumArtistEditByPath(tagEdits) {
  const editsByPath = new Map();
  if (!tagEdits || typeof tagEdits !== 'object' || Array.isArray(tagEdits)) {
    return editsByPath;
  }
  Object.entries(tagEdits).forEach(([path, edits]) => {
    if (
      !edits
      || typeof edits !== 'object'
      || !Object.prototype.hasOwnProperty.call(edits, 'album_artist')
    ) {
      return;
    }
    editsByPath.set(
      String(path || ''),
      String(edits.album_artist || '').trim() || 'Unknown Artist',
    );
  });
  return editsByPath;
}

function getCandidateExplicitAlbumArtist(candidate, explicitAlbumArtistByPath) {
  const candidatePaths = getAlbumTrackPaths(candidate);
  for (const [path, albumArtist] of explicitAlbumArtistByPath.entries()) {
    if (candidatePaths.has(path)) return albumArtist;
  }
  return null;
}

function appendMigratedAlbumsToSemanticGroups(groups, migrations, allowArtist) {
  const nextGroups = (Array.isArray(groups) ? groups : []).map((group) => ({
    ...group,
    albums: Array.isArray(group?.albums) ? group.albums.slice() : [],
  }));
  migrations.forEach(({ album, artist }) => {
    if (typeof allowArtist === 'function' && !allowArtist(artist)) return;
    let group = nextGroups.find(
      (candidate) => String(candidate?.artist || '').trim() === artist,
    );
    if (!group) {
      group = {
        artist,
        artist_display: artist,
        albums: [],
      };
      nextGroups.push(group);
    }
    group.albums.push(album);
    group.albums.sort(compareAlbumsWithinGalleryGroup);
  });
  return nextGroups.filter((group) => group.albums.length);
}

function patchAlbumGroupsWithExplicitArtistMigrations(
  groups,
  candidates,
  originalAlbum,
  removalPaths,
  replacementIdentityAliases,
  explicitAlbumArtistByPath,
  allowUnmatchedFallback,
  allowMigrationArtist,
  allowArbitraryGroupFallback = allowUnmatchedFallback,
) {
  const migrations = [];
  const membershipCandidates = [];
  candidates.forEach((candidate) => {
    const artist = getCandidateExplicitAlbumArtist(
      candidate,
      explicitAlbumArtistByPath,
    );
    if (artist === null) {
      membershipCandidates.push(candidate);
      return;
    }
    migrations.push({ album: candidate, artist });
  });
  const patchedGroups = patchAlbumGroupsPreservingMembership(
    groups,
    membershipCandidates,
    originalAlbum,
    removalPaths,
    replacementIdentityAliases,
    allowUnmatchedFallback,
    allowArbitraryGroupFallback,
  );
  return appendMigratedAlbumsToSemanticGroups(
    patchedGroups,
    migrations,
    allowMigrationArtist,
  );
}

function albumIsMountedInGroups(groups, album) {
  if (!album || !Array.isArray(groups)) return false;
  const albumPaths = getAlbumTrackPaths(album);
  return groups.some((group) => (
    (Array.isArray(group?.albums) ? group.albums : []).some((candidate) => (
      albumsShareRuntimeIdentityAlias(candidate, album)
      || albumsShareLogicalReleaseIdentity(candidate, album)
      || albumsShareTrackPath(candidate, albumPaths)
    ))
  ));
}

function synchronizeCurrentViewAlbumIndex() {
  const roleGroups = [
    ...(Array.isArray(state.view.primary_artist_groups)
      ? state.view.primary_artist_groups
      : []),
    ...(Array.isArray(state.view.family_artist_groups)
      ? state.view.family_artist_groups
      : []),
  ];
  const groups = roleGroups.length
    ? roleGroups
    : (Array.isArray(state.view.artist_groups) ? state.view.artist_groups : []);
  if (typeof rebuildAlbumIndex === 'function') {
    rebuildAlbumIndex(groups);
  }
  if (!(state.gallery?.albumIndex instanceof Map)) return;
  groups.forEach((group) => {
    (Array.isArray(group?.albums) ? group.albums : []).forEach((album) => {
      getAlbumRuntimeIdentityAliases(album).forEach((alias) => {
        state.gallery.albumIndex.set(alias, album);
      });
    });
  });
}

function applyUpdatedAlbumsToCurrentView(updatedAlbums, options = {}) {
  const incomingCandidates = Array.isArray(updatedAlbums) ? updatedAlbums.filter(Boolean) : [];
  const originalAlbum = options.originalAlbum || null;
  if (!incomingCandidates.length && !originalAlbum) return [];
  if (options.preserveGrouping) {
    patchVisibleAlbumsByTrackPath(incomingCandidates);
    if (!options.skipRender) {
      if (options.preserveScroll) preserveDocumentScrollPosition(() => renderView({ preserveScroll: true }));
      else renderView();
    }
    return incomingCandidates;
  }
  const visibleAlbums = collectVisibleAlbumsUnique();
  const candidates = coalesceUniqueVisibleLogicalAlbumCandidates(
    incomingCandidates,
    visibleAlbums,
    originalAlbum,
  ).map((candidate) => (
    enrichChangedLogicalReleaseFromHydratedAlbumIndex(candidate, originalAlbum)
  ));
  const removalPaths = new Set();
  candidates.forEach((album) => {
    getAlbumTrackPaths(album).forEach((path) => removalPaths.add(path));
  });
  if (originalAlbum) {
    getAlbumTrackPaths(originalAlbum).forEach((path) => removalPaths.add(path));
  }

  const replacementIdentityAliases = new Set();
  [...candidates, originalAlbum].filter(Boolean).forEach((album) => {
    [
      album.key,
      album.album_ref,
      typeof getAlbumRequestKey === 'function' ? getAlbumRequestKey(album) : '',
      typeof getAlbumIdentity === 'function' ? getAlbumIdentity(album) : '',
    ].forEach((value) => {
      const alias = String(value || '').trim();
      if (alias) replacementIdentityAliases.add(alias);
    });
  });

  const explicitAlbumArtistByPath = getExplicitAlbumArtistEditByPath(options.tagEdits);
  let grouped = state.view.artist_groups?.length
    ? patchAlbumGroupsWithExplicitArtistMigrations(
      state.view.artist_groups,
      candidates,
      originalAlbum,
      removalPaths,
      replacementIdentityAliases,
      explicitAlbumArtistByPath,
      true,
    )
    : groupAlbumsForCurrentView(candidates);
  if (!grouped.length && candidates.length) {
    grouped = groupAlbumsForCurrentView(candidates);
  }

  if (state.view.selected_artist) {
    const selectedArtist = String(state.view.selected_artist || '');
    const selectedArtistFamilyDisplayMode = resolveSelectedArtistFamilyDisplayModeForRuntimeView(state.view);
    const activeRelatedSet = new Set(Array.isArray(state.view.related_filter_artists) ? state.view.related_filter_artists : []);
    const hasMountedRoleGroups = Boolean(
      state.view.primary_artist_groups?.length
      || state.view.family_artist_groups?.length
    );
    const originalAlbumMountedInPrimaryGroups = albumIsMountedInGroups(
      state.view.primary_artist_groups,
      originalAlbum,
    );
    const originalAlbumMountedInFamilyGroups = albumIsMountedInGroups(
      state.view.family_artist_groups,
      originalAlbum,
    );
    const primaryGroups = !hasMountedRoleGroups
      ? grouped.filter((group) => String(group.artist || '') === selectedArtist)
      : patchAlbumGroupsWithExplicitArtistMigrations(
        state.view.primary_artist_groups,
        candidates,
        originalAlbum,
        removalPaths,
        replacementIdentityAliases,
        explicitAlbumArtistByPath,
        !originalAlbumMountedInFamilyGroups,
        (artist) => artist === selectedArtist,
        false,
      );
    const allFamilyGroups = !hasMountedRoleGroups
      ? grouped.filter((group) => String(group.artist || '') !== selectedArtist)
      : patchAlbumGroupsWithExplicitArtistMigrations(
        state.view.family_artist_groups,
        candidates,
        originalAlbum,
        removalPaths,
        replacementIdentityAliases,
        explicitAlbumArtistByPath,
        !originalAlbumMountedInPrimaryGroups,
        (artist) => artist !== selectedArtist,
        false,
      );
    const allFamilyArtists = Array.from(new Set([
      ...(Array.isArray(state.view.related_artists) ? state.view.related_artists : []),
      ...allFamilyGroups
        .map((group) => String(group.artist || '').trim())
        .filter((artist) => artist && artist !== selectedArtist),
    ])).sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }));
    const visibleFamilyGroups = activeRelatedSet.size
      ? allFamilyGroups.filter((group) => groupMatchesRelatedArtists(group, activeRelatedSet))
      : (state.view.primary_filter_active ? [] : allFamilyGroups);
    const nextPrimaryGroups = (state.view.primary_filter_active || !activeRelatedSet.size) ? primaryGroups : [];
    const nextArtistGroups = selectedArtistFamilyDisplayMode === 'chronological'
      ? buildSelectedArtistChronologicalGroupsForRuntime(nextPrimaryGroups, visibleFamilyGroups)
      : [...nextPrimaryGroups, ...visibleFamilyGroups];
    mergeViewPayload({
      related_artists: allFamilyArtists,
      primary_artist_groups: nextPrimaryGroups,
      family_artist_groups: visibleFamilyGroups,
      artist_groups: nextArtistGroups,
      album_count: (nextPrimaryGroups.reduce((sum, group) => sum + (group.albums || []).length, 0)
        + visibleFamilyGroups.reduce((sum, group) => sum + (group.albums || []).length, 0)),
      artist_count: (nextPrimaryGroups.length + visibleFamilyGroups.length),
    }, { trackSidebarReveal: false });
  } else {
    mergeViewPayload({
      artist_groups: grouped,
      album_count: grouped.reduce((sum, group) => sum + (group.albums || []).length, 0),
      artist_count: grouped.length,
    }, { trackSidebarReveal: false });
  }
  if (options.skipRender) synchronizeCurrentViewAlbumIndex();
  if (!options.skipRender) {
    if (options.preserveScroll) {
      preserveDocumentScrollPosition(() => renderView({ preserveScroll: true }));
    } else {
      renderView();
    }
  }
  return candidates;
}

async function prependUtilityLogHistoryEntry(entry) {
  if (!entry || typeof entry !== 'object') return;
  let persistedResult = null;
  try {
    persistedResult = await persistBrowserLogHistoryEntries([entry]);
  } catch (error) {
    console.warn('[AlbumHaven][History] Could not persist an immediate history entry.', error);
  }
  const existing = Array.isArray(state.utility.logHistory) ? state.utility.logHistory : [];
  const persistedItems = Array.isArray(persistedResult?.items) ? persistedResult.items : [];
  const fallbackEntry = persistedItems.length
    ? null
    : (typeof normalizeBrowserLogHistoryEntry === 'function'
      ? normalizeBrowserLogHistoryEntry(entry)
      : entry);
  state.utility.logHistory = persistedItems.length
    ? persistedItems
    : [
      fallbackEntry,
      ...existing.filter((item) => String(item?.id || '') !== String(fallbackEntry.id || '')),
    ].slice(0, 250);
  if (persistedResult?.status) {
    state.utility.logHistoryStorageStatus = persistedResult.status;
  }
  state.utility.logHistoryLoaded = true;
  if (!state.utility.selectedLogHistoryId) {
    const persistedEntry = persistedItems.find(
      (item) => String(item?.id || '') === String(entry.id || ''),
    ) || persistedItems[0];
    state.utility.selectedLogHistoryId = String(persistedEntry?.id || fallbackEntry?.id || '');
  }
  if (state.utility.activeTab === 'log-history') {
    renderUtilityModalContent();
  }
}

function applyExplicitFinalizedAlbumArtistEdits(finalizedAlbums, tagEdits) {
  if (!tagEditsExplicitlyChangeAlbumArtist(tagEdits)) return finalizedAlbums;
  return (finalizedAlbums || []).map((album) => {
    let explicitCandidateAlbumArtist = null;
    const tracks = (Array.isArray(album?.tracks) ? album.tracks : []).map((track) => {
      const edits = tagEdits[String(track?.path || '')];
      if (
        !edits
        || typeof edits !== 'object'
        || !Object.prototype.hasOwnProperty.call(edits, 'album_artist')
      ) {
        return track;
      }
      explicitCandidateAlbumArtist = String(edits.album_artist || '').trim();
      return {
        ...track,
        album_artist: explicitCandidateAlbumArtist,
      };
    });
    if (explicitCandidateAlbumArtist === null) return album;
    return {
      ...album,
      album_artist: explicitCandidateAlbumArtist,
      tracks,
    };
  });
}

function claimProblematicSaveTaskMutation(taskId, originalAlbum, expectedAlbumKey = '') {
  const normalizedTaskId = String(taskId || '').trim();
  const selectedKey = String(state.utility?.selectedProblematicKey || '').trim();
  const normalizedExpectedAlbumKey = String(expectedAlbumKey || '').trim();
  if (
    !normalizedTaskId
    || state.utility?.activeTab !== 'problematic-files'
    || !state.utility?.loaded
    || !selectedKey
    || (normalizedExpectedAlbumKey && selectedKey !== normalizedExpectedAlbumKey)
  ) return null;
  const selectedAlbum = (state.utility.problematicFiles || []).find((album) => (
    String(album?.key || '').trim() === selectedKey
  )) || null;
  const originalKey = String(originalAlbum?.key || '').trim();
  if (!selectedAlbum || !originalAlbum || (originalKey !== selectedKey && !albumsShareTrackPath(selectedAlbum, getAlbumTrackPaths(originalAlbum)))) {
    return null;
  }
  const existing = state.utility.problematicMutation;
  if (existing) {
    return String(existing.taskId || '') === normalizedTaskId
      && String(existing.albumKey || '') === selectedKey
      ? existing
      : null;
  }
  const list = typeof getUtilityModalElements === 'function'
    ? getUtilityModalElements()?.list
    : null;
  const mutation = {
    taskId: normalizedTaskId,
    albumKey: selectedKey,
    priorKeys: (state.utility.problematicFiles || []).map((album) => String(album?.key || '')).filter(Boolean),
    priorScrollTop: Number(list?.scrollTop || 0),
  };
  state.utility.problematicMutation = mutation;
  if (typeof renderUtilityModalContent === 'function') renderUtilityModalContent();
  return mutation;
}

async function settleProblematicSaveTaskMutation(taskId, { reconcileSelection = false } = {}) {
  const normalizedTaskId = String(taskId || '').trim();
  const mutation = state.utility?.problematicMutation;
  if (!mutation || String(mutation.taskId || '') !== normalizedTaskId) return false;
  const mutationOwnsView = (
    String(state.utility.selectedProblematicKey || '') === String(mutation.albumKey || '')
  );
  if (reconcileSelection && mutationOwnsView) {
    const items = Array.isArray(state.utility.problematicFiles) ? state.utility.problematicFiles : [];
    const survivingKeys = new Set(items.map((album) => String(album?.key || '')).filter(Boolean));
    const selectedKey = String(mutation.albumKey || '');
    if (survivingKeys.has(selectedKey)) {
      state.utility.selectedProblematicKey = selectedKey;
    } else {
      const priorKeys = Array.isArray(mutation.priorKeys) ? mutation.priorKeys : [];
      const selectedIndex = priorKeys.indexOf(selectedKey);
      const previousSurvivor = selectedIndex > 0
        ? priorKeys.slice(0, selectedIndex).reverse().find((key) => survivingKeys.has(key))
        : '';
      state.utility.selectedProblematicKey = previousSurvivor || String(items[0]?.key || '');
    }
    const survivorKey = String(state.utility.selectedProblematicKey || '');
    const survivor = items.find((album) => String(album?.key || '') === survivorKey) || null;
    if (survivor && survivor.detail_loaded !== true && typeof loadProblematicAlbumDetail === 'function') {
      await loadProblematicAlbumDetail(survivorKey, false, { render: false });
    }
  }
  const priorScrollTop = Number(mutation.priorScrollTop || 0);
  state.utility.problematicMutation = null;
  if (typeof renderUtilityModalContent === 'function') renderUtilityModalContent();
  const list = typeof getUtilityModalElements === 'function'
    ? getUtilityModalElements()?.list
    : null;
  if (list && mutationOwnsView) {
    const requiredScrollHeight = priorScrollTop + Number(list.clientHeight || 0);
    const missingScrollHeight = Math.max(0, requiredScrollHeight - Number(list.scrollHeight || 0));
    const ownerDocument = list.ownerDocument
      || (typeof document !== 'undefined' ? document : null);
    if (missingScrollHeight > 0 && ownerDocument?.createElement && typeof list.appendChild === 'function') {
      const retainedContent = ownerDocument.createElement('div');
      retainedContent.setAttribute('data-problematic-scroll-retainer', '');
      retainedContent.setAttribute('aria-hidden', 'true');
      retainedContent.style.flex = `0 0 ${missingScrollHeight}px`;
      retainedContent.style.height = `${missingScrollHeight}px`;
      retainedContent.style.pointerEvents = 'none';
      list.appendChild(retainedContent);
      const releaseRetainedGeometry = () => {
        retainedContent.remove?.();
        list.removeEventListener?.('pointerdown', releaseRetainedGeometry);
        list.removeEventListener?.('wheel', releaseRetainedGeometry);
        list.removeEventListener?.('keydown', releaseRetainedGeometry);
      };
      list.addEventListener?.('pointerdown', releaseRetainedGeometry);
      list.addEventListener?.('wheel', releaseRetainedGeometry, { passive: true });
      list.addEventListener?.('keydown', releaseRetainedGeometry);
    }
    list.scrollTop = priorScrollTop;
  }
  return true;
}

async function refreshLoadedProblematicFilesAfterSaveCompletion() {
  if (!state.utility?.loaded && !state.utility?.loading) return false;
  const staleLoadPromise = state.utility.loadPromise;
  if (state.utility.loading && staleLoadPromise) {
    try {
      await staleLoadPromise;
    } catch (error) {
      console.warn(
        '[AlbumHaven][SaveTask] The previous Problematic Files load failed before the completed save refresh.',
        error,
      );
    }
  }
  await loadProblematicFiles(true, { render: false });
  const utilityOverlay = typeof getUtilityModalElements === 'function'
    ? getUtilityModalElements()?.overlay
    : null;
  if (
    !state.utility?.problematicMutation
    && !state.utility?.problematicNavigationActiveToken
    && utilityOverlay?.hidden === false
    && typeof renderUtilityModalContent === 'function'
  ) {
    renderUtilityModalContent();
  }
  return true;
}

async function watchSaveTask(taskId, context = {}) {
  const normalizedId = String(taskId || '').trim();
  if (!normalizedId) return;
  const originalAlbum = context.originalAlbum || null;
  const hasProblematicMutationOriginKey = Object.prototype.hasOwnProperty.call(
    context,
    'problematicMutationOriginKey',
  );
  const problematicMutationOriginKey = String(
    context.problematicMutationOriginKey || '',
  ).trim();
  const problematicMutation = (
    !hasProblematicMutationOriginKey || problematicMutationOriginKey
  )
    ? claimProblematicSaveTaskMutation(
      normalizedId,
      originalAlbum,
      problematicMutationOriginKey,
    )
    : null;
  const hasOriginatingViewStateRevision = Object.prototype.hasOwnProperty.call(
    context,
    'originatingViewStateRevision',
  );
  const originatingViewStateRevision = Number(context.originatingViewStateRevision || 0);
  const tagEditMutationClaim = context.tagEditMutationClaim || (
    hasOriginatingViewStateRevision && originalAlbum
      ? claimTagEditViewMutation(originalAlbum)
      : null
  );
  const originStillOwnsView = () => (
    !hasOriginatingViewStateRevision
    || Number(state.ui?.viewStateRevision || 0) === originatingViewStateRevision
  );
  const originatingViewRequestUrl = String(context.originatingViewRequestUrl || '').trim();
  const currentViewMatchesOriginRequest = () => (
    Boolean(originatingViewRequestUrl)
    && typeof buildApiUrl === 'function'
    && String(buildApiUrl(state.view) || '').trim() === originatingViewRequestUrl
  );
  const mutationStillOwnsOriginResources = () => (
    !tagEditMutationClaim
    || tagEditViewMutationStillOwnsResources(tagEditMutationClaim)
  );
  const canReconcileOriginView = () => (
    originStillOwnsView() && mutationStillOwnsOriginResources()
  );
  const supersededMutationStillAtOrigin = () => (
    originStillOwnsView() && !mutationStillOwnsOriginResources()
  );
  const absoluteScrollPosition = context.absoluteScrollPosition
    && Number.isFinite(Number(context.absoluteScrollPosition.scrollTop))
    && Number.isFinite(Number(context.absoluteScrollPosition.scrollLeft))
    ? {
      scrollLeft: Number(context.absoluteScrollPosition.scrollLeft),
      scrollTop: Number(context.absoluteScrollPosition.scrollTop),
    }
    : null;
  const renderOptions = context.preserveAbsoluteScroll === true
    ? {
      preserveScroll: true,
      preserveAbsoluteScroll: true,
      ...(absoluteScrollPosition ? { absoluteScrollPosition } : {}),
    }
    : { preserveScroll: true };
  const currentViewRenderOptions = () => (
    originStillOwnsView() || currentViewMatchesOriginRequest()
      ? { ...renderOptions, preserveGalleryOptionsMenu: true }
      : { preserveScroll: true, preserveGalleryOptionsMenu: true }
  );
  const restoreOwnedAbsoluteScroll = () => {
    if (
      !absoluteScrollPosition
      || (!originStillOwnsView() && !currentViewMatchesOriginRequest())
      || typeof document === 'undefined'
      || typeof document.getElementById !== 'function'
    ) return false;
    if (
      typeof virtualGrid !== 'undefined'
      && virtualGrid
      && typeof virtualGrid.restoreOwnedAbsoluteScrollPosition === 'function'
    ) {
      return virtualGrid.restoreOwnedAbsoluteScrollPosition(absoluteScrollPosition);
    }
    const galleryScroll = document.getElementById('albums-scroll');
    if (!galleryScroll) return false;
    galleryScroll.scrollLeft = absoluteScrollPosition.scrollLeft;
    galleryScroll.scrollTop = absoluteScrollPosition.scrollTop;
    return true;
  };
  const providedTerminalPayload = context.terminalPayload
    && typeof context.terminalPayload === 'object'
    && !Array.isArray(context.terminalPayload)
    ? {
      ...context.terminalPayload,
      task_id: String(
        context.terminalPayload.task_id
        || context.terminalPayload.save_task_id
        || normalizedId,
      ).trim(),
      status: String(
        context.terminalPayload.status
        || context.terminalPayload.save_task_status
        || '',
      ).trim().toLowerCase(),
    }
    : null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const consumesProvidedTerminalPayload = attempt === 0 && providedTerminalPayload;
    try {
      let data = providedTerminalPayload;
      if (!consumesProvidedTerminalPayload) {
        const response = await fetch(`/utilities/save-task/${encodeURIComponent(normalizedId)}`, { headers: { Accept: 'application/json' } });
        data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) {
          throw new Error(data.error || 'Unable to load save task.');
        }
      } else if (!data.ok) {
        throw new Error(data.error || 'Unable to load save task.');
      }
      const responseTaskId = String(data.task_id || '').trim();
      if (responseTaskId && responseTaskId !== normalizedId) {
        await waitForBrowserTimeout(500);
        continue;
      }
      if (data.status === 'completed') {
        const preRefreshVisibleAlbums = collectVisibleAlbumsUnique();
        await refreshLoadedProblematicFilesAfterSaveCompletion();
        if (problematicMutation) {
          await settleProblematicSaveTaskMutation(normalizedId, { reconcileSelection: true });
        }
        const finalizedAlbums = applyExplicitFinalizedAlbumArtistEdits(
          Array.isArray(data.updated_albums) ? data.updated_albums : [],
          context.tagEdits,
        );
        const structuralTagEditRequiresMountedGalleryChildReplacement = (
          tagEditsRequireMountedGalleryChildReplacement(context.tagEdits)
        );
        const finalizedAlbumsKeepOriginalMembership = (
          finalizedAlbumsPreserveOriginalMembership(originalAlbum, finalizedAlbums)
        );
        const structuralTagEditRequiresCanonicalView = (
          structuralTagEditRequiresMountedGalleryChildReplacement
          && finalizedAlbumsKeepOriginalMembership
        );
        const finalizedAlbumsHaveCanonicalRuntimeIdentities = (
          finalizedAlbums.length > 0
          && finalizedAlbums.every((album) => (
            String(album?.request_key || '').trim()
            || String(album?.identity_key || '').trim()
          ))
        );
        const structuralMembershipTransferRequiresCanonicalRefresh = (
          structuralTagEditRequiresMountedGalleryChildReplacement
          && !finalizedAlbumsKeepOriginalMembership
        );
        const finalizedAlbumsCoverOriginalMembership = (
          finalizedAlbumsCoverExpectedTrackPaths(
            originalAlbum,
            context.optimisticAlbums,
            finalizedAlbums,
          )
        );
        const structuralPartialMembershipRequiresCanonicalRefresh = (
          structuralTagEditRequiresMountedGalleryChildReplacement
          && !finalizedAlbumsCoverOriginalMembership
        );
        let modalUpdatedAlbums = finalizedAlbums;
        let viewRefreshed = false;
        let viewReconciledLocally = false;
        if (data.requires_view_refresh) {
          if (
            canReconcileOriginView()
            && finalizedAlbums.length
            && (
              !structuralTagEditRequiresCanonicalView
              || finalizedAlbumsHaveCanonicalRuntimeIdentities
            )
          ) {
            try {
              const reconciledAlbums = applyUpdatedAlbumsToCurrentView(
                finalizedAlbums,
                {
                  skipRender: true,
                  originalAlbum,
                  preserveScroll: true,
                  tagEdits: context.tagEdits,
                },
              );
              if (reconciledAlbums.length) modalUpdatedAlbums = reconciledAlbums;
              renderView({
                ...renderOptions,
                preserveMountedGalleryChildren: true,
              });
              viewReconciledLocally = true;
            } catch (reconciliationError) {
              console.warn(
                '[AlbumHaven][SaveTask] Saved tags, but failed to reconcile the finalized albums locally.',
                reconciliationError,
              );
            }
          }
          if (
            (
              !viewReconciledLocally
              || structuralPartialMembershipRequiresCanonicalRefresh
            )
            && !supersededMutationStillAtOrigin()
          ) {
            try {
              viewRefreshed = await fetchAndRender(
                buildApiUrl(state.view),
                false,
                {
                  ...currentViewRenderOptions(),
                  preserveMountedGalleryChildren: true,
                  ...(!structuralTagEditRequiresCanonicalView
                    ? { retainMountedGalleryIfEquivalent: true }
                    : {}),
                  restartIfSameUrl: true,
                  shouldApplyResponse: () => !supersededMutationStillAtOrigin(),
                },
              );
              if (viewRefreshed && finalizedAlbums.length) {
                modalUpdatedAlbums = enrichFinalizedAlbumsWithCanonicalVisibleProjections(
                  finalizedAlbums,
                  collectVisibleAlbumsUnique(),
                  {
                    replaceCompactMembership: (finalizedAlbum) => (
                      originalAlbum
                      && albumsShareLogicalReleaseIdentity(finalizedAlbum, originalAlbum)
                    ),
                  },
                );
                if (
                  structuralMembershipTransferRequiresCanonicalRefresh
                  && finalizedAlbumsCoverOriginalMembership
                  && canReconcileOriginView()
                ) {
                  const reconciledAlbums = applyUpdatedAlbumsToCurrentView(
                    modalUpdatedAlbums,
                    {
                      skipRender: true,
                      originalAlbum,
                      preserveScroll: true,
                      tagEdits: context.tagEdits,
                    },
                  );
                  if (reconciledAlbums.length) modalUpdatedAlbums = reconciledAlbums;
                }
              }
              if (viewRefreshed && originalAlbum && !modalUpdatedAlbums.length) {
                modalUpdatedAlbums = collectVisibleAlbumsUnique();
              }
            } catch (refreshError) {
              console.warn('[AlbumHaven][SaveTask] Saved tags, but failed to refresh the view.', refreshError);
            }
          }
          if (
            structuralTagEditRequiresCanonicalView
            && !viewRefreshed
            && !viewReconciledLocally
            && canReconcileOriginView()
            && finalizedAlbums.length
          ) {
            const reconciledAlbums = applyUpdatedAlbumsToCurrentView(
              finalizedAlbums,
              {
                skipRender: true,
                originalAlbum,
                preserveScroll: true,
                tagEdits: context.tagEdits,
              },
            );
            if (reconciledAlbums.length) modalUpdatedAlbums = reconciledAlbums;
            renderView({
              ...renderOptions,
              preserveMountedGalleryChildren: true,
            });
            viewReconciledLocally = true;
          }
        } else if (canReconcileOriginView()) {
          const reconciledAlbums = applyUpdatedAlbumsToCurrentView(
            finalizedAlbums,
            {
              skipRender: true,
              originalAlbum,
              preserveScroll: true,
              tagEdits: context.tagEdits,
            },
          );
          if (reconciledAlbums.length) modalUpdatedAlbums = reconciledAlbums;
          renderView(renderOptions);
        } else if (!originStillOwnsView()) {
          try {
            await fetchAndRender(buildApiUrl(state.view), false, currentViewRenderOptions());
          } catch (refreshError) {
            console.warn(
              '[AlbumHaven][SaveTask] Saved tags, but the navigated view could not be refreshed.',
              refreshError,
            );
          }
        }
        if (originalAlbum && canReconcileOriginView()) {
          if (
            structuralMembershipTransferRequiresCanonicalRefresh
            && viewRefreshed
          ) {
            synchronizeCurrentViewAlbumIndex();
          }
          const trackModal = document.getElementById('track-modal');
          const trackModalOpen = Boolean(trackModal && !trackModal.hidden);
          if (!viewRefreshed || trackModalOpen) {
            modalUpdatedAlbums = enrichFinalizedAlbumsWithOptimisticModalTracks(
              modalUpdatedAlbums,
              viewRefreshed && trackModalOpen
                ? preRefreshVisibleAlbums
                : context.optimisticAlbums,
            );
          }
          updateOpenTrackModalAfterTagEdit(
            originalAlbum,
            modalUpdatedAlbums,
            {
              patchVisibleState: !viewRefreshed,
              preserveHydratedModalAfterCanonicalSave: (
                viewRefreshed
                || finalizedAlbumsHaveCanonicalRuntimeIdentities
              ),
            },
          );
          if (
            structuralTagEditRequiresMountedGalleryChildReplacement
            && data.requires_view_refresh
            && !finalizedAlbums.length
            && typeof invalidateHydratedTrackModalAlbumDetails === 'function'
          ) {
            invalidateHydratedTrackModalAlbumDetails([
              originalAlbum,
              ...(Array.isArray(context.optimisticAlbums) ? context.optimisticAlbums : []),
              ...modalUpdatedAlbums,
            ]);
          }
        }
        if (data.log_entry) {
          await prependUtilityLogHistoryEntry(data.log_entry);
        }
        restoreOwnedAbsoluteScroll();
        if (!consumesProvidedTerminalPayload) {
          showRepairAlert('Library view updated from saved files.', 'success', 1000);
        }
        settleTagEditViewMutation(tagEditMutationClaim);
        return;
      }
      if (data.status === 'failed') {
        let viewRefreshed = false;
        if (!supersededMutationStillAtOrigin()) {
          try {
            viewRefreshed = await fetchAndRender(
              buildApiUrl(state.view),
              false,
              currentViewRenderOptions(),
            );
          } catch (refreshError) {
            console.warn(
              '[AlbumHaven][SaveTask] Tag edit failed and the compensated view could not be refreshed.',
              refreshError,
            );
          }
        }
        if (!viewRefreshed && originalAlbum && canReconcileOriginView()) {
          applyUpdatedAlbumsToCurrentView(
            [originalAlbum],
            {
              skipRender: true,
              originalAlbum,
              preserveScroll: true,
            },
          );
          renderView(renderOptions);
        }
        if (originalAlbum && canReconcileOriginView()) {
          const reconciledAlbums = viewRefreshed
            ? collectVisibleAlbumsUnique()
            : [originalAlbum];
          updateOpenTrackModalAfterTagEdit(originalAlbum, reconciledAlbums, {
            preserveHydratedModalAfterFailedSave: true,
          });
        }
        if (data.log_entry) {
          try {
            await prependUtilityLogHistoryEntry(data.log_entry);
          } catch (historyError) {
            console.warn('[AlbumHaven][SaveTask] Could not persist the failed tag edit in browser history.', historyError);
          }
        }
        showRepairAlert(
          data.error || 'Tags were saved, but final refresh failed.',
          'error',
          null,
          { logHistoryLink: true },
        );
        if (problematicMutation) settleProblematicSaveTaskMutation(normalizedId);
        releaseFailedTagEditViewMutation(tagEditMutationClaim);
        return;
      }
    } catch (error) {
      if (consumesProvidedTerminalPayload) throw error;
      console.warn('[AlbumHaven][SaveTask] Could not check save task status.', error);
    }
    await waitForBrowserTimeout(500);
  }
  if (problematicMutation) settleProblematicSaveTaskMutation(normalizedId);
  settleTagEditViewMutation(tagEditMutationClaim);
}

function cacheTagEditCandidateAlbums(candidates, sourceAliasOwner, sourceAliases) {
  if (typeof cacheHydratedTrackModalAlbum !== 'function') return;
  candidates.filter((candidate) => candidate !== sourceAliasOwner).forEach((candidate) => {
    const candidateRequestKey = String(getAlbumRequestKey(candidate) || '').trim();
    cacheHydratedTrackModalAlbum(candidateRequestKey, candidate);
  });
  if (!sourceAliasOwner) return;
  const sourceRequestKey = String(getAlbumRequestKey(sourceAliasOwner) || '').trim();
  cacheHydratedTrackModalAlbum(
    sourceRequestKey,
    sourceAliasOwner,
    { aliases: sourceAliases },
  );
}

function preserveHydratedModalAfterFailedSave(candidate, originalAlbum, enabled = false) {
  const originalTracks = Array.isArray(originalAlbum?.tracks)
    ? originalAlbum.tracks
    : [];
  if (!enabled || !originalTracks.length) return candidate;
  return {
    ...candidate,
    ...originalAlbum,
    tracks: originalTracks.slice(),
    preview_only: false,
  };
}

function preserveHydratedModalTrackDetails(candidate, originalAlbum, enabled = false) {
  const candidateTracks = Array.isArray(candidate?.tracks) ? candidate.tracks : [];
  const originalTracks = Array.isArray(originalAlbum?.tracks) ? originalAlbum.tracks : [];
  if (!enabled || !originalTracks.length) return candidate;
  if (!candidateTracks.length) {
    const declaredTrackCount = Number(candidate?.track_count_preview || 0);
    if (declaredTrackCount > 0 && declaredTrackCount !== originalTracks.length) {
      return originalAlbum;
    }
    if (declaredTrackCount !== originalTracks.length) return candidate;
    return {
      ...candidate,
      tracks: originalTracks.slice(),
      preview_only: false,
    };
  }
  const originalTracksByPath = new Map(originalTracks.map((track) => [
    String(track?.path || ''),
    track,
  ]));
  let hydratedTrackCount = 0;
  const tracks = candidateTracks.map((track) => {
    const hydratedTrack = originalTracksByPath.get(String(track?.path || ''));
    if (!hydratedTrack) return track;
    hydratedTrackCount += 1;
    return {
      ...hydratedTrack,
      ...track,
    };
  });
  if (!hydratedTrackCount) return candidate;
  return {
    ...candidate,
    tracks,
    preview_only: hydratedTrackCount === candidateTracks.length
      ? false
      : candidate.preview_only,
  };
}

function updateOpenTrackModalAfterTagEdit(originalAlbum, updatedAlbums, options = {}) {
  const trackModal = document.getElementById('track-modal');
  const modalOpen = Boolean(trackModal && !trackModal.hidden);
  const candidates = Array.isArray(updatedAlbums) ? updatedAlbums.filter(Boolean) : [];
  if (!candidates.length) return;
  if (!modalOpen) {
    if (typeof cacheHydratedTrackModalAlbum !== 'function') return;
    const aliases = new Set([
      getAlbumRequestKey(originalAlbum),
      getAlbumIdentity(originalAlbum),
    ].map((alias) => String(alias || '').trim()).filter(Boolean));
    const sourceAliasOwner = candidates.find((candidate) => (
      albumsShareLogicalReleaseIdentity(candidate, originalAlbum)
    )) || candidates[0];
    cacheTagEditCandidateAlbums(candidates, sourceAliasOwner, aliases);
    return;
  }
  const currentAlbum = state.modalReleases[state.modalReleaseIndex] || originalAlbum;
  const currentPaths = getAlbumTrackPaths(currentAlbum);
  const originalPaths = getAlbumTrackPaths(originalAlbum);
  const updatedCurrentAlbum = getUpdatedAlbumForTrackPaths(candidates, currentPaths)
    || candidates.find((candidate) => albumsShareRuntimeIdentityAlias(candidate, currentAlbum))
    || null;
  const currentModalBelongsToMutation = (
    currentAlbum === originalAlbum
    || albumsShareRuntimeIdentityAlias(currentAlbum, originalAlbum)
    || albumsShareTrackPath(currentAlbum, originalPaths)
    || (
      updatedCurrentAlbum
      && albumsShareTrackPath(updatedCurrentAlbum, originalPaths)
    )
  );
  const remainingSourceAlbum = albumsShareLogicalReleaseIdentity(currentAlbum, originalAlbum)
    ? candidates.find((candidate) => (
      albumsShareLogicalReleaseIdentity(candidate, originalAlbum)
      && (
        getAlbumTrackPaths(candidate).size
        || Number(candidate?.track_count_preview || 0) > 0
      )
    ))
    : null;
  const updatedAlbum = remainingSourceAlbum
    || updatedCurrentAlbum
    || getUpdatedAlbumForTrackPaths(candidates, originalPaths)
    || candidates[0];
  if (!updatedAlbum) return;
  const failedSaveModalAlbum = preserveHydratedModalAfterFailedSave(
    updatedAlbum,
    originalAlbum,
    options.preserveHydratedModalAfterFailedSave === true
      && currentModalBelongsToMutation,
  );
  const modalAlbum = preserveHydratedModalTrackDetails(
    failedSaveModalAlbum,
    options.preserveHydratedModalAfterCanonicalSave === true
      && currentModalBelongsToMutation
      ? currentAlbum
      : originalAlbum,
    options.preserveHydratedModalAfterCanonicalSave === true
      && currentModalBelongsToMutation,
  );
  if (options.patchVisibleState !== false) {
    patchVisibleAlbumsByTrackPath(candidates);
  }
  const aliases = new Set([
    getAlbumRequestKey(originalAlbum),
    getAlbumIdentity(originalAlbum),
    ...(currentModalBelongsToMutation
      ? [getAlbumRequestKey(currentAlbum), getAlbumIdentity(currentAlbum)]
      : []),
  ].map((alias) => String(alias || '').trim()).filter(Boolean));
  const sourceAliasOwner = candidates.find((candidate) => (
    albumsShareLogicalReleaseIdentity(candidate, originalAlbum)
  )) || updatedAlbum;
  cacheTagEditCandidateAlbums(
    candidates,
    sourceAliasOwner === updatedAlbum ? modalAlbum : sourceAliasOwner,
    aliases,
  );
  if (!currentModalBelongsToMutation) return;
  const releaseSet = getAlbumReleaseSet(modalAlbum);
  state.modalReleases = releaseSet.releases.length ? releaseSet.releases : [modalAlbum];
  state.modalReleaseIndex = Math.max(0, releaseSet.selectedIndex || 0);
  renderTrackModalRelease(state.modalReleases[state.modalReleaseIndex] || modalAlbum);
}

function updateTrackModalIfStillShowingAlbum(originalAlbum, updatedAlbums) {
  const modalOpen = !document.getElementById('track-modal')?.hidden;
  if (!modalOpen) return;
  const currentAlbum = state.modalReleases[state.modalReleaseIndex] || null;
  if (!currentAlbum) return;
  const currentPaths = getAlbumTrackPaths(currentAlbum);
  const originalPaths = getAlbumTrackPaths(originalAlbum);
  if (!currentPaths.size || !originalPaths.size) return;
  const stillShowingOriginalAlbum = Array.from(currentPaths).some((path) => originalPaths.has(path));
  if (!stillShowingOriginalAlbum) return;
  updateOpenTrackModalAfterTagEdit(originalAlbum, updatedAlbums);
}

function applyRepairResultToProblematicFiles(originalAlbum, updatedAlbum) {
  const originalKey = String(originalAlbum?.key || '');
  const originalPaths = getAlbumTrackPaths(originalAlbum);
  const hasUpdatedAlbum = updatedAlbum && typeof updatedAlbum === 'object' && Object.keys(updatedAlbum).length;
  const updatedKey = hasUpdatedAlbum ? String(updatedAlbum.key || '') : '';
  const previousItems = Array.isArray(state.utility.problematicFiles) ? state.utility.problematicFiles : [];
  const selectedKeyBefore = String(state.utility.selectedProblematicKey || '');
  const selectedIndexBefore = previousItems.findIndex((item) => String(item?.key || '') === selectedKeyBefore);
  let insertedUpdatedAlbum = false;

  const nextItems = (state.utility.problematicFiles || []).reduce((items, item) => {
    const matchesOriginal = (originalKey && item.key === originalKey) || albumsShareTrackPath(item, originalPaths);
    const matchesUpdated = updatedKey && item.key === updatedKey;
    if (matchesOriginal || matchesUpdated) {
      if (hasUpdatedAlbum && !insertedUpdatedAlbum) {
        items.push(updatedAlbum);
        insertedUpdatedAlbum = true;
      }
      return items;
    }
    items.push(item);
    return items;
  }, []);

  if (hasUpdatedAlbum && !insertedUpdatedAlbum) {
    nextItems.push(updatedAlbum);
  }

  state.utility.problematicFiles = nextItems;
  state.utility.loaded = true;
  if (hasUpdatedAlbum) {
    state.utility.selectedProblematicKey = String(updatedAlbum.key || '');
  } else if (selectedIndexBefore >= 0) {
    const previousSurvivor = previousItems.slice(0, selectedIndexBefore).reverse().find((item) => (
      nextItems.some((candidate) => String(candidate?.key || '') === String(item?.key || ''))
    ));
    state.utility.selectedProblematicKey = String(previousSurvivor?.key || '');
  } else {
    state.utility.selectedProblematicKey = '';
  }
  state.utility.showRepairedDisplay = true;
  state.utility.repairSelections = {};
  state.utility.problemExclusionSelections = {};
  state.utility.separateReleaseSelections = {};
  state.utility.pendingRepairAction = '';
  renderUtilityModalContent();
}

function normalizeProblemFilterReason(reason) {
  const normalized = String(reason || '').trim();
  return normalized.startsWith('Incomplete track order:')
    ? 'Incomplete track order'
    : normalized;
}

function getAlbumProblemFilterReasons(album) {
  return (Array.isArray(album?.problem_reasons) ? album.problem_reasons : [])
    .map((reason) => normalizeProblemFilterReason(reason))
    .filter(Boolean);
}

function getProblemReasonTypes() {
  const reasons = new Set();
  (state.utility.problematicFiles || []).forEach((album) => {
    getAlbumProblemFilterReasons(album).forEach((reason) => {
      if (reason) reasons.add(reason);
    });
  });
  return Array.from(reasons).sort((a, b) => a.localeCompare(b));
}

function albumMatchesProblemFilters(album, selectedFilters = state.utility.selectedProblemFilters || []) {
  const selected = Array.isArray(selectedFilters) ? selectedFilters : [];
  if (!selected.length) return true;
  const reasons = new Set(getAlbumProblemFilterReasons(album));
  return selected.every((reason) => reasons.has(reason));
}

function getAlbumProblemFilterSortIndex(album) {
  const selected = state.utility.selectedProblemFilters || [];
  if (!selected.length) return Number.MAX_SAFE_INTEGER;
  const reasons = new Set(getAlbumProblemFilterReasons(album));
  const index = selected.findIndex((reason) => reasons.has(reason));
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function renderProblemFilterControls(els) {
  const reasonTypes = getProblemReasonTypes();
  const selected = state.utility.selectedProblemFilters || [];
  const selectedSet = new Set(selected);

  if (els.problemFilterButton) {
    const countSuffix = selected.length ? ` (${selected.length})` : '';
    els.problemFilterButton.textContent = `Problems${countSuffix}`;
    els.problemFilterButton.classList.toggle('is-active', Boolean(selected.length));
    els.problemFilterButton.setAttribute('aria-expanded', state.utility.problemDropdownOpen ? 'true' : 'false');
    els.problemFilterButton.hidden = false;
    els.problemFilterButton.disabled = !reasonTypes.length;
  }

  if (els.problemFilterMenu) {
    els.problemFilterMenu.hidden = !state.utility.problemDropdownOpen;
    els.problemFilterMenu.innerHTML = reasonTypes.length
      ? reasonTypes.map((reason) => `
          <button class="utility-problem-filter-option ${selectedSet.has(reason) ? 'is-selected' : ''}" type="button" data-problem-filter-value="${escapeHtml(reason)}" role="option" aria-selected="${selectedSet.has(reason) ? 'true' : 'false'}">
            <span class="utility-problem-filter-check">${selectedSet.has(reason) ? 'on' : ''}</span>
            <span class="utility-problem-filter-label">${escapeHtml(reason)}</span>
          </button>
        `).join('')
      : '<div class="utility-problem-filter-empty">No problem types found.</div>';
  }

  if (els.problemFilterChips) {
    els.problemFilterChips.innerHTML = selected.length
      ? selected.map((reason) => `
          <button class="utility-problem-filter-chip" type="button" data-remove-problem-filter="${escapeHtml(reason)}" title="Remove problem filter">
            <span>${escapeHtml(reason)}</span>
            <span aria-hidden="true">x</span>
          </button>
        `).join('')
      : '';
  }
}

function getFilteredProblematicAlbums() {
  const items = state.utility.problematicFiles || [];
  const query = (state.utility.searchQuery || '').trim().toLowerCase();

  const filtered = items.filter((album) => {
    if (!albumMatchesProblemFilters(album)) return false;
    if (!query) return true;
    const repairRows = Array.isArray(album.repair_preview_rows) ? album.repair_preview_rows : [];
    const trackTitles = Array.isArray(album.tracks) ? album.tracks.map((track) => String(track.title || '')) : [];
    const haystack = [
      String(album.name || ''),
      String(album.raw_name || ''),
      String(album.album_artist || ''),
      String(album.raw_album_artist || ''),
      String(album.year || ''),
      ...(Array.isArray(album.problem_reasons) ? album.problem_reasons.map((reason) => String(reason || '')) : []),
      String(album.search_text || ''),
      ...trackTitles,
      ...repairRows.flatMap((row) => [
        String(row.track_title || ''),
        String(row.original || ''),
        String(row.repaired || ''),
      ]),
    ].join('\n').toLowerCase();
    return haystack.includes(query);
  });

  if (!(state.utility.selectedProblemFilters || []).length) return filtered;
  return filtered.slice().sort((a, b) => (
    getAlbumProblemFilterSortIndex(a) - getAlbumProblemFilterSortIndex(b)
    || String(a.name || '').localeCompare(String(b.name || ''))
    || String(a.album_artist || '').localeCompare(String(b.album_artist || ''))
    || String(a.year || '').localeCompare(String(b.year || ''))
  ));
}

function getProblematicAlbumIssueLabel(album) {
  if (album?.detail_loading_deferred) return 'Loading issues…';
  const count = Array.isArray(album?.problem_reasons) ? album.problem_reasons.length : 0;
  return `${count} issue${count === 1 ? '' : 's'}`;
}

function getSelectedProblematicAlbumFrom(items) {
  return (items || []).find((item) => item.key === state.utility.selectedProblematicKey) || null;
}

function getSelectedUtilityRule() {
  return (state.utility.rules || []).find((item) => item.key === state.utility.selectedRuleKey) || null;
}

function getProblematicAlbumForTrackPath(trackPath) {
  const normalized = String(trackPath || '');
  return (state.utility.problematicFiles || []).find((album) =>
    (Array.isArray(album.problematic_track_paths) && album.problematic_track_paths.includes(normalized))
    || (Array.isArray(album.track_paths) && album.track_paths.includes(normalized))
  ) || null;
}

async function openUtilityModalForTrack(trackPath) {
  const navigationToken = Number(state.utility.problematicNavigationToken || 0) + 1;
  state.utility.problematicNavigationToken = navigationToken;
  state.utility.problematicNavigationActiveToken = navigationToken;
  const ownsNavigation = () => (
    Number(state.utility.problematicNavigationToken || 0) === navigationToken
  );
  try {
    const summaryRequestTokenBeforePendingTasks = Number(
      state.utility.problematicSummaryRequestToken || 0,
    );
    const pendingTasks = Object.values(
      state.utility.pendingProblematicSaveTasks || {},
    ).filter((entry) => (
      Array.isArray(entry?.trackPaths)
      && entry.trackPaths.includes(String(trackPath || ''))
      && entry.promise
      && typeof entry.promise.then === 'function'
    ));
    const optimisticAlbum = pendingTasks
      .flatMap((entry) => (Array.isArray(entry?.optimisticAlbums) ? entry.optimisticAlbums : []))
      .find((candidate) => albumsShareTrackPath(
        candidate,
        new Set([String(trackPath || '')].filter(Boolean)),
      )) || null;
    if (optimisticAlbum) {
      const optimisticKey = String(optimisticAlbum.key || '').trim();
      const existingItems = Array.isArray(state.utility.problematicFiles)
        ? state.utility.problematicFiles
        : [];
      state.utility.problematicFiles = [
        ...existingItems.filter((item) => String(item?.key || '').trim() !== optimisticKey),
        {
          ...optimisticAlbum,
          detail_loading_deferred: optimisticAlbum.detail_loaded !== true,
        },
      ];
      state.utility.loaded = true;
      state.utility.loading = false;
      state.utility.selectedProblematicKey = optimisticKey;
      state.utility.focusedTrackPath = String(trackPath || '');
      state.utility.showRepairedDisplay = true;
      state.utility.deferProblematicAutoSelection = false;
      state.utility.selectedProblemFilters = [];
      state.utility.problemDropdownOpen = false;
      setUtilityActiveTab('problematic-files');
      openUtilityModal({ resetSearch: true, resetSelection: false, forceLoad: false });
    }
    const optimisticDetailPromise = !optimisticAlbum || optimisticAlbum.detail_loaded === true
      ? null
      : Promise.resolve().then(async () => {
        const acceptedPromises = pendingTasks
          .map((entry) => entry?.acceptedPromise)
          .filter((promise) => promise && typeof promise.then === 'function');
        if (acceptedPromises.length) {
          await Promise.allSettled(acceptedPromises);
        }
        if (!ownsNavigation()) return null;
        return loadProblematicAlbumDetail(
          optimisticAlbum?.key || '',
          true,
          { allowMissing: true },
        );
      });
    if (pendingTasks.length) {
      await Promise.allSettled(pendingTasks.map((entry) => entry.promise));
      if (!ownsNavigation()) return;
    }
    if (optimisticDetailPromise) {
      await Promise.allSettled([optimisticDetailPromise]);
      if (!ownsNavigation()) return;
    }
    const summaryWasLoaded = state.utility.loaded;
    const pendingTaskRefreshedSummary = (
      pendingTasks.length > 0
      && Number(state.utility.problematicSummaryRequestToken || 0)
        > summaryRequestTokenBeforePendingTasks
    );
    if (!state.utility.loaded || (pendingTasks.length && !pendingTaskRefreshedSummary)) {
      const loadResult = await loadProblematicFiles(true, { render: false });
      if (loadResult === null || !ownsNavigation()) return;
    }
    let album = getProblematicAlbumForTrackPath(trackPath);
    if (!album && summaryWasLoaded) {
      const refreshResult = await loadProblematicFiles(true, { render: false });
      if (refreshResult === null || !ownsNavigation()) return;
      album = getProblematicAlbumForTrackPath(trackPath);
    }
    if (!ownsNavigation()) return;
    if (!album) {
      showToast('This track is not currently listed in Problematic Files.', 'error', 3200);
      return;
    }
    state.utility.selectedProblematicKey = album.key || '';
    state.utility.focusedTrackPath = String(trackPath || '');
    state.utility.showRepairedDisplay = true;
    state.utility.deferProblematicAutoSelection = false;
    state.utility.selectedProblemFilters = [];
    state.utility.problemDropdownOpen = false;
    setUtilityActiveTab('problematic-files');
    if (!album.detail_loaded) {
      await loadProblematicAlbumDetail(album.key || '', undefined, { render: false });
      if (!ownsNavigation()) return;
    }
    openUtilityModal({ resetSearch: true, resetSelection: false, forceLoad: false });
  } finally {
    if (Number(state.utility.problematicNavigationActiveToken || 0) === navigationToken) {
      state.utility.problematicNavigationActiveToken = 0;
    }
  }
}

function getIgnorableProblemRows(album) {
  const albumRows = Array.isArray(album?.album_problem_rows) ? album.album_problem_rows : [];
  const trackRows = (Array.isArray(album?.track_problem_rows) ? album.track_problem_rows : [])
    .flatMap((row) => Array.isArray(row.ignorable_reasons) ? row.ignorable_reasons : [])
    .filter((item) => String(item.row_key || ''));
  return [...albumRows.filter((item) => String(item?.row_key || '')), ...trackRows];
}

function selectProblemExclusion(rowKey, { toggle = true } = {}) {
  const normalizedKey = String(rowKey || '');
  const alreadySelected = Boolean(
    normalizedKey && state.utility.problemExclusionSelections?.[normalizedKey],
  );
  state.utility.problemExclusionSelections = normalizedKey && (!toggle || !alreadySelected)
    ? { [normalizedKey]: true }
    : {};
}

function extendProblemExclusionRange(reason, startIndex, endIndex) {
  const album = getSelectedProblematicAlbum();
  const rows = Array.isArray(album?.track_problem_rows) ? album.track_problem_rows : [];
  const normalizedReason = String(reason || '');
  const from = Math.min(Number(startIndex), Number(endIndex));
  const to = Math.max(Number(startIndex), Number(endIndex));
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to >= rows.length) return false;
  const keys = [];
  for (let index = from; index <= to; index += 1) {
    const match = (Array.isArray(rows[index]?.ignorable_reasons) ? rows[index].ignorable_reasons : [])
      .find((item) => String(item?.reason || '') === normalizedReason && String(item?.row_key || ''));
    if (match) keys.push(String(match.row_key));
  }
  if (!keys.length) return false;
  state.utility.problemExclusionSelections = Object.fromEntries(keys.map((key) => [key, true]));
  return true;
}

function getRepairRowKeysFromButton(button) {
  const rowKey = button?.getAttribute('data-repair-row-key') || '';
  const rowKeysPayload = button?.getAttribute('data-repair-row-keys') || '';
  let rowKeys = rowKey ? [rowKey] : [];
  if (rowKeysPayload) {
    try {
      const parsed = JSON.parse(rowKeysPayload);
      rowKeys = Array.isArray(parsed) ? parsed.map((value) => String(value || '')).filter(Boolean) : rowKeys;
    } catch (error) {
      console.warn('[AlbumHaven][Utilities] Could not parse problem action row keys.', error);
    }
  }
  return rowKeys;
}

function applyNotProblemChoice(button, choice) {
  const rowKeys = getRepairRowKeysFromButton(button);
  if (!rowKeys.length) return false;
  rowKeys.forEach((key) => {
    state.utility.repairSelections[key] = choice;
  });
  return true;
}

function applyRepairChoice(button, choice) {
  const rowKeys = getRepairRowKeysFromButton(button);
  if (!rowKeys.length) return false;
  const changed = rowKeys.some((key) => state.utility.repairSelections[key] !== choice);
  if (!changed) return false;
  rowKeys.forEach((key) => {
    state.utility.repairSelections[key] = choice;
  });
  return true;
}

function initializeRepairSelections(album) {
  const rows = Array.isArray(album?.repair_preview_rows) ? album.repair_preview_rows : [];
  const ignorableRows = getIgnorableProblemRows(album);
  const nextSelections = {};
  rows.forEach((row) => {
    const rowKey = String(row.row_key || '');
    if (!rowKey) return;
    nextSelections[rowKey] = state.utility.repairSelections[rowKey] || 'repair';
  });
  state.utility.repairSelections = nextSelections;
  const validExclusionKeys = new Set(ignorableRows.map((row) => String(row?.row_key || '')).filter(Boolean));
  state.utility.problemExclusionSelections = Object.fromEntries(
    Object.entries(state.utility.problemExclusionSelections || {})
      .filter(([rowKey, selected]) => selected && validExclusionKeys.has(rowKey)),
  );
}

function getSelectedRepairRowKeys() {
  return Object.entries(state.utility.repairSelections)
    .filter(([, value]) => value === 'repair')
    .map(([key]) => key);
}

function getIgnoredRepairRowKeys() {
  return Object.entries(state.utility.problemExclusionSelections || {})
    .filter(([, selected]) => Boolean(selected))
    .map(([key]) => key);
}

function getSelectedRepairFileCount() {
  return new Set(getSelectedRepairRowKeys().map((value) => String(value).split('::')[0]).filter(Boolean)).size;
}

function getSelectedSeparateReleaseKeys() {
  return Object.entries(state.utility.separateReleaseSelections || {})
    .filter(([, selected]) => Boolean(selected))
    .map(([key]) => key);
}

