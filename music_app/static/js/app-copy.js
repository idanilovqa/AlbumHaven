// The page side of the copy kept on the device (instant return; the worker is app-copy-worker.js).
// Deferred on the app page, so it runs after the document and capability-ui.js, before app.js.
// Inside the Android app it registers the worker only when the shell offers `app.copy.v1` (the
// runtime's bridge client calls adoptShell after its handshake), and saves the view whenever the app
// leaves the screen. In a browser over HTTPS or localhost it registers the server-first worker as soon
// as the page runs, saves a page it did not load once the worker runs, and saves the view when a
// tab is hidden only if it changed or ten minutes passed, since every save makes the server render
// the page.
//
// A page the worker answered from its copy is marked `content="cache"`. It asks the server which
// account is signed in: another account, or none, deletes the copy and loads the page again; no
// answer makes the copy read-only, with its Offline notice and every write hidden, until one comes.
// The notice means unreachable (no answer, a gateway error, or the device offline), never slow. Each
// answer lets the runtime bring the view up to date in place (onServerAnswer).
(function appCopy(root) {
  'use strict';

  const WORKER_URL = '/app-copy-worker.js';
  const ACCOUNT_URL = '/app-copy/account';
  const WEB_WORKER_URL = `${WORKER_URL}?mode=web`;
  const RETRY_DELAYS_MS = [3000, 10000, 30000];
  const WEB_SAVE_INTERVAL_MS = 10 * 60 * 1000;

  function createAppCopyClient({
    document, window, navigator, location, fetch, setTimeout, clearTimeout, capabilities, MessageChannel,
    now = Date.now,
  }) {
    const marker = document.querySelector('meta[name="album-haven-app-copy"]');
    const startedFromCopy = marker?.getAttribute('content') === 'cache';
    const copyAccount = marker?.getAttribute('data-account') || '';
    // The copy of another address stands in for this one, which was never kept (app-copy-worker.js).
    const viewMissing = startedFromCopy && marker.getAttribute('data-view-missing') === '1';
    // The server gave no answer at all within the worker's wait, so it is unreachable already.
    const unanswered = startedFromCopy && marker.getAttribute('data-unanswered') === '1';
    const answerListeners = [];
    let shell = null;
    let readOnly = false;
    let answered = false;
    let retries = 0;
    let retryTimer = 0;
    // A browser's last save; a page the worker loaded from the server is already kept.
    let lastSave = marker?.getAttribute('content') === 'network' && navigator.serviceWorker?.controller
      ? { url: location.href, at: now() } : null;

    // The worker's answer to [message], or no copy when no worker runs.
    async function ask(message) {
      const worker = (await navigator.serviceWorker?.getRegistration('/'))?.active;
      if (!worker) return { stored: false };
      const channel = new MessageChannel();
      const reply = new Promise((resolve) => {
        channel.port1.onmessage = (event) => {
          channel.port1.close();
          resolve(event.data);
        };
      });
      worker.postMessage(message, [channel.port2]);
      return reply;
    }

    // The shell skips its Connecting screen only while a copy exists for this origin.
    async function tell(message) {
      const reply = await ask(message);
      try {
        await shell?.report(Boolean(reply?.stored));
      } catch (_error) {
        // The shell keeps its last answer; the next one corrects it.
      }
      return reply;
    }

    async function forget() {
      await tell({ type: 'forget' });
      return {};
    }

    // Signed out, another account, or a sandbox switch: this copy must not stay on screen, and the
    // network page (or the sign-in page) replaces it.
    async function leaveCopy() {
      await forget();
      location.reload();
    }

    // The Offline notice, shown only while the server cannot be reached, never for a slow answer.
    function showNotice(on) {
      const notice = document.getElementById('app-copy-offline-notice');
      if (notice) notice.hidden = !on;
    }

    function setReadOnly(on) {
      if (!on) showNotice(false);
      if (readOnly === on) return;
      readOnly = on;
      capabilities()?.setReadOnly?.(on);
    }

    async function confirmAccount() {
      clearTimeout(retryTimer);
      let response;
      try {
        response = await fetch(ACCOUNT_URL, {
          credentials: 'same-origin', cache: 'no-store', redirect: 'manual', headers: { Accept: 'application/json' },
        });
      } catch (_error) {
        response = null;
      }
      if (!response || response.status >= 500) {
        setReadOnly(true);
        showNotice(true);
        retryTimer = setTimeout(confirmAccount, RETRY_DELAYS_MS[Math.min(retries, RETRY_DELAYS_MS.length - 1)]);
        retries += 1;
        return;
      }
      const account = response.ok ? (await response.json().catch(() => null))?.account : null;
      if (account !== copyAccount) {
        await leaveCopy();
        return;
      }
      retries = 0;
      answered = true;
      setReadOnly(false);
      answerListeners.forEach(listener => listener());
    }

    function adoptShell(info, port) {
      const workers = navigator.serviceWorker;
      if (!workers) return;
      if (!info) {
        shell = null;
        void workers.getRegistration('/').then(async (registration) => {
          if (!registration?.active?.scriptURL?.endsWith(WORKER_URL)) return;
          await forget();
          await registration.unregister();
        });
        return;
      }
      shell = port;
      void workers.register(WORKER_URL, { scope: '/', updateViaCache: 'none' }).then(() => {
        if (!info.forget) return tell({ type: 'status' });
        // The shell switched sandbox while this origin's page was gone.
        return startedFromCopy ? leaveCopy() : forget();
      }, () => {});
    }

    // The runtime's reconciliation, run after each server answer to a copy.
    function onServerAnswer(listener) {
      answerListeners.push(listener);
      if (startedFromCopy && answered) listener();
    }

    function startInBrowser() {
      if (capabilities()?.isAndroidShell?.() || !window.isSecureContext || !navigator.serviceWorker) return false;
      // Registered at once, not on `load`: a busy device fires `load` only after every image, and a
      // connection lost before then left nothing kept. A page the worker did not load (the first
      // visit) is saved as soon as the worker runs, also before the tab is ever hidden.
      void navigator.serviceWorker.register(WEB_WORKER_URL, { scope: '/', updateViaCache: 'none' })
        .then(() => navigator.serviceWorker.ready)
        .then(saveInBrowser)
        .catch(() => {});
      return true;
    }
    const inBrowser = startInBrowser();

    function saveInBrowser() {
      if (readOnly || (lastSave?.url === location.href && now() - lastSave.at < WEB_SAVE_INTERVAL_MS)) return;
      lastSave = { url: location.href, at: now() };
      void ask({ type: 'save', url: location.href });
    }

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'hidden') return;
      if (inBrowser) saveInBrowser();
      else if (shell && !readOnly) void tell({ type: 'save', url: location.href });
    });
    if (inBrowser) window.addEventListener('pagehide', saveInBrowser);
    window.addEventListener('online', () => { if (readOnly) void confirmAccount(); });
    // A browser shows its copy only when the server could not answer, so the copy starts read-only.
    // The notice waits for the account check unless the device itself is offline or the server
    // already gave no answer for the worker's whole wait.
    if (startedFromCopy && inBrowser) {
      setReadOnly(true);
      if (navigator.onLine === false || unanswered) showNotice(true);
    }
    if (startedFromCopy) void confirmAccount();

    return { startedFromCopy, viewMissing, isReadOnly: () => readOnly, adoptShell, forget, onServerAnswer };
  }

  if (typeof module === 'object' && module.exports) module.exports = { createAppCopyClient };
  if (root.document && root.navigator) {
    root.AlbumHavenAppCopy = createAppCopyClient({
      document: root.document,
      window: root,
      navigator: root.navigator,
      location: root.location,
      fetch: (...args) => root.fetch(...args),
      setTimeout: root.setTimeout.bind(root),
      clearTimeout: root.clearTimeout.bind(root),
      capabilities: () => root.AlbumHavenCapabilities,
      MessageChannel: root.MessageChannel,
    });
  }
}(typeof window === 'object' ? window : globalThis));
