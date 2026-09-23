function canExportUtilityLogHistory() {
  return state.utility.allowedActions?.['library.logs.read'] === true && state.utility.allowedActions?.['library.logs.export'] === true;
}

function getUtilityLogHistoryController() {
  const owner = state.utility;
  if (owner.logHistoryController) return owner.logHistoryController;
  let presentation = null;
  owner.logHistoryController = createUtilityLogHistoryQueryController({
    contextKey: owner,
    fetchPage: async ({ query, cursor, snapshot, page_size }) => {
      const params = new URLSearchParams({ page_size: String(page_size) });
      Object.entries(query || {}).forEach(([key, value]) => {
        if (Array.isArray(value)) value.forEach(item => params.append(key, item));
        else if (value) params.set(key, value);
      });
      if (cursor) params.set('cursor', cursor);
      if (snapshot) params.set('snapshot', snapshot);
      const response = await fetch(`/utilities/log-history?${params}`, { cache: 'no-store', headers: { Accept: 'application/json' } });
      const data = await response.json();
      if (!response.ok || data.ok === false) throw Object.assign(new Error(data.error || 'Unable to load log history.'), { status: response.status });
      if (state.utility !== owner) { owner.logHistoryController.setContext({}); return data; }
      return data;
    },
    onAccepted: ({ query, items, page, navigationOnly, publishNavigation }) => {
      if (state.utility !== owner) return;
      if (!navigationOnly) owner.allowedActions = { ...(owner.allowedActions || {}),
        'library.logs.read': page.allowed_actions?.['library.logs.read'] === true,
        'library.logs.export': page.allowed_actions?.['library.logs.export'] === true };
      if (publishNavigation && !Object.keys(query || {}).length) owner.logHistory = items;
    },
    exportQuery: async request => {
      if (state.utility !== owner || !canExportUtilityLogHistory()) throw new Error('Log export is unavailable.');
      const response = await fetch('/utilities/log-history/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
      const data = await response.json();
      if (!response.ok || data.ok === false) throw Object.assign(new Error(data.error || 'Unable to export logs.'), { status: response.status });
      if (state.utility !== owner) throw new Error('The library changed.');
      return data;
    },
    onChange: value => {
      if (state.utility !== owner) return;
      owner.logHistoryLoading = value.loading;
      owner.logHistoryRevision = value.revision;
      owner.selectedLogHistoryId = value.selectedEventId;
      if (value.snapshot) owner.logHistoryLoaded = true;
      const nextPresentation = [value.query, value.snapshot, value.items, value.selectedEventId, value.temporaryRowId, value.loading, value.error, value.stale, value.refreshRequired, value.periodLabel, owner.logHistory, owner.allowedActions];
      if (presentation && presentation.every((item, index) => item === nextPresentation[index])) return;
      presentation = nextPresentation;
      const els = getUtilityModalElements();
      if (owner.activeTab === 'log-history' && els.overlay && !els.overlay.hidden) renderUtilityLogHistory();
    },
  });
  return owner.logHistoryController;
}

function formatConsoleLogEvent(item) {
  const labels = { file_count: 'Files', processed: 'Processed', downloaded: 'Downloaded', not_touched: 'Not touched', skipped: 'Skipped', not_found: 'Not found', failed: 'Failed', updated: 'Updated', succeeded: 'Succeeded' };
  const outcomes = Object.entries(labels).filter(([key]) => Number.isFinite(item[key])).map(([key, label]) => `${label}: ${item[key]}`);
  return [item.timestamp, item.action, item.source, [item.artist, item.album, item.title].filter(Boolean).join(' · '), ...outcomes, item.message, item.error].filter(Boolean).join('  ');
}

function getConsoleLogText(items) {
  return (items || []).slice().sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')) || String(a.id).localeCompare(String(b.id))).map(formatConsoleLogEvent).join('\n');
}

function buildConsoleLog(items, { label = 'Console log' } = {}) {
  const ordered = (items || []).slice().sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')) || String(a.id).localeCompare(String(b.id)));
  return `<section class="console-log" aria-label="${escapeHtml(label)}"><div class="console-log__heading"><span>${escapeHtml(label)} · ${ordered.length} events</span>${window.ButtonComponent.renderActionButton({ icon: 'copy', ariaLabel: 'Copy log', attributes: { 'data-log-history-action': 'copy' } })}</div><pre class="console-log__lines" tabindex="0">${ordered.length ? ordered.map(item => {
    const success = item.level === 'success' || (!item.error && /succeeded|completed|saved/i.test(item.action || ''));
    const text = formatConsoleLogEvent(item);
    return `<span class="console-log__line${success ? ' console-log__line--success' : ''}">${escapeHtml(text)}</span>`;
  }).join('\n') : 'No events in this snapshot.'}</pre></section>`;
}

function utilityLogButton(label, action, { disabled = false } = {}) {
  return window.ButtonComponent.renderButton({ label, ariaLabel: label, disabled, attributes: { 'data-log-history-action': action } });
}

function buildUtilityLogHistoryConsole(value) {
  const selected = value.items.find(item => String(item.id) === value.selectedEventId);
  const title = selected ? escapeHtml(selected.action || 'Log entry') : value.temporaryRowId ? 'Logs for selected period' : 'Recent activity';
  return `<div class="utility-log-console-detail"><div class="utility-log-toolbar"><h3>${title}</h3>${canExportUtilityLogHistory() ? utilityLogButton('Export all logs', 'export-draft') : ''}</div>
    ${selected ? `<p>${escapeHtml([formatLogHistoryTimestamp(selected.timestamp), selected.source, selected.artist, selected.album, selected.title].filter(Boolean).join(' · '))}</p>` : value.temporaryRowId ? `<p>${escapeHtml(value.periodLabel || '')}</p>` : ''}
    ${value.stale ? buildOnPageAlertHtml({ severity: 'info', role: 'status', message: 'New activity is available. Refresh to capture it.' }) : ''}
    ${value.error ? buildOnPageAlertHtml({ severity: 'error', title: 'Log history unavailable', message: value.error }) : ''}
    ${buildConsoleLog(value.items)}
    <div class="utility-log-toolbar">${utilityLogButton(value.loading ? 'Loading…' : 'Refresh', 'refresh', { disabled: value.loading })}
    ${value.nextCursor ? utilityLogButton('Load more', 'more', { disabled: value.loading || value.refreshRequired }) : ''}
    ${value.temporaryRowId ? utilityLogButton('Clear period', 'clear') : ''}
    ${canExportUtilityLogHistory() ? utilityLogButton('Export displayed logs', 'export-current', { disabled: !value.snapshot || value.loading }) : ''}</div></div>`;
}

function reconcileUtilityLogHistoryTree(els, value) {
  if (els.list.dataset.utilityNavigationOwner !== 'log-history') {
    els.list.replaceChildren();
    els.list.dataset.utilityNavigationOwner = 'log-history';
  }
  const rows = (state.utility.logHistory || []).map(item => ({ id: String(item.id), item }));
  if (value.temporaryRowId) rows.unshift({ id: value.temporaryRowId, temporary: true });
  const existing = new Map(Array.from(els.list.querySelectorAll('[data-utility-log-history-id]'), node => [node.getAttribute('data-utility-log-history-id'), node]));
  const wanted = new Set(rows.map(row => row.id));
  for (const [id, node] of existing) if (!wanted.has(id)) node.remove();
  let cursor = els.list.firstElementChild;
  for (const row of rows) {
    let node = existing.get(row.id);
    if (!node) {
      const host = document.createElement('div');
      host.innerHTML = row.temporary ? window.NavigationTree.renderItem({ action: true, variant: 'panel', key: row.id, label: 'Selected period', subtitle: value.periodLabel || '', attributes: { 'data-utility-log-history-id': row.id, 'data-log-query-row': '1' } }) : buildUtilityLogHistoryListItem(row.item, false);
      node = host.firstElementChild;
    }
    if (node !== cursor) els.list.insertBefore(node, cursor);
    cursor = node.nextElementSibling;
    if (row.temporary) window.NavigationTree.updateItem(node, { label: 'Selected period', subtitle: value.periodLabel || '' });
    window.NavigationTree.setItemSelected(node, row.temporary ? Boolean(value.temporaryRowId && !value.selectedEventId) : row.id === value.selectedEventId);
  }
  els.count.textContent = String(rows.length);
}

async function selectUtilityLogHistoryEvent(id) {
  const controller = getUtilityLogHistoryController();
  if (id === controller.getState().temporaryRowId) return controller.selectPeriod();
  if (id === controller.getState().selectedEventId) return;
  await controller.selectEvent(id);
}

async function downloadUtilityLogHistory() {
  const data = await getUtilityLogHistoryController().exportCurrent();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
  anchor.href = url; anchor.download = `album-haven-logs-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function openUtilityLogHistoryQuery(exportAfter = false) {
  if (exportAfter && !canExportUtilityLogHistory()) return;
  const controller = getUtilityLogHistoryController();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!exportAfter) {
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    let dispose = () => {};
    return showAppFormDialog({
      title: 'Date range', anchor: getUtilityModalElements().problemFilterButton,
      contentHtml: `${buildDateRangePicker({ fromDate: today, toDate: today })}<p class="utility-detail-meta">${escapeHtml(zone)}</p>`,
      submitLabel: 'Apply',
      onMount: content => { dispose = mountDateRangePicker(content); },
      onClose: () => { dispose(); controller.cancelDraft(); },
      onSubmit: async content => {
        controller.beginDraft({ preset: 'custom', fromDate: content.querySelector('[name="fromDate"]').value,
          toDate: content.querySelector('[name="toDate"]').value });
        await controller.applyDraft();
        return true;
      },
    });
  }
  let preset = 'today';
  let disposeCalendar = () => {};
  const types = Array.from(new Set(['Tags edited', 'Library status error', 'Local cover selection persisted', 'Cover art update completed', 'Library indexing failed', ...(state.utility.logHistory || []).map(item => item.action).filter(Boolean)]));
  controller.beginDraft({ preset });
  const contentHtml = `<div class="utility-log-query-form"><p>Timezone: ${escapeHtml(zone)}</p><h4>Date range</h4>
    <div class="utility-log-presets">${[['today', 'Today'], ['7-days', '7 days'], ['30-days', '30 days'], ['custom', 'Custom']].map(([value, label]) => window.ButtonComponent.renderButton({ label, attributes: { 'data-log-preset': value, 'aria-pressed': String(value === preset) } })).join('')}</div>
    <div data-log-custom-dates hidden>${buildDateRangePicker()}</div>
    <h4>Log types</h4><div class="utility-log-type-options">${types.map(value => `<label><input type="checkbox" name="eventType" value="${escapeHtml(value)}" checked> ${escapeHtml(value)}</label>`).join('')}</div>
    <label>Text<input name="text" placeholder="Filter event text"></label></div>`;
  const mount = content => {
    const dates = content.querySelector('[data-log-custom-dates]');
    const syncCalendar = () => {
      disposeCalendar();
      dates.hidden = preset !== 'custom';
      dates.querySelectorAll('input, button').forEach(control => { control.disabled = dates.hidden; });
      disposeCalendar = dates.hidden ? () => {} : mountDateRangePicker(dates);
    };
    syncCalendar();
    content.querySelectorAll('[data-log-preset]').forEach(button => button.addEventListener('click', () => {
      preset = button.getAttribute('data-log-preset');
      content.querySelectorAll('[data-log-preset]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
      syncCalendar();
    }));

  };
  return showAppFormDialog({ title: exportAfter ? 'Export all logs' : 'Filter log period', anchor: exportAfter ? null : getUtilityModalElements().problemFilterButton, contentHtml, submitLabel: exportAfter ? 'Export logs' : 'Apply', onMount: mount,
    onClose: () => { disposeCalendar(); controller.cancelDraft(); },
    onSubmit: async content => {
      const selectedTypes = Array.from(content.querySelectorAll('[name="eventType"]')).filter(input => input.checked).map(input => input.value);
      if (!selectedTypes.length) throw new Error('Choose at least one log type.');
      controller.beginDraft({ preset, fromDate: content.querySelector('[name="fromDate"]').value, toDate: content.querySelector('[name="toDate"]').value, sources: [], event_types: selectedTypes.length === types.length ? [] : selectedTypes, text: content.querySelector('[name="text"]').value });
      await controller.applyDraft(); if (exportAfter) await downloadUtilityLogHistory(); return true;
    },
  });
}

async function handleUtilityLogHistoryAction(action) {
  const controller = getUtilityLogHistoryController();
  if (action === 'copy') return navigator.clipboard.writeText(getConsoleLogText(controller.getState().items));
  if (action === 'filter') return openUtilityLogHistoryQuery(false);
  if (action === 'export-draft') return openUtilityLogHistoryQuery(true);
  if (action === 'refresh') {
    const hasSelectedQuery = Object.keys(controller.getState().query || {}).length > 0;
    return Promise.all([controller.refresh(), ...(hasSelectedQuery ? [controller.refreshNavigation()] : [])]);
  }
  if (action === 'more') return controller.loadMore();
  if (action === 'clear') { controller.clear(); const id = controller.getState().selectedEventId; return id ? controller.selectEvent(id) : controller.refresh(); }
  if (action === 'export-current') return downloadUtilityLogHistory();
}
