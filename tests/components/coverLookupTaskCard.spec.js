const path = require('node:path');
const { test, expect } = require('@playwright/test');

const repositoryRoot = path.join(__dirname, '..', '..');
const cardStylesPath = path.join(
  repositoryRoot,
  'music_app',
  'static',
  'css',
  'runtime',
  'cover-lookup-drawer-and-related.css',
);
const drawerRuntimePath = path.join(
  repositoryRoot,
  'music_app',
  'static',
  'js',
  'runtime',
  'cover-lookup-modal-and-drawer.js',
);
const utilityHandlersPath = path.join(
  repositoryRoot,
  'music_app',
  'static',
  'js',
  'runtime',
  'bootstrap-utility-event-handlers.js',
);

test('cover lookup task card text can be selected and copied without activating the card', async ({
  context,
  page,
}) => {
  const componentOrigin = 'http://127.0.0.1:4399';
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: componentOrigin,
  });
  await page.route(`${componentOrigin}/cover-lookup-task-card`, (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html>
      <html>
        <body>
          <button id="cover-lookup-drawer-button"></button>
          <span id="cover-lookup-drawer-badge"></span>
          <section id="cover-lookup-drawer">
            <button id="cover-lookup-drawer-clear"></button>
            <div id="cover-lookup-drawer-body"></div>
          </section>
        </body>
      </html>`,
  }));
  await page.goto(`${componentOrigin}/cover-lookup-task-card`);
  await page.addStyleTag({ path: cardStylesPath });
  await page.evaluate(() => {
    window.state = {
      coverLookup: {
        drawerOpen: true,
        elapsedTimer: 0,
        modal: { taskId: '' },
        pollingTimer: 0,
        tasks: [{
          id: 'metallica-cover-lookup',
          status: 'completed',
          artist: 'Metallica',
          album: "Kill 'Em All",
          year: 1983,
          progress: 100,
          album_payload: { album_artist: 'Metallica', name: "Kill 'Em All", year: 1983 },
        }],
      },
      tagEditor: {},
      utility: {
        problemExclusionDrag: null,
        repairDragActive: false,
        repairDragChoice: 'ignore',
        repairDragClearOnClick: false,
        repairSuppressClick: false,
      },
    };
    window.escapeHtml = (value) => String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
    window.formatCoverLookupTaskElapsedLabel = () => 'Took 20m 25s';
    window.scheduleBrowserTimeout = (callback, delay) => window.setTimeout(callback, delay);
  });
  await page.addScriptTag({ path: drawerRuntimePath });
  await page.addScriptTag({ path: utilityHandlersPath });
  await page.evaluate(() => {
    document.addEventListener('click', (event) => handleUtilityBootstrapClick(event));
    document.addEventListener('mousedown', (event) => handleUtilityBootstrapMouseDown(event));
    document.addEventListener('mouseup', (event) => handleUtilityBootstrapMouseUp(event));
    document.addEventListener('keydown', (event) => handleUtilityBootstrapKeyDown(event));
    renderCoverLookupDrawer();
  });

  const card = page.getByRole('button', {
    name: /cover art look up metallica - kill 'em all - 1983 completed took 20m 25s/i,
  });
  await expect(card).toBeVisible();
  await card.hover();
  await expect(card).toHaveCSS('cursor', 'pointer');
  await expect(card).toHaveCSS('user-select', 'text');

  const titleBox = await card.locator('.cover-lookup-task-title').boundingBox();
  const elapsedBox = await card.locator('.cover-lookup-task-elapsed').boundingBox();
  expect(titleBox).not.toBeNull();
  expect(elapsedBox).not.toBeNull();
  await page.mouse.move(titleBox.x, titleBox.y + (titleBox.height / 2));
  await page.mouse.down();
  await page.mouse.move(
    elapsedBox.x + elapsedBox.width,
    elapsedBox.y + (elapsedBox.height / 2),
    { steps: 12 },
  );
  await page.mouse.up();

  const selectedText = await page.evaluate(() => window.getSelection()?.toString().trim() || '');
  expect(selectedText).toContain("Metallica - Kill 'Em All - 1983");
  expect(selectedText).toContain('Completed');
  expect(selectedText).toContain('Took 20m 25s');
  await page.keyboard.press('ControlOrMeta+C');
  await expect.poll(async () => {
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    return clipboardText.replaceAll('\r\n', '\n');
  }).toBe(selectedText.replaceAll('\r\n', '\n'));
  await expect.poll(() => page.evaluate(() => state.coverLookup.drawerOpen)).toBe(true);
});
