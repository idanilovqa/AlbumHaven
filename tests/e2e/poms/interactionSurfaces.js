import { expect } from '@playwright/test';

// All evaluations below observe rendered state; interactions use native Playwright input.
export async function expectStableButtonHover(page, button) {
  await page.mouse.move(1, 1);
  // parity-check: allow-read-only-measurement-evaluate -- compare rendered button colors
  const before = await button.evaluate(el => {
    const s = getComputedStyle(el);
    return { background: s.backgroundColor, image: s.backgroundImage, color: s.color };
  });
  // parity-check: allow-read-only-measurement-evaluate -- sample every frame across hover entry, including transient flashes
  const frames = button.evaluate(el => new Promise(resolve => {
    const samples = [];
    const started = performance.now();
    const sample = () => {
      const s = getComputedStyle(el);
      samples.push({ background: s.backgroundColor, image: s.backgroundImage, color: s.color });
      if (performance.now() - started >= 600) resolve(samples);
      else requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }));
  await button.hover();
  for (const frame of await frames) expect(frame).toEqual(before);
}

export async function expectSelectionDragStaysInside(page, panel) {
  const text = panel.locator('[data-artist-info-summary]');
  await expect(text).not.toBeEmpty();
  const box = await text.boundingBox();
  const panelBox = await panel.boundingBox();
  const outside = { x: Math.max(2, panelBox.x - 12), y: box.y + 10 };
  await page.mouse.move(box.x + 12, box.y + 10);
  await page.mouse.down();
  try {
    await page.mouse.move(box.x + Math.min(box.width - 5, 160), box.y + 10, { steps: 12 });
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(outside.x, outside.y + i * 3);
      // parity-check: allow-read-only-measurement-evaluate -- inspect selection containment and pre-paint suppression
      const observed = await panel.evaluate(el => {
        const selection = document.getSelection();
        const cards = [...document.querySelectorAll('.album-card')];
        return {
          selectionInside: Boolean(selection?.anchorNode && el.contains(selection.anchorNode) && el.contains(selection.focusNode)),
          cardsUnselectable: cards.length > 0 && cards.every(card => getComputedStyle(card).userSelect === 'none'),
        };
      });
      expect(observed).toEqual({ selectionInside: true, cardsUnselectable: true });
      await expect(panel).toBeVisible();
    }
  } finally { await page.mouse.up(); }
  await expect(panel).toBeVisible();
  await page.mouse.click(outside.x, outside.y);
  await expect(panel).toBeHidden();
}

export async function expectCombinedLoopWaveform(page) {
  const canvas = page.locator('[data-loop-stereo-waveform]:visible').first();
  await expect(canvas).toBeVisible();
  // parity-check: allow-read-only-measurement-evaluate -- inspect rendered canvas pixels, no injected peaks
  await expect.poll(() => canvas.evaluate(el => {
    const { width, height } = el;
    const pixels = el.getContext('2d').getImageData(0, 0, width, height).data;
    const center = Math.floor(height / 2);
    let painted = 0;
    let connected = 0;
    for (let x = 4; x < width - 4; x++) {
      let min = height, max = -1;
      for (let y = 0; y < height; y++) if (pixels[(y * width + x) * 4 + 3] > 0) { min = Math.min(min, y); max = y; }
      if (max < 0) continue;
      painted++;
      if (min <= center && max >= center && pixels[(center * width + x) * 4 + 3] > 0) connected++;
    }
    return painted > width / 4 && connected / painted > 0.95;
  }), { message: 'L+R must form one connected waveform around a single centerline' }).toBe(true);
}

export async function expectAlbumPauseFirstClick(page, globalPlayerActions) {
  const play = page.locator('#track-modal .play-track-button').first();
  for (const delay of [0, 180, 350]) {
    await expect(play).toHaveAttribute('aria-label', 'Pause track');
    await play.click({ delay });
    await globalPlayerActions.waitForPlaybackState({ paused: true });
    await expect(play).toHaveAttribute('aria-label', 'Play track');
    await play.click();
    await globalPlayerActions.waitForPlaybackState({ paused: false });
  }
}

export async function expectLoopPauseFirstClick(page) {
  const play = page.locator('[data-loop-play]:visible').first();
  const id = await play.getAttribute('data-loop-play');
  const audio = page.locator(`[data-loop-audio="${id}"]`);
  // parity-check: allow-read-only-measurement-evaluate -- observe rendered DOM, canvas, or media state
  if (await audio.evaluate(el => el.paused)) await play.click();
  for (const delay of [0, 180, 350]) {
  // parity-check: allow-read-only-measurement-evaluate -- observe rendered DOM, canvas, or media state
    await expect.poll(() => audio.evaluate(el => el.paused)).toBe(false);
    await play.click({ delay });
  // parity-check: allow-read-only-measurement-evaluate -- observe rendered DOM, canvas, or media state
    await expect.poll(() => audio.evaluate(el => el.paused)).toBe(true);
    await expect(play).toHaveAttribute('aria-label', 'Play');
    await play.click();
  }
  // parity-check: allow-read-only-measurement-evaluate -- observe rendered DOM, canvas, or media state
  await expect.poll(() => audio.evaluate(el => el.paused)).toBe(false);
  await play.click();
  // parity-check: allow-read-only-measurement-evaluate -- observe rendered DOM, canvas, or media state
  await expect.poll(() => audio.evaluate(el => el.paused)).toBe(true);
}

export class InteractionSurfaces {
  constructor(page) {
    this.root = page.locator('html');
    this.play = page.locator('#player-play');
    this.sourcesTrigger = page.getByRole('button', { name: 'Sources', exact: true });
    this.sourcesMenu = page.locator('#gallery-sources-menu');
    this.settingsTrigger = page.getByRole('button', { name: 'Settings', exact: true });
    this.settingsMenu = page.locator('#account-menu');
    this.preview = page.locator('.player-preview-dock');
    this.playerTitle = page.locator('.player-title');
    this.selectedTreeItem = page.locator('.navigation-tree-item.is-selected').first();
    this.panelDefault = page.locator('[data-panel-outline-theme]');
    this.panelSwatches = page.locator('[data-interaction-color="panel_outline"]');
    this.combine = page.locator('[data-toggle-combine-similar-artists]');
    this.familyTrigger = page.locator('[data-gallery-bar-action="artist-family"]');
    this.viewTrigger = page.locator('[data-gallery-view-cluster] button.is-active');
    this.typeTrigger = page.locator('[data-gallery-bar-action="album-types"]');
    this.familyPanel = page.locator('#artist-family-panel');
    this.typeMenu = page.locator('#gallery-album-types-menu');
    this.combinedHeading = page.locator('.family-artist-header .artist-name').filter({ hasText: /^Neal Morse \/ / });
    this.mainArtistInfo = page.locator('.family-artist-header [data-artist-info-trigger][data-artist="Neal Morse"]').first();
    this.infoPanel = page.locator('[data-artist-info-overlay]');
    this.cards = page.locator('.album-card');
    this.albumArt = page.locator('#track-modal .track-modal-cover-button');
    this.playingRow = page.locator('#track-modal .album-track-table__row--playing');
    this.galleryScroll = page.locator('#albums-scroll');
    this.coverCards = page.locator('.album-card[data-gallery-display="covers"]');
    this.search = page.getByRole('combobox', { name: 'Search music' });
    this.recentSearches = page.locator('#recent-search-popover');
    this.loopPlay = page.locator('[data-loop-play]:visible').first();
    this.tagEditor = page.locator('#tag-editor-modal');
    this.tagTable = this.tagEditor.locator('.compact-data-table');
    this.tagFooter = this.tagEditor.locator('.editor-footer');
    this.tagRows = this.tagEditor.locator('[data-tag-editor-track]');
  }
}

export async function expectPartialCoverRow(page, surfaces) {
  await expect(surfaces.coverCards.first()).toBeVisible();
  await surfaces.galleryScroll.hover();
  await page.mouse.wheel(0, 75);
  // parity-check: allow-read-only-measurement-evaluate -- ensure virtualized cards intersect the bottom clipping edge
  await expect.poll(() => surfaces.galleryScroll.evaluate(scroll => {
    const bounds = scroll.getBoundingClientRect();
    return [...scroll.querySelectorAll('.album-card')].some(card => {
      const rect = card.getBoundingClientRect();
      return rect.top < bounds.bottom - 2 && rect.bottom > bounds.bottom + 2;
    });
  })).toBe(true);
  const last = surfaces.coverCards.last();
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeVisible();
}

export async function expectPreviewOccludesControls(preview) {
  // parity-check: allow-read-only-measurement-evaluate -- verify hit testing inside the sticky preview including its opaque padding
  const result = await preview.evaluate(el => {
    const box = el.getBoundingClientRect();
    const owner = document.elementFromPoint(box.left + 3, box.top + 3);
    const before = getComputedStyle(el, '::before');
    return { owned: owner === el || el.contains(owner), background: before.backgroundColor, pointerEvents: before.pointerEvents };
  });
  expect(result.owned).toBe(true);
  expect(result.background).not.toBe('rgba(0, 0, 0, 0)');
  expect(result.pointerEvents).toBe('auto');
}

export async function expectSlowActivationLights(play) {
  await play.click();
  // parity-check: allow-read-only-measurement-evaluate -- inspect the two CSS animation definitions
  const motion = await play.evaluate(el => ['::before', '::after'].map(pseudo => {
    const s = getComputedStyle(el, pseudo);
    return { duration: parseFloat(s.animationDuration), name: s.animationName, image: s.backgroundImage };
  }));
  for (const light of motion) {
    expect(light.duration).toBeCloseTo(0.95, 2);
    expect(light.name).toBe('album-track-play-activation');
    expect(light.image).toContain('conic-gradient');
  }
}

export async function expectSharedOutlineGeometry(surfaces) {
  // parity-check: allow-read-only-measurement-evaluate -- measure CSS joins and gradients without altering the page
  const join = await surfaces.familyPanel.evaluate(panel => {
    const bar = document.querySelector('.gallery-bar').getBoundingClientRect();
    const rect = panel.getBoundingClientRect();
    const top = getComputedStyle(panel, '::after');
    return { y: rect.top + parseFloat(top.top), dividerY: bar.bottom - 1, height: top.height, fade: top.backgroundImage };
  });
  expect(Math.abs(join.y - join.dividerY)).toBeLessThanOrEqual(1);
  expect(join.height).toBe('1px');
  expect(join.fade).toContain('linear-gradient');
  // parity-check: allow-read-only-measurement-evaluate -- inspect interpolation and border continuity at the trigger
  const idle = await surfaces.familyTrigger.evaluate(el => {
    const s = getComputedStyle(el);
    return { image: s.backgroundImage, top: s.borderTopWidth, shadow: s.boxShadow, transition: s.transitionProperty };
  });
  expect(idle.image).toContain('linear-gradient');
  expect(idle.top).toBe('2px');
  expect(idle.shadow).toBe('none');
  expect(idle.transition).toContain('--trigger-anchor-cap');
}

export async function expectAnchorFollowsUnfold(page, surfaces) {
  // parity-check: allow-read-only-measurement-evaluate -- observe each rendered anchor and panel join after its layout update
  const measurement = surfaces.familyPanel.evaluate(panel => new Promise(resolve => {
    const trigger = document.querySelector('[data-gallery-bar-action="artist-family"]');
    const samples = [];
    let pendingSample = null;
    const read = () => {
      const box = panel.getBoundingClientRect();
      const style = getComputedStyle(panel);
      const left = parseFloat(style.getPropertyValue('--trigger-anchor-left'));
      return { offset: Math.abs(box.left + left - trigger.getBoundingClientRect().left),
        visible: !panel.hidden && style.visibility !== 'hidden' && box.width > 0 && box.height > 0 };
    };
    // Production registered its observer when the panel opened. This observer
    // records the resulting geometry later in the same rendering update.
    const resize = new ResizeObserver(() => {
      if (pendingSample) pendingSample = read();
    });
    resize.observe(trigger);
    resize.observe(panel);
    resize.observe(trigger.parentElement);
    const sampleFrame = () => {
      // Finalize the preceding frame without forcing a newer animated layout.
      // If no resize callback corrected it, its provisional result still counts.
      if (pendingSample) samples.push(pendingSample);
      if (samples.length === 24) {
        resize.disconnect();
        resolve(samples);
        return;
      }
      pendingSample = read();
      requestAnimationFrame(sampleFrame);
    };
    requestAnimationFrame(sampleFrame);
  }));
  await surfaces.viewTrigger.click();
  const samples = await measurement;
  expect(samples.every(sample => sample.visible)).toBe(true);
  expect(Math.max(...samples.map(sample => sample.offset))).toBeLessThanOrEqual(2);
  await surfaces.viewTrigger.click();
}
