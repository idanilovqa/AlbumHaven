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
