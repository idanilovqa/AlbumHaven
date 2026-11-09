// The page side of the Android app's copy (instant return; the worker is app-copy-worker.js).
// Loaded first on the app page. Only inside an Android shell that offers `app.copy.v1` does it
// register the worker; the runtime's bridge client calls adoptShell after its handshake.
//
// A page the worker answered from its copy is marked `content="cache"`. It asks the server which
// account is signed in: another account, or none, deletes the copy and loads the page again; no
// answer makes the copy read-only, with its notice and every write hidden, until one comes. Each
// answer lets the runtime bring the view up to date in place (onServerAnswer).
(function appCopy(root) {
  'use strict';

  const WORKER_URL = '/app-copy-worker.js';
  const ACCOUNT_URL = '/app-copy/account';
  const RETRY_DELAYS_MS = [3000, 10000, 30000];

  function createAppCopyClient({
    document, window, navigator, location, fetch, setTimeout, clearTimeout, capabilities, MessageChannel,
  }) {
    const marker = document.querySelector('meta[name="album-haven-app-copy"]');
    const startedFromCopy = marker?.getAttribute('content') === 'cache';
    const copyAccount = marker?.getAttribute('data-account') || '';
    const answerListeners = [];
    let shell = null;
    let readOnly = false;
    let answered = false;
    let retries = 0;
    let retryTimer = 0;

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

    function applyReadOnly() {
      const notice = document.getElementById('app-copy-offline-notice');
      if (notice) notice.hidden = !readOnly;
      capabilities()?.setReadOnly?.(readOnly);
    }

    function setReadOnly(on) {
      if (readOnly === on) return;
      readOnly = on;
      applyReadOnly();
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

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && shell && !readOnly) void tell({ type: 'save', url: location.href });
    });
    window.addEventListener('online', () => { if (readOnly) void confirmAccount(); });
    // The notice and the read-only controls are in the document below this script.
    document.addEventListener('DOMContentLoaded', () => { if (readOnly) applyReadOnly(); });
    if (startedFromCopy) void confirmAccount();

    return { startedFromCopy, isReadOnly: () => readOnly, adoptShell, forget, onServerAnswer };
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
