const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

const repositoryRoot = path.join(__dirname, '..', '..');

test('shared dropdown keeps a centered neutral chevron and pointer cursor across its control', async ({ page }) => {
  await page.setContent(`
    <!doctype html>
    <div class="ui-dropdown-control" style="width:240px;--muted:rgb(126, 132, 141)">
      <input type="text" aria-label="Exception" value="Custom Collection" readonly>
    </div>
  `);
  await page.addStyleTag({
    path: path.join(repositoryRoot, 'music_app/static/css/runtime/base-layout.css'),
  });
  await page.addStyleTag({
    path: path.join(repositoryRoot, 'music_app/static/css/button-component.css'),
  });

  const control = page.locator('.ui-dropdown-control');
  const input = control.getByRole('textbox');
  const rendered = await control.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const chevron = getComputedStyle(element, '::after');
    const chevronPointTarget = document.elementFromPoint(box.right - 16, box.top + (box.height / 2));
    return {
      inputCursor: getComputedStyle(element.querySelector('input')).cursor,
      inputCaretColor: getComputedStyle(element.querySelector('input')).caretColor,
      chevronPointCursor: getComputedStyle(chevronPointTarget).cursor,
      chevronPointTarget: chevronPointTarget?.tagName,
      visualCenterOffset: (() => {
        const matrix = new DOMMatrix(chevron.transform);
        const borderBoxHeight = Number.parseFloat(chevron.height)
          + Number.parseFloat(chevron.borderTopWidth)
          + Number.parseFloat(chevron.borderBottomWidth);
        return Number.parseFloat(chevron.top) + (borderBoxHeight / 2) + matrix.f
          - (box.height / 2);
      })(),
      width: chevron.width,
      height: chevron.height,
      borderRightColor: chevron.borderRightColor,
      pointerEvents: chevron.pointerEvents,
    };
  });

  expect(rendered.inputCursor).toBe('pointer');
  expect(rendered.inputCaretColor).toBe('rgba(0, 0, 0, 0)');
  expect(rendered.chevronPointCursor).toBe('pointer');
  expect(rendered.chevronPointTarget).toBe('INPUT');
  expect(Math.abs(rendered.visualCenterOffset)).toBeLessThanOrEqual(2);
  expect(rendered.width).toBe('5px');
  expect(rendered.height).toBe('5px');
  expect(rendered.borderRightColor).toBe('rgb(126, 132, 141)');
  expect(rendered.pointerEvents).toBe('none');
  await expect(input).toHaveCSS('cursor', 'pointer');

  await control.click({ position: { x: 224, y: 18 } });
  await expect(input).toBeFocused();

  await input.evaluate((element) => { element.disabled = true; });
  await expect(input).toHaveCSS('cursor', 'not-allowed');
  await expect(control).toHaveCSS('cursor', 'not-allowed');

  await input.evaluate((element) => { element.disabled = false; });
  await expect(input).toHaveCSS('cursor', 'pointer');
  await expect(control).toHaveCSS('cursor', 'pointer');
});

test('exception dropdown toggles its production menu on consecutive pointer clicks', async ({ page }) => {
  await page.setContent(`
    <!doctype html>
    <div id="tag-editor-modal" style="--panel:#1f2937;--text:#f9fafb;--muted:#9ca3af;--border:#4b5563">
      <form class="tag-editor-form" id="tag-editor-form">
        <div class="tag-editor-exception-field" data-tag-editor-exception-anchor>
          <div class="ui-dropdown-control">
            <input
              type="text"
              data-tag-field="exception_type"
              role="combobox"
              aria-expanded="false"
              value=""
              placeholder="None"
              readonly
            >
            <div id="tag-editor-exception-menu" class="tag-editor-exception-menu" role="listbox" hidden></div>
          </div>
        </div>
      </form>
    </div>
  `);
  await page.addStyleTag({
    path: path.join(repositoryRoot, 'music_app/static/css/button-component.css'),
  });
  await page.addStyleTag({
    path: path.join(repositoryRoot, 'music_app/static/css/runtime/utilities.css'),
  });
  await page.addScriptTag({ content: `
    var state = {
      view: {
        non_album_tracks: Array.from({ length: 10000 }, (_, index) => ({
          exception_type: index % 2 ? 'Interview' : 'Non-album rarity',
        })),
      },
    };
    function escapeHtml(value) { return String(value ?? ''); }
    function getTagEditorElements() { return { form: document.getElementById('tag-editor-form') }; }
  ` });
  await page.addScriptTag({
    path: path.join(repositoryRoot, 'music_app/static/js/runtime/utility-loaders-and-cover-lookup.js'),
  });
  await page.addScriptTag({
    path: path.join(repositoryRoot, 'music_app/static/js/runtime/bootstrap-utility-event-handlers.js'),
  });
  await page.evaluate(() => {
    document.addEventListener('click', (event) => handleUtilityBootstrapClick(event));
  });

  const input = page.getByRole('combobox');
  const menu = page.getByRole('listbox');
  await expect(input).toHaveAttribute('readonly', '');
  await expect(input).toHaveAttribute('placeholder', 'None');
  expect(await input.evaluate((element) => element.matches(':placeholder-shown'))).toBe(true);
  await expect(input).toHaveCSS('caret-color', 'rgba(0, 0, 0, 0)');

  const readGeometry = () => input.evaluate((element) => {
    const control = element.closest('.ui-dropdown-control');
    const controlBox = control.getBoundingClientRect();
    const inputBox = element.getBoundingClientRect();
    const chevron = getComputedStyle(control, '::after');
    const matrix = new DOMMatrix(chevron.transform);
    return {
      control: [controlBox.x, controlBox.y, controlBox.width, controlBox.height],
      input: [inputBox.x, inputBox.y, inputBox.width, inputBox.height],
      chevron: [
        controlBox.right - Number.parseFloat(chevron.right) - Number.parseFloat(chevron.width),
        controlBox.top + Number.parseFloat(chevron.top) + matrix.f,
        Number.parseFloat(chevron.width),
        Number.parseFloat(chevron.height),
      ],
    };
  });
  const closedGeometry = await readGeometry();
  const openDuration = await input.evaluate((element) => {
    const startedAt = performance.now();
    element.click();
    const menuElement = document.getElementById('tag-editor-exception-menu');
    if (menuElement.hidden || getComputedStyle(menuElement).display === 'none') return Infinity;
    menuElement.getBoundingClientRect();
    return performance.now() - startedAt;
  });
  await expect(menu).toBeVisible();
  await expect(input).toHaveAttribute('aria-expanded', 'true');
  expect(openDuration).toBeLessThan(50);
  expect(await readGeometry()).toEqual(closedGeometry);

  const closeDuration = await input.evaluate((element) => {
    const startedAt = performance.now();
    element.click();
    const menuElement = document.getElementById('tag-editor-exception-menu');
    if (!menuElement.hidden || getComputedStyle(menuElement).display !== 'none') return Infinity;
    return performance.now() - startedAt;
  });
  await expect(menu).toBeHidden();
  await expect(input).toHaveAttribute('aria-expanded', 'false');
  expect(closeDuration).toBeLessThan(50);
  expect(await readGeometry()).toEqual(closedGeometry);
});

// The stylesheets index.html loads, in its order, including its head partials.
function appStylesheets() {
  const templates = path.join(repositoryRoot, 'music_app/templates');
  const expand = (file, seen = new Set()) => {
    if (seen.has(file)) return '';
    seen.add(file);
    return fs.readFileSync(path.join(templates, file), 'utf8')
      .replace(/{%\s*include\s+["']([^"']+)["']\s*%}/g, (_, include) => expand(include, seen));
  };
  return [...expand('index.html').split('<body')[0].matchAll(/<link rel="stylesheet" href="([^"]+)"/g)]
    .map(([, href]) => href.match(/filename='([^']+)'/)?.[1] || href.replace(/^\/static\//, '').replace(/[?{].*$/, ''))
    .filter((sheet, index, sheets) => sheets.indexOf(sheet) === index);
}

test('the Edit Tags exception dropdown opens and closes in the frame after the press, all in one step', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const exceptionField = fs.readFileSync(path.join(repositoryRoot, 'music_app/templates/partials/primary-modals.html'), 'utf8')
    .match(/<div class="tag-editor-exception-field"[\s\S]*?<\/div><\/div><\/div>/)[0];
  await page.setContent(`<!doctype html><html lang="en"><head></head><body>
    <div id="tag-editor-modal"><div class="tag-editor-dialog" style="margin:200px auto;width:520px">
      <form class="tag-editor-form" id="tag-editor-form">${exceptionField}</form>
      <div id="tag-editor-footer" style="height:60px"></div>
    </div></div>
  </body></html>`);
  for (const sheet of appStylesheets()) {
    await page.addStyleTag({ path: path.join(repositoryRoot, 'music_app/static', sheet) });
  }
  await page.addScriptTag({ content: `
    var state = { view: { non_album_tracks: [] } };
    function escapeHtml(value) { return String(value ?? ''); }
    function getTagEditorElements() { return { form: document.getElementById('tag-editor-form') }; }
  ` });
  for (const script of [
    'js/button-component.js',
    'js/runtime/trigger-anchor.js',
    'js/runtime/utility-loaders-and-cover-lookup.js',
    'js/runtime/bootstrap-utility-event-handlers.js',
  ]) await page.addScriptTag({ path: path.join(repositoryRoot, 'music_app/static', script) });
  // The production document listener (bootstrap-event-handlers.js).
  await page.evaluate(() => {
    document.addEventListener('click', (event) => {
      if (event.defaultPrevented) return;
      handleUtilityBootstrapClick(event);
    });
  });

  const input = page.locator('#tag-editor-exception-input');
  const menu = page.locator('#tag-editor-exception-menu');
  // An empty exception reads as None before any interaction.
  await expect(input).toHaveValue('');
  await expect(input).toHaveAttribute('placeholder', 'None');
  expect(await input.evaluate((element) => element.matches(':placeholder-shown'))).toBe(true);

  // Samples every frame from the press until the gesture has settled.
  const startSampling = () => page.evaluate(() => {
    const field = document.getElementById('tag-editor-exception-input');
    const control = field.closest('.ui-dropdown-control');
    const list = document.getElementById('tag-editor-exception-menu');
    window.dropdownSample = { frames: [], longTasks: [], pressAt: null };
    const sample = window.dropdownSample;
    new PerformanceObserver((entries) => {
      entries.getEntries().forEach((entry) => sample.longTasks.push(entry.duration));
    }).observe({ type: 'longtask' });
    document.addEventListener('pointerdown', () => { sample.pressAt = performance.now(); }, { once: true, capture: true });
    const read = (timestamp) => {
      const listStyle = getComputedStyle(list);
      const fieldStyle = getComputedStyle(field);
      sample.frames.push({
        at: timestamp,
        menuVisible: listStyle.display !== 'none' && list.getBoundingClientRect().height > 0,
        menuOpacity: listStyle.opacity,
        menuTransform: listStyle.transform,
        menuClip: listStyle.clipPath,
        expanded: field.getAttribute('aria-expanded'),
        focused: document.activeElement === field,
        chevron: getComputedStyle(control, '::after').transform,
        outline: [fieldStyle.borderTopColor, fieldStyle.boxShadow, fieldStyle.borderTopLeftRadius, fieldStyle.borderBottomLeftRadius].join(' '),
        // Anything still easing toward its end state on the field, its control, or its menu.
        running: document.getAnimations()
          .filter((animation) => [field, control, list].some((element) => element.contains(animation.effect?.target)))
          .map((animation) => `${animation.transitionProperty || animation.animationName}`),
      });
      if (sample.frames.length < 30) requestAnimationFrame(read);
    };
    requestAnimationFrame(read);
  });
  const readSample = () => page.evaluate(() => {
    const { frames, longTasks, pressAt } = window.dropdownSample;
    return { longTasks, frames: frames.filter((frame) => frame.at > pressAt) };
  });
  const box = await input.boundingBox();
  const chevron = { x: box.x + box.width - 16, y: box.y + box.height / 2 };

  // Open: the menu, the field's focus outline and expanded state all appear in
  // the first frame after the press, and nothing changes after that frame.
  await startSampling();
  await page.mouse.move(chevron.x, chevron.y);
  await page.mouse.down();
  await page.waitForTimeout(150);
  const opening = await readSample();
  const [firstOpen, ...heldOpen] = opening.frames;
  expect(firstOpen).toMatchObject({ menuVisible: true, menuOpacity: '1', expanded: 'true', focused: true, running: [] });
  heldOpen.forEach((frame) => expect({ ...frame, at: 0 }).toEqual({ ...firstOpen, at: 0 }));
  expect(opening.longTasks.filter((duration) => duration > 50)).toEqual([]);
  // Releasing the press neither closes nor redraws the open menu.
  await page.mouse.up();
  await expect(menu).toBeVisible();
  await expect(input).toHaveAttribute('aria-expanded', 'true');
  await expect(menu.getByRole('option', { name: 'None', exact: true })).toHaveAttribute('aria-selected', 'true');

  // Close: a second press closes everything in the frame after it.
  await startSampling();
  await page.mouse.down();
  await page.waitForTimeout(150);
  const closing = await readSample();
  const [firstClosed, ...heldClosed] = closing.frames;
  expect(firstClosed).toMatchObject({ menuVisible: false, expanded: 'false', focused: true, running: [] });
  heldClosed.forEach((frame) => expect({ ...frame, at: 0 }).toEqual({ ...firstClosed, at: 0 }));
  expect(closing.longTasks.filter((duration) => duration > 50)).toEqual([]);
  await page.mouse.up();
  await expect(menu).toBeHidden();
  await expect(input).toHaveAttribute('aria-expanded', 'false');

  // Choosing an option still happens on release, and None stores no exception.
  await page.mouse.down();
  await page.mouse.up();
  await menu.getByRole('option', { name: 'Interview', exact: true }).click();
  await expect(menu).toBeHidden();
  await expect(input).toHaveValue('Interview');
  await page.mouse.move(chevron.x, chevron.y);
  await page.mouse.down();
  await expect(menu).toBeVisible();
  await page.mouse.up();
  await menu.getByRole('option', { name: 'None', exact: true }).click();
  await expect(input).toHaveValue('');
  expect(await input.evaluate((element) => element.matches(':placeholder-shown'))).toBe(true);
});
