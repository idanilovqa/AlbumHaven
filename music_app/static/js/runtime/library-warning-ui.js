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
  const libraryHealth = document.getElementById('library-health');
  const loader = document.getElementById('library-loader');
  const scanPageVisible = options.scanPageVisible
    ?? Boolean(loader?.classList?.contains('is-scan-page'));
  const hidden = !model.warning || !model.dismissed || !scanPageVisible;
  if (scanNotice.hidden !== hidden) scanNotice.hidden = hidden;
  if (libraryHealth) libraryHealth.hidden = hidden;
  loader?.classList?.toggle?.('has-library-health', !hidden);
  if (hidden) return;
  const problems = health.problems || [];
  const unavailable = problems.some(problem => problem.state === 'root_unavailable');
  const canRefresh = problems.some(problem => problem.allowed_actions?.['library.refresh'] === true);
  const message = unavailable
    ? `A watched library folder became unavailable. Reconnect it${canRefresh ? ', then run Full Rescan' : ''}.`
    : `Some library changes may have been missed.${canRefresh ? ' Run Full Rescan to reconcile them.' : ''}`;
  const notice = buildOnPageAlertHtml({severity:'warning',title:'',message,className:'on-page-alert--compact',
    actionsHtml: canRefresh
      ? ButtonComponent.renderButton({label:'Full Rescan',attributes:{'data-status-action':'full-rescan'}}) : ''});
  if (scanNotice.innerHTML !== notice) scanNotice.innerHTML = notice;
}
