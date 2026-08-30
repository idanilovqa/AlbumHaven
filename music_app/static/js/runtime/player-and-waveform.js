function getPlayerElements() {
  return {
    player: document.querySelector('.global-player'),
    coverButton: document.getElementById('player-cover-button'),
    play: document.getElementById('player-play'),
    title: document.getElementById('player-title'),
    albumLink: document.getElementById('player-album-link'),
    waveformCanvas: document.getElementById('player-waveform-canvas'),
    timeline: document.getElementById('player-timeline'),
    time: document.getElementById('player-time'),
    loopActions: document.querySelector('[data-loop-action-owner="global-player"]'),
    loopRange: document.querySelector('[data-loop-range-owner="global-player"]'),
    loopRegion: document.getElementById('player-loop-region'),
    loopStartHandle: document.getElementById('player-loop-start-handle'),
    loopEndHandle: document.getElementById('player-loop-end-handle'),
  };
}

function mountGlobalPlayerLoopControls() {
  const options = getGlobalPlayerLoopControlOptions();
  const actionHost = document.querySelector('[data-loop-action-mount="global-player"]');
  if (actionHost && !actionHost.querySelector('[data-loop-action-owner="global-player"]')) {
    actionHost.removeAttribute('data-loop-action-owner');
    actionHost.innerHTML = options.buildActionMarkup();
  }
  const els = getPlayerElements();
  if (els.loopActions && !els.loopActions._loopActionController) {
    els.loopActions._loopActionController = options.mountAction(els.loopActions);
  }
  if (els.loopRange && !els.loopRange._loopRangeController) {
    els.loopRange._loopRangeController = options.mountRange(els.loopRange);
  }
}

function formatTrackDuration(seconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  if (totalSeconds <= 0) return '';
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function formatAlbumDuration(seconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  if (totalSeconds <= 0) return '';
  const totalMinutes = Math.floor(totalSeconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours) return `${hours}h ${minutes}m`;
  return `${totalMinutes}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

function formatLoopTime(seconds, includeMillis = false) {
  const value = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(value / 60);
  const wholeSeconds = Math.floor(value % 60);
  if (!includeMillis) return `${minutes}:${String(wholeSeconds).padStart(2, '0')}`;
  const totalMillis = Math.round(value * 1000);
  const roundedMinutes = Math.floor(totalMillis / 60000);
  const roundedSeconds = Math.floor((totalMillis % 60000) / 1000);
  const millis = totalMillis % 1000;
  return `${roundedMinutes}:${String(roundedSeconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

function getPlayerPlaybackSnapshot() {
  return getStreamingPlaybackSnapshot();
}

function drawWaveformOnCanvas(canvas, waveform, progressRatio = 0) {
  if (!canvas) return;
  const width = Math.max(1, canvas.clientWidth || canvas.width || 1);
  const height = Math.max(1, canvas.clientHeight || canvas.height || 1);
  const ratio = window.devicePixelRatio || 1;
  const targetWidth = Math.round(width * ratio);
  const targetHeight = Math.round(height * ratio);
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.scale(ratio, ratio);

  const fill = state.player.appearance.waveformFillColor;
  const edge = state.player.appearance.waveformEdgeColor;
  const topMid = height * 0.24;
  const bottomMid = height * 0.76;
  const halfBand = Math.max(3, height * 0.18);
  const peaksLeft = Array.isArray(waveform?.left) ? waveform.left : [];
  const peaksRight = Array.isArray(waveform?.right) ? waveform.right : [];
  const bars = Math.max(peaksLeft.length, peaksRight.length, 1);
  const barWidth = width / bars;

  const drawChannel = (peaks, centerY, fillAlpha) => {
    if (!peaks.length) return;
    const smoothed = peaks.map((peak, index) => {
      const prev = peaks[Math.max(0, index - 1)] || peak;
      const next = peaks[Math.min(peaks.length - 1, index + 1)] || peak;
      return ((prev * 0.25) + (peak * 0.5) + (next * 0.25));
    });

    ctx.beginPath();
    smoothed.forEach((peak, index) => {
      const x = index * barWidth;
      const amplitude = Math.max(1, peak * halfBand);
      if (index === 0) {
        ctx.moveTo(x, centerY - amplitude);
      } else {
        ctx.lineTo(x, centerY - amplitude);
      }
    });
    for (let index = smoothed.length - 1; index >= 0; index -= 1) {
      const x = index * barWidth;
      const amplitude = Math.max(1, smoothed[index] * halfBand);
      ctx.lineTo(x, centerY + amplitude);
    }
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.globalAlpha = fillAlpha;
    ctx.fill();
    ctx.globalAlpha = 1;

    ctx.beginPath();
    smoothed.forEach((peak, index) => {
      const x = index * barWidth;
      const amplitude = Math.max(1, peak * halfBand);
      if (index === 0) {
        ctx.moveTo(x, centerY - amplitude);
      } else {
        ctx.lineTo(x, centerY - amplitude);
      }
    });
    ctx.strokeStyle = edge;
    ctx.lineWidth = 1.2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    ctx.beginPath();
    for (let index = 0; index < smoothed.length; index += 1) {
      const x = index * barWidth;
      const amplitude = Math.max(1, smoothed[index] * halfBand);
      if (index === 0) {
        ctx.moveTo(x, centerY + amplitude);
      } else {
        ctx.lineTo(x, centerY + amplitude);
      }
    }
    ctx.stroke();
  };

  const clampedProgress = Math.max(0, Math.min(1, progressRatio || 0));
  const playheadX = width * clampedProgress;
  drawChannel(peaksLeft, topMid, 0.42);
  drawChannel(peaksRight, bottomMid, 0.42);
  if (playheadX > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, playheadX, height);
    ctx.clip();
    drawChannel(peaksLeft, topMid, 0.82);
    drawChannel(peaksRight, bottomMid, 0.82);
    ctx.restore();
  }

  ctx.strokeStyle = edge;
  ctx.shadowColor = edge;
  ctx.shadowBlur = 10;
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  ctx.moveTo(playheadX, 0);
  ctx.lineTo(playheadX, height);
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.fillStyle = edge;
  ctx.beginPath();
  ctx.arc(playheadX, height * 0.5, 3.2, 0, Math.PI * 2);
  ctx.fill();
}

function clearWaveformCanvas() {
  const els = getPlayerElements();
  const canvas = els.waveformCanvas;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width || 0, canvas.height || 0);
}

async function updateWaveformAppearance(forceReload = false) {
  const els = getPlayerElements();
  const wrap = els.timeline?.parentElement;
  const playback = getPlayerPlaybackSnapshot();
  const path = String(state.player.current?.path || '');
  const isWaveform = state.player.loopActive || state.player.appearance.seekbarMode === 'waveform';
  wrap?.classList.toggle('is-waveform', isWaveform);
  if (els.waveformCanvas) {
    els.waveformCanvas.hidden = !isWaveform;
  }
  if (!isWaveform || !els.waveformCanvas || !path) {
    clearWaveformCanvas();
    return;
  }
  const renderToken = forceReload ? state.player.waveform.renderToken + 1 : state.player.waveform.renderToken;
  state.player.waveform.renderToken = renderToken;
  if (forceReload) {
    clearWaveformCanvas();
  }
  const generation = Number(playback.generation ?? state.player.streaming?.generation) || 0;
  const active = state.player.waveform.compactPeaks;
  const waveform = active?.path === path && active.generation === generation
    ? active.data
    : null;
  if (state.player.waveform.renderToken !== renderToken) return;
  const duration = Number(playback.duration) || 0;
  const progressRatio = duration > 0 ? (Number(playback.currentTime) || 0) / duration : 0;
  drawWaveformOnCanvas(els.waveformCanvas, waveform, progressRatio);
}

async function handleStreamingPlaybackWaveformReady(event = {}) {
  const generation = Number(event.generation) || 0;
  const currentPath = String(event.currentPath || '');
  const continuityPath = String(event.continuityPath || '');
  const currentPeaks = await loadWaveformPeaks(currentPath, 280, generation);
  const playback = getPlayerPlaybackSnapshot();
  if (!currentPeaks || Number(playback.generation ?? state.player.streaming?.generation) !== generation
      || String(state.player.current?.path || '') !== currentPath) return;
  const activePeaks = state.player.waveform.compactPeaks;
  if (activePeaks?.path !== currentPath || activePeaks.generation !== generation
      || activePeaks.data !== currentPeaks) {
    state.player.waveform.compactPeaks = { path: currentPath, generation, data: currentPeaks };
    await updateWaveformAppearance();
  }
  if (continuityPath
      && Number(getPlayerPlaybackSnapshot().generation ?? state.player.streaming?.generation) === generation) {
    await loadWaveformPeaks(continuityPath, 280, generation);
  }
}

function parseLoopTime(value) {
  const text = String(value || '').trim();
  if (!text) return NaN;
  const parts = text.split(':');
  if (parts.length === 1) return Number(parts[0]);
  const seconds = Number(parts.pop());
  const minutes = Number(parts.pop() || 0);
  const hours = Number(parts.pop() || 0);
  if (![seconds, minutes, hours].every(Number.isFinite)) return NaN;
  return (hours * 3600) + (minutes * 60) + seconds;
}

function buildProblematicAlbumListItem(album, selected) {
  const showConverted = !album.has_encoding_repairs || !selected || state.utility.showRepairedDisplay;
  const displayName = getProblematicAlbumDisplayValue(album, 'album', showConverted) || 'Unknown Album';
  const displayArtist = getProblematicAlbumDisplayValue(album, 'album_artist', showConverted) || 'Unknown Artist';
  const displayYear = String(album.year || '').trim();
  const displayTitle = displayYear ? `${displayName} / ${displayYear}` : displayName;
  return `
    <button class="utility-list-item ${selected ? 'is-active' : ''}" type="button" data-problematic-album-key="${escapeHtml(album.key)}">
      <span class="utility-list-item-title">${escapeHtml(displayTitle)}</span>
      <span class="utility-list-item-meta">${escapeHtml(displayArtist)}</span>
      <span class="utility-list-item-issues">${escapeHtml(getProblematicAlbumIssueLabel(album))}</span>
      ${album.has_encoding_repairs ? '<span class="utility-list-item-badge">Converted display</span>' : ''}
    </button>
  `;
}

function buildUtilityRuleListItem(rule, selected) {
  return `
    <button class="utility-list-item ${selected ? 'is-active' : ''}" type="button" data-utility-rule-key="${escapeHtml(rule.key || '')}">
      <span class="utility-list-item-title">${escapeHtml(rule.title || 'Rule')}</span>
      <span class="utility-list-item-meta">${escapeHtml(rule.description || '')}</span>
      <span class="utility-list-item-issues">${Number(rule.count || 0)} applied</span>
    </button>
  `;
}

function buildUtilityLoopGroupKey(loop) {
  const artist = String(loop?.artist || '').trim().toLowerCase();
  const title = String(loop?.title || '').trim().toLowerCase();
  const album = String(loop?.album || '').trim().toLowerCase();
  if (artist || title || album) {
    return `${artist}::${title}::${album}`;
  }
  const sourcePath = String(loop?.source_path || '').trim().toLowerCase();
  if (sourcePath) return sourcePath;
  return String(loop?.id || '');
}

function groupUtilityLoops(loops) {
  const items = Array.isArray(loops) ? loops : [];
  const groups = [];
  const byKey = new Map();
  items.forEach((loop) => {
    const key = buildUtilityLoopGroupKey(loop);
    if (!key) return;
    let group = byKey.get(key);
    if (!group) {
      group = {
        key,
        representativeLoop: loop,
        loops: [],
      };
      byKey.set(key, group);
      groups.push(group);
    }
    group.loops.push(loop);
  });
  return groups;
}

function isUtilityLoopGroupCollapsed(groupKey) {
  return Boolean(state.utility.collapsedLoopGroups?.[String(groupKey || '')]);
}

function buildUtilityLoopTree(group, selectedGroupKey, selectedLoopId) {
  const representative = group?.representativeLoop || group?.loops?.[0] || null;
  const title = representative?.title || representative?.name || 'Saved loops';
  const subtitle = [representative?.artist, representative?.album].filter(Boolean).join(' - ') || 'Unknown track';
  const loopCount = Array.isArray(group?.loops) ? group.loops.length : 0;
  const groupKey = String(group?.key || '');
  const collapsed = isUtilityLoopGroupCollapsed(groupKey);
  const groupSelected = groupKey && groupKey === String(selectedGroupKey || '');
  const loopsHtml = collapsed
    ? ''
    : `
      <div class="utility-loop-tree-children">
        ${(group?.loops || []).map((loop) => `
          <button class="utility-loop-tree-child ${String(loop?.id || '') === String(selectedLoopId || '') && state.utility.selectedLoopDetailMode === 'loop' ? 'is-active' : ''}" type="button" draggable="true" data-utility-loop-id="${escapeHtml(loop?.id || '')}" data-utility-loop-group-key="${escapeHtml(groupKey)}">
            <span class="utility-loop-drag-handle" aria-hidden="true">⋮⋮</span>
            <span class="utility-loop-tree-icon" aria-hidden="true"></span>
            <span class="utility-loop-tree-label">${escapeHtml(loop?.name || 'Saved loop')}</span>
          </button>
        `).join('')}
      </div>
    `;
  return `
    <div class="utility-loop-tree ${groupSelected ? 'is-group-selected' : ''} ${collapsed ? 'is-collapsed' : ''}" data-utility-loop-tree="${escapeHtml(groupKey)}">
      <div class="utility-loop-group-row ${groupSelected && state.utility.selectedLoopDetailMode !== 'loop' ? 'is-active' : ''}">
        <button class="utility-list-item utility-loop-group-list-item ${groupSelected && state.utility.selectedLoopDetailMode !== 'loop' ? 'is-active' : ''}" type="button" draggable="true" data-utility-loop-group-key="${escapeHtml(groupKey)}">
          <span class="utility-loop-drag-handle" aria-hidden="true">⋮⋮</span>
          <span class="utility-loop-tree-row-main">
            <span class="utility-loop-tree-song-copy">
              <span class="utility-list-item-title">${escapeHtml(title)}</span>
              <span class="utility-list-item-meta">${escapeHtml(subtitle)}</span>
              <span class="utility-loop-group-count">${escapeHtml(loopCount > 1 ? `${loopCount} loops` : '1 loop')}</span>
            </span>
          </span>
          <span class="utility-loop-collapse-toggle-wrap">
            <span class="utility-loop-collapse-toggle" data-utility-loop-collapse="${escapeHtml(groupKey)}" aria-label="${collapsed ? 'Expand song loops' : 'Collapse song loops'}" aria-expanded="${collapsed ? 'false' : 'true'}" role="button" tabindex="0">${collapsed ? '▸' : '▾'}</span>
          </span>
        </button>
      </div>
      ${loopsHtml}
    </div>
  `;
}

function formatLoopCreatedAt(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatLogHistoryTimestamp(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const timeZone = getPreferredUserTimeZone();
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  });
}

