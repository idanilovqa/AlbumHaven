const path = require('node:path');
const { test, expect } = require('@playwright/test');

const staticRoot = path.join(__dirname, '..', '..', 'music_app', 'static');

// The production drawer markup (closed), its renderer, the shared trigger-anchor owner and the
// app's own click and keydown dispatchers. Only the network loaders are inert.
async function mountClosedDrawer(page, tasks = ['First', 'Second'].map(album => ({ album, status: 'completed' }))) {
  await page.setContent(`<!doctype html>
    <input id="before-trigger" aria-label="Before">
    <button class="cover-lookup-drawer-button" id="cover-lookup-drawer-button" type="button" data-toggle-cover-lookup-drawer="1" aria-label="Cover art lookups">Lookups</button>
    <span id="cover-lookup-drawer-badge" hidden></span>
    <aside class="cover-lookup-drawer shell-info-drawer" id="cover-lookup-drawer" hidden>
      <div class="cover-lookup-drawer-header">
        <div><h3 class="cover-lookup-drawer-title">Cover lookups</h3><div id="cover-lookup-drawer-summary">No activity</div></div>
        <div class="cover-lookup-drawer-actions">
          <button class="cover-lookup-drawer-clear" id="cover-lookup-drawer-clear" type="button" disabled data-clear-cover-lookup-completed="1" aria-label="Clear completed cover art lookups">Clear</button>
          <button class="cover-lookup-drawer-close" type="button" data-close-cover-lookup-drawer="1" aria-label="Close cover art lookups">Close</button>
        </div>
      </div>
      <div class="cover-lookup-drawer-body" id="cover-lookup-drawer-body"></div>
    </aside>`);
  await page.addStyleTag({ path: path.join(staticRoot, 'css/runtime/cover-lookup-drawer-and-related.css') });
  await page.evaluate((tasks) => {
    window.state = {
      coverLookup: {
        drawerOpen: false,
        elapsedTimer: 0,
        modal: { taskId: '' },
        pollingTimer: 0,
        tasks: tasks.map(({ album, status, ...task }, index) => ({
          id: `task-${index}`,
          status,
          progress: 100,
          artist: 'Artist',
          album,
          album_payload: { album_artist: 'Artist', name: album },
          ...task,
        })),
      },
      tagEditor: {},
      utility: { problemExclusionDrag: null, repairDragActive: false, repairSuppressClick: false },
    };
    window.escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
    window.formatCoverLookupTaskElapsedLabel = () => 'Took 20s';
    window.scheduleBrowserTimeout = (callback, delay) => window.setTimeout(callback, delay);
  }, tasks);
  for (const file of ['button-component.js', 'runtime/trigger-anchor.js', 'runtime/cover-lookup-modal-and-drawer.js', 'runtime/bootstrap-utility-event-handlers.js']) {
    await page.addScriptTag({ path: path.join(staticRoot, 'js', file) });
  }
  await page.evaluate(() => {
    window.loadCoverLookupTasks = () => Promise.resolve();
    window.ensureCoverLookupPolling = () => {};
    window.stopCoverLookupPollingIfIdle = () => {};
    window.openCoverLookupModal = () => {};
    for (const name of ['closeTagEditorExceptionMenu', 'closeUtilityLoopSettingMenu', 'handleLibrarySettingsClick']) {
      window[name] = () => false;
    }
    document.addEventListener('click', event => handleUtilityBootstrapClick(event));
    document.addEventListener('keydown', event => handleUtilityBootstrapKeyDown(event));
    renderCoverLookupDrawer();
  });
  return {
    trigger: page.locator('#cover-lookup-drawer-button'),
    drawer: page.locator('#cover-lookup-drawer'),
    close: page.getByRole('button', { name: 'Close cover art lookups' }),
  };
}

const focusIsInsideDrawer = page => page.evaluate(() => (
  document.getElementById('cover-lookup-drawer').contains(document.activeElement)
));

test('opening the notifications drawer with the keyboard moves focus into it and Escape returns it to the trigger', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const { trigger, drawer, close } = await mountClosedDrawer(page);
  await page.locator('#before-trigger').focus();
  await page.keyboard.press('Tab');
  await expect(trigger).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(drawer).toBeVisible();
  await expect(drawer).toHaveClass(/is-open/);
  // The first enabled control of the panel takes focus (Clear is disabled with nothing finished to clear).
  await expect(close).toBeFocused();
  expect(await focusIsInsideDrawer(page)).toBe(true);

  // Tab keeps working inside the open panel: it reaches the first notification card.
  await page.keyboard.press('Tab');
  expect(await focusIsInsideDrawer(page)).toBe(true);
  await expect(page.locator('[data-open-cover-lookup-task="task-0"]')).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(drawer).not.toHaveClass(/is-open/);
  await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => state.coverLookup.drawerOpen)).toBe(false);
  expect(pageErrors).toEqual([]);
});

test('closing the notifications drawer from its Close button by keyboard returns focus to the trigger', async ({ page }) => {
  const { trigger, drawer, close } = await mountClosedDrawer(page);
  await trigger.focus();
  await page.keyboard.press('Space');
  await expect(close).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(drawer).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('Escape closes a pointer-opened notifications drawer and keeps focus on its trigger', async ({ page }) => {
  const { trigger, drawer } = await mountClosedDrawer(page);
  await trigger.click();
  await expect(drawer).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('Tab walks each notification card, then its Retry when present, then its delete button, and Shift+Tab walks back', async ({ page }) => {
  // A failed lookup also renders Retry, which stays in reach between its card and its delete button.
  const { trigger, close } = await mountClosedDrawer(page, [
    { album: 'First', status: 'completed' },
    { album: 'Second', status: 'failed' },
    { album: 'Third', status: 'completed' },
  ]);
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(close).toBeFocused();
  await expect(page.locator('[data-retry-cover-lookup-task="task-1"]')).toHaveCount(1);

  const focusedStop = () => page.evaluate(() => {
    const active = document.activeElement;
    const card = active?.closest('.cover-lookup-task-card');
    const taskId = card?.querySelector('[data-open-cover-lookup-task]')?.getAttribute('data-open-cover-lookup-task');
    if (!taskId) return active?.getAttribute('aria-label') || active?.id || '';
    return active.matches('[data-open-cover-lookup-task]') ? `card:${taskId}`
      : active.matches('[data-retry-cover-lookup-task]') ? `retry:${taskId}`
      : active.matches('[data-clear-cover-lookup-task]') ? `delete:${taskId}` : `other:${taskId}:${active.getAttribute('aria-label')}`;
  });
  const expected = ['card:task-0', 'delete:task-0', 'card:task-1', 'retry:task-1', 'delete:task-1', 'card:task-2', 'delete:task-2'];
  const forward = [];
  for (let index = 0; index < expected.length; index += 1) {
    await page.keyboard.press('Tab');
    forward.push(await focusedStop());
  }
  expect(forward).toEqual(expected);

  const backward = [];
  for (let index = 0; index < expected.length - 1; index += 1) {
    await page.keyboard.press('Shift+Tab');
    backward.push(await focusedStop());
  }
  expect(backward).toEqual(expected.slice(0, -1).reverse());
});

// Every card state the renderer produces: its card and each visible, enabled button are Tab stops in visual order.
const CARD_STATES = [
  ['completed', { status: 'completed' }],
  ['completed with no covers', { status: 'completed', result_kind: 'no-results' }],
  ['art chosen', { status: 'completed', notification_action_taken: true }],
  ['failed', { status: 'failed' }],
  ['interrupted', { status: 'failed', result_kind: 'interrupted' }],
  ['canceled', { status: 'canceled' }],
  ['queued', { status: 'pending' }],
  ['searching', { status: 'running', progress: 40 }],
  ['downloading the chosen art', { status: 'running', job_kind: 'save_remote_selection' }],
];

for (const [label, task] of CARD_STATES) {
  test(`Tab reaches each ${label} notification card and every visible button on it in visual order`, async ({ page }) => {
    const { trigger, close } = await mountClosedDrawer(page, ['First', 'Second', 'Third'].map(album => ({ album, ...task })));
    await trigger.focus();
    await page.keyboard.press('Enter');
    expect(await focusIsInsideDrawer(page)).toBe(true);
    await expect(page.locator('.cover-lookup-task-card')).toHaveCount(3);
    // Clear completed precedes Close in the header when it is enabled; the walk starts after the header.
    await close.focus();

    // Expected stops come from what is on screen: each card, then its visible enabled buttons, ordered top-to-bottom, left-to-right.
    const expected = await page.evaluate(() => Array.from(document.querySelectorAll('.cover-lookup-task-card')).flatMap((card) => {
      const opener = card.querySelector('[data-open-cover-lookup-task]');
      const buttons = Array.from(card.querySelectorAll('button')).filter(button => {
        const style = getComputedStyle(button);
        return !button.disabled && button.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      }).sort((a, b) => {
        const ra = a.getBoundingClientRect(); const rb = b.getBoundingClientRect();
        return Math.abs(ra.top - rb.top) > 2 ? ra.top - rb.top : ra.left - rb.left;
      });
      return [opener, ...buttons].map(node => `${opener.getAttribute('data-open-cover-lookup-task')}:${node.getAttribute('aria-label')}`);
    }));
    expect(expected.length).toBeGreaterThanOrEqual(3);

    const focusedStop = () => page.evaluate(() => {
      const active = document.activeElement;
      const taskId = active?.closest('.cover-lookup-task-card')?.querySelector('[data-open-cover-lookup-task]')?.getAttribute('data-open-cover-lookup-task');
      return `${taskId || 'outside'}:${active?.getAttribute('aria-label')}`;
    });
    const forward = [];
    for (let index = 0; index < expected.length; index += 1) {
      await page.keyboard.press('Tab');
      forward.push(await focusedStop());
    }
    expect(forward).toEqual(expected);
    const backward = [];
    for (let index = 0; index < expected.length - 1; index += 1) {
      await page.keyboard.press('Shift+Tab');
      backward.push(await focusedStop());
    }
    expect(backward).toEqual(expected.slice(0, -1).reverse());
  });
}
