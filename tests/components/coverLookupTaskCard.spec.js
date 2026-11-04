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
const buttonStylesPath = path.join(
  repositoryRoot,
  'music_app',
  'static',
  'css',
  'button-component.css',
);
const playerLayoutStylesPath = path.join(
  repositoryRoot,
  'music_app',
  'static',
  'css',
  'runtime',
  'shell-persistent-player.css',
);
const buttonRuntimePath = path.join(
  repositoryRoot,
  'music_app',
  'static',
  'js',
  'button-component.js',
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

for (const refreshWhilePressed of [false, true]) {
test(refreshWhilePressed
  ? 'cover lookup task card preserves a pending text drag across polling'
  : 'cover lookup task card text can be selected and copied without activating the card', async ({
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
  await page.addStyleTag({ path: buttonStylesPath });
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
  await page.addScriptTag({ path: buttonRuntimePath });
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
    name: /open cover look up: kill 'em all — metallica · 1983/i,
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
  if (refreshWhilePressed) {
    const observation = await page.evaluate(() => {
      const original = document.querySelector('[data-open-cover-lookup-task]');
      const pressed = original.matches(':active');
      const collapsed = window.getSelection()?.isCollapsed;
      renderCoverLookupDrawer();
      return { pressed, collapsed, preserved: original === document.querySelector('[data-open-cover-lookup-task]') };
    });
    expect(observation).toEqual({ pressed: true, collapsed: true, preserved: true });
  }
  await page.mouse.move(
    elapsedBox.x + elapsedBox.width,
    elapsedBox.y + (elapsedBox.height / 2),
    { steps: 12 },
  );
  await page.mouse.up();

  const selectedText = await page.evaluate(() => window.getSelection()?.toString().trim() || '');
  expect(selectedText).toContain("Kill 'Em All");
  expect(selectedText).toContain('Metallica · 1983');
  expect(selectedText).toContain('covers found');
  expect(selectedText).toContain('Took 20m 25s');
  await page.keyboard.press('ControlOrMeta+C');
  await expect.poll(async () => {
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    return clipboardText.replaceAll('\r\n', '\n');
 }).toBe(selectedText.replaceAll('\r\n', '\n'));
await expect.poll(() => page.evaluate(() => state.coverLookup.drawerOpen)).toBe(true);

await page.evaluate(() => {
  window.getSelection()?.removeAllRanges();
  state.coverLookup.tasks = [{
    id: 'running-cover-lookup',
    status: 'running',
    artist: 'Metallica',
    album: "Kill 'Em All",
    year: 1983,
    progress: 50,
  }];
  renderCoverLookupDrawer();
});

const stopButton = page.getByRole('button', { name: 'Stop lookup', exact: true });
const stopIcon = stopButton.locator('svg');
await expect(stopButton).toBeVisible();
await expect(stopIcon).toHaveClass(/action-button__icon/);
await expect(stopIcon).toHaveCSS('stroke-width', '1.8px');
await expect(stopIcon).toHaveCSS('fill', 'none');

});
}

for (const viewport of [
  { name: 'mobile', width: 390, height: 844, playerHeight: 92 },
  { name: 'desktop', width: 1280, height: 900, playerHeight: 76 },
]) {
  test(`cover lookup drawer keeps full cards in a bounded scrolling lane on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.setContent(`<!doctype html>
      <html style="--player-height:${viewport.playerHeight}px">
        <body>
          <button id="cover-lookup-drawer-button"></button>
          <span id="cover-lookup-drawer-badge"></span>
          <aside class="cover-lookup-drawer" id="cover-lookup-drawer" hidden>
            <div class="cover-lookup-drawer-header">
              <div>
                <h3 class="cover-lookup-drawer-title">Cover lookups</h3>
                <div class="cover-lookup-drawer-subtitle" id="cover-lookup-drawer-summary"></div>
              </div>
              <button id="cover-lookup-drawer-clear"></button>
            </div>
            <div class="cover-lookup-drawer-body" id="cover-lookup-drawer-body"></div>
          </aside>
          <footer class="global-player" style="height:${viewport.playerHeight}px"></footer>
        </body>
      </html>`);
    await page.addStyleTag({ content: '* { box-sizing: border-box; } body { margin: 0; }' });
    await page.addStyleTag({ path: cardStylesPath });
    await page.addStyleTag({ path: buttonStylesPath });
    await page.addStyleTag({ path: playerLayoutStylesPath });
    await page.evaluate(() => {
      window.state = {
        coverLookup: {
          drawerOpen: true,
          elapsedTimer: 0,
          modal: { taskId: '' },
          pollingTimer: 0,
          tasks: Array.from({ length: 24 }, (_, index) => ({
            id: `completed-${index}`,
            status: 'completed',
            artist: `Artist ${index}`,
            album: `Album ${index}`,
            year: 2000 + index,
            progress: 100,
            album_payload: { album_artist: `Artist ${index}`, name: `Album ${index}` },
          })),
        },
      };
      window.escapeHtml = (value) => String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
      window.formatCoverLookupTaskElapsedLabel = () => 'Took 1m';
      window.scheduleBrowserTimeout = (callback, delay) => window.setTimeout(callback, delay);
    });
    await page.addScriptTag({ path: buttonRuntimePath });
    await page.addScriptTag({ path: drawerRuntimePath });
    await page.evaluate(() => renderCoverLookupDrawer());

    const drawer = page.locator('#cover-lookup-drawer');
    const body = page.locator('#cover-lookup-drawer-body');
    const cards = body.locator('.cover-lookup-task-card');
    await expect(cards).toHaveCount(24);
    await expect(cards.first().locator('.cover-lookup-task-title')).toBeVisible();
    await expect(cards.first()).toHaveCSS('min-height', '66px');

    const geometry = await page.evaluate(() => {
      const drawerElement = document.getElementById('cover-lookup-drawer');
      const bodyElement = document.getElementById('cover-lookup-drawer-body');
      const player = document.querySelector('.global-player');
      const firstCard = bodyElement.querySelector('.cover-lookup-task-card');
      const drawerBox = drawerElement.getBoundingClientRect();
      const playerBox = player.getBoundingClientRect();
      const firstCardBox = firstCard.getBoundingClientRect();
      return {
        drawerBottom: drawerBox.bottom,
        playerTop: playerBox.top,
        bodyClientHeight: bodyElement.clientHeight,
        bodyScrollHeight: bodyElement.scrollHeight,
        bodyOverflowY: getComputedStyle(bodyElement).overflowY,
        firstCardHeight: firstCardBox.height,
      };
    });
    expect(geometry.drawerBottom).toBeCloseTo(geometry.playerTop, 0);
    expect(geometry.bodyOverflowY).toBe('auto');
    expect(geometry.bodyScrollHeight).toBeGreaterThan(geometry.bodyClientHeight);
    expect(geometry.firstCardHeight).toBeGreaterThanOrEqual(66);

    await body.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(cards.last()).toBeInViewport();
    const lastCardBottom = await cards.last().evaluate(element => element.getBoundingClientRect().bottom);
    expect(lastCardBottom).toBeLessThanOrEqual(geometry.playerTop);
    await expect(drawer).toBeVisible();
  });
}
