(() => {
  "use strict";

  const form = document.querySelector(".recovery-form");
  const submit = document.querySelector(".recovery-submit");
  if (!form || !submit) return;

  form.addEventListener("submit", () => {
    if (!form.checkValidity()) return;
    submit.disabled = true;
    submit.textContent = submit.dataset?.loadingLabel || "Sending…";
  });
})();
