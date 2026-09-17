const problematicNavigationRowContent = new WeakMap();

function renderProblematicFiles({ preserveProblematicTree = false } = {}) {
  const els = getUtilityModalElements();
  if (!els.overlay || !els.list || !els.detail || !els.count) return;

  const mountedRows = preserveProblematicTree
    ? Array.from(els.list.querySelectorAll?.('[data-problematic-album-key]') || []) : [];
  const albumsByKey = new Map((state.utility.problematicFiles || []).map(album => [String(album.key), album]));
  const mountedItems = mountedRows.map(row => albumsByKey.get(row.getAttribute('data-problematic-album-key')));
  const retainTree = mountedRows.length > 0 && mountedItems.every(Boolean);
  const items = retainTree ? mountedItems : getFilteredProblematicAlbums();
  const operationalItems = Array.isArray(state.utility.libraryWatchHealthProblems)
    ? state.utility.libraryWatchHealthProblems
    : [];
  const operationalHtml = operationalItems
    .map((problem) => buildLibraryWatchHealthProblemRow(problem))
    .join('');
  const renderTree = selectedKey => {
    if (!retainTree) {
      els.list.innerHTML = operationalHtml + items.map(album => buildProblematicAlbumListItem(album, album.key === selectedKey)).join('');
    }
    Array.from(els.list.querySelectorAll?.('[data-problematic-album-key]') || []).forEach(row => {
      const album = albumsByKey.get(row.getAttribute('data-problematic-album-key'));
      if (!album) return;
      const selected = album.key === selectedKey;
      const content = getProblematicAlbumNavigationOptions(album, selected);
      if (retainTree) {
        const previous = problematicNavigationRowContent.get(row);
        window.NavigationTree.updateItem(row, {
          ...content,
          artworkHtml: previous && previous.artworkSource === content.artworkSource ? undefined : content.artworkHtml,
        });
        window.NavigationTree.setItemSelected(row, selected);
      }
      problematicNavigationRowContent.set(row, content);
    });
  };
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
    els.list.innerHTML = `${operationalHtml}<div class="utility-empty-state compact">Loading...</div>`;
    els.detail.innerHTML = '<div class="utility-empty-state">Loading problematic albums...</div>';
    return;
  }

  if (!items.length) {
    els.list.innerHTML = `${operationalHtml}<div class="utility-empty-state compact">No matching problematic albums found.</div>`;
    els.detail.innerHTML = '<div class="utility-empty-state">No matching problematic albums found.</div>';
    return;
  }

  const selectedProblematicMissing = !state.utility.selectedProblematicKey
    || !items.some((item) => item.key === state.utility.selectedProblematicKey);
  if (selectedProblematicMissing && state.utility.deferProblematicAutoSelection && (state.utility.selectedProblemFilters || []).length) {
    renderTree('');
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
  renderTree(state.utility.selectedProblematicKey);
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
    const activeAlbumRow = els.list.querySelector?.('.utility-list-item.is-active');
    activeAlbumRow?.scrollIntoView?.({ block: 'nearest' });
    if (activeAlbumRow?.getBoundingClientRect && els.list.getBoundingClientRect) {
      const listRect = els.list.getBoundingClientRect();
      const activeAlbumRect = activeAlbumRow.getBoundingClientRect();
      if (activeAlbumRect.bottom > listRect.bottom) {
        els.list.scrollTop += Math.ceil(activeAlbumRect.bottom - listRect.bottom);
      } else if (activeAlbumRect.top < listRect.top) {
        els.list.scrollTop -= Math.ceil(listRect.top - activeAlbumRect.top);
      }
    }
    const focusedTrackSelector = `[data-problematic-track-path="${cssEscape(state.utility.focusedTrackPath)}"]`;
    const focusedTrackMatch = els.detail.querySelector?.(focusedTrackSelector);
    const focusedTrackRow = focusedTrackMatch?.closest?.('[role="row"]') || focusedTrackMatch;
    if (focusedTrackRow?.getBoundingClientRect && els.detail.getBoundingClientRect) {
      const detailRect = els.detail.getBoundingClientRect();
      const focusedTrackRect = focusedTrackRow.getBoundingClientRect();
      if (focusedTrackRect.bottom > detailRect.bottom) {
        els.detail.scrollTop += Math.ceil(focusedTrackRect.bottom - detailRect.bottom);
      } else if (focusedTrackRect.top < detailRect.top) {
        els.detail.scrollTop -= Math.ceil(detailRect.top - focusedTrackRect.top);
      }
    }
    if (focusedTrackRow) state.utility.focusedTrackPath = '';
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
    els.search.value = state.utility.rulesSearchQuery || '';
    els.search.disabled = false;
    els.search.placeholder = 'Filter album, filename, or reason';
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
  document.querySelectorAll('[data-utility-loop-entry], [data-utility-loop-id]').forEach(node => {
    const id = getUtilityLoopNodeId(node);
    const dragging = id && id === state.utility.loopDragId;
    const dropping = id && id === state.utility.loopDropTargetId;
    node.classList.toggle('is-dragging', Boolean(dragging));
    node.classList.toggle('is-drop-before', Boolean(dropping && state.utility.loopDropPosition === 'before'));
    node.classList.toggle('is-drop-after', Boolean(dropping && state.utility.loopDropPosition === 'after'));
  });
}

function getUtilityLoopNodeId(node) {
  return String(node?.getAttribute('data-utility-loop-entry') || node?.getAttribute('data-utility-loop-id') || '');
}

function syncUtilityLoopMoveButtons() {
  document.querySelectorAll('[data-move-utility-loop]').forEach(button => {
    const id = button.getAttribute('data-move-utility-loop');
    const loop = (state.utility.loops || []).find(item => String(item.id) === id);
    const scope = loop && getUtilityLoopOrderScope(loop.song_key);
    const index = scope?.loops.findIndex(item => String(item.id) === id) ?? -1;
    const direction = button.getAttribute('data-loop-move-direction');
    const unavailable = !scope || Boolean(state.utility.loopOrderPending?.[loop.song_key])
      || (direction === 'up' ? index <= 0 : index >= scope.loops.length - 1);
    button.setAttribute('aria-disabled', String(unavailable));
    // Keep the focused control in the tab order across an optimistic boundary move.
    button.dataset.moveUnavailable = String(unavailable);
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
  )).join('') || '<div class="utility-empty-state compact">No matching loops.</div>';
  bindUtilityLoopDragAndDrop();
  syncUtilityLoopDragUi();
}

function bindUtilityLoopDragAndDrop() {
  const clear = () => { clearUtilityLoopDragState(); syncUtilityLoopDragUi(); };
  const payload = () => ({ type: state.utility.loopDragType, id: state.utility.loopDragId, groupKey: state.utility.loopDragGroupKey });
  document.querySelectorAll('[data-utility-loop-entry], [data-utility-loop-id]').forEach(node => {
    const currentLoop = () => (state.utility.loops || []).find(loop => String(loop.id) === getUtilityLoopNodeId(node));
    node.setAttribute('draggable', String(canReorderUtilityLoop(currentLoop())));
    if (node.dataset.dragBound === '1') return;
    node.dataset.dragBound = '1';
    const target = () => ({ type: 'loop', id: getUtilityLoopNodeId(node), groupKey: currentLoop()?.song_key });
    node.addEventListener('dragstart', event => {
      const loop = currentLoop();
      if (!canReorderUtilityLoop(loop) || state.utility.loopOrderPending?.[loop.song_key]
          || event.target?.closest?.('button, input, select, textarea, a, [data-loop-range-surface]')) {
        event.preventDefault(); clear(); return;
      }
      state.utility.loopDragType = 'loop'; state.utility.loopDragId = String(loop.id);
      state.utility.loopDragGroupKey = loop.song_key;
      state.utility.loopSuppressClick = false;
      updateUtilityLoopDropState('', '', '');
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', JSON.stringify(payload()));
      }
    });
    node.addEventListener('dragover', event => {
      const position = getUtilityLoopDropPosition(node, event.clientY);
      if (!buildReorderedUtilityLoops(state.utility.loops, payload(), target(), position)) {
        updateUtilityLoopDropState('', '', ''); return;
      }
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      updateUtilityLoopDropState('loop', getUtilityLoopNodeId(node), position, currentLoop().song_key);
    });
    node.addEventListener('dragleave', event => {
      if (!event.relatedTarget || !node.contains(event.relatedTarget)) updateUtilityLoopDropState('', '', '');
    });
    node.addEventListener('drop', async event => {
      event.preventDefault(); event.stopPropagation?.();
      const source = payload(); const destination = target();
      const position = getUtilityLoopDropPosition(node, event.clientY);
      clear();
      state.utility.loopSuppressClick = true;
      try { return await reorderUtilityLoops(source, destination, position); }
      finally { setTimeout(() => { state.utility.loopSuppressClick = false; }, 0); }
    });
    node.addEventListener('dragend', clear);
  });
  document.querySelectorAll('[data-move-utility-loop]').forEach(button => {
    if (button.dataset.moveBound === '1') return;
    button.dataset.moveBound = '1';
    button.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation?.();
      if (button.getAttribute('aria-disabled') === 'true') return false;
      return moveUtilityLoop(button.getAttribute('data-move-utility-loop'), button.getAttribute('data-loop-move-direction'));
    });
  });
  if (!state.utility.loopDragDismissBound) {
    state.utility.loopDragDismissBound = true;
    document.addEventListener('keydown', event => { if (event.key === 'Escape') clear(); });
    document.addEventListener('drop', clear);
    document.addEventListener('dragend', clear);
  }
  syncUtilityLoopMoveButtons();
}

function syncUtilityLoopPanelVisibility() {
  const visibleIds = new Set(getFilteredUtilityLoops().map(loop => String(loop.id)));
  const els = getUtilityModalElements();
  els.detail?.querySelectorAll('[data-utility-loop-entry]').forEach(panel => { panel.hidden = !visibleIds.has(getUtilityLoopNodeId(panel)); });
  const empty = visibleIds.size === 0;
  const groupDetail = els.detail?.querySelector('.utility-loop-group-detail');
  const panelList = els.detail?.querySelector('.utility-loop-entry-list');
  if (groupDetail) groupDetail.hidden = empty;
  if (panelList) panelList.hidden = empty;
  let message = els.detail?.querySelector('[data-loop-search-empty]');
  if (empty && !message && els.detail) {
    message = document.createElement('div');
    message.setAttribute('data-loop-search-empty', '1');
    message.setAttribute('class', 'utility-empty-state');
    message.textContent = 'No matching loops.';
    els.detail.appendChild(message);
  }
  if (message) message.hidden = !empty;
}

function filterUtilityLoopViews() {
  if (state.utility.activeTab !== 'loops') return;
  const els = getUtilityModalElements();
  const filtered = getFilteredUtilityLoops();
  if (els.count) els.count.textContent = String(filtered.length);
  if (filtered.length && !filtered.some(loop => buildUtilityLoopGroupKey(loop) === state.utility.selectedLoopGroupKey)) {
    state.utility.selectedLoopGroupKey = buildUtilityLoopGroupKey(filtered[0]);
    state.utility.selectedLoopId = String(filtered[0].id);
    renderUtilityLoops();
    return;
  }
  const scroll = els.list?.scrollTop;
  renderUtilityLoopList(els, filtered);
  if (els.list && Number.isFinite(scroll)) els.list.scrollTop = scroll;
  syncUtilityLoopPanelVisibility();
}

function renderUtilityLoops() {
  const els = getUtilityModalElements();
  if (!els.overlay || !els.list || !els.detail || !els.count) return;
  state.utility.loopViewGeneration = Number(state.utility.loopViewGeneration || 0) + 1;
  if (typeof disposeMountedLoopActions === 'function') disposeMountedLoopActions(els.detail);
  if (els.overlay.hidden) return;
  els.detail.classList.add('is-loop-detail');
  const loops = state.utility.loops || [];
  if (els.sidebarLabel) els.sidebarLabel.textContent = 'Loops';
  const filtered = getFilteredUtilityLoops();
  els.count.textContent = String(filtered.length);
  if (els.search) {
    els.search.value = state.utility.loopsSearchQuery || '';
    els.search.disabled = false;
    els.search.placeholder = 'Filter song, artist, album, or loop';
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

  const groupedLoops = groupUtilityLoops(filtered.length ? filtered : loops);
  if (!state.utility.selectedLoopGroupKey || !groupedLoops.some((group) => String(group.key || '') === String(state.utility.selectedLoopGroupKey || ''))) {
    state.utility.selectedLoopGroupKey = String(groupedLoops[0]?.key || '');
  }
  if (!state.utility.selectedLoopId || !loops.some((item) => String(item.id || '') === String(state.utility.selectedLoopId))) {
    const defaultLoop = groupedLoops.find((group) => String(group.key || '') === String(state.utility.selectedLoopGroupKey || ''))?.loops?.[0] || loops[0];
    state.utility.selectedLoopId = String(defaultLoop?.id || '');
  }
  const selectedGroup = getSelectedUtilityLoopGroup();
  state.utility.selectedLoopDetailMode = 'group';
  renderUtilityLoopList(els, getFilteredUtilityLoops());
  els.detail.innerHTML = buildUtilityLoopDetail(selectedGroup);
  (selectedGroup?.loops || []).forEach((loop) => initializeUtilityLoopPlayer(loop));
  bindUtilityLoopDragAndDrop();
  syncUtilityLoopPanelVisibility();
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

function renderUtilityModalContent(options = {}) {
  const els = getUtilityModalElements();
  const activeTab = state.utility.activeTab || 'problematic-files';
  if (activeTab !== 'loops' && typeof disposeMountedLoopActions === 'function') disposeMountedLoopActions(els.detail);
  if (activeTab !== 'appearance' && typeof unmountAppearanceEditors === 'function') unmountAppearanceEditors();
  els.overlay?.setAttribute('data-active-tab', activeTab);
  els.detail?.classList.remove('is-loop-detail');
  els.tabs.forEach((tab) => {
    const selected = tab.getAttribute('data-utility-tab') === activeTab;
    tab.classList.toggle('is-active', selected);
    tab.setAttribute('aria-selected', selected ? 'true' : 'false');
    tab.setAttribute('role', 'tab');
    tab.setAttribute('tabindex', selected ? '0' : '-1');
    tab.setAttribute('aria-controls', 'utility-problematic-detail');
  });
  const selectedTab = els.tabs.find(tab => tab.getAttribute('data-utility-tab') === activeTab);
  if (selectedTab?.id) {
    els.detail?.setAttribute('role', 'tabpanel');
    els.detail?.setAttribute('aria-labelledby', selectedTab.id);
  }
  syncUtilityTabAlignment(els);
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
    renderProblematicFiles(options);
  }
}

const utilityTabAlignmentObservers = new WeakMap();
function syncUtilityTabAlignment(els = getUtilityModalElements()) {
  const strip = els.overlay?.querySelector?.('.utility-modal-tabs');
  const header = els.overlay?.querySelector?.('.utility-modal-header');
  if (!strip || !header) return;
  const update = () => {
    const active = strip.querySelector('[aria-selected="true"]');
    if (!active || els.overlay.hidden) return;
    const outer = header.getBoundingClientRect();
    const rect = active.getBoundingClientRect();
    header.style.setProperty('--active-tab-left', `${Math.max(0, rect.left - outer.left)}px`);
    header.style.setProperty('--active-tab-right', `${Math.min(outer.width, rect.right - outer.left)}px`);
  };
  const revealAndUpdate = () => {
    const active = strip.querySelector('[aria-selected="true"]');
    if (active && !els.overlay.hidden && strip.getBoundingClientRect) {
      const visible = strip.getBoundingClientRect();
      const rect = active.getBoundingClientRect();
      const availableWidth = visible.right - visible.left;
      const delta = rect.right - rect.left > availableWidth || rect.left < visible.left
        ? rect.left - visible.left : rect.right > visible.right ? rect.right - visible.right : 0;
      if (delta) strip.scrollLeft += delta;
    }
    update();
  };
  revealAndUpdate();
  if (!utilityTabAlignmentObservers.has(strip)) {
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(revealAndUpdate) : null;
    observer?.observe(header);
    observer?.observe(strip);
    els.tabs.forEach(tab => observer?.observe(tab));
    strip.addEventListener('scroll', update, { passive: true });
    utilityTabAlignmentObservers.set(strip, { observer, update });
  }
}

function disposeUtilityTabAlignment(els = getUtilityModalElements()) {
  const strip = els.overlay?.querySelector?.('.utility-modal-tabs');
  if (!strip) return;
  const binding = utilityTabAlignmentObservers.get(strip);
  if (!binding) return;
  binding.observer?.disconnect();
  strip.removeEventListener('scroll', binding.update);
  utilityTabAlignmentObservers.delete(strip);
}

