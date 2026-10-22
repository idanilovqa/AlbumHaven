/** Presentation only: supplied columns never grant data, selection or actions. */
export function resolveTrackTableColumns(columns, width, choices = {}, {identityReserve = 0} = {}) {
  const unique = [...new Map(columns.map(column => [column.key, column])).values()];
  const required = column => column.required === true || column.identity === true;
  const pixels = column => Number.isFinite(column.width) && column.width > 0 ? column.width : 0;
  const budget = items => items.length ? 20 + 8 * (items.length - 1) + items.reduce((sum, column) => sum + pixels(column), 0) : 0;
  // Reserve is an automatic-admission budget only; explicit extras retain the
  // native title minimum and can request local horizontal overflow.
  const identityMinimum = unique.filter(column => column.identity).reduce((sum, column) => sum + pixels(column), 0);
  const reserve = unique.some(column => column.identity) && Number.isFinite(identityReserve) ? Math.max(0, identityReserve - identityMinimum) : 0;
  const visible = new Set(unique.filter(column => required(column) || choices[column.key] === true).map(column => column.key));
  for (const column of unique) {
    if (visible.has(column.key) || choices[column.key] === false || width < column.autoMinWidth) continue;
    if (Number.isFinite(width) && width > 0 && budget(unique.filter(item => visible.has(item.key) || item === column)) + reserve <= width) visible.add(column.key);
  }
  const projected = unique.filter(column => visible.has(column.key));
  return {visibleKeys: projected.map(column => column.key), minWidth: budget(projected),
    gridTemplate: projected.map(column => column.identity ? `minmax(${pixels(column)}px,1fr)` : `${pixels(column)}px`).join(' ')};
}

/** Native cells are retained. React owns this bounded owner's lifetime and choices. */
export function bindTrackTablePresentation(host, initial) {
  const document = host.ownerDocument, window = document.defaultView;
  let options = initial, disposed = false, press = null, tail = null, menu = null, menuProof = null;
  let tables = [], plan = null, parent = host.parentElement, resizeFrame = null;
  const headerTabs = new Map(), measuredWidths = new Map(), labels = new Map();
  const current = () => !disposed && host.isConnected && !host.closest('[hidden],[inert],[aria-hidden="true"]')
    && options.isCurrent?.() !== false;
  const ancestry = () => {const nodes = []; for (let node = host; node; node = node.parentNode) nodes.push(node); return nodes;};
  const proof = anchor => ({source: options.source, anchor, ancestors: ancestry(), header: anchor?.closest('.compact-data-table-header')});
  const valid = saved => {
    const ancestors = ancestry();
    return current() && saved.source === options.source && saved.anchor?.isConnected
      && saved.ancestors.length === ancestors.length && saved.ancestors.every((node, index) => ancestors[index] === node)
      && (!saved.header || host.contains(saved.header));
  };
  const cancel = () => {if (press) window.clearTimeout(press.timer); press = null;};
  const close = settings => {menu?.close?.(settings); menu = null; menuProof = null;};
  const retire = () => {cancel(); tail = null; close();};
  const heading = target => {
    const node = target?.closest?.('.compact-data-table-header');
    return node && host.contains(node) && tables.includes(node.closest('.compact-data-table')) ? node : null;
  };
  const menuAnchor = (target, header) => {
    const button = target.closest('button');
    if (button && !button.disabled) return button;
    const cell = target.closest('[role="columnheader"]');
    return cell?.querySelector('[data-cdt-column-label]')
      || [...header.querySelectorAll('[data-cdt-column-label],button:not(:disabled)')]
        .find(node => !node.closest('[data-cdt-responsive-hidden]')) || null;
  };
  const restoreLabel = (label, original) => {
    if (original.wrapped) label.replaceWith(...label.childNodes);
    else {
      if (original.tabindex === null) label.removeAttribute('tabindex'); else label.setAttribute('tabindex', original.tabindex);
      if (original.marker === null) label.removeAttribute('data-cdt-column-label'); else label.setAttribute('data-cdt-column-label', original.marker);
      if (original.expanded === null) label.removeAttribute('aria-expanded'); else label.setAttribute('aria-expanded', original.expanded);
    }
  };
  function paint() {
    if (!current()) return;
    const next = [...host.querySelectorAll('.compact-data-table')];
    if (host.matches('.compact-data-table')) next.unshift(host);
    if (parent !== host.parentElement || tables.some(table => !next.includes(table))) retire();
    parent = host.parentElement; tables = next;
    for (const [header, original] of headerTabs) if (!host.contains(header)) {
      if (original === null) header.removeAttribute('tabindex'); else header.setAttribute('tabindex', original);
      headerTabs.delete(header);
    }
    for (const [label, original] of labels) if (!host.contains(label)) {restoreLabel(label, original); labels.delete(label);}
    // Use rendered text ranges, not assigned grid widths, so repeated sizing
    // never ratchets a flexible column wider. Hidden optional cells use minima.
    const widthsByKey = new Map(options.columns.filter(column => !column.identity)
      .map(column => [column.key, Math.max(column.width, measuredWidths.get(column.key) || 0)]));
    for (const table of tables) for (const cell of table.querySelectorAll('[data-cdt-column]')) {
      const key = cell.dataset.cdtColumn;
      if (!widthsByKey.has(key) || cell.hasAttribute('data-cdt-responsive-hidden')) continue;
      let width = widthsByKey.get(key);
      if (cell.scrollWidth > cell.clientWidth) width = Math.max(width, cell.scrollWidth);
      const walker = document.createTreeWalker(cell, window.NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        if (!walker.currentNode.textContent.trim() || walker.currentNode.parentElement.closest('.sr-only,svg')) continue;
        const range = document.createRange(); range.selectNodeContents(walker.currentNode);
        const rect = range.getBoundingClientRect?.();
        if (rect) width = Math.max(width, Math.ceil(rect.width) + (cell.querySelector('[data-cdt-sort]') ? 16 : 0));
      }
      widthsByKey.set(key, width); measuredWidths.set(key, width);
    }
    const measured = options.columns.map(column => column.identity ? column : {...column, width: widthsByKey.get(column.key)});
    const widths = [host.clientWidth || host.getBoundingClientRect().width, ...tables.map(table => table.clientWidth)].filter(value => value > 0);
    const width = widths.length ? Math.min(...widths) : 0;
    plan = resolveTrackTableColumns(measured, width, options.choices, {identityReserve: width <= 640 ? Math.min(240, width * .45) : 0});
    for (const table of tables) {
      table.setAttribute('data-cdt-responsive', '');
      table.style.setProperty('--cdt-responsive-columns', plan.gridTemplate);
      table.style.setProperty('--cdt-responsive-min-width', `${plan.minWidth}px`);
      for (const cell of table.querySelectorAll('[data-cdt-column]')) {
        const hidden = !plan.visibleKeys.includes(cell.dataset.cdtColumn);
        if (hidden && cell.contains(document.activeElement)) table.querySelector('.compact-data-table-header')?.focus({preventScroll: true});
        cell.toggleAttribute('data-cdt-responsive-hidden', hidden);
      }
      const header = table.querySelector('.compact-data-table-header');
      if (header && !headerTabs.has(header)) {headerTabs.set(header, header.getAttribute('tabindex')); header.setAttribute('tabindex', '0');}
      for (const cell of header?.querySelectorAll('[role="columnheader"]') || []) {
        const button = cell.querySelector('[data-cdt-sort]');
        if (button) continue;
        let label = cell.querySelector('[data-cdt-column-label]');
        const wrapped = !label;
        if (!label) {
          label = document.createElement('span');
          label.append(...cell.childNodes); cell.append(label);
        }
        if (!labels.has(label)) {
          labels.set(label, {wrapped, tabindex: label.getAttribute('tabindex'), marker: label.getAttribute('data-cdt-column-label'), expanded: label.getAttribute('aria-expanded')});
          label.setAttribute('data-cdt-column-label', ''); label.setAttribute('tabindex', '-1');
        }
      }
    }
  }
  function openColumns(anchor) {
    if (!current() || !anchor?.isConnected || anchor.disabled || anchor.closest('[hidden],[inert],[aria-hidden="true"]')
      || typeof options.openChoice !== 'function') return false;
    paint();
    const optional = options.columns.filter(column => !column.required && !column.identity);
    if (!optional.length) return false;
    const saved = proof(anchor), visible = new Set(plan.visibleKeys);
    close(); menuProof = saved;
    menu = options.openChoice(anchor, {label: 'Track columns', selected: '', menuWidth: 'content', matchTriggerWidth: false,
      density: 'compact', actionMenu: true, updateTriggerLabel: false,
      formats: [...optional.map(column => ({value: column.key, label: `${visible.has(column.key) ? 'Hide' : 'Show'} ${column.label}`})),
        {value: '__defaults', label: 'Restore default columns'}],
      onSelect: key => {
        if (!valid(saved) || key !== '__defaults' && !optional.some(column => column.key === key)) return;
        const next = key === '__defaults' ? {} : {...options.choices, [key]: !visible.has(key)};
        // Restore through native Choice before a synchronous consumer update
        // can hide the originating label or retire this menu.
        close({restoreFocus: true});
        options.onChoicesChange?.(next);
        if (saved.anchor.closest('[data-cdt-responsive-hidden]')) saved.header?.focus({preventScroll: true});
      }});
    return true;
  }
  const pointerdown = event => {
    tail = null; cancel();
    const header = heading(event.target);
    if (!header || event.isPrimary === false || event.button !== 0 || !current()) return;
    const anchor = menuAnchor(event.target, header);
    const saved = proof(anchor), work = {saved, header, id: event.pointerId, x: event.clientX, y: event.clientY};
    press = work;
    work.timer = window.setTimeout(() => {
      if (press !== work) return;
      press = null;
      if (valid(saved) && openColumns(anchor)) tail = {header, target: event.target.closest('[role="columnheader"]') || header, id: work.id, releasedUntil: null};
    }, 500);
  };
  const pointermove = event => {if (press && (event.pointerId !== press.id || Math.hypot(event.clientX - press.x, event.clientY - press.y) > 8)) cancel();};
  const click = event => {
    if (tail && event.detail > 0 && (tail.releasedUntil === null || Date.now() <= tail.releasedUntil) && tail.target.contains(event.target)
      && (!('pointerId' in event) || event.pointerId === tail.id)) {
      tail = null; event.preventDefault(); event.stopImmediatePropagation();
    } else if (event.detail > 0) tail = null;
  };
  const contextmenu = event => {
    const header = heading(event.target); if (!header) return;
    cancel();
    if (tail?.header === header || openColumns(menuAnchor(event.target, header))) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  };
  const keydown = event => {
    if (event.key === 'Escape') cancel();
    if (event.repeat || event.isComposing || !heading(event.target)) return;
    if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10' || event.altKey && event.key === 'ArrowDown') contextmenu(event);
  };
  const resize = () => {retire(); paint();};
  const observedResize = () => {
    if (disposed) return;
    retire();
    // Painting can change the observed host's height when local scrollbars
    // appear. Leave observer delivery before measuring and writing that layout.
    if (resizeFrame !== null) return;
    resizeFrame = window.requestAnimationFrame(() => {
      resizeFrame = null;
      paint();
    });
  };
  const pointerup = event => {
    cancel();
    // A held, consumed press stays consumed until release, however long held.
    if (tail && event.pointerId === tail.id) tail.releasedUntil = Date.now() + 1000;
  };
  const touchstart = event => {if (event.touches.length > 1) retire();};
  const events = {touchstart, pointerdown, pointermove, pointerup, pointercancel: retire, click, contextmenu, keydown, scroll: cancel};
  for (const [name, listener] of Object.entries(events)) document.addEventListener(name, listener, {capture: true, passive: ['pointermove', 'scroll'].includes(name)});
  window.addEventListener('resize', resize); window.addEventListener('blur', retire); window.addEventListener('scroll', cancel, true);
  const observer = typeof window.ResizeObserver === 'function' ? new window.ResizeObserver(observedResize) : null;
  observer?.observe(host);
  const structure = new window.MutationObserver(() => {
    if (press && !valid(press.saved) || menuProof && !valid(menuProof)) retire();
  });
  structure.observe(document.documentElement, {childList: true, subtree: true});
  paint();
  return {openColumns,
    update(next) {
      if (disposed) return;
      if (Object.hasOwn(next, 'source') && next.source !== options.source
        || Object.hasOwn(next, 'choices') && next.choices !== options.choices
        || next.openChoice && next.openChoice !== options.openChoice) retire();
      if (Object.hasOwn(next, 'source') && next.source !== options.source) measuredWidths.clear();
      options = {...options, ...next};
      if (!current()) retire(); else paint();
    },
    dispose() {
      if (disposed) return; retire(); disposed = true; observer?.disconnect(); structure.disconnect();
      if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame);
      resizeFrame = null;
      for (const [name, listener] of Object.entries(events)) document.removeEventListener(name, listener, true);
      window.removeEventListener('resize', resize); window.removeEventListener('blur', retire); window.removeEventListener('scroll', cancel, true);
      for (const table of tables) {
        table.removeAttribute('data-cdt-responsive'); table.style.removeProperty('--cdt-responsive-columns'); table.style.removeProperty('--cdt-responsive-min-width');
        for (const cell of table.querySelectorAll('[data-cdt-responsive-hidden]')) cell.removeAttribute('data-cdt-responsive-hidden');
      }
      for (const [header, original] of headerTabs) {if (original === null) header.removeAttribute('tabindex'); else header.setAttribute('tabindex', original);}
      for (const [label, original] of labels) restoreLabel(label, original);
      labels.clear(); headerTabs.clear(); measuredWidths.clear(); tables = [];
    }};
}
