const { test, expect } = require('@playwright/test');
const path = require('path');

const repositoryRoot = path.resolve(__dirname, '../..');
const componentUrl = 'http://gallery-bar-alignment.test/';

test('Gallery-bar actions align with the right edge of their layout boundary', async ({ page }) => {
  await page.route(componentUrl, route => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: `<!doctype html>
      <html>
        <body style="margin: 0">
          <section class="gallery-bar" style="width: 480px; box-sizing: border-box">
            <div class="gallery-bar__context">Gallery</div>
            <div class="gallery-bar__actions">
              <button class="gallery-action-button" type="button">Family</button>
              <button class="gallery-action-button" type="button">View</button>
              <button class="gallery-action-button" type="button">Types</button>
            </div>
          </section>
        </body>
      </html>`,
  }));

  await page.goto(componentUrl);
  await page.addStyleTag({
    path: path.join(repositoryRoot, 'music_app/static/css/gallery-main.css'),
  });

  const geometry = await page.evaluate(() => {
    const bar = document.querySelector('.gallery-bar').getBoundingClientRect();
    const actions = document.querySelector('.gallery-bar__actions').getBoundingClientRect();
    return { barRight: bar.right, actionsRight: actions.right };
  });

  expect(geometry.actionsRight).toBe(geometry.barRight);
});

for (const mode of ['light', 'dark']) {
  test(`${mode} Gallery-bar hover uses its approved surface`, async ({ page }) => {
    await page.route(componentUrl, route => route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html>
        <html data-appearance-mode="${mode}" style="
          --appearance-main-surface: rgb(100, 120, 140);
          --appearance-item-action-hover-background: rgb(20, 30, 40);
          --appearance-item-action-hover-border: rgb(60, 70, 80);
          --appearance-play: rgb(0, 160, 80);
          --text: rgb(10, 12, 14);
          --border: rgb(50, 55, 60);
        ">
          <body>
            <div class="gallery-bar__actions">
              <button id="action" class="gallery-action-button" type="button">Types</button>
              <div id="cluster" class="gallery-view-cluster">
                <button id="choice" class="gallery-view-choice" type="button">View</button>
              </div>
            </div>
            <div id="light-expected" style="background: color-mix(in srgb, rgb(100, 120, 140) 85%, white 15%)"></div>
          </body>
        </html>`,
    }));
    await page.goto(componentUrl);
    await page.addStyleTag({ path: path.join(repositoryRoot, 'music_app/static/css/gallery-main.css') });

    await page.locator('#action').hover();
    const action = await page.locator('#action').evaluate(element => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, border: style.borderColor };
    });
    const expectedLight = await page.locator('#light-expected').evaluate(element => getComputedStyle(element).backgroundColor);
    expect(action.background).toBe(mode === 'light' ? expectedLight : 'rgb(20, 30, 40)');
    expect(action.border).toBe('rgb(60, 70, 80)');

    await page.locator('#choice').hover();
    const cluster = await page.locator('#cluster').evaluate(element => getComputedStyle(element).backgroundColor);
    const choice = await page.locator('#choice').evaluate(element => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, color: style.color };
    });
    expect(cluster).toBe(mode === 'light' ? expectedLight : 'rgb(20, 30, 40)');
    expect(choice.background).toBe(mode === 'light' ? expectedLight : 'rgb(100, 120, 140)');
    expect(choice.color).toBe('rgb(0, 160, 80)');
  });
}
