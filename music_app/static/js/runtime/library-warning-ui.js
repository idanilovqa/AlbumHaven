function libraryWarningPresentation(health = {}, dismissedToken = '') {
  const warning = health.state === 'warning';
  const token = String(health.warning_token || '');
  return { warning, token, showIcon: warning && !(health.dismissed || (token && token === dismissedToken)) };
}

function renderLibraryWarning(data = {}) {
  const health = data.watcher_health || {};
  const model = libraryWarningPresentation(health, state.ui.dismissedLibraryWarningToken);
  const trigger = document.getElementById('library-warning-button');
  const panel = document.getElementById('library-warning-panel');
  const scanNotice = document.getElementById('library-scan-warning');
  if (!trigger || !panel || !scanNotice) return;
  trigger.hidden = !model.showIcon;
  if (!trigger.innerHTML) trigger.innerHTML = buildAlertIconHtml('warning');
  const message = 'Some library changes may have been missed. Run a full rescan to reconcile the library. Dismissing this alert does not resolve the warning.';
  const notice = buildOnPageAlertHtml({severity:'warning',title:'Library watcher needs attention',message,
    actionsHtml: (health.problems || []).some(p => p.allowed_actions?.['library.refresh'] === true)
      ? ButtonComponent.renderButton({label:'Full Rescan',attributes:{'data-status-action':'full-rescan'}}) : ''});
  scanNotice.hidden = !model.warning;
  if (scanNotice.innerHTML !== notice) scanNotice.innerHTML = notice;
  if (panel.dataset.warningToken !== model.token || !panel.innerHTML) {
    panel.dataset.warningToken = model.token;
    panel.innerHTML = buildOnPageAlertHtml({severity:'warning',title:'Library watcher needs attention',message,
      actionsHtml: ButtonComponent.renderButton({label:'Open Library/Scan',attributes:{'data-library-warning-scan':'1'}})
        + ButtonComponent.renderButton({label:'Dismiss',attributes:{'data-dismiss-library-warning':'1'}})});
  }
  if (!model.showIcon && galleryMainSurfaceController?.current?.()?.key === 'library-warning') {
    closeGalleryMainSurface(false);
  }
  if (!model.warning) state.ui.dismissedLibraryWarningToken = '';
}

async function dismissLibraryWarning(button) {
  const panel = document.getElementById('library-warning-panel');
  const token = panel?.dataset.warningToken || '';
  if (!token || button.disabled) return;
  button.disabled = true;
  try {
    const response = await fetch('/account/library-warning/dismiss', {method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({token})});
    if (!response.ok) throw new Error(response.status === 409
      ? 'The library warning changed. Please review the latest warning.' : 'Unable to dismiss the warning. Please try again.');
    state.ui.dismissedLibraryWarningToken = token;
    closeGalleryMainSurface(false);
    renderLibraryWarning(state.status);
    document.getElementById('scan-indicator')?.focus();
  } catch (error) {
    showRepairAlert(error.message, 'error', null);
  } finally { button.disabled = false; }
}

function handleLibraryWarningClick(event) {
  const trigger = event.target.closest?.('#library-warning-button');
  if (trigger) {
    event.preventDefault();
    openGalleryMainSurface('library-warning', trigger, document.getElementById('library-warning-panel'));
    return true;
  }
  const dismiss = event.target.closest?.('[data-dismiss-library-warning]');
  if (dismiss) { event.preventDefault(); void dismissLibraryWarning(dismiss); return true; }
  if (event.target.closest?.('[data-library-warning-scan]')) {
    event.preventDefault(); closeGalleryMainSurface(false); openScanPage(); return true;
  }
  return false;
}
