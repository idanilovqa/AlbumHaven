(() => {
  "use strict";

  // Signing in or out ends what the browser kept for the previous account: the same keys as
  // runtime/browser-storage-helpers.js.
  for (const [storage, keys] of [
    ["localStorage", ["albumhaven.playerState.v1", "albumhaven.androidNativeQueue.v1"]],
    ["sessionStorage", ["albumhaven.recentSearches.v1", "albumhaven.playbackHandoff.v1"]],
  ]) {
    try {
      keys.forEach((key) => window[storage].removeItem(key));
    } catch (_error) {
      // Storage is switched off: nothing was kept.
    }
  }

  const form = document.querySelector(".login-form");
  const password = document.querySelector("#login-password");
  const toggle = document.querySelector(".login-password-toggle");
  const submitButton = document.querySelector(".login-submit");
  const failure = document.querySelector(".login-alert");
  const csrfToken = form?.querySelector('input[name="csrf_token"]');

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
