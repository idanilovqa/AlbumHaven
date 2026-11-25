(() => {
  "use strict";

  const form = document.querySelector(".login-form");
  const password = document.querySelector("#login-password");
  const toggle = document.querySelector(".login-password-toggle");
  const submitButton = document.querySelector(".login-submit");
  const failure = document.querySelector(".login-alert");
  const expiredNotice = document.querySelector(".login-expired");
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
    // The one-time sign-in token lives ten minutes. A page that comes back into
    // view after most of that fetches a new one before the user types.
    const TOKEN_REFRESH_AFTER_MS = 9 * 60 * 1000;
    let tokenIssuedAt = Date.now();
    const useToken = (token) => {
      csrfToken.value = token;
      tokenIssuedAt = Date.now();
    };
    // A sign-in waits for a refresh in flight, so the two never replace each other's token.
    let pendingRefresh = null;
    const refreshStaleToken = () => {
      if (pendingRefresh || submitButton.disabled) return;
      if (Date.now() - tokenIssuedAt < TOKEN_REFRESH_AFTER_MS) return;
      pendingRefresh = (async () => {
        try {
          const response = await window.fetch(form.action, {
            headers: { Accept: "application/json" },
            credentials: "same-origin",
            redirect: "error",
          });
          const body = response.ok ? await response.json() : null;
          if (typeof body?.csrf_token === "string") useToken(body.csrf_token);
        } catch (_error) {
          // A sign-in with the old token still recovers through the expired reply.
        } finally {
          pendingRefresh = null;
        }
      })();
    };
    window.addEventListener("pageshow", () => {
      window.AlbumHavenStartupProgress?.reset();
      restoreControls();
      refreshStaleToken();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") refreshStaleToken();
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
    const expiredToken = (reply) =>
      reply && !reply.accepted && reply.body?.expired === true && typeof reply.body.csrf_token === "string";
    // Credentials are checked before any loading UI. The native post stays the
    // no-script path and the fallback for replies this script cannot read.
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (submitButton.disabled) return;
      submitButton.disabled = true;
      submitButton.textContent = "Signing in…";
      await pendingRefresh;
      let reply = await requestSignIn();
      if (expiredToken(reply)) {
        // The page outlived its token or another tab replaced it: sign in once
        // more with the fresh token and the credentials already typed.
        useToken(reply.body.csrf_token);
        reply = await requestSignIn();
      }
      if (reply?.accepted && typeof reply.body?.redirect === "string") {
        window.AlbumHavenStartupProgress?.show(25);
        if (copyWorkerReady) {
          await Promise.race([copyWorkerReady, new Promise(resolve => window.setTimeout(resolve, COPY_WORKER_WAIT_MS))]);
        }
        window.location.assign(reply.body.redirect);
      } else if (reply && !reply.accepted && typeof reply.body?.csrf_token === "string") {
        useToken(reply.body.csrf_token);
        if (expiredNotice) expiredNotice.hidden = true;
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
