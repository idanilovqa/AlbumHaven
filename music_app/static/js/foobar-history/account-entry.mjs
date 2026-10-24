import {createFoobarHistoryOwner} from './owner.mjs';
import {mountFoobarHistoryPanel} from './panel.mjs';

// Read-only account route. No library bootstrap or importer write owner is
// started here; the same panel is also mounted inside native Home.
const contextRoot = document.getElementById('account-foobar-history');
const host = contextRoot?.querySelector('[data-foobar-history-host]');
if (contextRoot && host) {
  let disposed = false, owner = null, view = null;
  const isCurrent = () => !disposed && contextRoot.isConnected && host.isConnected
    && document.getElementById('account-foobar-history') === contextRoot && contextRoot.contains(host);
  const allows = action => isCurrent() && action === 'account.self.foobar.read'
    && contextRoot.dataset.accountFoobarHistoryAllowed === 'true';
  const dispose = () => {
    if (disposed) return; disposed = true; window.removeEventListener('pagehide', dispose);
    try {view?.dispose();} finally {owner?.dispose();}
    if (host.isConnected) host.textContent = 'Foobar history was closed. Reload this page to read it again.';
  };
  try {
    owner = createFoobarHistoryOwner({fetch: (...args) => window.fetch(...args), contextRoot, allows, isCurrent});
    view = mountFoobarHistoryPanel(host, {buttonHtml: options => window.ButtonComponent.renderButton(options)}, {owner, isCurrent});
    window.addEventListener('pagehide', dispose);
    if (!isCurrent()) dispose();
  } catch {
    dispose(); if (host.isConnected) host.textContent = 'Foobar history is unavailable. Reload to try again.';
  }
}
