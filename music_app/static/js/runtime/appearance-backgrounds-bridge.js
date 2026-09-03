// Utilities owns navigation; the standalone module owns the account draft/editor.
function getBackgroundAppearanceEditor() {
  return typeof window !== 'undefined' ? window.AlbumHavenAppearance?.instance : null;
}
function confirmBackgroundAppearanceLeave() {
  return getBackgroundAppearanceEditor()?.allowLeave(message => showBrowserConfirm(message)) !== false;
}
function unmountAppearanceEditors() {
  getBackgroundAppearanceEditor()?.unmount();
  if (typeof window !== 'undefined') window.AlbumHavenSelectionAccent?.unmount?.();
}
function mountBackgroundAppearanceEditor(detail) {
  const editor = getBackgroundAppearanceEditor();
  if (editor) editor.mount(detail);
  else detail.innerHTML = '<div class="utility-empty-state">Backgrounds could not be loaded. Reload this page to try again.</div>';
}

// Live canvases consume only the account's applied state, never the editor draft.
function getSavedAppearancePlayerColors() {
  return typeof window !== 'undefined' ? window.AlbumHavenAppearance?.getSavedPlayerColors?.() || null : null;
}
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('album-haven-appearance-change', () => {
    if (typeof updateWaveformAppearance === 'function') updateWaveformAppearance();
  });
}

// Read the existing browser preference only when the owner asks to recover it.
// Normalized runtime defaults are not evidence that earlier colors were stored.
function getPreviousBrowserWaveformColors() {
  if (typeof getLocalStorageItem !== 'function' || typeof PLAYER_APPEARANCE_STORAGE_KEY === 'undefined') return null;
  try {
    const raw = getLocalStorageItem(PLAYER_APPEARANCE_STORAGE_KEY);
    if (!raw) return null;
    const previous = JSON.parse(raw);
    if (!previous || typeof previous !== 'object' || Array.isArray(previous)) return null;
    const colors = [previous.waveformFillColor, previous.waveformEdgeColor];
    if (!colors.every(color => typeof color === 'string' && color.length === 7 && /^#[0-9a-f]{6}$/i.test(color))) return null;
    return { fill: colors[0].toUpperCase(), edge: colors[1].toUpperCase() };
  } catch (_failure) { return null; }
}
function mountSeekbarAppearanceEditor(detail) {
  const host = detail.querySelector('[data-appearance-seekbar-editor]');
  if (!host) return;
  const editor = getBackgroundAppearanceEditor();
  if (editor?.mountSeekbar) editor.mountSeekbar(host, { getLegacyColors: getPreviousBrowserWaveformColors });
  else host.innerHTML = '<div class="utility-empty-state">Waveform colors could not be loaded. Reload this page to try again.</div>';
}
