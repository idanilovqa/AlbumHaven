// Native form retains focus and dismissal; shared presenter owns only sheet gestures.
export function mountWeeklyGoalsSheet(host, runtime, {isCurrent, onClose}) {
  const doc = host.ownerDocument, win = doc.defaultView;
  const overlay = host.closest('#app-form-modal'), panel = host.closest('.confirm-modal-dialog');
  if (!overlay || !panel || !win.AlbumHavenBottomSheet || !win.matchMedia) return {dispose() {}};
  const media = win.matchMedia('(max-width: 720px)');
  const handle = doc.createElement('div'); handle.className = 'album-sheet-handle'; handle.hidden = true;
  handle.setAttribute('aria-hidden', 'true'); handle.append(doc.createElement('span'));
  const toggleHost = doc.createElement('span'); toggleHost.className = 'weekly-goals-sheet-toggle';
  // Keep keyboard controls inside the native form's existing focus scope.
  toggleHost.innerHTML = runtime.actionHtml({ariaLabel: 'Expand Weekly Goals settings', icon: 'expand', presentation: 'bare'});
  const toggle = toggleHost.firstElementChild; toggle.hidden = true;
  panel.prepend(handle); host.prepend(toggleHost);
  let presenter, disposed = false;
  const current = () => !disposed && isCurrent() && host.isConnected;
  const foreground = () => current() && !overlay.hidden && !overlay.closest('[inert]')
    && (typeof win.getTopmostOpenModal !== 'function' || win.getTopmostOpenModal() === overlay);
  function clear() {presenter?.dispose(); presenter = null; overlay.classList.remove('is-native-bottom-sheet'); if (!handle.hidden) handle.hidden = true; if (!toggle.hidden) toggle.hidden = true;}
  function sync() {
    if (!current() || !media.matches) {clear(); return;}
    if (!presenter) {
      overlay.classList.add('is-native-bottom-sheet');
      presenter = win.AlbumHavenBottomSheet.mount({overlay, panel, handle, toggle, scroller: host,
        readBounds: () => ({header: doc.querySelector('#mobile-page-header:not([hidden])')}), isCurrent: current, foreground,
        requestClose: reason => current() ? onClose({reason}) : false,
        ownDismissal: false, ownFocus: false,
        expandLabel: 'Expand Weekly Goals settings', collapseLabel: 'Collapse Weekly Goals settings'});
    }
    presenter.suspend(!foreground());
  }
  const observer = typeof win.MutationObserver === 'function' ? new win.MutationObserver(sync) : null;
  observer?.observe(overlay, {attributes: true, subtree: true, attributeFilter: ['hidden', 'inert']});
  media.addEventListener('change', sync); sync();
  return {dispose() {if (disposed) return; disposed = true; observer?.disconnect(); media.removeEventListener('change', sync); clear(); handle.remove(); toggleHost.remove();}};
}
