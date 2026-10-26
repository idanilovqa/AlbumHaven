import {createListeningSettingsProvider} from './listening-settings-provider.mjs';
import {createListeningSettingsController} from './listening-settings-model.mjs';

// Native scopeKey contains account, library, signed session continuity and a
// monotonic transport generation. Library changes conservatively retire this
// account-owned view too; no library identifier is sent to the account route.
export function createListeningSettingsSession({runtime, fetch, onChange}) {
  let disposed = false, scope = null, controller = null, release = null, visibleEnabled = false;
  function retire() {release?.(); release = null; controller?.dispose(); controller = null;}
  return Object.freeze({
    update({enabled = false} = {}) {
      if (disposed) return;
      const wasEnabled = visibleEnabled;
      visibleEnabled = enabled === true;
      if (wasEnabled && !visibleEnabled) controller?.suspend();
      const shell = runtime.snapshot(), next = shell.authenticated && typeof shell.scopeKey === 'string' ? shell.scopeKey : null;
      if (scope !== next) {retire(); scope = next;}
      if (!controller && scope && enabled) {
        const captured = scope;
        const isCurrent = () => {
          const current = runtime.snapshot();
          return !disposed && visibleEnabled && scope === captured && current.authenticated === true && current.scopeKey === captured;
        };
        controller = createListeningSettingsController({provider: createListeningSettingsProvider({fetch, isCurrent}), isCurrent});
        release = controller.subscribe(onChange);
        void controller.load();
      } else if (controller && !wasEnabled && visibleEnabled) {void controller.load();}

    },
    getController: () => controller,
    dispose() {if (disposed) return; disposed = true; retire(); scope = null;},
  });
}
