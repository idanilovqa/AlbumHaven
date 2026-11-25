const path = require('node:path');
const { test, expect } = require('@playwright/test');

const staticRoot = path.resolve(__dirname, '../../music_app/static');
const runtimeRoot = path.join(staticRoot, 'js', 'runtime');

// Python sorted() order of the row keys, which is the order the Rules payload lists them after a reload.
const SERVER_ORDER = [
  ['Abba/Gold/01 Dancing Queen.flac', '01 Dancing Queen.flac'],
  ['Moby/Play/01 Honey.flac', '01 Honey.flac'],
  ['Zeta/Zero/01 Start.flac', '01 Start.flac'],
  ['abba/gold/02 Waterloo.flac', '02 Waterloo.flac'],
  ['Émile/Encore/01 Bis.flac', '01 Bis.flac'],
  ['Алиса/Энергия/01 Пачка.flac', '01 Пачка.flac'],
  ['Ａ Wide/Album/01 Track.flac', '01 Track.flac'],
  ['\u{1d11e} Clef/Album/02 Track.flac', '02 Track.flac'],
].map(([filePath, filename]) => ({
  row_key: `${filePath}::problem-file::missing-year`,
  scope: 'file',
  path: filePath,
  filename,
  problem_reason: 'Missing year',
}));
const EXISTING = [SERVER_ORDER[1], SERVER_ORDER[5]];
const ADDED = SERVER_ORDER.filter((item) => !EXISTING.includes(item));

async function mountRulesTable(page) {
  await page.setViewportSize({ width: 900, height: 900 });
  await page.setContent('<div id="detail"></div>');
  for (const file of ['runtime/compact-data-table.css', 'runtime/utilities.css']) {
    await page.addStyleTag({ path: path.join(staticRoot, 'css', file) });
  }
  await page.evaluate((existing) => {
    window.state = { utility: { rules: [{
      key: 'problem-ignores', title: 'Problem exclusions', count: existing.length,
      items: existing, album_items: [], file_items: existing,
    }], problematicFiles: [] } };
    window.escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);
    window.buildOnPageAlertHtml = () => '';
    window.buildSmallAlertHtml = () => '';
    window.closeRepairConfirmModal = () => {};
    window.showToast = () => {};
    window.waitForProblematicUtilityRenderFrame = () => Promise.resolve();
    window.renderUtilityModalContent = () => {
      const rule = window.state.utility.rules.find(item => item.key === 'problem-ignores');
      document.getElementById('detail').innerHTML = window.buildUtilityRuleDetail(rule);
    };
    window.releaseCreate = null;
    window.fetch = () => new Promise((resolve) => { window.releaseCreate = resolve; });
  }, EXISTING);
  for (const file of ['compact-data-table.js', 'utility-list-builders.js', 'problem-exclusion-mutations.js']) {
    await page.addScriptTag({ path: path.join(runtimeRoot, file) });
  }
  await page.evaluate(() => window.renderUtilityModalContent());
}

async function visibleFilenames(page) {
  const rows = page.getByRole('table', { name: 'File exclusions' }).locator('.compact-data-table-body > [role="row"]');
  const boxes = await rows.evaluateAll(elements => elements.map(element => ({
    top: element.getBoundingClientRect().top,
    name: element.querySelector('.utility-rule-album-title').textContent,
    busy: element.getAttribute('aria-busy') === 'true',
  })));
  for (let index = 1; index < boxes.length; index += 1) {
    expect(boxes[index].top).toBeGreaterThan(boxes[index - 1].top);
  }
  return boxes;
}

test('a queued and then saved Ignore shows each rule at its reload position', async ({ page }) => {
  await mountRulesTable(page);
  await expect(page.getByRole('table', { name: 'File exclusions' })).toBeVisible();
  expect((await visibleFilenames(page)).map(row => row.name)).toEqual(EXISTING.map(item => item.filename));

  const completion = page.evaluate(added => {
    window.createCompletion = window.queueProblemExclusionCreate({ album: { key: 'album' }, items: added });
  }, ADDED);
  await completion;
  const queued = await visibleFilenames(page);
  expect(queued.map(row => row.name)).toEqual(SERVER_ORDER.map(item => item.filename));
  expect(queued.map(row => row.busy)).toEqual(SERVER_ORDER.map(item => !EXISTING.includes(item)));

  await page.evaluate(async added => {
    window.releaseCreate({ ok: true, json: async () => ({ ok: true, applied_items: added }) });
    await window.createCompletion;
  }, ADDED);
  const saved = await visibleFilenames(page);
  expect(saved.map(row => row.name)).toEqual(SERVER_ORDER.map(item => item.filename));
  expect(saved.every(row => !row.busy)).toBe(true);
  await expect(page.locator('[data-revert-problem-ignore]')).toHaveCount(SERVER_ORDER.length);
});
