(function registerProblematicFilesVirtualList(global) {
  const DEFAULT_ROW_STRIDE = 68;
  const DEFAULT_OVERSCAN = 6;
  const MOBILE_BREAKPOINT = '(max-width: 720px)';
  const savedOffsets = new WeakMap();

  function clamp(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), maximum);
  }

  function calculateRange({ count, offset, viewport, stride, overscan }) {
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
    const savedOffset = savedOffsets.get(list) || { horizontal: 0, vertical: 0 };
    list.scrollLeft = savedOffset.horizontal;
    list.scrollTop = savedOffset.vertical;

    const isHorizontal = () => Boolean(global.matchMedia?.(MOBILE_BREAKPOINT)?.matches);
    const getStride = (horizontal) => (
      horizontal ? Math.min(240, Math.max(1, Number(list.clientWidth) * 0.78)) + 8 : rowStride
    );

    const renderNow = () => {
      frame = 0;
      if (disposed) return;
      const horizontal = isHorizontal();
      const stride = getStride(horizontal);
      const offset = horizontal ? Number(list.scrollLeft) : Number(list.scrollTop);
      const viewport = horizontal ? Number(list.clientWidth) : Number(list.clientHeight);
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
      const rows = items.slice(range.start, range.end).map((item) => (
        renderRow(item, String(item?.key || '') === selectedKey)
      )).join('');

      list.innerHTML = [
        `<div class="problematic-virtual-spacer" data-problematic-virtual-spacer="before" style="${dimension}:${beforeSize}px" aria-hidden="true"></div>`,
        rows,
        `<div class="problematic-virtual-spacer" data-problematic-virtual-spacer="after" style="${dimension}:${afterSize}px" aria-hidden="true"></div>`,
      ].join('');
      list.dataset.problematicMountedCount = String(range.end - range.start);
      list.dataset.problematicVirtualStart = String(range.start);
      list.dataset.problematicVirtualEnd = String(range.end);
      list.dataset.problematicVirtualAxis = horizontal ? 'horizontal' : 'vertical';
    };

    const schedule = () => {
      if (disposed || frame) return;
      frame = global.requestAnimationFrame(renderNow);
    };

    const reveal = (key) => {
      const index = items.findIndex((item) => String(item?.key || '') === String(key || ''));
      if (index < 0) return;
      const horizontal = isHorizontal();
      const stride = getStride(horizontal);
      const viewport = horizontal ? Number(list.clientWidth) : Number(list.clientHeight);
      const current = horizontal ? Number(list.scrollLeft) : Number(list.scrollTop);
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

    const render = (nextItems, nextSelectedKey) => {
      const previousSelectedKey = selectedKey;
      items = Array.isArray(nextItems) ? nextItems : [];
      selectedKey = String(nextSelectedKey || '');
      renderNow();
      if (selectedKey !== previousSelectedKey) reveal(selectedKey);
    };

    const dispose = () => {
      if (disposed) return;
      disposed = true;
      savedOffsets.set(list, {
        horizontal: Number(list.scrollLeft) || 0,
        vertical: Number(list.scrollTop) || 0,
      });
      list.removeEventListener('scroll', schedule);
      global.removeEventListener?.('resize', schedule);
      if (frame) global.cancelAnimationFrame(frame);
      delete list.dataset.problematicMountedCount;
      delete list.dataset.problematicVirtualStart;
      delete list.dataset.problematicVirtualEnd;
      delete list.dataset.problematicVirtualAxis;
    };

    list.addEventListener('scroll', schedule, { passive: true });
    global.addEventListener?.('resize', schedule, { passive: true });
    return { render, reveal, dispose };
  }

  global.ProblematicFilesVirtualList = { calculateRange, create };
}(window));
