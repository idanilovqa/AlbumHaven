const {test, expect, shared, tools, mount, compact, open, waitForResetCall, waitForOnlyResetCall, actionBoxes, expandBounds, resetBounds, headerBounds, assertTailOrder, waitForVisibleHeaderFocus, waitForReachablePanel, waitForPanelGutters, viewportWidths, panelBounds, placeLowerHeader, addDocumentScrollbar, mountNativeWrappers, mountPlayerObstruction} = require('./homeSharedHeaderFixture');

for (const key of ['Enter', 'Space']) test(`Tools toggles through native ${key} activation and reuses original actions`, async ({page}) => {
  await mount(page); await compact(page);
  await page.evaluate(() => {window.originalReset = [...document.querySelectorAll('button')].find(node => node.textContent === 'Reset');});
  await expect(page.getByRole('button', {name: 'Reset', exact: true})).toBeHidden();
  await tools(page).focus(); await page.keyboard.press(key);
  await expect(tools(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('button', {name: 'Reset', exact: true})).toBeVisible();
  await page.getByRole('button', {name: 'Reset', exact: true}).click();
  await waitForResetCall(page);
  await tools(page).focus(); await page.keyboard.press(key);
  await expect(tools(page)).toHaveAttribute('aria-expanded', 'false');
  expect(await page.evaluate(() => window.originalReset === [...document.querySelectorAll('button')].find(node => node.textContent === 'Reset'))).toBe(true);
});

test('child native choice owns first Escape; second closes Tools and restores its trigger', async ({page}) => {
  await mount(page); await open(page);
  const period = page.getByRole('button', {name: 'Period: Last week', exact: true});
  await period.focus(); await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menu', {name: 'Period', exact: true})).toBeVisible();
  await expect(page.getByRole('menuitemradio', {name: 'Last week', exact: true})).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu', {name: 'Period', exact: true})).toHaveCount(0);
  await expect(tools(page)).toHaveAttribute('aria-expanded', 'true'); await expect(period).toBeFocused();
  await page.keyboard.press('Escape'); await expect(tools(page)).toHaveAttribute('aria-expanded', 'false'); await expect(tools(page)).toBeFocused();
});

test('selecting a native child option keeps Tools available and updates current count', async ({page}) => {
  await mount(page); await open(page);
  await page.getByRole('button', {name: 'Period: Last week', exact: true}).click();
  await page.getByRole('menuitemradio', {name: 'Last month', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Period: Last month', exact: true})).toBeFocused();
  await expect(tools(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator(shared)).toContainText('28');
  await expect(page.getByRole('button', {name: 'Period: Last month', exact: true})).toHaveText('');
});

test('outside pointer closes Tools without taking focus from the clicked control', async ({page}) => {
  await mount(page); await open(page);
  await page.getByRole('button', {name: 'Outside target', exact: true}).click();
  await expect(tools(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', {name: 'Outside target', exact: true})).toBeFocused();
});

test('refresh retains native action identity and applies latest callback and disabled authority', async ({page}) => {
  await mount(page); await open(page);
  await page.getByRole('button', {name: 'Missing', exact: true}).focus();
  await page.evaluate(() => {window.retainedMissing = document.activeElement; window.fixtureUpdate({permitted: false});});
  await expect(page.getByRole('button', {name: 'Missing', exact: true})).toBeDisabled();
  expect(await page.evaluate(() => window.retainedMissing === [...document.querySelectorAll('button')].find(node => node.textContent === 'Missing'))).toBe(true);
  await page.evaluate(() => window.retainedMissing.click());
  expect(await page.evaluate(() => window.fixtureCalls)).not.toContain('missing');
  await page.getByRole('button', {name: 'Reset', exact: true}).click();
  expect(await page.evaluate(() => window.fixtureCalls)).toContain('reset:1');
});

test('real measured resize fits one action row without cloning or leaving an orphan choice', async ({page}) => {
  await mount(page); await open(page);
  await page.getByRole('button', {name: 'Rows: All rows', exact: true}).click();
  await expect(page.getByRole('menu', {name: 'Rows', exact: true})).toBeVisible();
  await page.evaluate(() => {window.retainedRows = document.querySelector('[aria-label="Rows: All rows"]');});
  await page.setViewportSize({width: 1500, height: 700});
  await expect(page.locator(shared)).toHaveAttribute('data-header-compact', 'false');
  await expect(tools(page)).toBeHidden();
  await expect(page.getByRole('button', {name: 'Reset', exact: true})).toBeVisible();
  expect(await page.evaluate(() => window.retainedRows === document.querySelector('[aria-label="Rows: All rows"]'))).toBe(true);
  const boxes = await actionBoxes(page);
  const midpoints = boxes.map(box => box.y + box.height / 2);
  expect(Math.max(...midpoints) - Math.min(...midpoints)).toBeLessThanOrEqual(2);
  await page.setViewportSize({width: 370, height: 700}); await compact(page);
  await expect(tools(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('menu', {name: 'Rows', exact: true})).toHaveCount(0);
  expect(await page.locator('[aria-label="Rows: All rows"]').count()).toBe(1);
});

test('unmount retires child menu and document-level dismissal ownership', async ({page}) => {
  await mount(page); await open(page);
  await page.getByRole('button', {name: 'Rows: All rows', exact: true}).click();
  await page.evaluate(() => window.fixtureUnmount());
  await expect(page.getByRole('menu')).toHaveCount(0); await expect(page.locator(shared)).toHaveCount(0);
  await page.getByRole('button', {name: 'Outside target', exact: true}).focus(); await page.keyboard.press('Escape');
  await expect(page.getByRole('button', {name: 'Outside target', exact: true})).toBeFocused();
});

// The caller supplies this priority order; SharedHeader must preserve both the
// order and original native nodes rather than sort, clone or proxy them.
for (const finalOrder of [['collapse'], ['collapse', 'more'], ['collapse', 'more', 'close']]) {
  const names = finalOrder.map(icon => ({collapse: 'Collapse', more: 'More actions', close: 'Close'})[icon]);
  test(`caller tail keeps ${names.at(-1)} rightmost across inline and compact layouts`, async ({page}) => {
    await mount(page, 1500, finalOrder);
    await expect(page.locator(shared)).toHaveAttribute('data-header-compact', 'false');
    await page.evaluate(labels => {window.originalTail = labels.map(label => document.querySelector('button[aria-label="' + label + '"]'));}, names);
    await assertTailOrder(page, names);
    const expand = await expandBounds(page);
    const reset = await resetBounds(page);
    expect(expand.x + expand.width).toBeLessThanOrEqual(reset.x);
    await page.setViewportSize({width: 370, height: 700}); await compact(page);
    for (const name of names) await expect(page.getByRole('button', {name, exact: true})).toBeHidden();
    await open(page); await assertTailOrder(page, names);
    expect(await page.evaluate(labels => labels.every((label, index) => window.originalTail[index] === document.querySelector('button[aria-label="' + label + '"]')), names)).toBe(true);
    for (const name of names) await expect(page.locator(shared).getByRole('button', {name, exact: true})).toHaveCount(1);
  });
}

for (const key of ['Enter', 'Space']) test(`opening Tools with ${key} makes its native actions reachable by forward Tab`, async ({page}) => {
  await mount(page); await compact(page);
  await tools(page).focus(); await page.keyboard.press(key);
  await expect(tools(page)).toHaveAttribute('aria-expanded', 'true');
  const visited = [];
  for (let index = 0; index < 8; index++) {
    await page.keyboard.press('Tab');
    visited.push(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent?.trim()));
    if (visited.at(-1) === 'Reset') break;
    expect(visited.at(-1)).not.toBe('Outside target');
  }
  expect(visited).toContain('Reset');
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => window.fixtureCalls)).toContain('reset:0');
});

test('compact-to-inline measurement returns Tools focus to a connected visible native action', async ({page}) => {
  await mount(page); await compact(page); await tools(page).focus();
  await page.setViewportSize({width: 1500, height: 700});
  await expect(page.locator(shared)).toHaveAttribute('data-header-compact', 'false');
  await expect(tools(page)).toBeHidden();
  await waitForVisibleHeaderFocus(page);
  await expect(page.getByRole('button', {name: 'Reset', exact: true})).toBeFocused();
  await page.keyboard.press('Enter');
  await waitForOnlyResetCall(page);
});

for (const obstructed of [false, true]) test(`lower short-viewport capsule stays reachable${obstructed ? ' above the global player' : ''}`, async ({page}) => {
  await mount(page); await page.setViewportSize({width: 370, height: 320});
  // These are real component placement/obstruction inputs, not invented DOM
  // measurements or substitutions for the actual player runtime.
  await placeLowerHeader(page, obstructed);
  if (obstructed) await mountPlayerObstruction(page);
  await open(page);
  const panel = page.locator(`${shared} .home-header__floating-panel`);
  await expect(panel).toHaveCount(1); await expect(panel).toBeVisible();
  await waitForReachablePanel(page, panel, obstructed);
  const box = await panelBounds(panel), header = await headerBounds(page);
  expect(box.y + box.height, 'a lower header opens above when there is more usable space').toBeLessThanOrEqual(header.y);
  await page.getByRole('button', {name: 'Collapse', exact: true}).scrollIntoViewIfNeeded();
  await page.getByRole('button', {name: 'Collapse', exact: true}).click();
  expect(await page.evaluate(() => window.fixtureCalls)).toContain('collapse');
});

test('inline focused native Period menu retires into visible Tools when measurement becomes compact', async ({page}) => {
  await mount(page, 1500);
  await expect(page.locator(shared)).toHaveAttribute('data-header-compact', 'false');
  const period = page.getByRole('button', {name: 'Period: Last week', exact: true});
  await period.evaluate(node => {window.retainedPeriodAnchor = node;});
  await period.focus(); await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitemradio', {name: 'Last week', exact: true})).toBeFocused();
  await page.setViewportSize({width: 370, height: 700});
  await compact(page);
  await expect(page.getByRole('menu', {name: 'Period', exact: true})).toHaveCount(0);
  await expect(tools(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(tools(page)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(tools(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(period).toBeVisible();
  expect(await period.evaluate(node => node === window.retainedPeriodAnchor)).toBe(true);
  expect(await page.evaluate(() => window.fixtureCalls)).toEqual([]);
});

test('retiring an unfocused native Period menu on compact transition does not steal outside focus', async ({page}) => {
  await mount(page, 1500);
  await expect(page.locator(shared)).toHaveAttribute('data-header-compact', 'false');
  await page.getByRole('button', {name: 'Period: Last week', exact: true}).click();
  await expect(page.getByRole('menu', {name: 'Period', exact: true})).toBeVisible();
  const outside = page.getByRole('button', {name: 'Outside target', exact: true});
  // Focus movement is deliberate and does not send an outside pointer event;
  // the native menu remains mounted until the ensuing measured concealment.
  await outside.focus(); await expect(outside).toBeFocused();
  await page.setViewportSize({width: 370, height: 700}); await compact(page);
  await expect(page.getByRole('menu', {name: 'Period', exact: true})).toHaveCount(0);
  await expect(outside).toBeFocused();
  await expect(tools(page)).toHaveAttribute('aria-expanded', 'false');
});

test('Period selection preserves mounted Tools and Period nodes, disclosure state, focus and current callbacks', async ({page}) => {
  await mount(page); await open(page);
  await page.evaluate(() => {
    window.beforePeriodRerender = {
      tools: document.querySelector('button[data-header-tools]'),
      period: document.querySelector('button[aria-label="Period: Last week"]'),
      reset: [...document.querySelectorAll('button')].find(node => node.textContent === 'Reset'),
    };
  });
  await page.getByRole('button', {name: 'Period: Last week', exact: true}).click();
  await page.getByRole('menuitemradio', {name: 'Last month', exact: true}).click();
  await expect(page.locator(shared)).toContainText('28');
  await expect(tools(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator(`${shared} .home-header__floating-panel`)).toBeVisible();
  const period = page.getByRole('button', {name: 'Period: Last month', exact: true});
  await expect(period).toBeFocused();
  expect(await page.evaluate(() => {
    const held = window.beforePeriodRerender;
    return held.tools === document.querySelector('button[data-header-tools]')
      && held.period === document.querySelector('button[aria-label="Period: Last month"]')
      && held.reset === [...document.querySelectorAll('button')].find(node => node.textContent === 'Reset');
  })).toBe(true);
  await page.getByRole('button', {name: 'Reset', exact: true}).click();
  expect(await page.evaluate(() => window.fixtureCalls)).toEqual(['reset:0']);
  await page.keyboard.press('Escape');
  await expect(tools(page)).toHaveAttribute('aria-expanded', 'false'); await expect(tools(page)).toBeFocused();
});

test('repeated unrelated parent refresh preserves expanded native markup and focused control identity', async ({page}) => {
  await mount(page); await open(page);
  const period = page.getByRole('button', {name: 'Period: Last week', exact: true});
  await period.focus();
  await page.evaluate(() => {
    window.beforeNoopRefresh = {tools: document.querySelector('button[data-header-tools]'), period: document.activeElement};
  });
  for (let revision = 1; revision <= 3; revision++) {
    await page.evaluate(() => window.fixtureUpdate({}));
    await expect(tools(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator(`${shared} .home-header__floating-panel`)).toBeVisible();
    await expect(period).toBeFocused();
    expect(await page.evaluate(() => window.beforeNoopRefresh.tools === document.querySelector('button[data-header-tools]')
      && window.beforeNoopRefresh.period === document.activeElement)).toBe(true);
  }
  await page.getByRole('button', {name: 'Reset', exact: true}).click();
  expect(await page.evaluate(() => window.fixtureCalls)).toEqual(['reset:3']);
});

test('Tabs and ViewControl keep their mounted native owners through unrelated React19 parent renders', async ({page}) => {
  await mount(page, 1500);
  await page.evaluate(() => {window.fixtureUnmount();});
  await mountNativeWrappers(page);
  await page.getByRole('button', {name: 'Grouped tracks', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Listening history', exact: true})).toBeVisible();
  await page.evaluate(() => {window.wrapperNodes = {
    tabs: document.querySelector('#native-wrapper-tabs'), recent: document.querySelector('[data-in-page-tab="recent"]'),
    view: document.querySelector('.unfolding-action-button'), grouped: document.querySelector('[data-action-value="grouped"]'),
    history: document.querySelector('[data-action-value="history"]'),
  };});
  for (let revision = 1; revision <= 3; revision++) {
    await page.evaluate(() => window.refreshWrappers());
    await expect(page.locator('[data-probe-revision]')).toHaveText(String(revision));
    expect(await page.evaluate(() => {
      const n = window.wrapperNodes;
      return n.tabs === document.querySelector('#native-wrapper-tabs') && n.recent === document.querySelector('[data-in-page-tab="recent"]')
        && n.view === document.querySelector('.unfolding-action-button') && n.grouped === document.querySelector('[data-action-value="grouped"]')
        && n.history === document.querySelector('[data-action-value="history"]');
    })).toBe(true);
    await expect(page.getByRole('button', {name: 'Grouped tracks', exact: true})).toHaveAttribute('aria-expanded', 'true');
  }
  await page.getByRole('button', {name: 'Listening history', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Listening history', exact: true})).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', {name: 'Listening history', exact: true})).toBeFocused();
  expect(await page.evaluate(() => window.wrapperNodes.history === document.activeElement && window.wrapperNodes.tabs === document.querySelector('#native-wrapper-tabs'))).toBe(true);
  await page.getByRole('tab', {name: 'News', exact: true}).click();
  await expect(page.getByRole('tab', {name: 'News', exact: true})).toHaveAttribute('aria-selected', 'true');
  expect(await page.evaluate(() => window.wrapperCalls)).toEqual(['view:history', 'tab:news']);
});

test('compact capsule respects the 8px left gutter with a real document scrollbar', async ({page}) => {
  await mount(page, 1180);
  await addDocumentScrollbar(page);
  await compact(page);
  const viewport = await viewportWidths(page);
  expect(viewport.clientWidth).toBeLessThan(viewport.innerWidth);
  await open(page);
  const panel=page.locator(`${shared} .home-header__floating-panel`); await expect(panel).toBeVisible();
  await waitForPanelGutters(page, panel);
  await page.getByRole('button',{name:'Collapse',exact:true}).click();
  expect(await page.evaluate(()=>window.fixtureCalls)).toContain('collapse');
});
