const { test, expect } = require('@playwright/test');
const path = require('path');

const repositoryRoot = path.resolve(__dirname, '../..');
const componentUrl = 'http://gallery-card-hover-year.test/';

test('art-only Gallery glow centers meet the hover-frame gap endpoints', async ({ page }) => {
  await page.route(componentUrl, route => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: `<!doctype html>
      <html>
        <body style="margin: 40px">
          <section class="album-card" data-gallery-display="covers" data-gallery-release-year="2009"
            style="position: relative; width: 200px; height: 200px">
            <span class="gallery-card__hover-year" aria-hidden="true">2009</span>
          </section>
        </body>
      </html>`,
  }));
  await page.goto(componentUrl);
  await page.addStyleTag({ path: path.join(repositoryRoot, 'music_app/static/css/gallery-main.css') });

  const card = page.locator('.album-card');
  await card.hover();
  await expect.poll(() => card.evaluate(element => (
    getComputedStyle(element).getPropertyValue('--gallery-year-gap').trim()
  ))).toBe('34px');

  const geometry = await page.locator('.gallery-card__hover-year').evaluate(element => {
    const card = element.parentElement.getBoundingClientRect();
    const year = element.getBoundingClientRect();
    const frame = getComputedStyle(element.parentElement, '::after');
    const before = getComputedStyle(element, '::before');
    const after = getComputedStyle(element, '::after');
    const number = value => Number.parseFloat(value);
    const gap = number(getComputedStyle(element.parentElement).getPropertyValue('--gallery-year-gap'));
    const frameTopStrokeCenter = card.top + number(frame.top) + number(frame.borderTopWidth) / 2;
    return {
      frameTopStrokeCenter,
      leftGlow: {
        x: year.right - number(before.right) - number(before.width) / 2,
        y: year.top + number(before.top) + number(before.height) / 2,
      },
      rightGlow: {
        x: year.left + number(after.left) + number(after.width) / 2,
        y: year.top + number(after.top) + number(after.height) / 2,
      },
      leftGapEndpoint: card.left + card.width / 2 - gap,
      rightGapEndpoint: card.left + card.width / 2 + gap,
    };
  });

  expect(geometry.leftGlow.x).toBeCloseTo(geometry.leftGapEndpoint, 1);
  expect(geometry.rightGlow.x).toBeCloseTo(geometry.rightGapEndpoint, 1);
  expect(geometry.leftGlow.y).toBeCloseTo(geometry.frameTopStrokeCenter, 1);
  expect(geometry.rightGlow.y).toBeCloseTo(geometry.frameTopStrokeCenter, 1);
});
