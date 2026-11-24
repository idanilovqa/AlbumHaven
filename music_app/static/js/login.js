(() => {
  "use strict";

  // Signed out: what this device kept of the account goes, but not the songs kept for offline play:
  // the places Back would return to (return-place.js), the saved player, the app's queue, recent searches
  // and this tab's playback claim.
  const ACCOUNT_LOCAL_KEYS = ["album-haven-return-places", "albumhaven.playerState.v1", "albumhaven.androidNativeQueue.v1"];
  const ACCOUNT_SESSION_KEYS = ["albumhaven.playerTabState.v1", "albumhaven.recentSearches.v1",
    "albumhaven.playbackHandoff.v1", "albumhaven.playbackSameTab.v1"];
  for (const [storage, keys] of [["localStorage", ACCOUNT_LOCAL_KEYS], ["sessionStorage", ACCOUNT_SESSION_KEYS]]) {
    try {
      for (const key of keys) window[storage]?.removeItem(key);
    } catch (_error) {
      // Storage is switched off, so none were kept.
    }
  }

  const form = document.querySelector(".login-form");
  const password = document.querySelector("#login-password");
  const toggle = document.querySelector(".login-password-toggle");
  const submitButton = document.querySelector(".login-submit");
  const failure = document.querySelector(".login-alert");
  const csrfToken = form?.querySelector('input[name="csrf_token"]');

  // Instant return in a browser: the copy's worker is installed while signing in, so the library
  // page that follows passes through it and is kept as it arrives. Without it the first copy waits
  // for a second render of the page, and a connection lost in between leaves nothing to show.
  // The Android app runs its own worker, which the shell starts.
  const copyWorkerReady = (() => {
    const workerUrl = document.querySelector('meta[name="album-haven-app-copy-worker"]')?.content;
    const bridge = window.AlbumHavenBridge;
    const inAndroidShell = typeof bridge?.postMessage === "function" && bridge.window !== bridge;
    if (!workerUrl || inAndroidShell || !window.isSecureContext || !window.navigator?.serviceWorker) return null;
    return window.navigator.serviceWorker.register(workerUrl, { scope: "/", updateViaCache: "none" })
      .then(() => window.navigator.serviceWorker.ready)
      .catch(() => {});
  })();
  // Signing in never waits long for it: a worker that is late only keeps the page later.
  const COPY_WORKER_WAIT_MS = 2000;

  if (password && toggle) {
    toggle.addEventListener("click", () => {
      const visible = password.type === "password";
      password.type = visible ? "text" : "password";
      toggle.setAttribute("aria-pressed", String(visible));
      toggle.textContent = visible ? "Hide" : "Show";
      password.focus();
    });
  }

  if (form && password && submitButton && failure && csrfToken) {
    const restoreControls = () => {
      submitButton.disabled = false;
      submitButton.textContent = "Sign in";
    };
    window.addEventListener("pageshow", () => {
      window.AlbumHavenStartupProgress?.reset();
      restoreControls();
    });
    // Returns the JSON sign-in reply, or null when only a native post can show the result.
    const requestSignIn = async () => {
      try {
        const response = await window.fetch(form.action, {
          method: "POST",
          body: new URLSearchParams(new FormData(form)),
          headers: { Accept: "application/json" },
          credentials: "same-origin",
          redirect: "error",
        });
        if (!response.headers.get("content-type")?.startsWith("application/json")) return null;
        return { accepted: response.ok, body: await response.json() };
      } catch (_error) {
        return null;
      }
    };
    // Credentials are checked before any loading UI. The native post stays the
    // no-script path and the fallback for replies this script cannot read.
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (submitButton.disabled) return;
      submitButton.disabled = true;
      submitButton.textContent = "Signing in…";
      const reply = await requestSignIn();
      if (reply?.accepted && typeof reply.body?.redirect === "string") {
        window.AlbumHavenStartupProgress?.show(25);
        if (copyWorkerReady) {
          await Promise.race([copyWorkerReady, new Promise(resolve => window.setTimeout(resolve, COPY_WORKER_WAIT_MS))]);
        }
        window.location.assign(reply.body.redirect);
      } else if (reply && !reply.accepted && typeof reply.body?.csrf_token === "string") {
        csrfToken.value = reply.body.csrf_token;
        failure.hidden = false;
        password.value = "";
        restoreControls();
        password.focus();
      } else {
        HTMLFormElement.prototype.submit.call(form);
      }
    });
  }
})();
