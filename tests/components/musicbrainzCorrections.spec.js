// MusicBrainz data corrections and the Edits Queue (Delivery 2, S4): approved mockups D1, D2,
// E1, E2 and I1, with the owner's 2026-11-15 answers ("Add to queue", "Auto submit bulks").
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

const root = path.join(__dirname, '..', '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const indexTemplate = read('music_app/templates/index.html');
// The page's own stylesheets, after the shared ones its partials link first.
const stylesheets = [...['css/appearance-backgrounds.css', 'css/button-component.css', 'css/navigation-tree.css'].map((file) => [, file]),
  ...indexTemplate.matchAll(/filename='(css\/[^']+)'|href="\/static\/(css\/[^"?]+)/g)]
  .map((match) => path.join(root, 'music_app', 'static', match[1] || match[2]))
  .filter((file) => fs.existsSync(file));

const CASE_ROW = { field: 'title', label: 'Track 1 title', disc_number: 1, track_number: 1, current_value: 'malawelekaahm',
  proposed_value: 'Malawêlekaahm', kind: 'accents', mode: 'auto', state: 'applied' };
const ARTIST_ROW = { field: 'album_artist', label: 'Album artist', disc_number: 0, track_number: 0,
  current_value: 'Christian Vander', proposed_value: 'Magma', kind: 'album_artist_renamed', mode: 'review', state: 'pending' };

async function mount(page, { width = 1440, height = 900, phone = false } = {}) {
  await page.setViewportSize({ width, height });
  await page.setContent(`<!doctype html><html><body class="has-dark-theme">
    <div class="utility-modal${phone ? ' is-mobile-page' : ''}" id="utility-modal" data-active-tab="edits-queue">
      <div class="utility-modal-dialog" role="dialog" aria-label="Settings">
        <div class="utility-modal-body">
          <aside class="utility-sidebar"><div class="utility-list" id="utility-problematic-list"></div></aside>
          <section class="utility-detail" id="utility-problematic-detail"></section>
        </div>
      </div>
    </div></body></html>`);
  for (const file of stylesheets) await page.addStyleTag({ path: file });
  await page.addScriptTag({ content: `
    window.state = { utility: { activeTab: 'edits-queue', problematicFiles: [] } };
    window.AlbumHavenCapabilities = { allows: (action) => action === 'library.metadata_matches.review' };
    window.showToast = () => {};
    // The cover URL helpers live in modal-and-overlay-helpers.js, not loaded here: no cover art.
    window.buildAlbumDisplayCoverUrl = () => '';
    window.buildAlbumLightboxCoverUrl = () => '';
    window.getUtilityModalElements = () => ({ overlay: document.getElementById('utility-modal'),
      detail: document.getElementById('utility-problematic-detail'), list: document.getElementById('utility-problematic-list') });
  ` });
  for (const file of [
    'music_app/static/js/button-component.js',
    'music_app/static/js/runtime/markup-format-helpers.js',
    'music_app/static/js/runtime/alert-components.js',
    'music_app/static/js/runtime/album-artbox.js',
    'music_app/static/js/runtime/compact-data-table.js',
    'music_app/static/js/runtime/utility-list-builders.js',
    'music_app/static/js/runtime/gallery-main-components.js',
    'music_app/static/js/runtime/album-details-components.js',
    'music_app/static/js/runtime/musicbrainz-corrections.js',
  ]) {
    await page.addScriptTag({ path: path.join(root, file) });
  }
}

async function showQueue(page, tab, section = 'applied') {
  await page.evaluate(([selected, chosen, caseRow, artistRow]) => {
    const album = (key, title, rows) => ({ album_key: key, album_title: title, artist_name: 'Christian Vander', year: 1974, rows });
    Object.assign(editsQueue, {
      tab: selected, section: chosen, settings: { auto_submit_bulks: false, next_run_at: null },
      kinds: chosen === 'applied'
        ? [{ kind: 'accents', albums: 2, rows: 2 }, { kind: 'case', albums: 40, rows: 120 }]
        : [{ kind: 'edition_suffix', albums: 3, rows: 4 }, { kind: 'album_artist_renamed', albums: 1, rows: 1 },
          { kind: 'whole_album', albums: 1, rows: 6 }],
      openKind: chosen === 'applied' ? 'accents' : 'album_artist_renamed',
      pages: chosen === 'applied'
        ? { 'applied:accents': { albums: [album('wurdah', 'Wurdah Ïtah', [caseRow]), album('kohntark', 'Köhntarkösz', [caseRow])], nextOffset: null } }
        : { 'review:album_artist_renamed': { albums: [album('wurdah', 'Wurdah Ïtah', [artistRow])], nextOffset: null } },
      queueStartsAt: '2026-11-16T11:20:00Z',
      lookups: [
        { request_id: 9, target_kind: 'album', album_key: 'live', album_title: 'Live At Budokan', artist_name: 'Dream Theater', year: 2004, requested_at: '2026-11-16T10:20:00Z' },
        { request_id: 10, target_kind: 'artist', local_artist_id: 41, artist_name: 'Ktzat Acheret', requested_at: '2026-11-16T10:22:00Z' },
      ],
    });
    renderUtilityEditsQueue();
  }, [tab, section, CASE_ROW, ARTIST_ROW]);
}

test('D1: a data correction entry shows its label and its changes with their status, and no Add to queue', async ({ page }) => {
  await mount(page);
  await page.evaluate(([caseRow, artistRow]) => {
    document.getElementById('utility-modal').setAttribute('data-active-tab', 'problematic-files');
    document.getElementById('utility-problematic-detail').innerHTML = buildMusicBrainzCorrectionProblemDetail({
      key: 'musicbrainz-correction:wurdah', entity_kind: 'musicbrainz_correction', name: 'Wurdah Ïtah',
      album_artist: 'Christian Vander', year: 1974,
      musicbrainz_correction: { album_key: 'wurdah', corrections: [caseRow, artistRow] },
    });
  }, [CASE_ROW, ARTIST_ROW]);
  const detail = page.locator('#utility-problematic-detail');

  await expect(detail.locator('.alert-label--warning')).toHaveText('Data Correction Needed');
  await expect(detail.getByRole('columnheader')).toHaveText(['Tag', 'In your files', 'MusicBrainz', 'Status']);
  await expect(detail.getByRole('row').nth(1).getByRole('cell')).toHaveText(['Track 1 title', 'malawelekaahm', 'Malawêlekaahm', 'Applied']);
  await expect(detail.getByRole('row').nth(2).getByRole('cell')).toHaveText(['Album artist', 'Christian Vander', 'Magma', 'Waiting for approval']);
  await expect(detail.getByRole('button', { name: /Add to queue|Apply changes/ })).toHaveCount(0);
});

test('E1: Applied automatically lists kinds and pages albums with Undo; Auto submit bulks off; Bulk Correction visibly disabled', async ({ page }) => {
  await mount(page);
  await showQueue(page, 'data-correction');

  await expect(page.locator('.utility-sidebar')).toBeHidden();
  const detail = page.locator('#utility-problematic-detail');
  await expect(detail.locator('.edits-queue > .in-page-tabs').getByRole('tab')).toHaveText(['Data Correction', 'MusicBrainz Look Up']);
  await expect(detail.locator('.edits-queue-sections').getByRole('tab')).toHaveText(['Applied automatically', 'Waiting for approval']);
  await expect(detail.getByRole('switch', { name: 'Auto submit bulks' })).toHaveAttribute('aria-checked', 'false');
  const bulk = detail.getByRole('button', { name: 'Bulk Correction' });
  await expect(bulk).toBeDisabled();
  await expect(bulk).toHaveAttribute('title', 'Bulk Correction arrives soon.');
  expect(Number(await bulk.evaluate((node) => getComputedStyle(node).opacity))).toBeLessThan(1);
  await expect(detail.locator('[data-edits-queue-open-kind]')).toHaveText(['Accents · 2 albums, 2 changes', 'Case only · 40 albums, 120 changes']);
  const albums = detail.locator('[data-edits-queue-album-row]');
  await expect(albums).toHaveCount(2);
  await expect(albums.first().locator('.version-picker-option-name')).toHaveText('Wurdah Ïtah');
  await expect(albums.first().getByRole('cell')).toHaveText(['Track 1 title', 'malawelekaahm', 'Malawêlekaahm', 'Applied']);
  await expect(albums.first().getByRole('button', { name: 'Undo' })).toBeEnabled();
  await expect(detail.getByRole('button', { name: /Approve|Skip/ })).toHaveCount(0);
  const [list, row, undo] = await Promise.all([detail.locator('.version-picker-list').boundingBox(), albums.first().boundingBox(),
    albums.first().getByRole('button', { name: 'Undo' }).boundingBox()]);
  expect(list.width).toBeGreaterThan(1000);
  expect(row.x + row.width - (undo.x + undo.width)).toBeLessThan(24);
});

test('E3: Waiting for approval offers Approve kind, while artist kinds and whole albums are approved per album only', async ({ page }) => {
  await mount(page);
  await showQueue(page, 'data-correction', 'review');
  const detail = page.locator('#utility-problematic-detail');

  await expect(detail.locator('.edits-queue-sections').getByRole('tab', { name: 'Waiting for approval' })).toHaveAttribute('aria-selected', 'true');
  const groups = detail.locator('.edits-queue-kind');
  await expect(groups.nth(0).getByRole('button', { name: 'Approve kind' })).toBeVisible();
  await expect(groups.nth(1).getByRole('button', { name: 'Approve kind' })).toHaveCount(0);
  await expect(groups.nth(2).getByRole('button', { name: 'Approve kind' })).toHaveCount(0);
  await expect(groups.nth(2).locator('[data-edits-queue-open-kind]')).toHaveText('Whole albums to review · 1 album, 6 changes');
  const album = detail.locator('[data-edits-queue-album-row="wurdah"]');
  await expect(album.getByRole('button', { name: 'Approve' })).toBeEnabled();
  await expect(album.getByRole('button', { name: 'Skip' })).toBeEnabled();
  await expect(album.getByRole('cell')).toHaveText(['Album artist', 'Christian Vander', 'Magma', 'Waiting for approval']);
});

test('E2: the MusicBrainz Look Up tab lists queued look ups with when they start, in the same list', async ({ page }) => {
  await mount(page);
  await showQueue(page, 'musicbrainz-lookup');
  const detail = page.locator('#utility-problematic-detail');

  await expect(detail.getByRole('tab', { name: 'MusicBrainz Look Up' })).toHaveAttribute('aria-selected', 'true');
  await expect(detail.getByRole('switch')).toHaveCount(0);
  const rows = detail.locator('.version-picker-option');
  await expect(rows.locator('.version-picker-option-name')).toHaveText(['Live At Budokan', 'Ktzat Acheret']);
  await expect(rows.first().locator('.version-picker-option-subtitle')).toContainText('Release · Dream Theater · 2004 — queued ');
  await expect(rows.first().locator('.version-picker-option-subtitle')).toContainText('starts by itself at ');
  await expect(rows.nth(1).locator('.version-picker-option-subtitle')).toContainText('Artist — queued ');
  await expect(rows.nth(1).locator('.version-picker-option-cover')).toHaveText('No cover');
});

test('I1: album details show the a.k.a. title dimmed, at the title size, after the title and before the year', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => {
    document.body.innerHTML = buildAlbumDetailsHeaderHtml({ artist: 'Christian Vander', album: 'Wurdah Ïtah', year: '1974',
      alternativeTitles: ['Tristan et Iseult'] });
  });
  const primary = page.locator('.album-details-header__primary');
  const aka = primary.locator('.album-details-header__aka');

  await expect(primary).toHaveText('Christian Vander • Wurdah Ïtah (a.k.a. Tristan et Iseult) • 1974');
  const styles = await Promise.all([primary, aka].map((node) => node.evaluate((element) => {
    const style = getComputedStyle(element);
    return { size: style.fontSize, color: style.color };
  })));
  expect(styles[1].size).toBe(styles[0].size);
  expect(styles[1].color).not.toBe(styles[0].color);
});

// Owner 2026-11-16: phones too, on the phone settings page.
test('P1: on a phone the applied changes keep the switch, Bulk Correction and Undo within the screen', async ({ page }) => {
  await mount(page, { width: 390, height: 844, phone: true });
  await showQueue(page, 'data-correction');
  const detail = page.locator('#utility-problematic-detail');

  await expect(page.locator('.utility-sidebar')).toBeHidden();
  await expect(detail.getByRole('switch', { name: 'Auto submit bulks' })).toBeVisible();
  await expect(detail.getByRole('button', { name: 'Bulk Correction' })).toBeDisabled();
  const albums = detail.locator('[data-edits-queue-album-row]');
  await expect(albums).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  for (const index of [0, 1]) {
    const box = await albums.nth(index).getByRole('button', { name: 'Undo' }).boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  }
});

test('P2: on a phone the Edits Queue MusicBrainz Look Up list keeps open/remove within the screen', async ({ page }) => {
  await mount(page, { width: 390, height: 844, phone: true });
  await showQueue(page, 'musicbrainz-lookup');
  const detail = page.locator('#utility-problematic-detail');

  await expect(page.locator('.utility-sidebar')).toBeHidden();
  await expect(detail.locator('.edits-queue > .in-page-tabs').getByRole('tab')).toHaveText(['Data Correction', 'MusicBrainz Look Up']);
  const rows = detail.locator('.version-picker-option');
  await expect(rows).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  for (const index of [0, 1]) {
    for (const name of [/^Open /, /^Remove /]) {
      const box = await rows.nth(index).getByRole('button', { name }).boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
    }
    const name = await rows.nth(index).locator('.version-picker-option-name').boundingBox();
    expect(name.width).toBeGreaterThan(80);
  }
});
