import { expect } from '@playwright/test';
import { MobileTouchFeedbackPage } from './mobileTouchFeedbackPage.js';

/** Native mobile touch input and read-only rendered evidence. No app state injection. */
export class MobileGalleryPinchPage extends MobileTouchFeedbackPage {
  async geometry() {
    // parity-check: allow-read-only-measurement-evaluate -- observe painted cards, loaded artwork and scroll bounds without changing DOM or app state.
    return this.galleryScroll.evaluate(scroll => {
      const rect = element => element.getBoundingClientRect().toJSON();
      const viewport = rect(scroll);
      const css = getComputedStyle(scroll);
      const content = { left: viewport.left + scroll.clientLeft + Number.parseFloat(css.paddingLeft),
        right: viewport.left + scroll.clientLeft + scroll.clientWidth - Number.parseFloat(css.paddingRight) };
      const cards = [...scroll.querySelectorAll('.album-card')].map(card => {
        const trigger = card.querySelector('[data-open-tracklist][data-album-key]');
        const image = card.querySelector('img');
        return {
          key: trigger?.getAttribute('data-album-key'),
          occurrence: card.closest('[data-virtual-section-key]')?.getAttribute('data-virtual-section-key'),
          title: trigger?.getAttribute('aria-label'),
          box: rect(card),
          artbox: rect(trigger),
          image: image ? { src: image.currentSrc, loaded: image.complete && image.naturalWidth > 0 } : null,
          transform: card.style.transform,
        };
      });
      const grid = scroll.querySelector('#artist-groups');
      const bottomSpacer = scroll.querySelector('#albums-spacer-bottom');
      const translate = getComputedStyle(grid).translate.split(/\s+/);
      const settlement = { grid: rect(grid), bottomSpacer: rect(bottomSpacer),
        translateY: translate.length > 1 ? Number.parseFloat(translate[1]) : 0,
        layoutGap: bottomSpacer.offsetTop - grid.offsetTop - grid.offsetHeight };
      return { viewport, content, settlement, scrollTop: scroll.scrollTop, scrollHeight: scroll.scrollHeight,
        scale: window.visualViewport.scale, mounted: cards.length,
        cards, visible: cards.filter(card => card.box.bottom > viewport.top && card.box.top < viewport.bottom) };
    });
  }

  // Owner 2026-11-22: the band changes only when a label visibly passes behind the gallery bar.
  async bandOwnership() {
    // parity-check: allow-read-only-measurement-evaluate -- compare the painted band with the painted artist labels.
    return this.galleryScroll.evaluate(scroll => {
      const top = scroll.getBoundingClientRect().top;
      const labels = [...scroll.querySelectorAll('[data-scroll-artist]')]
        .map(section => ({ artist: section.dataset.scrollArtist.trim(), bottom: section.querySelector('.artist-name')?.getBoundingClientRect().bottom }))
        .filter(label => Number.isFinite(label.bottom)).sort((a, b) => a.bottom - b.bottom);
      const below = labels.find(label => label.bottom > top);
      // With no passed label still mounted, the artist of the cards under the bar is the one that passed.
      const card = [...scroll.querySelectorAll('.album-card')].find((item) => {
        const box = item.getBoundingClientRect();
        return box.bottom > top && (!below || box.top < below.bottom);
      });
      return {
        band: document.querySelector('[data-gallery-bar-instance="gallery"] [data-artist-info-trigger]')?.dataset.artist ?? null,
        passed: labels.filter(label => label.bottom <= top).at(-1)?.artist
          ?? card?.closest('[data-scroll-artist]')?.dataset.scrollArtist.trim() ?? null,
        stillVisible: labels.filter(label => label.bottom > top).map(label => label.artist),
      };
    });
  }

  async expectBandChangesOnlyBehindBar() {
    await expect.poll(async () => {
      const { band, passed, stillVisible } = await this.bandOwnership();
      return passed === null ? !stillVisible.includes(band) : band === passed;
    }, { message: 'the band names an artist whose label has not passed behind the bar' }).toBe(true);
  }

  // A swipe keeps gliding: a finger position read mid-glide is not where the pinch starts.
  async waitForScrollToRest() {
    let previous = null;
    await expect.poll(async () => {
      const { scrollTop } = await this.geometry();
      const resting = scrollTop === previous;
      previous = scrollTop;
      return resting;
    }, { intervals: [250] }).toBe(true);
  }

  async beginPinch({ center, span = 110 } = {}) {
    const box = await this.galleryScroll.boundingBox();
    if (!box) throw new Error('Pinch requires a visible gallery.');
    const midpoint = center || { x: box.x + box.width / 2, y: box.y + Math.min(150, box.height / 2) };
    // parity-check: allow-read-only-measurement-evaluate -- retain the native touch targets and every original ancestor while fingers remain down.
    const observation = await this.galleryScroll.evaluateHandle((scroll, input) => {
      const originals = [];
      for (const direction of [-1, 1]) {
        let node = document.elementFromPoint(input.midpoint.x + direction * input.span / 2, input.midpoint.y);
        while (node && node !== scroll) { originals.push({ node, parent: node.parentNode }); node = node.parentNode; }
      }
      return { connected: () => originals.every(({ node, parent }) => node.isConnected && node.parentNode === parent) };
    }, { midpoint, span });
    let session;
    let scale = 1, active = true;
    const points = value => [0, 1].map(id => ({ id, x: midpoint.x + (id ? 1 : -1) * span * value / 2, y: midpoint.y }));
    const dispatch = (type, touchPoints) => session.send('Input.dispatchTouchEvent', { type, touchPoints });
    try { session = await this.page.context().newCDPSession(this.page); await dispatch('touchStart', points(scale)); }
    catch (error) {
      await observation.dispose(); await session?.detach(); throw error;
    }
    return {
      center: midpoint,
      move: async target => {
        const from = scale;
        for (let step = 1; step <= 6; step++) await dispatch('touchMove', points(from + (target - from) * step / 6));
        scale = target;
        // parity-check: allow-read-only-measurement-evaluate -- retain the native touch targets and every original ancestor while fingers remain down.
        expect(await observation.evaluate(value => value.connected())).toBe(true);
      },
      addThird: () => dispatch('touchStart', [...points(scale), { id: 2, x: midpoint.x, y: midpoint.y + 40 }]),
      end: async () => { if (active) { await dispatch('touchEnd', []); active = false; } },
      cancel: async () => { if (active) { await dispatch('touchCancel', []); active = false; } },
      close: async () => {
        try { if (active) await dispatch('touchCancel', []); }
        finally {
          try { await observation.dispose(); }
          finally { await session.detach(); }
        }
      },
    };
  }

  async swipeGallery(direction = 'down') {
    const box = await this.galleryScroll.boundingBox();
    if (!box) throw new Error('Swipe requires a visible gallery.');
    const travel = Math.min(320, box.height * .55);
    const startY = direction === 'down' ? box.y + box.height * .8 : box.y + box.height * .2;
    await this.swipeAt(box.x + box.width / 2, startY, direction === 'down' ? -travel : travel);
  }

  async resetBrowserZoom() {
    const session = await this.page.context().newCDPSession(this.page);
    try { await session.send('Emulation.resetPageScaleFactor'); }
    finally { await session.detach(); }
  }

  async expectNoPreview() {
    await expect.poll(async () => (await this.geometry()).cards.every(card => !card.transform)).toBe(true);
    await expect(this.albumPage).not.toBeVisible();
  }

  expectBounds(sample) {
    expect(sample.visible.length).toBeGreaterThan(0);
    expect(sample.scale).toBe(1);
    for (const card of sample.visible) {
      expect(card.key).toBeTruthy();
      expect(card.title).toBeTruthy();
      expect(card.box.width).toBeGreaterThan(0);
      expect(card.box.left).toBeGreaterThanOrEqual(sample.content.left - 1);
      expect(card.box.right).toBeLessThanOrEqual(sample.content.right + 1);
    }
  }

  expectCenteredRows(sample) {
    const rows = new Map();
    for (const card of sample.visible) {
      const top = Math.round(card.box.top);
      if (!rows.has(top)) rows.set(top, []);
      rows.get(top).push(card.box);
    }
    for (const boxes of rows.values()) {
      const left = Math.min(...boxes.map(box => box.left));
      const right = Math.max(...boxes.map(box => box.right));
      expect((left + right) / 2).toBeCloseTo((sample.content.left + sample.content.right) / 2, 0);
    }
  }

  midpointCard(sample) {
    const x = (sample.content.left + sample.content.right) / 2;
    const y = sample.viewport.top + sample.viewport.height / 2;
    const candidates = sample.visible.filter(item => item.artbox.top >= sample.viewport.top
      && item.artbox.bottom <= sample.viewport.bottom);
    const card = candidates.sort((a, b) => Math.hypot(a.artbox.x + a.artbox.width / 2 - x, a.artbox.y + a.artbox.height / 2 - y)
      - Math.hypot(b.artbox.x + b.artbox.width / 2 - x, b.artbox.y + b.artbox.height / 2 - y))[0];
    if (!card) throw new Error('The gallery must contain a fully visible artwork for the midpoint scenario.');
    const center = { x: Math.max(sample.viewport.left + 65, Math.min(sample.viewport.right - 65, card.artbox.x + card.artbox.width / 2)),
      y: card.artbox.top + card.artbox.height * .4 };
    return { ...card, center, fractionY: .4 };
  }
}
