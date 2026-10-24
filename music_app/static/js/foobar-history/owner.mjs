import {createFoobarHistoryProvider} from './provider.mjs';
import {createFoobarHistoryController} from './controller.mjs';

// One account read owner can be borrowed by the Home tab or the account-only
// page. The marker is continuity, never a substitute for server authorization.
export function createFoobarHistoryOwner({fetch, contextRoot, allows, isCurrent}) {
  let disposed = false, observer = null;
  const document = contextRoot?.ownerDocument, window = document?.defaultView;
  let provider = null, controller = null;
  const retire = () => {if (!disposed) {provider?.retire(); controller?.retire();}};
  const current = () => {try {return !disposed && contextRoot?.isConnected === true && isCurrent() === true;} catch {return false;}};
  function dispose() {
    if (disposed) return; disposed = true; observer?.disconnect(); window?.removeEventListener('pagehide', retire);
    try {controller?.dispose();} finally {provider?.dispose();}
  }
  try {
    provider = createFoobarHistoryProvider({fetch, contextRoot, allows, isCurrent: current});
    controller = createFoobarHistoryController({provider});
    if (typeof window?.MutationObserver === 'function') {
      observer = new window.MutationObserver(records => {
        if (records.some(record => record.type === 'attributes') || !current()) retire();
      });
      observer.observe(contextRoot, {attributes: true, attributeFilter: ['data-account-foobar-context', 'data-account-foobar-scope', 'data-account-foobar-history-allowed']});
      if (contextRoot.parentNode) observer.observe(contextRoot.parentNode, {childList: true});
    }
    window?.addEventListener('pagehide', retire);
    return Object.freeze({provider, controller, initialize: () => controller.initialize(), retire, dispose});
  } catch (error) {dispose(); throw error;}
}
