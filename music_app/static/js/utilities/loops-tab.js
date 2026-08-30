function clearUtilityLoopDragState() {
  state.utility.loopDragId = '';
  state.utility.loopDropTargetId = '';
  state.utility.loopDropPosition = '';
}

function syncUtilityLoopDragUi() {
  document.querySelectorAll('[data-utility-loop-id]').forEach((button) => {
    const buttonLoopId = String(button.getAttribute('data-utility-loop-id') || '');
    button.classList.toggle('is-dragging', buttonLoopId && buttonLoopId === String(state.utility.loopDragId || ''));
    button.classList.toggle(
      'is-drop-before',
      buttonLoopId && buttonLoopId === String(state.utility.loopDropTargetId || '') && state.utility.loopDropPosition === 'before',
    );
    button.classList.toggle(
      'is-drop-after',
      buttonLoopId && buttonLoopId === String(state.utility.loopDropTargetId || '') && state.utility.loopDropPosition === 'after',
    );
  });
}

function updateUtilityLoopDropState(targetId, position) {
  state.utility.loopDropTargetId = String(targetId || '');
  state.utility.loopDropPosition = position === 'after' ? 'after' : position === 'before' ? 'before' : '';
  syncUtilityLoopDragUi();
}

function getUtilityLoopDropPosition(button, clientY) {
  const rect = button.getBoundingClientRect();
  return clientY < rect.top + (rect.height / 2) ? 'before' : 'after';
}

function renderUtilityLoopList(els, loops) {
  els.list.innerHTML = loops.map((loop) => buildUtilityLoopListItem(loop, String(loop.id || '') === String(state.utility.selectedLoopId))).join('');
  bindUtilityLoopDragAndDrop();
  syncUtilityLoopDragUi();
}

function bindUtilityLoopDragAndDrop() {
  document.querySelectorAll('[data-utility-loop-id]').forEach((button) => {
    if (button.dataset.dragBound === '1') return;
    button.dataset.dragBound = '1';
    button.addEventListener('dragstart', (event) => {
      const loopId = String(button.getAttribute('data-utility-loop-id') || '');
      if (!loopId) {
        event.preventDefault();
        return;
      }
      state.utility.loopDragId = loopId;
      state.utility.loopSuppressClick = false;
      updateUtilityLoopDropState('', '');
      syncUtilityLoopDragUi();
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', loopId);
      }
    });
    button.addEventListener('dragover', (event) => {
      const targetId = String(button.getAttribute('data-utility-loop-id') || '');
      const draggedId = String(state.utility.loopDragId || event.dataTransfer?.getData('text/plain') || '');
      if (!targetId || !draggedId) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      if (draggedId === targetId) {
        updateUtilityLoopDropState('', '');
        return;
      }
      updateUtilityLoopDropState(targetId, getUtilityLoopDropPosition(button, event.clientY));
    });
    button.addEventListener('drop', async (event) => {
      event.preventDefault();
      const targetId = String(button.getAttribute('data-utility-loop-id') || '');
      const draggedId = String(state.utility.loopDragId || event.dataTransfer?.getData('text/plain') || '');
      const position = state.utility.loopDropTargetId === targetId && state.utility.loopDropPosition
        ? state.utility.loopDropPosition
        : getUtilityLoopDropPosition(button, event.clientY);
      state.utility.loopSuppressClick = true;
      clearUtilityLoopDragState();
      syncUtilityLoopDragUi();
      await reorderUtilityLoops(draggedId, targetId, position);
      window.setTimeout(() => {
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
  const loops = state.utility.loops || [];
  if (els.sidebarLabel) els.sidebarLabel.textContent = 'Loops';
  els.count.textContent = String(loops.length);
  setUtilitySearchState({ enabled: false, placeholder: 'Saved loops', value: '' });
  setUtilityProblemFilterState({ enabled: false, hidden: true, chipsHtml: '' });

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

  if (!state.utility.selectedLoopId || !loops.some((item) => String(item.id || '') === String(state.utility.selectedLoopId))) {
    state.utility.selectedLoopId = String(loops[0].id || '');
  }
  const selectedLoop = getSelectedUtilityLoop();
  renderUtilityLoopList(els, loops);
  els.detail.innerHTML = buildUtilityLoopDetail(selectedLoop);
  initializeUtilityLoopPlayer(selectedLoop);
}

async function loadUtilityLoops(force = false) {
  if (state.utility.loopsLoading) return state.utility.loopsLoadPromise;
  if (state.utility.loopsLoaded && !force) {
    renderUtilityModalContent();
    return null;
  }
  state.utility.loopsLoading = true;
  renderUtilityModalContent();
  state.utility.loopsLoadPromise = (async () => {
    try {
      const response = await fetch('/utilities/loops', { headers: { Accept: 'application/json' } });
      const data = await response.json();
      state.utility.loops = Array.isArray(data.loops) ? data.loops : [];
      state.utility.loopsLoaded = true;
    } catch (error) {
      console.error('[AlbumHaven][Loops] Failed to load loops.', error);
      state.utility.loops = [];
      showToast('Unable to load saved loops.', 'error', 3200);
    } finally {
      state.utility.loopsLoading = false;
      state.utility.loopsLoadPromise = null;
      renderUtilityModalContent();
    }
  })();
  return state.utility.loopsLoadPromise;
}

function handleLoopsUtilityClick(event) {
  const utilityLoopButton = event.target.closest('[data-utility-loop-id]');
  if (utilityLoopButton) {
    event.preventDefault();
    if (state.utility.loopSuppressClick) {
      state.utility.loopSuppressClick = false;
      return true;
    }
    state.utility.selectedLoopId = utilityLoopButton.getAttribute('data-utility-loop-id') || '';
    renderUtilityModalContent();
    return true;
  }

  const utilityLoopRepeatButton = event.target.closest('[data-toggle-loop-repeat]');
  if (utilityLoopRepeatButton) {
    event.preventDefault();
    const loopId = utilityLoopRepeatButton.getAttribute('data-toggle-loop-repeat') || '';
    if (loopId && String(state.utility.selectedLoopId || '') !== String(loopId)) {
      state.utility.selectedLoopId = loopId;
    }
    state.utility.loopRepeatEnabled = !state.utility.loopRepeatEnabled;
    updateUtilityLoopRepeatButton(loopId);
    return true;
  }

  const utilityLoopSpeedValueButton = event.target.closest('[data-loop-speed-value-button]');
  if (utilityLoopSpeedValueButton) {
    event.preventDefault();
    const loopId = utilityLoopSpeedValueButton.getAttribute('data-loop-speed-value-button') || '';
    const menu = document.querySelector(`[data-loop-speed-menu="${cssEscape(loopId)}"]`);
    if (menu) {
      updateUtilityLoopAudioRate(loopId);
      const willOpen = menu.hidden;
      document.querySelectorAll('.utility-loop-speed-menu').forEach((item) => {
        item.hidden = true;
        item.style.visibility = '';
      });
      menu.hidden = !willOpen;
      if (willOpen) positionUtilityLoopSpeedMenu(loopId);
    }
    return true;
  }

  const utilityLoopSpeedStepButton = event.target.closest('[data-loop-speed-step]');
  if (utilityLoopSpeedStepButton) {
    event.preventDefault();
    const control = utilityLoopSpeedStepButton.closest('[data-loop-speed-control]');
    const loopId = control?.getAttribute('data-loop-speed-control') || '';
    const audio = document.querySelector(`[data-loop-audio="${cssEscape(loopId)}"]`);
    if (audio) {
      const current = Number(audio.dataset.speed || '1') || 1;
      const delta = Number(utilityLoopSpeedStepButton.getAttribute('data-loop-speed-step') || 0) || 0;
      const next = Math.max(0.25, Math.min(2, Math.round((current + delta) * 20) / 20));
      audio.dataset.speed = String(next);
      updateUtilityLoopAudioRate(loopId);
    }
    return true;
  }

  const utilityLoopSpeedOptionButton = event.target.closest('[data-loop-speed-option]');
  if (utilityLoopSpeedOptionButton) {
    event.preventDefault();
    const menu = utilityLoopSpeedOptionButton.closest('[data-loop-speed-menu]');
    const loopId = menu?.getAttribute('data-loop-speed-menu') || '';
    const audio = document.querySelector(`[data-loop-audio="${cssEscape(loopId)}"]`);
    if (audio) {
      const next = Math.max(0.25, Math.min(1.5, Math.round((Number(utilityLoopSpeedOptionButton.getAttribute('data-loop-speed-option') || 1) || 1) * 4) / 4));
      audio.dataset.speed = String(next);
      updateUtilityLoopAudioRate(loopId);
    }
    if (menu) menu.hidden = true;
    return true;
  }

  const utilityLoopPitchButton = event.target.closest('[data-loop-pitch-step]');
  if (utilityLoopPitchButton) {
    event.preventDefault();
    const control = utilityLoopPitchButton.closest('[data-loop-pitch-control]');
    const loopId = control?.getAttribute('data-loop-pitch-control') || '';
    const audio = document.querySelector(`[data-loop-audio="${cssEscape(loopId)}"]`);
    if (audio) {
      const next = Math.max(-12, Math.min(12, (Number(audio.dataset.pitch || '0') || 0) + Number(utilityLoopPitchButton.getAttribute('data-loop-pitch-step') || 0)));
      renderUtilityLoopPitchPreview(loopId, next);
    }
    return true;
  }

  const createLoopFromSavedButton = event.target.closest('[data-create-loop-from-saved]');
  if (createLoopFromSavedButton) {
    event.preventDefault();
    createLoopFromSavedLoop(createLoopFromSavedButton.getAttribute('data-create-loop-from-saved') || '');
    return true;
  }

  const deleteSavedLoopButton = event.target.closest('[data-delete-saved-loop]');
  if (deleteSavedLoopButton) {
    event.preventDefault();
    deleteSavedLoop(deleteSavedLoopButton.getAttribute('data-delete-saved-loop') || '');
    return true;
  }

  return false;
}

registerUtilityTab('loops', {
  render: renderUtilityLoops,
  load: loadUtilityLoops,
  shouldLoadOnActivate() {
    return !state.utility.loopsLoaded;
  },
  handleClick: handleLoopsUtilityClick,
});
