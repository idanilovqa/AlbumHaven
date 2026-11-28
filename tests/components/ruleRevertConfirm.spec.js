const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

// Settings → Rules: every Revert rule button asks "Revert rule?" (No / Yes) in front of Settings.
// The page runs every runtime module of the bundle, in bundle order, on the real modal templates.
const root = path.resolve(__dirname, '../..');
const templates = path.join(root, 'music_app/templates');
const stripJinja = markup => markup.replace(/{%[^]*?%}|{{[^]*?}}/g, '');
const modals = stripJinja(fs.readFileSync(path.join(templates, 'partials/primary-modals.html'), 'utf8')
  + fs.readFileSync(path.join(templates, 'partials/confirm-modals.html'), 'utf8')
    .replace('{% include "partials/app-form-modal.html" %}', fs.readFileSync(path.join(templates, 'partials/app-form-modal.html'), 'utf8')));
const navigationTreeItem = fs.readFileSync(path.join(templates, 'components/navigation-tree-item.html'), 'utf8');
const runtimeModules = fs.readFileSync(path.join(root, 'music_app/static/js/runtime-bundle.js'), 'utf8')
  .split('\n').filter(line => line.startsWith('// BEGIN ')).map(line => line.slice('// BEGIN '.length).trim())
  .filter(file => !file.endsWith('/bootstrap-init.js'));
const pageScripts = ['capability-ui.js', 'client-device-preferences.js', 'button-component.js', 'unfolding-action-button.js', 'navigation-tree.js'];
const styles = ['runtime/base-layout.css', 'runtime/compact-data-table.css', 'runtime/alert-components.css', 'dialog-component.css',
  'runtime/utilities.css', 'runtime/shell-persistent-player.css', 'navigation-tree.css', 'mobile-layout.css'];
const allowedActions = { 'library.rules.read': true, 'library.rules.manage': true, 'library.versions.manage': true, 'library.problems.read': true };
const capabilities = { allowed_actions: allowedActions, denied_selectors: [], read_only_selectors: [], denied_tabs: [],
  available_tabs: ['problematic-files', 'rules'], client_surface: 'private_web', cover_provider_groups: [] };

const albumExclusion = { row_key: 'rr-moby::play::problem-album::missing-year', scope: 'album', album_key: 'rr-moby::play', artist: 'Moby', album: 'Play', problem_reason: 'Missing year' };
const fileExclusion = { row_key: 'Moby/Play/01 Honey.flac::problem-file::missing-year', scope: 'file', path: 'Moby/Play/01 Honey.flac', filename: '01 Honey.flac', album: 'Play', problem_reason: 'Missing year' };
const addedExclusion = { row_key: 'rr-juha::kivi::problem-album::album-name-mismatch', scope: 'album', album_key: 'rr-juha::kivi', reason: 'Album name mismatch' };
const versionException = { key: 'rr-abba::gold', name: 'Gold', album_artist: 'Abba', year: '1992' };
const rulesPayload = { ok: true, failed_ignored_repairs: [], ignored_version_keys: [versionException.key], rules: [
  { key: 'version-exceptions', title: 'Version exceptions', count: 1, albums: [versionException] },
  { key: 'problem-ignores', title: 'Problem exclusions', count: 2, items: [albumExclusion, fileExclusion], album_items: [albumExclusion], file_items: [fileExclusion] },
] };
// Rules saved before the album/file split still arrive as one grouped list.
const legacyRulesPayload = { ...rulesPayload, rules: [rulesPayload.rules[0], { key: 'problem-ignores', title: 'Problem exclusions', count: 1, items: [fileExclusion] }] };

const clients = [
  { name: 'desktop browser', options: { viewport: { width: 1280, height: 860 } } },
  // A wide tablet or a phone held sideways is a mobile client with the desktop layout (wider than 900 px).
  { name: 'mobile client wider than 900 px', options: { viewport: { width: 1180, height: 820 }, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36' } },
];

async function openRules(page, payload = rulesPayload) {
  const reverts = [];
  await page.route('http://rules.test/**', async route => {
    const url = new URL(route.request().url());
    const json = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>
        <script id="capability-bootstrap" type="application/json">${JSON.stringify(capabilities)}</script>
        <script>window.__ALBUM_HAVEN_UTILITY_ALLOWED_ACTIONS__ = ${JSON.stringify(allowedActions)};</script>
        <script id="navigation-tree-item-template" type="text/plain">${navigationTreeItem}</script>
        <nav class="mobile-navigation" id="mobile-navigation"></nav><form id="search-form"></form>
        <main><div id="albums-scroll"><div id="albums-spacer-top"></div><div id="artist-groups"></div><div id="albums-spacer-bottom"></div></div></main>
        <div class="mobile-page-outlet" id="mobile-page-outlet" hidden></div>
        ${modals}</body></html>` });
    }
    if (url.pathname === '/utilities/rules') return json(payload);
    if (url.pathname === '/utilities/rules/problem-ignores') {
      const { items } = JSON.parse(route.request().postData());
      return json({ ok: true, status: 'applied', removed_legacy_row_keys: [], applied_items: items.map(item => ({ ...item, artist: 'Juha', album: 'Kivi', problem_reason: 'Album name mismatch' })) });
    }
    if (url.pathname.endsWith('/revert')) {
      reverts.push({ path: url.pathname, body: JSON.parse(route.request().postData()) });
      return json({ ok: true, status: 'applied', rules: rulesPayload.rules.filter(rule => rule.key !== 'version-exceptions'), ignored_version_keys: [] });
    }
    return json({});
  });
  await page.goto('http://rules.test/');
  for (const file of pageScripts) await page.addScriptTag({ path: path.join(root, 'music_app/static/js', file) });
  for (const file of runtimeModules) await page.addScriptTag({ path: path.join(root, 'music_app/static', file) }).catch(() => {});
  for (const file of styles) await page.addStyleTag({ path: path.join(root, 'music_app/static/css', file) });
  await page.evaluate(() => {
    attachModalEvents();
    attachUtilityModalEvents();
    attachRepairConfirmEvents();
    initMobileNavigation();
    setUtilityActiveTab('rules');
    openUtilityModal();
  });
  await expect(page.locator('[data-utility-rule-key="version-exceptions"]')).toBeVisible();
  return reverts;
}

async function showProblemExclusions(page) {
  await page.locator('[data-utility-rule-key="problem-ignores"]').click();
  await expect(page.getByRole('heading', { name: 'Problem exclusions' })).toBeVisible();
}

// Excludes a problem through the Problematic Files confirmation, as the owner does before opening Rules.
async function addExclusionFromProblematicFiles(page) {
  await page.evaluate((item) => {
    state.utility.problematicFiles = [{ key: item.album_key, name: 'Kivi', album_artist: 'Juha', problem_reasons: [item.reason],
      album_problem_rows: [{ row_key: item.row_key, album_key: item.album_key, reason: item.reason }], track_problem_rows: [] }];
    state.utility.selectedProblematicKey = item.album_key;
    state.utility.pendingRepairKey = item.album_key;
    state.utility.problemExclusionSelections = { [item.row_key]: true };
    state.utility.pendingRepairAction = 'detected';
    openRepairConfirmModal();
  }, addedExclusion);
  await page.getByRole('button', { name: 'Create Exception' }).click();
  await expect(page.locator('#repair-confirm-modal')).toBeHidden();
}

async function expectRevertDialogOnTop(page, target) {
  const dialog = page.getByRole('dialog', { name: 'Revert rule?' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(`Revert the rule for ${target}?`);
  await expect(dialog.getByRole('button', { name: 'No', exact: true })).toBeFocused();
  const onTop = await dialog.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
  });
  expect(onTop).toBe(true);
  return dialog;
}

const cases = [
  { kind: 'version exception', target: 'Gold', button: '[data-revert-version-exception="rr-abba::gold"]',
    request: { path: '/utilities/rules/version-exceptions/revert', body: { album_key: 'rr-abba::gold' } } },
  { kind: 'album exclusion', target: 'Play', button: `[data-revert-problem-ignore="${albumExclusion.row_key}"]`, exclusions: true,
    request: { path: '/utilities/rules/problem-ignores/revert', body: { row_key: albumExclusion.row_key } } },
  { kind: 'file exclusion', target: '01 Honey.flac', button: `[data-revert-problem-ignore="${fileExclusion.row_key}"]`, exclusions: true,
    request: { path: '/utilities/rules/problem-ignores/revert', body: { row_key: fileExclusion.row_key } } },
  { kind: 'exclusion just added in Problematic Files', target: 'Kivi', button: `[data-revert-problem-ignore="${addedExclusion.row_key}"]`, exclusions: true, added: true,
    request: { path: '/utilities/rules/problem-ignores/revert', body: { row_key: addedExclusion.row_key } } },
  { kind: 'exclusion in the legacy grouped list', target: '01 Honey.flac', button: `[data-revert-problem-ignore="${fileExclusion.row_key}"]`, exclusions: true, payload: legacyRulesPayload,
    request: { path: '/utilities/rules/problem-ignores/revert', body: { row_key: fileExclusion.row_key } } },
];

for (const client of clients) {
  test.describe(`Revert rule on a ${client.name}`, () => {
    test.use(client.options);
    for (const item of cases) {
      test(`${item.kind}: No keeps the rule, Yes reverts it`, async ({ page }) => {
        const reverts = await openRules(page, item.payload);
        if (item.added) await addExclusionFromProblematicFiles(page);
        if (item.exclusions) await showProblemExclusions(page);
        const revert = page.locator(item.button);
        await expect(revert).toBeVisible();

        await revert.click();
        const dialog = await expectRevertDialogOnTop(page, item.target);
        await dialog.getByRole('button', { name: 'No', exact: true }).click();
        await expect(dialog).toBeHidden();
        await expect(revert).toBeVisible();
        await expect(revert).toBeFocused();
        expect(reverts).toEqual([]);

        await revert.click();
        await (await expectRevertDialogOnTop(page, item.target)).getByRole('button', { name: 'Yes', exact: true }).click();
        await expect(page.locator('#repair-confirm-modal')).toBeHidden();
        await expect.poll(() => reverts).toEqual([item.request]);
      });
    }
  });
}
