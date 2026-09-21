function libraryWarningPresentation(health = {}, dismissedToken = '') {
  const warning = health.state === 'warning' || (Array.isArray(health.problems) && health.problems.length > 0);
  const token = String(health.warning_token || '');
  return { warning, token, dismissed: Boolean(health.dismissed || (token && token === dismissedToken)) };
}

function renderLibraryWarning(data = {}, options = {}) {
  const health = data.watcher_health || {};
  const model = libraryWarningPresentation(health, state.ui.dismissedLibraryWarningToken);
  const scanNotice = document.getElementById('library-scan-warning');
  if (!scanNotice) return;
  const scanPageVisible = options.scanPageVisible
    ?? Boolean(document.getElementById('library-loader')?.classList?.contains('is-scan-page'));
  const hidden = !model.warning || !model.dismissed || !scanPageVisible;
  if (scanNotice.hidden !== hidden) scanNotice.hidden = hidden;
  if (hidden) return;
  const problems = health.problems || [];
  const unavailable = problems.some(problem => problem.state === 'root_unavailable');
  const canRefresh = problems.some(problem => problem.allowed_actions?.['library.refresh'] === true);
  const message = unavailable
    ? `A watched library folder became unavailable. Reconnect the drive or network share and check that the folder is accessible${canRefresh ? ', then run Full Rescan' : ''}.`
    : `Some library changes may have been missed.${canRefresh ? ' Run a full rescan to reconcile the library.' : ''} Dismissing the alert does not resolve the warning.`;
  const notice = buildOnPageAlertHtml({severity:'warning',title:'Library watcher needs attention',message,
    actionsHtml: canRefresh
      ? ButtonComponent.renderButton({label:'Full Rescan',attributes:{'data-status-action':'full-rescan'}}) : ''});
  if (scanNotice.innerHTML !== notice) scanNotice.innerHTML = notice;
}
