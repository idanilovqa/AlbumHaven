(function exposeCapabilities(root) {
  'use strict';

  function readPolicy(document) {
    try {
      const payload = JSON.parse(document.getElementById('capability-bootstrap')?.textContent || '{}');
      const actions = payload.allowed_actions;
      if (!actions || typeof actions !== 'object' || Array.isArray(actions)) return null;
      return Object.freeze({
        actions: Object.freeze({ ...actions }),
        deniedSelectors: Array.isArray(payload.denied_selectors) ? payload.denied_selectors : [],
        readOnlySelectors: Array.isArray(payload.read_only_selectors) ? payload.read_only_selectors : [],
        deniedTabs: Array.isArray(payload.denied_tabs) ? payload.denied_tabs : [],
        availableTabs: Object.freeze(Array.isArray(payload.available_tabs)
          ? payload.available_tabs.filter(tab => typeof tab === 'string') : []),
        clientSurface: String(payload.client_surface || 'private_web'),
        coverProviderGroups: Object.freeze(Array.isArray(payload.cover_provider_groups)
          ? payload.cover_provider_groups.filter(group => typeof group === 'string') : []),
      });
    } catch (_error) {
      return null;
    }
  }

  function install(document) {
    const policy = readPolicy(document);
    const allows = (action) => Boolean(policy && policy.actions[action] === true);
    // The Android tab is client-owned: only the APK's injected bridge object can reveal it, never an
    // element or frame window that named access exposes under its name. The runtime's bridge
    // client asks this same predicate.
    const isAndroidShell = () => {
      const bridge = root.AlbumHavenBridge;
      return typeof bridge?.postMessage === 'function' && bridge.window !== bridge;
    };
    const allowsUtilityTab = (tab) => tab === 'android'
      ? isAndroidShell()
      : Boolean(policy && policy.availableTabs.includes(tab));
    const resolveUtilityTab = (preferred) => allowsUtilityTab(preferred)
      ? preferred : policy?.availableTabs[0] || null;
    const allowsCoverCandidate = (candidate) => Boolean(policy && (policy.clientSurface !== 'tv'
      || policy.coverProviderGroups.includes(candidate?.lookup_group)));
    // The Android app's offline copy (app-copy.js) hides permitted writes the same way as denied
    // ones until the server answers.
    const readOnlySelectors = policy ? policy.readOnlySelectors.join(',\n') : '';
    let readOnlyStyle = null;
    const setReadOnly = (on) => {
      if (Boolean(on) === Boolean(readOnlyStyle) || !readOnlySelectors) return;
      if (readOnlyStyle) {
        readOnlyStyle.remove();
        readOnlyStyle = null;
        return;
      }
      readOnlyStyle = document.createElement('style');
      readOnlyStyle.id = 'capability-read-only';
      readOnlyStyle.textContent = `${readOnlySelectors} { display: none !important; }`;
      document.head.append(readOnlyStyle);
    };
    const result = Object.freeze({ allows, allowsUtilityTab, resolveUtilityTab, allowsCoverCandidate, isAndroidShell,
      setReadOnly, clientSurface: policy?.clientSurface || 'private_web' });
    root.AlbumHavenCapabilities = result;
    if (!policy) return result;
    const denied = policy.deniedSelectors.join(',');
    if (denied || readOnlySelectors) {
      // CSS is applied before first paint. This capture guard also rejects
      // synthetic activation of a hidden control; the server remains decisive.
      document.addEventListener('click', (event) => {
        const target = event.target;
        if ((denied && target?.closest?.(denied)) || (readOnlyStyle && target?.closest?.(readOnlySelectors))) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      }, true);
    }
    const ready = () => {
      // Keyboard traversal uses native hidden state, not just CSS visibility.
      document.querySelectorAll?.('[data-utility-tab]').forEach(tab => {
        tab.hidden = !allowsUtilityTab(tab.getAttribute('data-utility-tab'));
      });
      if (!policy.deniedTabs.length) return;
      const dialog = document.querySelector('#utility-modal .utility-modal-dialog');
      if (!dialog || dialog.querySelector('.capability-section-denied')) return;
      const message = document.createElement('div');
      message.className = 'capability-section-denied utility-empty-state';
      message.setAttribute('role', 'status');
      message.textContent = 'This section is unavailable for your account or device. Choose an available section above.';
      dialog.append(message);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once: true });
    else ready();
    return result;
  }

  if (typeof module === 'object' && module.exports) module.exports = { readPolicy, install };
  if (root.document) install(root.document);
}(typeof window === 'object' ? window : globalThis));
