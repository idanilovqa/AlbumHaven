const path = require('node:path');
const { test, expect } = require('@playwright/test');

const repositoryRoot = path.resolve(__dirname, '../..');
const componentUrl = 'http://app-bar-settings-icon.test/';

test('Settings glyph is sized and centered on the app-bar action centerline', async ({ page }) => {
  await page.route(componentUrl, (route) => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: `<!doctype html>
      <html>
        <body style="margin: 0">
          <header class="app-bar">
            <div></div><div></div>
            <div class="toolbar-right">
              <button class="button ui-button ui-button--icon ui-button--medium action-button" aria-label="Sources">
                <span class="ui-button__content action-button__content">
                  <svg class="peer-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 17h16"/></svg>
                </span>
              </button>
              <button class="button ui-button ui-button--icon ui-button--medium action-button" id="settings-button" aria-label="Settings">
                <span class="ui-button__content action-button__content">
                  <svg class="ui-icon action-button__icon settings-button__icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/></svg>
                </span>
              </button>
            </div>
          </header>
        </body>
      </html>`,
  }));
  await page.goto(componentUrl);
  await page.addStyleTag({ path: path.join(repositoryRoot, 'music_app/static/css/button-component.css') });
  await page.addStyleTag({ path: path.join(repositoryRoot, 'music_app/static/css/app-chrome.css') });

  const geometry = await page.evaluate(() => {
    const peerButton = document.querySelector('[aria-label="Sources"]').getBoundingClientRect();
    const settingsButton = document.querySelector('#settings-button').getBoundingClientRect();
    const settingsIcon = document.querySelector('.settings-button__icon').getBoundingClientRect();
    return {
      peerCenterY: peerButton.top + peerButton.height / 2,
      settingsCenterY: settingsButton.top + settingsButton.height / 2,
      iconCenterY: settingsIcon.top + settingsIcon.height / 2,
      iconWidth: settingsIcon.width,
      iconHeight: settingsIcon.height,
    };
  });

  expect(geometry.iconWidth).toBe(20);
  expect(geometry.iconHeight).toBe(20);
  expect(Math.abs(geometry.settingsCenterY - geometry.peerCenterY)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(geometry.iconCenterY - geometry.peerCenterY)).toBeLessThanOrEqual(0.5);
});
