function buildCompactDataTable(config = {}) {
  const columns = Array.isArray(config.columnsConfig) ? config.columnsConfig : [];
  const rows = Array.isArray(config.rows) ? config.rows : [];
  const headerMode = ['visible', 'screen-reader', 'absent'].includes(config.headers)
    ? config.headers
    : 'visible';
  const density = config.density === 'default' ? 'default' : 'compact';
  const overflow = config.overflow === 'local' ? 'local' : 'none';
  const mobile = config.mobile === 'stack' ? 'stack' : 'preserve';
  const frame = ['outline', 'inset', 'none'].includes(config.frame) ? config.frame : 'inset';
  const gridColumns = String(config.columns || '').trim();
  const actionTrack = String(config.actionTrackWidth || '').trim();
  const narrowColumns = String(config.narrowColumns || '').trim();
  const styleParts = [];
  if (gridColumns) styleParts.push(`--cdt-columns: ${gridColumns}`);
  if (actionTrack) styleParts.push(`--cdt-action-track: ${actionTrack}`);
  if (narrowColumns) styleParts.push(`--cdt-narrow-columns: ${narrowColumns}`);
  const style = styleParts.length ? ` style="${escapeHtml(styleParts.join('; '))}"` : '';
  const ariaLabel = String(config.ariaLabel || '').trim();
  const selection = ['single', 'multiple'].includes(config.selection) ? config.selection : 'none';
  const fallbackIdSeed = ariaLabel || columns.map((column) => column.key || '').filter(Boolean).join('-') || 'table';
  const tableId = String(config.id || fallbackIdSeed)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'compact-data-table';

  const buildCell = (column, cellValue, role) => {
    const cell = role === 'cell' && cellValue && typeof cellValue === 'object'
      ? cellValue
      : { content: cellValue };
    let content = cell?.content || '';
    const actionAttribute = (column.action ? ' data-cdt-action' : '') + (narrowColumns && column.hideWhenNarrow === true ? ' data-cdt-hide-narrow' : '');
    const effectiveHeaderMode = column.header || headerMode;
    // Sorting is opt-in presentation. Consumers retain row order, state and events.
    const sortable = role === 'columnheader' && effectiveHeaderMode === 'visible' && column.sortable === true
      && typeof column.key === 'string' && column.key.trim() !== '';
    const sortDirection = sortable && config.sort?.key === column.key && ['asc', 'desc'].includes(config.sort?.direction)
      ? config.sort.direction : 'default';
    const sortAttribute = sortable
      ? ` aria-sort="${sortDirection === 'asc' ? 'ascending' : sortDirection === 'desc' ? 'descending' : 'none'}"`
      : '';
    if (sortable) {
      const label = String(column.label || column.key);
      const current = sortDirection === 'asc' ? 'ascending' : sortDirection === 'desc' ? 'descending' : 'default order';
      const next = sortDirection === 'asc' ? 'descending order' : sortDirection === 'desc' ? 'default order' : 'ascending order';
      const indicator = sortDirection === 'default'
        ? '<span class="compact-data-table__sort-icon" aria-hidden="true">↕</span>'
        : ButtonComponent.renderIconSvg(sortDirection === 'asc' ? 'ascending' : 'descending', {className: 'compact-data-table__sort-icon'});
      content = ButtonComponent.renderButton({
        label, size: 'small', quiet: true, className: 'compact-data-table__sort',
        disabled: config.sortDisabled === true,
        ariaLabel: `Sort by ${label}: ${current}.${config.sortDisabled === true ? '' : ` Activate for ${next}.`}`,
        attributes: {'data-cdt-sort': column.key, 'data-cdt-sort-direction': sortDirection},
      }).replace('<span class="ui-button__content">', '<span class="ui-button__content"><span class="compact-data-table__sort-label">')
        .replace('</span>', `</span>${indicator}</span>`);
    }
    const headerClass = role === 'columnheader' && effectiveHeaderMode === 'screen-reader'
      ? ' class="sr-only"'
      : '';
    const selected = role === 'cell' && cell.ariaSelected === true ? ' aria-selected="true"' : '';
    const disabled = role === 'cell' && cell.ariaDisabled === true ? ' aria-disabled="true"' : '';
    const ariaLabel = role === 'cell' && String(cell.ariaLabel || '').trim()
      ? ` aria-label="${escapeHtml(cell.ariaLabel)}"`
      : '';
    const headerId = `${tableId}-header-${String(column.key || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-')}`;
    const headerIdentity = role === 'columnheader'
      ? ` id="${escapeHtml(headerId)}"`
      : '';
    const headerAssociation = role === 'cell' && effectiveHeaderMode !== 'absent' && headerMode !== 'absent'
      ? ` aria-labelledby="${escapeHtml(headerId)}"`
      : '';
    return `<div role="${role}" data-cdt-column="${escapeHtml(column.key || '')}"${headerIdentity}${actionAttribute}${headerClass}${sortAttribute}${selected}${disabled}${ariaLabel}${headerAssociation}>${content}</div>`;
  };

  const header = headerMode === 'absent'
    ? ''
    : `<div role="row" class="compact-data-table-header">${columns
      .map((column) => (
        column.header === 'absent'
          ? `<div data-cdt-column="${escapeHtml(column.key || '')}"${column.action ? ' data-cdt-action' : ''}${narrowColumns && column.hideWhenNarrow === true ? ' data-cdt-hide-narrow' : ''} aria-hidden="true"></div>`
          : buildCell(column, escapeHtml(column.label || ''), 'columnheader')
      ))
      .join('')}</div>`;
  const body = rows.map((row) => {
    const rowClassName = String(row?.className || '')
      .split(/\s+/)
      .map((value) => value.trim())
      .filter((value) => /^[a-zA-Z0-9_-]+$/.test(value))
      .join(' ');
    const selected = row?.ariaSelected === true ? ' aria-selected="true"' : '';
    const disabled = row?.ariaDisabled === true ? ' aria-disabled="true"' : '';
    const busy = row?.ariaBusy === true ? ' aria-busy="true"' : '';
    const tabIndex = row?.tabIndex === 0 || row?.tabIndex === -1
      ? ` tabindex="${row.ariaDisabled === true ? -1 : row.tabIndex}"` : '';
    const dataAttributes = Object.entries(row?.dataAttributes || {}).map(([name, value]) => {
      const normalizedName = String(name || '').trim().toLowerCase();
      return /^[a-z0-9-]+$/.test(normalizedName)
        ? ` data-${normalizedName}="${escapeHtml(value || '')}"`
        : '';
    }).join('');
    if (Object.prototype.hasOwnProperty.call(row || {}, 'fullSpanContent')) {
      const fullSpanLabel = String(row?.ariaLabel || '').trim();
      return `<div role="row" class="compact-data-table-row compact-data-table-row--full-span${rowClassName ? ` ${rowClassName}` : ''}" data-cdt-row-key="${escapeHtml(row?.key || '')}"${dataAttributes}${fullSpanLabel ? ` aria-label="${escapeHtml(fullSpanLabel)}"` : ''}><div role="cell" data-cdt-full-span>${row.fullSpanContent || ''}</div></div>`;
    }
    return `<div role="row" class="compact-data-table-row${rowClassName ? ` ${rowClassName}` : ''}" data-cdt-row-key="${escapeHtml(row?.key || '')}"${dataAttributes}${selected}${disabled}${busy}${tabIndex}>${columns.map((column) => (
      buildCell(column, row?.cells?.[column.key] || '', 'cell')
    )).join('')}</div>`;
  }).join('');

  const empty = !rows.length
    ? `<div data-cdt-empty>${config.emptyHtml || ''}</div>`
    : '';
  const helper = config.helperHtml ? `<div data-cdt-helper>${config.helperHtml}</div>` : '';
  return `<div class="compact-data-table" id="${escapeHtml(tableId)}" role="table"${ariaLabel ? ` aria-label="${escapeHtml(ariaLabel)}"` : ''} data-cdt-headers="${headerMode}" data-cdt-density="${density}" data-cdt-overflow="${overflow}" data-cdt-mobile="${mobile}" data-cdt-frame="${frame}" data-cdt-selection="${selection}"${narrowColumns ? ' data-cdt-narrow="true"' : ''}${style}>${header}<div role="rowgroup" class="compact-data-table-body">${body}</div>${empty}${helper}</div>`;
}
