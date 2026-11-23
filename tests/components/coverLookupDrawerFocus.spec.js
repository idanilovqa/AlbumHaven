const path = require('node:path');
const { test, expect } = require('@playwright/test');

const staticRoot = path.join(__dirname, '..', '..', 'music_app', 'static');
const FOCUSED_TASK = 'task-12';

// The real drawer renderer and the real keyboard and click handlers. Opening the modal is recorded; the
// click handler's dismissers of unrelated surfaces (tag menu, loop menu, library settings) are inert.
async function mountDrawer(page) {
  await page.setContent(`<!doctype html>
    <button id="cover-lookup-drawer-button">Notifications</button>
    <span id="cover-lookup-drawer-badge"></span>
    <input id="outside-drawer">
    <aside id="cover-lookup-drawer" class="cover-lookup-drawer">
      <button id="cover-lookup-drawer-clear">Clear</button>
      <div id="cover-lookup-drawer-body" class="cover-lookup-drawer-body"></div>
    </aside>`);
  await page.addStyleTag({ path: path.join(staticRoot, 'css/runtime/cover-lookup-drawer-and-related.css') });
  // A short lane, so the focused card can sit below the visible part of the drawer.
  await page.addStyleTag({ content: '#cover-lookup-drawer-body { flex: none; height: 240px; overflow-y: auto; }' });
  await page.evaluate(() => {
    window.state = {
      coverLookup: {
        drawerOpen: true,
        elapsedTimer: 0,
        modal: { taskId: '' },
        pollingTimer: 0,
        tasks: Array.from({ length: 24 }, (_value, index) => ({
          id: `task-${index}`,
          status: 'completed',
          progress: 100,
          artist: 'Artist',
          album: `Album ${index}`,
          album_payload: { album_artist: 'Artist', name: `Album ${index}` },
        })),
      },
      tagEditor: {},
      utility: { problemExclusionDrag: null, repairDragActive: false, repairSuppressClick: false },
    };
    window.escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
    window.formatCoverLookupTaskElapsedLabel = () => 'Took 20s';
    window.scheduleBrowserTimeout = (callback, delay) => window.setTimeout(callback, delay);
  });
  for (const file of ['button-component.js', 'runtime/cover-lookup-modal-and-drawer.js', 'runtime/bootstrap-utility-event-handlers.js']) {
    await page.addScriptTag({ path: path.join(staticRoot, 'js', file) });
  }
  await page.evaluate(() => {
    window.openedTasks = [];
    window.openCoverLookupModal = (_album, options) => { openedTasks.push(options.taskId); };
    for (const name of ['closeTagEditorExceptionMenu', 'closeUtilityLoopSettingMenu', 'handleLibrarySettingsClick']) {
      window[name] = () => false;
    }
    document.addEventListener('click', event => handleUtilityBootstrapClick(event));
    document.addEventListener('keydown', event => handleUtilityBootstrapKeyDown(event));
    renderCoverLookupDrawer();
  });
}

const opener = page => page.locator(`[data-open-cover-lookup-task="${FOCUSED_TASK}"]`);

// Renders through the drawer's public entry and reports that the DOM really was rewritten.
function render(page, { changed = false, targeted = false, removed = false } = {}) {
  return page.evaluate((options) => {
    const { id } = options;
    if (options.removed) state.coverLookup.tasks = state.coverLookup.tasks.filter(task => task.id !== id);
    if (options.changed) {
      state.coverLookup.tasks = state.coverLookup.tasks.map(task => (task.id === id ? { ...task, album: 'Renamed album' } : task));
    }
    const body = document.getElementById('cover-lookup-drawer-body');
    const observer = new MutationObserver(() => {});
    observer.observe(body, { childList: true, subtree: true });
    renderCoverLookupDrawer(options.targeted ? { taskIds: [id] } : {});
    const rewritten = observer.takeRecords().length > 0;
    observer.disconnect();
    return rewritten;
  }, { id: FOCUSED_TASK, changed, targeted, removed });
}

const RENDERS = [
  ['a full unchanged', {}],
  ['a full changed', { changed: true }],
  ['a targeted', { changed: true, targeted: true }],
];

for (const [label, options] of RENDERS) {
  test(`cover lookup drawer keeps a focused task opener through ${label} render`, async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await mountDrawer(page);
    await opener(page).focus();
    await expect(opener(page)).toBeFocused();
    // The focused card is out of view: keeping its focus must not scroll it back in.
    const scrollTop = await page.evaluate(() => {
      const body = document.getElementById('cover-lookup-drawer-body');
      body.scrollTop = 40;
      return body.scrollTop;
    });
    expect(scrollTop).toBe(40);

    expect(await render(page, options), 'the render is not suppressed').toBe(true);

    if (options.changed) await expect(opener(page)).toContainText('Renamed album');
    await expect(opener(page)).toBeFocused({ timeout: 2000 });
    expect(await page.locator('#cover-lookup-drawer-body').evaluate(body => body.scrollTop)).toBe(scrollTop);
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => openedTasks)).toEqual([FOCUSED_TASK]);
    expect(pageErrors).toEqual([]);
  });
}

test('cover lookup drawer renders never take focus from outside or force it after the focused card is removed', async ({ page }) => {
  for (const [, options] of RENDERS) {
    await mountDrawer(page);
    await page.locator('#outside-drawer').focus();
    expect(await render(page, options)).toBe(true);
    await expect(page.locator('#outside-drawer')).toBeFocused();
  }
  for (const targeted of [false, true]) {
    await mountDrawer(page);
    await opener(page).focus();
    expect(await render(page, { removed: true, targeted })).toBe(true);
    await expect(opener(page)).toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  }
});
