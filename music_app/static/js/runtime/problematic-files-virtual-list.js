(function registerProblematicFilesVirtualList(global) {
  const DEFAULT_ROW_STRIDE = 68;
  const DEFAULT_OVERSCAN = 6;
  const savedOffsets = new WeakMap();

  function clamp(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), maximum);
  }

  function calculateRange({ count, offset, viewport, stride = DEFAULT_ROW_STRIDE, overscan = DEFAULT_OVERSCAN }) {
    if (!count) return { start: 0, end: 0 };
    const visibleStart = Math.floor(Math.max(0, offset) / stride);
    const visibleCount = Math.max(1, Math.ceil(Math.max(1, viewport) / stride));
    return {
      start: clamp(visibleStart - overscan, 0, count),
      end: clamp(visibleStart + visibleCount + overscan, 0, count),
    };
  }

  function create({
    list,
    renderRow,
    onNearEnd,
    rowStride = DEFAULT_ROW_STRIDE,
    overscan = DEFAULT_OVERSCAN,
  }) {
    if (!list || typeof renderRow !== 'function') {
      throw new TypeError('Problematic Files virtualization requires a list and row renderer.');
    }

    let items = [];
    let selectedKey = '';
    let frame = 0;
    let disposed = false;
    let spacerGeometry = '';
    let footerText = '';
    const mountedRows = new Map();
    // A status line after the last row (more results loading), kept after the trailing spacer.
    const footer = list.ownerDocument.createElement('div');
    footer.className = 'utility-empty-state compact';
    footer.setAttribute('data-problematic-list-footer', '');
    footer.setAttribute('role', 'status');
    const [before, after] = ['before', 'after'].map((position) => {
      const spacer = list.ownerDocument.createElement('div');
      spacer.className = 'problematic-virtual-spacer';
      spacer.setAttribute('data-problematic-virtual-spacer', position);
      spacer.setAttribute('aria-hidden', 'true');
      return spacer;
    });
    const savedOffset = savedOffsets.get(list) || { horizontal: 0, vertical: 0 };
    list.scrollLeft = savedOffset.horizontal;
    list.scrollTop = savedOffset.vertical;

    // The list's own layout names its axis and what scrolls it: a row strip scrolls itself sideways; a
    // column scrolls itself, or, when it does not clip (the phone Settings page), moves with the page:
    // then the screen is its viewport and any scroll may move it.
    const listStyle = global.getComputedStyle?.(list) || null;
    const horizontal = Boolean(listStyle && /flex/.test(listStyle.display) && listStyle.flexDirection.startsWith('row'));
    const scrollsItself = !listStyle || /auto|scroll/.test(horizontal ? listStyle.overflowX : listStyle.overflowY);
    const scrollTarget = scrollsItself ? list : list.ownerDocument;
    const scrollListenerOptions = { passive: true, capture: !scrollsItself };
    let forcedOffset = null;
    const getStride = () => (
      horizontal ? Math.min(240, Math.max(1, Number(list.clientWidth) * 0.78)) + 8 : rowStride
    );
    // The list's scroll offset and visible extent along its axis.
    const readViewport = () => {
      if (forcedOffset !== null) return { offset: forcedOffset, viewport: Number(global.innerHeight) };
      if (scrollsItself) {
        return horizontal
          ? { offset: Number(list.scrollLeft), viewport: Number(list.clientWidth) }
          : { offset: Number(list.scrollTop), viewport: Number(list.clientHeight) };
      }
      return { offset: Math.max(0, -list.getBoundingClientRect().top), viewport: Number(global.innerHeight) };
    };

    const renderNow = () => {
      if (frame) global.cancelAnimationFrame(frame);
      frame = 0;
      if (disposed) return;
      const stride = getStride();
      const { offset, viewport } = readViewport();
      const visibleStart = Math.floor(Math.max(0, offset) / stride);
      const visibleCount = Math.max(1, Math.ceil(Math.max(1, viewport) / stride));
      const range = calculateRange({
        count: items.length,
        offset,
        viewport,
        stride,
        overscan,
      });
      const beforeSize = range.start * stride;
      const afterSize = (items.length - range.end) * stride;
      const dimension = horizontal ? 'width' : 'height';
      const visibleItems = items.slice(range.start, range.end);
      const keys = new Set(visibleItems.map((item) => String(item.key)));
      const focused = list.ownerDocument.activeElement;
      const nextSpacerGeometry = `${dimension}:${beforeSize}:${afterSize}`;
      if (spacerGeometry !== nextSpacerGeometry) {
        before.style.cssText = `${dimension}:${beforeSize}px`;
        after.style.cssText = `${dimension}:${afterSize}px`;
        spacerGeometry = nextSpacerGeometry;
      }
      if (before.parentNode !== list) list.replaceChildren(before, after);
      if (footerText) {
        if (footer.textContent !== footerText) footer.textContent = footerText;
        if (after.nextElementSibling !== footer) list.insertBefore(footer, after.nextElementSibling);
      } else if (footer.parentNode === list) footer.remove();
      for (const [key, row] of mountedRows) {
        if (keys.has(key)) continue;
        row.remove();
        mountedRows.delete(key);
      }
      let previous = before;
      for (const item of visibleItems) {
        const key = String(item.key);
        let row = mountedRows.get(key);
        if (!row) {
          const template = list.ownerDocument.createElement('template');
          template.innerHTML = renderRow(item, key === selectedKey);
          row = template.content.firstElementChild;
          mountedRows.set(key, row);
        }
        if (previous.nextElementSibling !== row) list.insertBefore(row, previous.nextElementSibling);
        previous = row;
      }
      if (scrollsItself) {
        if (horizontal) list.scrollLeft = offset;
        else list.scrollTop = offset;
      }
      if (focused && list.contains(focused) && list.ownerDocument.activeElement !== focused) {
        focused.focus({ preventScroll: true });
      }
      const metadata = {
        problematicMountedCount: String(range.end - range.start),
        problematicVirtualStart: String(range.start),
        problematicVirtualEnd: String(range.end),
        problematicVirtualAxis: horizontal ? 'horizontal' : 'vertical',
      };
      for (const [key, value] of Object.entries(metadata)) {
        if (list.dataset[key] !== value) list.dataset[key] = value;
      }
      const prefetchRows = Math.max(overscan, visibleCount * 4);
      if (items.length && visibleStart + visibleCount >= Math.max(0, items.length - prefetchRows)) onNearEnd?.();
    };

    const schedule = () => {
      if (disposed || frame) return;
      frame = global.requestAnimationFrame(renderNow);
    };

    // Opening the modal changes this viewport without resizing the window.
    const resizeObserver = typeof global.ResizeObserver === 'function'
      ? new global.ResizeObserver(schedule)
      : null;
    resizeObserver?.observe(list);

    const reveal = (key) => {
      const index = items.findIndex((item) => String(item?.key || '') === String(key || ''));
      if (index < 0) return;
      const stride = getStride();
      if (!scrollsItself) {
        // Mount the row's window, then let the page bring the row into view.
        if (!mountedRows.has(String(key))) {
          forcedOffset = index * stride;
          renderNow();
          forcedOffset = null;
        }
        mountedRows.get(String(key))?.scrollIntoView?.({ block: 'nearest' });
        schedule();
        return;
      }
      const { offset: current, viewport } = readViewport();
      const start = index * stride;
      const end = start + stride;
      let next = current;
      if (start < current) next = start;
      else if (end > current + viewport) next = Math.max(0, end - viewport);
      if (next === current) return;
      if (horizontal) list.scrollLeft = next;
      else list.scrollTop = next;
      schedule();
    };

    const render = (nextItems, nextSelectedKey, { footer: nextFooter = '' } = {}) => {
      const previousSelectedKey = selectedKey;
      items = Array.isArray(nextItems) ? nextItems : [];
      selectedKey = String(nextSelectedKey || '');
      footerText = String(nextFooter || '');
      renderNow();
      if (selectedKey !== previousSelectedKey) {
        reveal(selectedKey);
        renderNow();
      }
    };

    const handleKeydown = (event) => {
      if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;
      const row = event.target.closest?.('[data-problematic-album-key]');
      if (!row || !list.contains(row)) return;
      const index = items.findIndex((item) => String(item.key) === row.getAttribute('data-problematic-album-key'));
      const nextIndex = index + (event.shiftKey ? -1 : 1);
      if (index < 0 || nextIndex < 0 || nextIndex >= items.length) return;
      const key = String(items[nextIndex].key);
      if (mountedRows.has(key)) return;
      event.preventDefault();
      reveal(key);
      renderNow();
      mountedRows.get(key)?.focus({ preventScroll: true });
    };

    const dispose = () => {
      if (disposed) return;
      disposed = true;
      savedOffsets.set(list, {
        horizontal: Number(list.scrollLeft) || 0,
        vertical: Number(list.scrollTop) || 0,
      });
      scrollTarget.removeEventListener('scroll', schedule, scrollListenerOptions);
      list.removeEventListener('keydown', handleKeydown);
      global.removeEventListener?.('resize', schedule);
      resizeObserver?.disconnect();
      if (frame) global.cancelAnimationFrame(frame);
      delete list.dataset.problematicMountedCount;
      delete list.dataset.problematicVirtualStart;
      delete list.dataset.problematicVirtualEnd;
      delete list.dataset.problematicVirtualAxis;
    };

    scrollTarget.addEventListener('scroll', schedule, scrollListenerOptions);
    list.addEventListener('keydown', handleKeydown);
    global.addEventListener?.('resize', schedule, { passive: true });
    return { render, reveal, dispose };
  }

  global.ProblematicFilesVirtualList = { calculateRange, create };
}(window));
