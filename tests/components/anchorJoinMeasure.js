// Reads an open trigger/panel pair's painted outline from a device-pixel screenshot.
// The outline is the accent line drawn by runtime/trigger-anchor.css around the
// trigger and down the panel side(s) it shares with the trigger.
async function measureAnchorJoin(page, anchor, surface) {
  await page.mouse.move(1, 1);
  // The cap colour animates back from the hover colour (220 ms).
  await page.waitForTimeout(320);
  const ids = {};
  for (const [key, locator] of [['anchor', anchor], ['surface', surface]]) {
    ids[key] = await locator.evaluate((element, fallback) => {
      element.id ||= fallback;
      return `#${CSS.escape(element.id)}`;
    }, `anchor-join-${key}`);
  }
  const screenshot = await page.screenshot({ animations: 'disabled', scale: 'device' });
  return page.evaluate(async ({ base64, anchorSelector, surfaceSelector }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, image.width, image.height).data;
    const scale = image.width / window.innerWidth;
    const anchorElement = document.querySelector(anchorSelector);
    const trigger = anchorElement.getBoundingClientRect();
    const panel = document.querySelector(surfaceSelector).getBoundingClientRect();
    const probe = document.createElement('span');
    probe.style.color = getComputedStyle(anchorElement).getPropertyValue('--trigger-anchor-accent').trim();
    document.body.appendChild(probe);
    const accent = getComputedStyle(probe).color.match(/[\d.]+/g).slice(0, 3).map(Number);
    probe.remove();
    const isAccent = (x, y) => {
      if (x < 0 || y < 0 || x >= image.width || y >= image.height) return false;
      const offset = (y * image.width + x) * 4;
      return accent.every((channel, index) => Math.abs(data[offset + index] - channel) <= 48);
    };
    const below = panel.top >= trigger.bottom - 2;
    const px = value => Math.round(value * scale);
    const rows = (from, to) => {
      const list = [];
      for (let y = px(Math.min(from, to)); y <= px(Math.max(from, to)); y += 1) list.push(y);
      return list;
    };
    // Rows that must carry the trigger's own outline, and the panel rows next to the join.
    const triggerRows = below ? rows(trigger.top + 8, trigger.bottom - 2) : rows(trigger.top + 2, trigger.bottom - 8);
    const joinRows = below ? rows(trigger.bottom - 2, panel.top + 4) : rows(panel.bottom - 4, trigger.top + 2);
    const panelRows = below ? rows(panel.top + 1, panel.top + 4) : rows(panel.bottom - 4, panel.bottom - 1);
    const outerEdge = (side, y) => {
      const center = px(trigger[side]);
      const reach = px(8);
      let found = null;
      for (let x = center - reach; x <= center + reach; x += 1) {
        if (!isAccent(x, y)) continue;
        if (side === 'left') { found = x; break; }
        found = x + 1;
      }
      return found === null ? null : found / scale;
    };
    // Down to the panel's top line where the panel only meets the trigger's corner.
    const cornerRows = below ? rows(trigger.bottom - 2, panel.top) : rows(panel.bottom, trigger.top + 2);
    const fill = getComputedStyle(document.querySelector(surfaceSelector)).backgroundColor
      .match(/[\d.]+/g).slice(0, 3).map(Number);
    const isStroke = (x, y) => {
      const offset = (y * image.width + x) * 4;
      return fill.some((channel, index) => Math.abs(data[offset + index] - channel) > 12);
    };
    const sides = {};
    for (const side of ['left', 'right']) {
      const flush = Math.abs(panel[side] - trigger[side]) <= 4;
      const edgeRows = [...triggerRows, ...(flush ? joinRows : cornerRows)];
      const missingRows = edgeRows.filter(y => outerEdge(side, y) === null).map(y => y / scale);
      const triggerEdges = triggerRows.map(y => outerEdge(side, y)).filter(value => value !== null);
      const panelEdges = flush ? panelRows.map(y => outerEdge(side, y)).filter(value => value !== null) : [];
      const all = [...triggerEdges, ...panelEdges];
      // Where the panel extends past the trigger, its top line meets the trigger's outline.
      const outward = side === 'left' ? -1 : 1;
      const lineY = below ? panel.top : panel.bottom;
      const cornerGap = !flush && [2, 3, 4].some(dx => ![-2, -1, 0, 1].some(dy =>
        isStroke(px(trigger[side] + outward * dx), px(lineY) + dy)));
      sides[side] = {
        flush,
        missingRows,
        step: all.length ? Math.max(...all) - Math.min(...all) : null,
        cornerGap,
      };
    }
    // Inside the outline, the trigger's interior runs into the panel's: no row of
    // the join carries a separator line.
    const separatorRows = (below ? rows(trigger.bottom - 3, panel.top + 3) : rows(panel.bottom - 3, trigger.top + 3))
      .filter(y => {
        for (let x = px(trigger.left + 4); x <= px(trigger.right - 4); x += 1) if (isStroke(x, y)) return true;
        return false;
      }).map(y => y / scale);
    // The trigger's own top (or bottom) edge stays outlined across its width.
    const capY = below ? trigger.top : trigger.bottom;
    const capGaps = [];
    for (let x = px(trigger.left + 10); x <= px(trigger.right - 10); x += 1) {
      if (![-3, -2, -1, 0, 1, 2, 3].some(dy => isAccent(x, px(capY) + dy))) capGaps.push(x / scale);
    }
    return {
      trigger: { left: trigger.left, right: trigger.right, top: trigger.top, bottom: trigger.bottom },
      panel: { left: panel.left, right: panel.right, top: panel.top, bottom: panel.bottom },
      sides,
      capGaps,
      separatorRows,
    };
  }, { base64: screenshot.toString('base64'), anchorSelector: ids.anchor, surfaceSelector: ids.surface });
}

// One continuous outline: each shared side has one outer edge from the trigger into the
// panel, no row of the outline is missing, and a wider panel's top line meets the trigger.
function expectContinuousJoin(expect, result, { flushSides, label }) {
  for (const side of ['left', 'right']) {
    const measured = result.sides[side];
    expect(measured.flush, `${label}: ${side} edges ${flushSides.includes(side) ? 'line up' : 'differ'}`)
      .toBe(flushSides.includes(side));
    expect(measured.missingRows, `${label}: ${side} outline has no missing rows`).toEqual([]);
    if (measured.flush) {
      expect(measured.step, `${label}: ${side} trigger and panel edges are one line (px)`).toBeLessThanOrEqual(0.5);
    } else {
      expect(measured.cornerGap, `${label}: ${side} corner joins the panel top line`).toBe(false);
    }
  }
  expect(result.capGaps, `${label}: trigger outline is closed across its far edge`).toEqual([]);
  expect(result.separatorRows, `${label}: no separator line between trigger and panel`).toEqual([]);
}

// Reads each joined corner of an open trigger/panel pair from a device-pixel
// screenshot. A side is flush (the panel continues the trigger's side line) or
// open (the panel's top line runs outward from the trigger's side line).
async function measureAnchorCorners(page, anchor, surface) {
  await page.mouse.move(1, 1);
  await page.waitForTimeout(320);
  const screenshot = await page.screenshot({ animations: 'disabled', scale: 'device' });
  const anchorHandle = await anchor.elementHandle();
  const surfaceHandle = await surface.elementHandle();
  return page.evaluate(async ({ base64, anchorElement, surfaceElement }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, image.width, image.height).data;
    const scale = image.width / window.innerWidth;
    const visual = anchorElement.closest('.ui-dropdown-control') || anchorElement;
    const trigger = visual.getBoundingClientRect();
    const panel = surfaceElement.getBoundingClientRect();
    const rgb = color => {
      const probe = document.createElement('span');
      probe.style.color = color;
      document.body.appendChild(probe);
      const value = getComputedStyle(probe).color.match(/[\d.]+/g).slice(0, 3).map(Number);
      probe.remove();
      return value;
    };
    const accent = rgb(getComputedStyle(visual).getPropertyValue('--trigger-anchor-accent').trim());
    const interior = rgb(getComputedStyle(surfaceElement).backgroundColor);
    const near = (x, y, color, tolerance) => {
      if (x < 0 || y < 0 || x >= image.width || y >= image.height) return false;
      const offset = (y * image.width + x) * 4;
      return color.every((channel, index) => Math.abs(data[offset + index] - channel) <= tolerance);
    };
    const isAccent = (x, y) => near(x, y, accent, 48);
    const px = value => Math.round(value * scale);
    // The accent run crossing a row, scanned inward from outside the trigger's side.
    const run = (side, y) => {
      const outward = side === 'left' ? -1 : 1;
      const start = px(trigger[side]) + outward * px(6);
      let x = start;
      while (!isAccent(x, y) && Math.abs(x - start) < px(14)) x -= outward;
      if (!isAccent(x, y)) return null;
      let width = 0;
      while (isAccent(x - outward * width, y)) width += 1;
      return { outer: side === 'left' ? x : x + 1, width };
    };
    const below = panel.top >= trigger.bottom - 2;
    const step = below ? 1 : -1;
    const triggerY = px((trigger.top + trigger.bottom) / 2);
    const sides = {};
    for (const side of ['left', 'right']) {
      const outward = side === 'left' ? -1 : 1;
      const line = run(side, triggerY);
      const flush = Math.abs(panel[side] - trigger[side]) <= 4;
      const result = { flush, triggerLine: line };
      sides[side] = result;
      if (!line) continue;
      const outerColumn = side === 'left' ? line.outer : line.outer - 1;
      const innerColumn = outerColumn - outward * (line.width - 1);
      if (flush) {
        // Below the trigger the side line keeps the trigger's outer edge and width,
        // and the panel's own edge is that outer edge.
        result.mismatchedPanelRows = [];
        const edgeY = below ? panel.top : panel.bottom;
        for (let dy = 1; dy <= px(12); dy += 1) {
          const y = px(edgeY) + step * dy;
          const measured = run(side, y);
          if (!measured || measured.outer !== line.outer || measured.width !== line.width) {
            result.mismatchedPanelRows.push({ y: y / scale, ...measured });
          }
        }
        result.panelEdgeOffset = (px(panel[side]) - line.outer) / scale;
        continue;
      }
      // The panel's top line, read in a column just outside the trigger.
      const column = outerColumn + outward * px(4);
      const lineRows = [];
      for (let y = px(below ? trigger.bottom - 4 : panel.bottom - 6); y <= px(below ? panel.top + 6 : trigger.top + 4); y += 1) {
        if (isAccent(column, y)) lineRows.push(y);
      }
      result.panelLineRows = lineRows.length;
      if (!lineRows.length) continue;
      const lineNear = below ? Math.min(...lineRows) : Math.max(...lineRows);
      const lineFar = below ? Math.max(...lineRows) : Math.min(...lineRows);
      // The side line ends on the panel line's far edge: it neither stops short nor overshoots.
      result.sideLineOvershoot = [outerColumn, innerColumn].map(x => {
        let y = triggerY;
        while (isAccent(x, y + step)) y += step;
        return ((y - lineFar) * step) / scale;
      });
      // The outside corner is filled where the side line and the panel line meet.
      result.cornerHoles = [];
      for (let y = Math.min(lineNear, lineFar); y <= Math.max(lineNear, lineFar); y += 1) {
        for (let x = innerColumn; x !== outerColumn + outward * px(6); x += outward) {
          if (!isAccent(x, y)) result.cornerHoles.push([x / scale, y / scale]);
        }
      }
      // Inside the corner the trigger runs into the panel: interior colour only,
      // no notch and no stub of the panel line.
      result.innerCornerNotches = [];
      for (let y = Math.min(lineNear, lineFar) - px(3); y <= Math.max(lineNear, lineFar) + px(3); y += 1) {
        for (let dx = 1; dx <= px(4); dx += 1) {
          const x = innerColumn - outward * dx;
          if (!near(x, y, interior, 12)) result.innerCornerNotches.push([x / scale, y / scale]);
        }
      }
    }
    const joinRadius = style => (below
      ? { left: style.borderBottomLeftRadius, right: style.borderBottomRightRadius }
      : { left: style.borderTopLeftRadius, right: style.borderTopRightRadius });
    const panelStyle = getComputedStyle(surfaceElement);
    return {
      sides,
      triggerJoinRadius: [undefined, '::after', '::before'].map(pseudo => joinRadius(getComputedStyle(visual, pseudo))),
      panelJoinRadius: below
        ? { left: panelStyle.borderTopLeftRadius, right: panelStyle.borderTopRightRadius }
        : { left: panelStyle.borderBottomLeftRadius, right: panelStyle.borderBottomRightRadius },
    };
  }, { base64: screenshot.toString('base64'), anchorElement: anchorHandle, surfaceElement: surfaceHandle });
}

// Every joined corner meets at a right angle, with one 2 px line width on both sides.
function expectSquareCorners(expect, result, { label, scale }) {
  const square = { left: '0px', right: '0px' };
  for (const radius of result.triggerJoinRadius) expect(radius, `${label}: trigger corners at the join are square`).toEqual(square);
  expect(result.panelJoinRadius, `${label}: panel corners at the join are square`).toEqual(square);
  for (const side of ['left', 'right']) {
    const measured = result.sides[side];
    expect(measured.triggerLine?.width, `${label}: ${side} trigger outline is 2 px`).toBe(2 * scale);
    if (measured.flush) {
      expect(measured.mismatchedPanelRows, `${label}: ${side} panel side line keeps the trigger outline's edge and width`).toEqual([]);
      expect(measured.panelEdgeOffset, `${label}: ${side} panel edge is the outline's outer edge (px)`).toBe(0);
    } else {
      expect(measured.panelLineRows, `${label}: ${side} panel top line is 2 px`).toBe(2 * scale);
      expect(measured.sideLineOvershoot, `${label}: ${side} side line ends on the panel line's far edge (px)`).toEqual([0, 0]);
      expect(measured.cornerHoles, `${label}: ${side} outer corner is filled`).toEqual([]);
      expect(measured.innerCornerNotches, `${label}: ${side} inner corner has no notch or stub`).toEqual([]);
    }
  }
}

module.exports = { measureAnchorJoin, expectContinuousJoin, measureAnchorCorners, expectSquareCorners };
