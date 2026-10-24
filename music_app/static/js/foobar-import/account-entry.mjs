import {mountFoobarImport} from './index.mjs';

// This account-only page shares the native component with Settings. It never
// starts the library bootstrap, changes shell policy, or fabricates authority.
const contextRoot = document.getElementById('account-foobar');
const target = contextRoot?.querySelector('[data-foobar-import-host]');
if (contextRoot && target) {
  const marker = contextRoot.dataset.accountFoobarContext;
  const scope = contextRoot.dataset.accountFoobarScope;
  const matchingLibraryId = contextRoot.dataset.accountFoobarMatchingLibraryId;
  let retired = false, mounted = null;
  const isCurrent = () => !retired && contextRoot.isConnected && target.isConnected
    && document.getElementById('account-foobar') === contextRoot
    && contextRoot.contains(target)
    && contextRoot.dataset.accountFoobarContext === marker
    && contextRoot.dataset.accountFoobarScope === scope
    && contextRoot.dataset.accountFoobarMatchingLibraryId === matchingLibraryId;
  const allows = action => isCurrent() && action === 'account.self.foobar.write'
    && contextRoot.dataset.accountFoobarAllowed === 'true';
  const observer = new MutationObserver(records => {
    if (records.some(record => record.type === 'attributes') || !isCurrent()) retire();
  });
  function retire() {
    if (retired) return;
    retired = true;
    observer.disconnect();
    window.removeEventListener('pagehide', retire);
    try { mounted?.dispose(); } catch { /* This retired host cannot publish again. */ }
    mounted = null;
    // A restored document must not silently reuse an old account/session owner.
    if (target.isConnected) {
      target.replaceChildren();
      const message = document.createElement('p');
      message.setAttribute('role', 'status');
      message.textContent = 'Foobar settings were closed. Reload this page to reopen them.';
      target.append(message);
    }
  }
  observer.observe(contextRoot, {attributes: true, childList: true,
    attributeFilter: ['data-account-foobar-context', 'data-account-foobar-scope',
      'data-account-foobar-allowed', 'data-account-foobar-matching-library-id']});
  if (contextRoot.parentNode) observer.observe(contextRoot.parentNode, {childList: true});
  window.addEventListener('pagehide', retire);
  try {
    if (!/^[a-f0-9]{64}$/.test(marker || '') || scope !== 'account-foobar-v1'
        || !allows('account.self.foobar.write')) throw new Error('Unavailable context.');
    mounted = mountFoobarImport(target, {
      fetch: (...args) => window.fetch(...args), contextRoot, allows, isCurrent,
      renderButton: options => window.ButtonComponent.renderButton(options),
      renderTable: options => window.buildCompactDataTable(options),
    });
    if (!mounted || typeof mounted.dispose !== 'function') throw new Error('Unavailable component.');
    if (!isCurrent()) retire();
  } catch {
    retire();
    if (target.isConnected) target.textContent = 'Foobar import controls are unavailable. Check the status of any import already submitted.';
  }
}
