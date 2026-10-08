(() => {
  "use strict";

  const form = document.querySelector(".login-form");
  const password = document.querySelector("#login-password");
  const toggle = document.querySelector(".login-password-toggle");
  const submitButton = document.querySelector(".login-submit");

  if (password && toggle) {
    toggle.addEventListener("click", () => {
      const visible = password.type === "password";
      password.type = visible ? "text" : "password";
      toggle.setAttribute("aria-pressed", String(visible));
      toggle.textContent = visible ? "Hide" : "Show";
      password.focus();
    });
  }

  if (form && submitButton) {
    window.addEventListener("pageshow", () => {
      window.AlbumHavenStartupProgress?.reset();
      submitButton.disabled = false;
      submitButton.textContent = "Sign in";
    });
    form.addEventListener("submit", () => {
      if (!form.checkValidity()) return;
      window.AlbumHavenStartupProgress?.show(25);
      submitButton.disabled = true;
      submitButton.textContent = "Signing in…";
    });
  }
})();
