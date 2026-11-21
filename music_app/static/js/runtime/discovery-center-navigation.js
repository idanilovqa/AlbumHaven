/* Discovery Center owns tab navigation inside its mounted shell page. */
(() => {
  'use strict';

  function create({ document, window, fetch, DOMParser }) {
    if (!document.querySelector('[data-discovery-center-page-kind]')) return null;
    const historyPositionKey = 'albumHavenDiscoveryPosition';
    const readHistoryPosition = () => Number.isSafeInteger(window.history.state?.[historyPositionKey])
      ? window.history.state[historyPositionKey] : null;
    let currentPosition = readHistoryPosition() ?? 0;
    window.history.replaceState({
      ...window.history.state,
      [historyPositionKey]: currentPosition,
    }, '', window.location.href);
    let currentUrl = window.location.href;
    let restoringPosition = null;
    let sequence = 0;
    let pending = null;

    const resolveUrl = (value) => {
      try {
        const url = new URL(value, window.location.href);
        return url.origin === window.location.origin && url.pathname === '/news' ? url : null;
      } catch (_error) {
        return null;
      }
    };

    const setBusy = (busy) => {
      const page = document.querySelector('[data-discovery-center-page-kind]');
      if (!page) return;
      if (busy) page.setAttribute('aria-busy', 'true');
      else page.removeAttribute('aria-busy');
    };

    async function navigate(value, { historyMode = 'push' } = {}) {
      const url = resolveUrl(value);
      if (!url) return false;
      const ownSequence = ++sequence;
      pending?.abort();
      pending = new AbortController();
      setBusy(true);
      try {
        const response = await fetch(url.href, {
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { Accept: 'text/html' },
          signal: pending.signal,
        });
        if (ownSequence !== sequence) return false;
        const responseUrl = new URL(response.url || url.href, url.href);
        const loginRedirect = response.redirected
          && responseUrl.origin === window.location.origin
          && responseUrl.pathname === '/login';
        if (response.status === 401 || loginRedirect) {
          window.location.assign('/login');
          return false;
        }
        const destination = resolveUrl(responseUrl.href);
        if (!response.ok || !destination
          || !response.headers.get('content-type')?.includes('text/html')) {
          throw new Error('Discovery Center request failed.');
        }
        const parsed = new DOMParser().parseFromString(await response.text(), 'text/html');
        if (ownSequence !== sequence) return false;
        const incoming = parsed.querySelector('[data-discovery-center-page-kind]');
        const current = document.querySelector('[data-discovery-center-page-kind]');
        if (!incoming || !current) throw new Error('Discovery Center content is missing.');
        current.replaceWith(incoming);
        document.title = parsed.title || document.title;
        if (historyMode === 'push') {
          window.history.pushState({
            ...window.history.state,
            [historyPositionKey]: currentPosition + 1,
          }, '', destination.href);
        } else if (historyMode === 'replace') {
          window.history.replaceState({
            ...window.history.state,
            [historyPositionKey]: currentPosition,
          }, '', destination.href);
        }
        currentPosition = readHistoryPosition() ?? currentPosition;
        currentUrl = destination.href;
        return true;
      } catch (error) {
        if (ownSequence === sequence && error.name !== 'AbortError') {
          console.error('[AlbumHaven] Discovery Center navigation failed.', error);
          window.showToast?.('Discovery Center could not be loaded. Please try again.');
        }
        return false;
      } finally {
        if (ownSequence === sequence) {
          pending = null;
          setBusy(false);
        }
      }
    }

    const onClick = (event) => {
      if (event.defaultPrevented || event.button !== 0
        || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const link = event.target?.closest?.('[data-discovery-center-page-kind] a[href]');
      if (!link || link.hasAttribute('download') || (link.target && link.target !== '_self')) return;
      const url = resolveUrl(link.href);
      if (!url) return;
      event.preventDefault();
      void navigate(url.href);
    };

    const onPopState = async (event) => {
      const url = resolveUrl(window.location.href);
      if (!url) return;
      event.stopImmediatePropagation?.();
      if (restoringPosition !== null) {
        if (readHistoryPosition() === restoringPosition) {
          currentPosition = restoringPosition;
          currentUrl = window.location.href;
          restoringPosition = null;
        }
        return;
      }
      const targetPosition = readHistoryPosition();
      const priorPosition = currentPosition;
      if (await navigate(url.href, { historyMode: 'none' })) {
        currentPosition = targetPosition ?? priorPosition;
        currentUrl = url.href;
        return;
      }
      if (targetPosition !== null && targetPosition !== priorPosition) {
        restoringPosition = priorPosition;
        window.history.go(priorPosition - targetPosition);
      } else {
        window.history.replaceState(window.history.state, '', currentUrl);
      }
    };

    document.addEventListener('click', onClick);
    window.addEventListener('popstate', onPopState, true);
    return { navigate };
  }

  window.AlbumHavenDiscoveryNavigation = { create };
  if (typeof document !== 'undefined') {
    window.AlbumHavenDiscoveryNavigation.instance = create({
      document,
      window,
      fetch: window.fetch?.bind(window) || fetch,
      DOMParser: window.DOMParser || DOMParser,
    });
  }
})();
