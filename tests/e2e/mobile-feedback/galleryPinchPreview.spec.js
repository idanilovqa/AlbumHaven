import { test, expect } from '../fixtures/mobileFeedbackTest.js';
import { MobileGalleryPinchPage } from '../poms/mobileGalleryPinchPage.js';

const transitions = [
  { from: 3, to: 2, scale: 1.4 }, { from: 2, to: 1, scale: 1.4 },
  { from: 1, to: 2, scale: 1 / 1.4 }, { from: 2, to: 3, scale: 1 / 1.4 },
  { from: 3, to: 1, scale: 1.8 }, { from: 1, to: 3, scale: 1 / 1.8 },
];

for (const width of [320, 390, 820]) {
  for (const view of ['cards', 'covers']) {
    test(`mobile ${width}px ${view}: all density directions animate real covers before release and stay bounded at the top`, async ({ page, app }, testInfo) => {
      await page.setViewportSize({ width, height: 844 });
      const phone = new MobileGalleryPinchPage(page);
      await phone.browseArtist();
      await expect(phone.galleryContextName).toHaveText('Northlight');
      await phone.selectView(view);
      await phone.selectColumns(3);
      for (const { from, to, scale } of transitions) {
        await phone.expectGridColumns(from);
        await expect.poll(async () => (await phone.geometry()).visible[0]?.image?.loaded).toBe(true);
        const before = await phone.geometry();
        const first = before.cards[0];
        expect(before.scrollTop).toBe(0);
        const gesture = await phone.beginPinch();
        try {
          const direction = Math.sign(scale - 1);
          await gesture.move(1 + direction * .07);
          await expect.poll(async () => {
            const card = (await phone.geometry()).cards.find(item => item.key === first.key);
            return direction * (card.box.width - first.box.width);
          }).toBeGreaterThan(1);
          const early = await phone.geometry();
          await gesture.move(1 + direction * .14);
          const later = await phone.geometry();
          const earlyCard = early.cards.find(item => item.key === first.key);
          const laterCard = later.cards.find(item => item.key === first.key);
          expect(direction * (laterCard.box.width - earlyCard.box.width)).toBeGreaterThan(1);
          for (const sample of [early, later]) {
            phone.expectBounds(sample);
            expect(sample.scrollTop).toBe(0);
            const card = sample.cards.find(item => item.key === first.key);
            expect(card.image).toEqual(first.image);
            expect(card.box.top).toBeCloseTo(first.box.top, 0);
            expect(card.box.top).toBeGreaterThanOrEqual(sample.viewport.top - 1);
            expect(sample.cards.map(item => item.key)).toEqual(expect.arrayContaining(before.cards.map(item => item.key)));
          }
          await testInfo.attach(`${view}-${from}-to-${to}-intermediate`, {
            body: JSON.stringify({ before, early, later }), contentType: 'application/json',
          });
          await testInfo.attach(`${view}-${from}-to-${to}-painted-preview`, { body: await page.screenshot(), contentType: 'image/png' });
          await gesture.move(scale);
          await gesture.releaseOne();
          // One remaining touch must not replace the original DOM or snap density.
          expect((await phone.geometry()).cards.some(card => card.transform)).toBe(true);
          await gesture.end();
        } finally { await gesture.close(); }
        await phone.expectGridColumns(to);
        await phone.expectNoPreview();
        const settled = await phone.geometry();
        phone.expectBounds(settled);
        phone.expectCenteredRows(settled);
        expect(settled.scrollTop).toBe(0);
        expect(settled.cards[0].key).toBe(first.key);
        expect(settled.cards[0].box.top).toBeCloseTo(first.box.top, 0);
        await expect(phone.galleryContextName).toHaveText('Northlight');
      }
      await expect(phone.albumPage).not.toBeVisible();
      expect(await phone.hasNoHorizontalOverflow()).toBe(true);
    });
  }
}

for (const view of ['cards', 'covers']) {
  for (const interruption of ['cancel', 'third-finger', 'replacement-finger', 'replacement-reused-id', 'resize']) {
    test(`mobile ${view}: ${interruption} cleans an interrupted gesture and the next pinch still works`, async ({ page, app }) => {
      const phone = new MobileGalleryPinchPage(page);
      await phone.browseArtist();
      await phone.selectView(view);
      await phone.selectColumns(3);
      const before = await phone.geometry();
      const gesture = await phone.beginPinch();
      try {
        await gesture.move(1.4);
        await expect.poll(async () => (await phone.geometry()).cards.some(card => card.transform)).toBe(true);
        if (interruption === 'cancel') await gesture.cancel();
        else if (interruption === 'third-finger') await gesture.addThird();
        else if (interruption.startsWith('replacement-')) {
          await gesture.releaseOne();
          await gesture.replaceReleasedFinger({ reuseIdentifier: interruption === 'replacement-reused-id' });
        } else await page.setViewportSize({ width: 430, height: 844 });
        await phone.expectNoPreview();
        await gesture.end();
      } finally { await gesture.close(); }
      await phone.expectGridColumns(3);
      await page.setViewportSize({ width: 390, height: 844 });
      await phone.expectNoPreview();
      expect((await phone.geometry()).cards[0].key).toBe(before.cards[0].key);
      await phone.nativePinch(1.4);
      await phone.expectGridColumns(2);
      await phone.expectNoPreview();
      await expect(phone.galleryContextName).toHaveText('Northlight');
      await phone.nativePinch(1.4);
      await phone.expectGridColumns(1);
      const beforeSwipe = (await phone.geometry()).scrollTop;
      await phone.swipeGallery();
      await expect.poll(async () => (await phone.geometry()).scrollTop).toBeGreaterThan(beforeSwipe);
    });
  }

  test(`mobile ${view}: reduced motion avoids live transforms but settles the same 1.4 and 1.8 choices`, async ({ page, app }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const phone = new MobileGalleryPinchPage(page);
    await phone.browseArtist();
    await phone.selectView(view);
    for (const [scale, columns] of [[1.4, 2], [1.8, 1]]) {
      await phone.selectColumns(3);
      const before = await phone.geometry();
      const gesture = await phone.beginPinch();
      try {
        await gesture.move(scale);
        const during = await phone.geometry();
        expect(during.cards.map(card => [card.key, card.box, card.transform]))
          .toEqual(before.cards.map(card => [card.key, card.box, card.transform]));
        await gesture.end();
      } finally { await gesture.close(); }
      await phone.expectGridColumns(columns);
      await phone.expectNoPreview();
      phone.expectBounds(await phone.geometry());
    }
  });
}

test('mobile Rows ignores gallery pinch and retains the Cards/Covers density preference', async ({ page, app }) => {
  const phone = new MobileGalleryPinchPage(page);
  await phone.browseArtist();
  await phone.selectView('cards');
  await phone.selectColumns(2);
  await phone.selectView('list');
  const before = await phone.geometry();
  for (const scale of [1.8, .45]) {
    const gesture = await phone.beginPinch();
    try {
      await gesture.move(scale);
      const during = await phone.geometry();
      expect(during.cards.map(card => [card.key, card.box.width, card.transform]))
        .toEqual(before.cards.map(card => [card.key, card.box.width, card.transform]));
      await gesture.end();
    } finally { await gesture.close(); }
  }
  await phone.expectNoPreview();
  await phone.selectView('covers');
  await phone.expectGridColumns(2);
  await expect(phone.galleryContextName).toHaveText('Northlight');
});

test('mobile preference saves on release, survives reload and another mobile session, and leaves desktop isolated', async ({ page, app, mobileBrowserSessions }) => {
  const phone = new MobileGalleryPinchPage(page);
  const desktopSession = await mobileBrowserSessions.create({ baseURL: new URL(page.url()).origin,
    viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false,
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36' });
  try {
    const desktop = new MobileGalleryPinchPage(desktopSession.page);
    await desktop.signIn('rendref', 'Phase Seven Owner Passphrase 2026!');
    await desktop.search('Northlight');
    await expect(desktop.galleryCards.first()).toBeVisible();
    const desktopBefore = await desktop.geometry();
    await phone.browseArtist();
    await phone.selectView('cards');
    await phone.selectColumns(3);
    // parity-check: allow-read-only-measurement-evaluate -- let preceding normal preference saves finish before observing this gesture's writes.
    await expect.poll(() => page.evaluate(() => window.AlbumHavenDevicePreferences.syncState)).toBe('saved');
    const writes = [];
    const observe = request => {
      if (new URL(request.url()).pathname === '/account/layout-preferences' && request.method() === 'PUT') {
        const body = request.postDataJSON();
        if (Object.hasOwn(body.changes || {}, 'mobileGridColumns')) writes.push(body);
      }
    };
    page.on('request', observe);
    const gesture = await phone.beginPinch();
    try {
      await gesture.move(1.4);
      expect(writes).toHaveLength(0);
      await gesture.releaseOne();
      expect(writes).toHaveLength(0);
      const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/account/layout-preferences'
        && response.request().method() === 'PUT' && response.request().postDataJSON()?.changes?.mobileGridColumns === 2);
      await gesture.end();
      expect((await saved).ok()).toBe(true);
      expect(writes).toHaveLength(1);
      expect(writes[0].profile).toBe('mobile');
    } finally { await gesture.close(); page.off('request', observe); }
    await phone.expectGridColumns(2);
    await page.reload();
    await phone.expectGridColumns(2);
    const session = await mobileBrowserSessions.create({ baseURL: new URL(page.url()).origin,
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    try {
      const mobile = new MobileGalleryPinchPage(session.page);
      await mobile.signIn('rendref', 'Phase Seven Owner Passphrase 2026!');
      await mobile.browseArtist();
      await mobile.expectGridColumns(2);
    } finally { await session.close(); }
    await desktopSession.page.reload();
    await expect(desktop.galleryCards.first()).toBeVisible();
    const desktopAfter = await desktop.geometry();
    expect(desktopAfter.cards.map(card => [card.key, card.box.width, card.transform]))
      .toEqual(desktopBefore.cards.map(card => [card.key, card.box.width, card.transform]));
    await expect(desktop.zoomButton).toBeVisible();
    // Desktop receives no pinch input. This is a saved-preference/layout isolation check only.
  } finally { await desktopSession.close(); }
});

for (const view of ['cards', 'covers']) {
  test(`mobile ${view}: resizing near the bottom clamps scroll without empty trailing space`, async ({ page, app }, testInfo) => {
    const phone = new MobileGalleryPinchPage(page);
    await phone.browseArtist();
    await phone.selectView(view);
    await phone.selectColumns(1);
    for (let index = 0; index < 12; index++) await phone.swipeGallery();
    await expect.poll(async () => {
      const sample = await phone.geometry();
      return sample.scrollHeight - sample.viewport.height - sample.scrollTop;
    }).toBeLessThanOrEqual(1);
    const before = await phone.geometry();
    const anchor = phone.midpointCard(before);
    const gesture = await phone.beginPinch({ center: anchor.center });
    try {
      for (const scale of [.93, .85, .72, .55]) {
        await gesture.move(scale);
        const sample = await phone.geometry();
        phone.expectBounds(sample);
        expect(sample.scrollTop).toBeGreaterThanOrEqual(0);
        expect(sample.scrollTop + sample.viewport.height).toBeLessThanOrEqual(sample.scrollHeight + 1);
        expect(Math.max(...sample.visible.map(card => card.box.bottom))).toBeGreaterThan(sample.viewport.top + sample.viewport.height / 2);
      }
      await testInfo.attach(`${view}-bottom-preview`, { body: await page.screenshot(), contentType: 'image/png' });
      await gesture.end();
    } finally { await gesture.close(); }
    await phone.expectGridColumns(3);
    await phone.expectNoPreview();
    // Check final painted content before any new swipe can clear a stranded anchor phase.
    await expect.poll(async () => Math.abs((await phone.geometry()).settlement.translateY)).toBeLessThanOrEqual(1);
    const settled = await phone.geometry();
    // offset geometry preserves legitimate collapsed section margins. Painted and
    // layout boundaries may differ only by pixel rounding, not the rejected anchor distance.
    expect(Math.abs(settled.settlement.bottomSpacer.top - settled.settlement.grid.bottom
      - settled.settlement.layoutGap)).toBeLessThanOrEqual(2);
    phone.expectBounds(settled);
    await testInfo.attach(`${view}-bottom-settled`, { body: await page.screenshot(), contentType: 'image/png' });
    await phone.swipeGallery('up');
    await expect(phone.galleryContextName).toHaveText('Northlight');
    await expect(phone.albumPage).not.toBeVisible();
    phone.expectBounds(await phone.geometry());
  });
}
