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
    const sides = {};
    for (const side of ['left', 'right']) {
      const flush = Math.abs(panel[side] - trigger[side]) <= 4;
      const edgeRows = flush ? [...triggerRows, ...joinRows] : [...triggerRows, ...rows(trigger.bottom - 2, panel.top)];
      const missingRows = edgeRows.filter(y => outerEdge(side, y) === null).map(y => y / scale);
      const triggerEdges = triggerRows.map(y => outerEdge(side, y)).filter(value => value !== null);
      const panelEdges = flush ? panelRows.map(y => outerEdge(side, y)).filter(value => value !== null) : [];
      const all = [...triggerEdges, ...panelEdges];
      // Where the panel extends past the trigger, its top line meets the trigger's outline.
      const outward = side === 'left' ? -1 : 1;
      const lineY = below ? panel.top : panel.bottom;
      const fill = getComputedStyle(document.querySelector(surfaceSelector)).backgroundColor
        .match(/[\d.]+/g).slice(0, 3).map(Number);
      const isStroke = (x, y) => {
        const offset = (y * image.width + x) * 4;
        return fill.some((channel, index) => Math.abs(data[offset + index] - channel) > 12);
      };
      const cornerGap = !flush && [2, 3, 4].some(dx => ![-2, -1, 0, 1].some(dy =>
        isStroke(px(trigger[side] + outward * dx), px(lineY) + dy)));
      sides[side] = {
        flush,
        missingRows,
        step: all.length ? Math.max(...all) - Math.min(...all) : null,
        triggerEdge: triggerEdges.length ? triggerEdges[0] : null,
        panelEdge: panelEdges.length ? panelEdges[0] : null,
        cornerGap,
      };
    }
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
}

module.exports = { measureAnchorJoin, expectContinuousJoin };
