function renderUtilityAppearance() {
  const els = getUtilityModalElements();
  if (!els.overlay || !els.list || !els.detail || !els.count) return;
  if (els.sidebarLabel) els.sidebarLabel.textContent = 'Appearance';
  els.count.textContent = '1';
  setUtilitySearchState({ enabled: false, placeholder: 'Appearance', value: '' });
  setUtilityProblemFilterState({ enabled: false, hidden: true, chipsHtml: '' });
  state.utility.appearanceKey = 'seekbar';
  els.list.innerHTML = buildUtilityAppearanceListItem('seekbar', 'Seekbar', 'Default or waveform appearance', true);
  els.detail.innerHTML = buildUtilityAppearanceDetail();
}

function handleAppearanceUtilityClick(event) {
  const utilityAppearanceButton = event.target.closest('[data-utility-appearance-key]');
  if (utilityAppearanceButton) {
    event.preventDefault();
    state.utility.appearanceKey = utilityAppearanceButton.getAttribute('data-utility-appearance-key') || 'seekbar';
    renderUtilityModalContent();
    return true;
  }

  const appearanceModeRadio = event.target.closest('[data-appearance-seekbar-mode]');
  if (appearanceModeRadio) {
    state.player.appearance = normalizePlayerAppearance({
      ...state.player.appearance,
      seekbarMode: appearanceModeRadio.getAttribute('data-appearance-seekbar-mode') || 'default',
    });
    persistPlayerAppearance();
    updateWaveformAppearance(true);
    renderUtilityModalContent();
    return true;
  }

  return false;
}

function handleAppearanceUtilityInput(event) {
  const appearanceColor = event.target.closest('[data-appearance-color]');
  if (!appearanceColor) return false;
  const color = String(appearanceColor.value || '');
  if (/^#[0-9a-f]{6}$/i.test(color)) {
    const field = appearanceColor.getAttribute('data-appearance-color') || 'fill';
    state.player.appearance = normalizePlayerAppearance({
      ...state.player.appearance,
      waveformFillColor: field === 'fill' ? color : state.player.appearance.waveformFillColor,
      waveformEdgeColor: field === 'edge' ? color : state.player.appearance.waveformEdgeColor,
    });
    persistPlayerAppearance();
    updateWaveformAppearance();
  }
  return true;
}

registerUtilityTab('appearance', {
  render: renderUtilityAppearance,
  handleClick: handleAppearanceUtilityClick,
  handleInput: handleAppearanceUtilityInput,
});
