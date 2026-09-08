function renderProblematicFiles() {
  const els = getUtilityModalElements();
  if (!els.overlay || !els.list || !els.detail || !els.count) return;

  const priorListScrollTop = Number(els.list.scrollTop);
  const replaceListContents = (html) => {
    els.list.innerHTML = html;
    if (Number.isFinite(priorListScrollTop) && priorListScrollTop > 0) {
      els.list.scrollTop = priorListScrollTop;
    }
  };

  const items = getFilteredProblematicAlbums();
  const operationalItems = Array.isArray(state.utility.libraryWatchHealthProblems)
    ? state.utility.libraryWatchHealthProblems
    : [];
  const operationalHtml = operationalItems
    .map((problem) => buildLibraryWatchHealthProblemRow(problem))
    .join('');
  if (els.sidebarLabel) els.sidebarLabel.textContent = 'Albums';
  els.count.textContent = String(items.length + operationalItems.length);
  if (els.search) {
    els.search.disabled = false;
    els.search.placeholder = 'Filter artist, album, or track';
    els.search.value = state.utility.searchQuery || '';
  }
  if (els.problemFilterButton) {
    els.problemFilterButton.disabled = false;
    els.problemFilterButton.hidden = false;
  }
  renderProblemFilterControls(els);

  const mutation = state.utility.problematicMutation;
  if (
    mutation
    && String(mutation.albumKey || '') === String(state.utility.selectedProblematicKey || '')
  ) {
    els.detail.setAttribute?.('aria-busy', 'true');
    mountProblematicMutationOverlay(els.detail);
    if (Number.isFinite(Number(mutation.priorScrollTop))) {
      els.list.scrollTop = Number(mutation.priorScrollTop);
    }
    return;
  }
  els.detail.removeAttribute?.('aria-busy');
  els.detail.removeAttribute?.('inert');

  if (state.utility.loading) {
    replaceListContents(`${operationalHtml}<div class="utility-empty-state compact">Loading...</div>`);
    els.detail.innerHTML = '<div class="utility-empty-state">Loading problematic albums...</div>';
    return;
  }

  if (!items.length) {
    replaceListContents(`${operationalHtml}<div class="utility-empty-state compact">No matching problematic albums found.</div>`);
    els.detail.innerHTML = '<div class="utility-empty-state">No matching problematic albums found.</div>';
    return;
  }

  const selectedProblematicMissing = !state.utility.selectedProblematicKey
    || !items.some((item) => item.key === state.utility.selectedProblematicKey);
  if (selectedProblematicMissing && state.utility.deferProblematicAutoSelection && (state.utility.selectedProblemFilters || []).length) {
    replaceListContents(operationalHtml + items.map((album) => buildProblematicAlbumListItem(album, false)).join(''));
    els.detail.innerHTML = '<div class="utility-empty-state">Select an album to inspect its problematic tags.</div>';
    return;
  }

  if (selectedProblematicMissing) {
    const focusedTrackPath = String(state.utility.focusedTrackPath || '');
    const focusedAlbum = focusedTrackPath
      ? items.find((item) => (
        (Array.isArray(item?.problematic_track_paths)
          && item.problematic_track_paths.includes(focusedTrackPath))
        || (Array.isArray(item?.track_paths) && item.track_paths.includes(focusedTrackPath))
      )) || null
      : null;
    const priorKeys = Array.isArray(state.utility.problematicMutation?.priorKeys)
      ? state.utility.problematicMutation.priorKeys
      : [];
    const previousIndex = priorKeys.indexOf(state.utility.selectedProblematicKey);
    const priorSurvivor = previousIndex > 0
      ? priorKeys.slice(0, previousIndex).reverse().find((key) => items.some((item) => item.key === key))
      : '';
    state.utility.selectedProblematicKey = focusedAlbum?.key || priorSurvivor || items[0].key;
    state.utility.deferProblematicAutoSelection = false;
    state.utility.showRepairedDisplay = true;
  }

  const selectedAlbum = getSelectedProblematicAlbumFrom(items);
  replaceListContents(operationalHtml + items.map((album) => buildProblematicAlbumListItem(album, album.key === state.utility.selectedProblematicKey)).join(''));
  if (selectedAlbum?.detail_load_failed) {
    els.detail.innerHTML = '<div class="utility-empty-state">Unable to load the selected problematic album.</div>';
    return;
  }
  if (!selectedAlbum?.detail_loaded) {
    els.detail.innerHTML = '<div class="utility-empty-state">Loading selected problematic album...</div>';
    if (!selectedAlbum?.detail_loading_deferred) {
      void loadProblematicAlbumDetail(selectedAlbum?.key || '');
    }
    return;
  }
  initializeRepairSelections(selectedAlbum);
  els.detail.innerHTML = buildProblematicAlbumDetail(selectedAlbum);
  if (state.utility.focusedTrackPath) {
    const focusedTrackPath = String(state.utility.focusedTrackPath);
    const scrollFocusedRowsIntoView = () => {
      let albumGeometryReady = false;
      const activeAlbumRow = els.list.querySelector?.('.utility-list-item.is-active');
      activeAlbumRow?.scrollIntoView?.({ block: 'nearest' });
      if (activeAlbumRow?.getBoundingClientRect && els.list.getBoundingClientRect) {
        const listRect = els.list.getBoundingClientRect();
        const activeAlbumRect = activeAlbumRow.getBoundingClientRect();
        albumGeometryReady = listRect.bottom > listRect.top
          && activeAlbumRect.bottom > activeAlbumRect.top;
        if (activeAlbumRect.bottom > listRect.bottom) {
          els.list.scrollTop += Math.ceil(activeAlbumRect.bottom - listRect.bottom);
        } else if (activeAlbumRect.top < listRect.top) {
          els.list.scrollTop -= Math.ceil(listRect.top - activeAlbumRect.top);
        }
      }
      const focusedTrackSelector = `[data-problematic-track-path="${cssEscape(focusedTrackPath)}"]`;
      const focusedTrackMatch = els.detail.querySelector?.(focusedTrackSelector);
      const focusedTrackRow = focusedTrackMatch?.closest?.('[role="row"]') || focusedTrackMatch;
      let trackGeometryReady = false;
      if (focusedTrackRow?.getBoundingClientRect && els.detail.getBoundingClientRect) {
        const detailRect = els.detail.getBoundingClientRect();
        const focusedTrackRect = focusedTrackRow.getBoundingClientRect();
        trackGeometryReady = detailRect.bottom > detailRect.top
          && focusedTrackRect.bottom > focusedTrackRect.top;
        if (focusedTrackRect.bottom > detailRect.bottom) {
          els.detail.scrollTop += Math.ceil(focusedTrackRect.bottom - detailRect.bottom);
        } else if (focusedTrackRect.top < detailRect.top) {
          els.detail.scrollTop -= Math.ceil(detailRect.top - focusedTrackRect.top);
        }
      }
      return {
        focusedTrackRendered: Boolean(focusedTrackRow),
        layoutReady: albumGeometryReady && trackGeometryReady,
      };
    };
    const initialFocusedNavigation = scrollFocusedRowsIntoView();
    const finishFocusedNavigation = (remainingAttempts) => {
      if (String(state.utility.focusedTrackPath || '') !== focusedTrackPath) return;
      const result = scrollFocusedRowsIntoView();
      if (!result.layoutReady &&
        result.focusedTrackRendered
        && remainingAttempts > 1
        && typeof scheduleBrowserAnimationFrame === 'function'
      ) {
        scheduleBrowserAnimationFrame(() => finishFocusedNavigation(remainingAttempts - 1));
      }
    };
    if (initialFocusedNavigation.focusedTrackRendered && typeof scheduleBrowserAnimationFrame === 'function') {
      scheduleBrowserAnimationFrame(() => finishFocusedNavigation(3));
    }
  }
}

function mountProblematicMutationOverlay(detail) {
  const overlayMarkup = `
    <div class="problematic-mutation-overlay" role="status" aria-live="polite">
      <span class="problematic-mutation-spinner" aria-hidden="true"></span>
      <span>Hold on. Your changes are being applied</span>
    </div>
  `;
  if (detail.querySelector?.('.problematic-mutation-overlay')) return;

  const ownerDocument = detail.ownerDocument
    || (typeof document !== 'undefined' ? document : null);
  if (
    ownerDocument?.createElement
    && typeof detail.appendChild === 'function'
  ) {
    const preservedContent = ownerDocument.createElement('div');
    preservedContent.className = 'problematic-mutation-content';
    preservedContent.setAttribute('data-problematic-mutation-content', '');
    preservedContent.setAttribute('inert', '');
    while (detail.firstChild) preservedContent.appendChild(detail.firstChild);

    const overlay = ownerDocument.createElement('div');
    overlay.className = 'problematic-mutation-overlay';
    overlay.setAttribute('role', 'status');
    overlay.setAttribute('aria-live', 'polite');
    const spinner = ownerDocument.createElement('span');
    spinner.className = 'problematic-mutation-spinner';
    spinner.setAttribute('aria-hidden', 'true');
    const message = ownerDocument.createElement('span');
    message.textContent = 'Hold on. Your changes are being applied';
    overlay.appendChild(spinner);
    overlay.appendChild(message);
    detail.appendChild(preservedContent);
    detail.appendChild(overlay);
    return;
  }

  detail.innerHTML = `<div class="problematic-mutation-content" data-problematic-mutation-content inert>${String(detail.innerHTML || '')}</div>`;
  if (typeof detail.insertAdjacentHTML === 'function') {
    detail.insertAdjacentHTML('beforeend', overlayMarkup);
    return;
  }
  detail.innerHTML += overlayMarkup;
}

function renderUtilityRules() {
  const els = getUtilityModalElements();
  if (!els.overlay || !els.list || !els.detail || !els.count) return;
  const rules = state.utility.rules || [];
  if (els.sidebarLabel) els.sidebarLabel.textContent = 'Rules';
  els.count.textContent = String(rules.length);
  if (els.search) {
    els.search.value = '';
    els.search.disabled = true;
    els.search.placeholder = 'Rules';
  }
  if (els.problemFilterButton) {
    els.problemFilterButton.disabled = true;
    els.problemFilterButton.hidden = true;
  }
  if (els.problemFilterMenu) els.problemFilterMenu.hidden = true;
  if (els.problemFilterChips) els.problemFilterChips.innerHTML = '';

  if (state.utility.rulesLoading) {
    els.list.innerHTML = '<div class="utility-empty-state compact">Loading rules...</div>';
    els.detail.innerHTML = '<div class="utility-empty-state">Loading rules...</div>';
    return;
  }

  if (!rules.length) {
    els.list.innerHTML = '<div class="utility-empty-state compact">No rules found.</div>';
    els.detail.innerHTML = '<div class="utility-empty-state">No rules found.</div>';
    return;
  }

  if (!state.utility.selectedRuleKey || !rules.some((item) => item.key === state.utility.selectedRuleKey)) {
    state.utility.selectedRuleKey = rules[0].key || '';
  }
  const selectedRule = getSelectedUtilityRule();
  els.list.innerHTML = rules.map((rule) => buildUtilityRuleListItem(rule, rule.key === state.utility.selectedRuleKey)).join('');
  els.detail.innerHTML = buildUtilityRuleDetail(selectedRule);
}

function clearUtilityLoopDragState() {
  state.utility.loopDragType = '';
  state.utility.loopDragId = '';
  state.utility.loopDragGroupKey = '';
  state.utility.loopDropType = '';
  state.utility.loopDropTargetId = '';
  state.utility.loopDropGroupKey = '';
  state.utility.loopDropPosition = '';
}

function syncUtilityLoopDragUi() {
  document.querySelectorAll('[data-utility-loop-group-key]').forEach((button) => {
    const groupKey = String(button.getAttribute('data-utility-loop-group-key') || '');
    const isGroupButton = button.hasAttribute('data-utility-loop-id') === false;
    const isDragging = isGroupButton
      ? state.utility.loopDragType === 'group' && groupKey && groupKey === String(state.utility.loopDragId || '')
      : state.utility.loopDragType === 'loop' && String(button.getAttribute('data-utility-loop-id') || '') === String(state.utility.loopDragId || '');
    const isDropTarget = isGroupButton
      ? state.utility.loopDropType === 'group' && groupKey && groupKey === String(state.utility.loopDropTargetId || '')
      : state.utility.loopDropType === 'loop' && String(button.getAttribute('data-utility-loop-id') || '') === String(state.utility.loopDropTargetId || '');
    button.classList.toggle('is-dragging', isDragging);
    button.classList.toggle(
      'is-drop-before',
      isDropTarget && state.utility.loopDropPosition === 'before',
    );
    button.classList.toggle(
      'is-drop-after',
      isDropTarget && state.utility.loopDropPosition === 'after',
    );
  });
}

function updateUtilityLoopDropState(type, targetId, position, groupKey = '') {
  state.utility.loopDropType = String(type || '');
  state.utility.loopDropTargetId = String(targetId || '');
  state.utility.loopDropGroupKey = String(groupKey || '');
  state.utility.loopDropPosition = position === 'after' ? 'after' : position === 'before' ? 'before' : '';
  syncUtilityLoopDragUi();
}

function getUtilityLoopDropPosition(button, clientY) {
  const rect = button.getBoundingClientRect();
  return clientY < rect.top + (rect.height / 2) ? 'before' : 'after';
}

function renderUtilityLoopList(els, loops) {
  const groups = groupUtilityLoops(loops);
  els.list.innerHTML = groups.map((group) => buildUtilityLoopTree(
    group,
    state.utility.selectedLoopGroupKey || getSelectedUtilityLoopGroup()?.key || '',
    state.utility.selectedLoopId || '',
  )).join('');
  bindUtilityLoopDragAndDrop();
  syncUtilityLoopDragUi();
}

function bindUtilityLoopDragAndDrop() {
  document.querySelectorAll('[data-utility-loop-group-key]').forEach((button) => {
    if (button.dataset.dragBound === '1') return;
    button.dataset.dragBound = '1';
    button.addEventListener('dragstart', (event) => {
      const groupKey = String(button.getAttribute('data-utility-loop-group-key') || '');
      const loopId = String(button.getAttribute('data-utility-loop-id') || '');
      const dragType = loopId ? 'loop' : 'group';
      const dragId = loopId || groupKey;
      if (!groupKey || !dragId) {
        event.preventDefault();
        return;
      }
      state.utility.loopDragType = dragType;
      state.utility.loopDragId = dragId;
      state.utility.loopDragGroupKey = groupKey;
      state.utility.loopSuppressClick = false;
      updateUtilityLoopDropState('', '', '');
      syncUtilityLoopDragUi();
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', JSON.stringify({ type: dragType, id: dragId, groupKey }));
      }
    });
    button.addEventListener('dragover', (event) => {
      const targetKey = String(button.getAttribute('data-utility-loop-group-key') || '');
      const targetLoopId = String(button.getAttribute('data-utility-loop-id') || '');
      let payload = { type: state.utility.loopDragType, id: state.utility.loopDragId, groupKey: state.utility.loopDragGroupKey };
      const raw = String(event.dataTransfer?.getData('text/plain') || '');
      if ((!payload.id || !payload.type) && raw) {
        try { payload = JSON.parse(raw); } catch (_error) {}
      }
      if (!targetKey || !payload?.id || !payload?.type) return;
      if (payload.type === 'loop' && payload.groupKey !== targetKey) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      const targetType = targetLoopId ? 'loop' : 'group';
      const targetId = targetLoopId || targetKey;
      if (payload.id === targetId && payload.type === targetType) {
        updateUtilityLoopDropState('', '', '');
        return;
      }
      updateUtilityLoopDropState(targetType, targetId, getUtilityLoopDropPosition(button, event.clientY), targetKey);
    });
    button.addEventListener('drop', async (event) => {
      event.preventDefault();
      const targetKey = String(button.getAttribute('data-utility-loop-group-key') || '');
      const targetLoopId = String(button.getAttribute('data-utility-loop-id') || '');
      let payload = { type: state.utility.loopDragType, id: state.utility.loopDragId, groupKey: state.utility.loopDragGroupKey };
      const raw = String(event.dataTransfer?.getData('text/plain') || '');
      if ((!payload.id || !payload.type) && raw) {
        try { payload = JSON.parse(raw); } catch (_error) {}
      }
      if (!payload?.id || !payload?.type || !targetKey) return;
      if (payload.type === 'loop' && payload.groupKey !== targetKey) return;
      const targetType = targetLoopId ? 'loop' : 'group';
      const targetId = targetLoopId || targetKey;
      const position = state.utility.loopDropTargetId === targetId && state.utility.loopDropPosition
        ? state.utility.loopDropPosition
        : getUtilityLoopDropPosition(button, event.clientY);
      state.utility.loopSuppressClick = true;
      clearUtilityLoopDragState();
      syncUtilityLoopDragUi();
      await reorderUtilityLoops(payload, { type: targetType, id: targetId, groupKey: targetKey }, position);
      scheduleBrowserTimeout(() => {
        state.utility.loopSuppressClick = false;
      }, 0);
    });
    button.addEventListener('dragend', () => {
      clearUtilityLoopDragState();
      syncUtilityLoopDragUi();
    });
  });
}

function renderUtilityLoops() {
  const els = getUtilityModalElements();
  if (!els.overlay || !els.list || !els.detail || !els.count) return;
  els.detail.classList.add('is-loop-detail');
  const loops = state.utility.loops || [];
  if (els.sidebarLabel) els.sidebarLabel.textContent = 'Loops';
  els.count.textContent = String(loops.length);
  if (els.search) {
    els.search.value = '';
    els.search.disabled = true;
    els.search.placeholder = 'Saved loops';
  }
  if (els.problemFilterButton) {
    els.problemFilterButton.disabled = true;
    els.problemFilterButton.hidden = true;
  }
  if (els.problemFilterMenu) els.problemFilterMenu.hidden = true;
  if (els.problemFilterChips) els.problemFilterChips.innerHTML = '';

  if (state.utility.loopsLoading) {
    els.list.innerHTML = '<div class="utility-empty-state compact">Loading loops...</div>';
    els.detail.innerHTML = '<div class="utility-empty-state">Loading loops...</div>';
    return;
  }

  if (!loops.length) {
    clearUtilityLoopDragState();
    els.list.innerHTML = '<div class="utility-empty-state compact">No saved loops yet.</div>';
    els.detail.innerHTML = '<div class="utility-empty-state">Create a loop from the bottom player and it will appear here.</div>';
    return;
  }

  const groupedLoops = groupUtilityLoops(loops);
  if (!state.utility.selectedLoopGroupKey || !groupedLoops.some((group) => String(group.key || '') === String(state.utility.selectedLoopGroupKey || ''))) {
    state.utility.selectedLoopGroupKey = String(groupedLoops[0]?.key || '');
  }
  if (!state.utility.selectedLoopId || !loops.some((item) => String(item.id || '') === String(state.utility.selectedLoopId))) {
    const defaultLoop = groupedLoops.find((group) => String(group.key || '') === String(state.utility.selectedLoopGroupKey || ''))?.loops?.[0] || loops[0];
    state.utility.selectedLoopId = String(defaultLoop?.id || '');
  }
  const selectedGroup = getSelectedUtilityLoopGroup();
  const selectedLoop = state.utility.selectedLoopDetailMode === 'loop' ? getSelectedUtilityLoop() : null;
  renderUtilityLoopList(els, loops);
  els.detail.innerHTML = buildUtilityLoopDetail(selectedGroup, selectedLoop);
  ((selectedLoop ? [selectedLoop] : selectedGroup?.loops) || []).forEach((loop) => initializeUtilityLoopPlayer(loop));
  updateUtilityLoopRepeatButton(String(state.utility.selectedLoopId || ''));
}

function renderUtilityAppearance() {
  const els = getUtilityModalElements();
  if (!els.overlay || !els.list || !els.detail || !els.count) return;
  if (els.sidebarLabel) els.sidebarLabel.textContent = 'Appearance';
  els.count.textContent = '5';
  if (els.search) {
    els.search.value = '';
    els.search.disabled = true;
    els.search.placeholder = 'Appearance';
  }
  if (els.problemFilterButton) {
    els.problemFilterButton.disabled = true;
    els.problemFilterButton.hidden = true;
  }
  if (els.problemFilterMenu) els.problemFilterMenu.hidden = true;
  if (els.problemFilterChips) els.problemFilterChips.innerHTML = '';
  const appearanceKeys = ['backgrounds', 'seekbar', 'selection-accent', 'alerts', 'album-page'];
  if (!appearanceKeys.includes(state.utility.appearanceKey)) state.utility.appearanceKey = 'backgrounds';
  const selectedKey = state.utility.appearanceKey;
  const navigationTree = typeof window !== 'undefined' ? window.NavigationTree : null;
  const labels = { backgrounds: 'Main elements', seekbar: 'Player & Seekbar', 'selection-accent': 'Selection & Hover', alerts: 'Alerts', 'album-page': 'Album page' };
  els.list.innerHTML = appearanceKeys.map(key => navigationTree?.renderItem
    ? navigationTree.renderItem({ key, label: labels[key], variant: 'panel', action: true, selected: selectedKey === key, attributes: { 'data-utility-appearance-key': key } })
    : buildUtilityAppearanceListItem(key, labels[key], '', selectedKey === key)).join('');
  if (selectedKey === 'backgrounds') {
    if (typeof window !== 'undefined') window.AlbumHavenSelectionAccent?.unmount?.();
    if (typeof mountBackgroundAppearanceEditor === 'function') mountBackgroundAppearanceEditor(els.detail);
  } else if (selectedKey === 'selection-accent') {
    const appearance = typeof window !== 'undefined' ? window.AlbumHavenAppearance?.instance : null;
    if (appearance?.mountSelectionAccent) appearance.mountSelectionAccent(els.detail);
    else els.detail.innerHTML = '<div class="utility-empty-state">Selection &amp; Hover could not be loaded. Reload this page to try again.</div>';
  } else if (selectedKey === 'alerts') {
    if (typeof window !== 'undefined') window.AlbumHavenSelectionAccent?.unmount?.();
    if (typeof mountAlertsAppearanceEditor === 'function') mountAlertsAppearanceEditor(els.detail);
  } else if (selectedKey === 'album-page') {
    if (typeof window !== 'undefined') window.AlbumHavenSelectionAccent?.unmount?.();
    if (typeof mountAlbumPageAppearanceEditor === 'function') mountAlbumPageAppearanceEditor(els.detail);
  } else {
    if (typeof unmountAppearanceEditors === 'function') unmountAppearanceEditors();
    els.detail.innerHTML = buildUtilityAppearanceDetail();
    if (typeof mountSeekbarAppearanceEditor === 'function') mountSeekbarAppearanceEditor(els.detail);
  }
}

function getSelectedUtilityIntegration() {
  return buildUtilityIntegrationItems().find((item) => String(item.key || '') === String(state.utility.selectedIntegrationKey || '')) || null;
}

function renderUtilityIntegrations() {
  const els = getUtilityModalElements();
  if (!els.overlay || !els.list || !els.detail || !els.count) return;
  const integrations = buildUtilityIntegrationItems();
  if (els.sidebarLabel) els.sidebarLabel.textContent = 'Integrations';
  els.count.textContent = String(integrations.length);
  if (els.search) {
    els.search.value = '';
    els.search.disabled = true;
    els.search.placeholder = 'Integrations';
  }
  if (els.problemFilterButton) {
    els.problemFilterButton.disabled = true;
    els.problemFilterButton.hidden = true;
  }
  if (els.problemFilterMenu) els.problemFilterMenu.hidden = true;
  if (els.problemFilterChips) els.problemFilterChips.innerHTML = '';

  if (state.utility.integrationsLoading) {
    els.list.innerHTML = '<div class="utility-empty-state compact">Loading integrations...</div>';
    els.detail.innerHTML = '<div class="utility-empty-state">Loading integrations...</div>';
    return;
  }
  if (!state.utility.selectedIntegrationKey || !integrations.some((item) => String(item.key || '') === String(state.utility.selectedIntegrationKey || ''))) {
    state.utility.selectedIntegrationKey = String(integrations[0].key || '');
  }
  const selected = getSelectedUtilityIntegration();
  els.list.innerHTML = integrations.map((item) => buildUtilityIntegrationListItem(item, String(item.key || '') === String(state.utility.selectedIntegrationKey || ''))).join('');
  els.detail.innerHTML = buildUtilityIntegrationDetail(selected);
}

function getSelectedUtilityLogHistoryItem() {
  return (state.utility.logHistory || []).find((item) => String(item.id || '') === String(state.utility.selectedLogHistoryId)) || null;
}

function renderUtilityLogHistory() {
  const els = getUtilityModalElements();
  if (!els.overlay || !els.list || !els.detail || !els.count) return;
  const items = state.utility.logHistory || [];
  if (els.sidebarLabel) els.sidebarLabel.textContent = 'History';
  els.count.textContent = String(items.length);
  if (els.search) {
    els.search.value = '';
    els.search.disabled = true;
    els.search.placeholder = 'Log history';
  }
  if (els.problemFilterButton) {
    els.problemFilterButton.disabled = true;
    els.problemFilterButton.hidden = true;
  }
  if (els.problemFilterMenu) els.problemFilterMenu.hidden = true;
  if (els.problemFilterChips) els.problemFilterChips.innerHTML = '';
  const storageStatus = state.utility.logHistoryStorageStatus || {};
  const storageMessage = String(storageStatus.message || '');
  const safeStorageMessage = typeof escapeHtml === 'function'
    ? escapeHtml(storageMessage)
    : storageMessage;
  const storageWarning = storageStatus.persistent === false
    ? `<div class="utility-empty-state compact">${safeStorageMessage || 'History is session-only and will be lost on reload.'}</div>`
    : '';

  if (state.utility.logHistoryLoading) {
    els.list.innerHTML = '<div class="utility-empty-state compact">Loading history...</div>';
    els.detail.innerHTML = '<div class="utility-empty-state">Loading history...</div>';
    return;
  }
  if (!items.length) {
    els.list.innerHTML = '<div class="utility-empty-state compact">No history yet.</div>';
    els.detail.innerHTML = `
      <div class="utility-empty-state">Important scan, file, edit, and repair activity—including errors—will appear here.</div>
      ${storageWarning}
      <div class="confirm-modal-actions">
        <button class="button button-secondary" type="button" data-export-log-history="1">Export Logs</button>
      </div>
    `;
    return;
  }
  if (!state.utility.selectedLogHistoryId || !items.some((item) => String(item.id || '') === String(state.utility.selectedLogHistoryId))) {
    state.utility.selectedLogHistoryId = String(items[0].id || '');
  }
  const selectedItem = getSelectedUtilityLogHistoryItem();
  els.list.innerHTML = items.map((item) => buildUtilityLogHistoryListItem(item, String(item.id || '') === String(state.utility.selectedLogHistoryId))).join('');
  els.detail.innerHTML = `${storageWarning}${buildUtilityLogHistoryDetail(selectedItem)}`;
}

function renderUtilityModalContent() {
  const els = getUtilityModalElements();
  const activeTab = state.utility.activeTab || 'problematic-files';
  if (activeTab !== 'appearance' && typeof unmountAppearanceEditors === 'function') unmountAppearanceEditors();
  els.overlay?.setAttribute('data-active-tab', activeTab);
  els.detail?.classList.remove('is-loop-detail');
  els.tabs.forEach((tab) => {
    const selected = tab.getAttribute('data-utility-tab') === activeTab;
    tab.classList.toggle('is-active', selected);
    tab.setAttribute('aria-selected', selected ? 'true' : 'false');
  });
  if (activeTab === 'rules') {
    renderUtilityRules();
  } else if (activeTab === 'loops') {
    renderUtilityLoops();
  } else if (activeTab === 'log-history') {
    renderUtilityLogHistory();
  } else if (activeTab === 'integrations') {
    renderUtilityIntegrations();
  } else if (activeTab === 'appearance') {
    renderUtilityAppearance();
  } else {
    renderProblematicFiles();
  }
}

