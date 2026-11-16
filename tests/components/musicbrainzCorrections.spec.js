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

const ARTIST = { field: 'album_artist', label: 'Album artist', current: 'Christian Vander', proposed: 'Magma', tracks: [] };
const TRACK_ARTISTS = { field: 'artist', label: 'Artist (12 tracks)', current: 'Christian Vander', proposed: 'Magma',
  tracks: Array.from({ length: 12 }, (_, index) => ({ disc_number: 1, track_number: index + 1 })) };

async function mount(page, { width = 1440, height = 900 } = {}) {
  await page.setViewportSize({ width, height });
  await page.setContent(`<!doctype html><html><body class="has-dark-theme">
    <div class="utility-modal" id="utility-modal" data-active-tab="edits-queue">
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

async function showQueue(page, tab) {
  await page.evaluate(([corrections, selected]) => {
    Object.assign(editsQueue, {
      tab: selected, corrections, settings: { auto_submit_bulks: false, next_run_at: null }, queueStartsAt: '2026-11-16T11:20:00Z',
      lookups: [
        { request_id: 9, target_kind: 'album', album_key: 'live', album_title: 'Live At Budokan', artist_name: 'Dream Theater', year: 2004, requested_at: '2026-11-16T10:20:00Z' },
        { request_id: 10, target_kind: 'artist', local_artist_id: 41, artist_name: 'Ktzat Acheret', requested_at: '2026-11-16T10:22:00Z' },
      ],
    });
    renderUtilityEditsQueue();
  }, [[
    { entry_id: 4, album_key: 'wurdah', album_title: 'Wurdah Ïtah', artist_name: 'Christian Vander', year: 1974, corrections: [ARTIST, TRACK_ARTISTS] },
    { entry_id: 5, album_key: 'secret', album_title: 'The Secret', artist_name: 'The Alan Parsons Project', year: 2019,
      corrections: [{ ...ARTIST, current: 'The Alan Parsons Project', proposed: 'Alan Parsons' }] },
  ], tab]);
}

test('D1: a data correction entry shows its label, the change table and Add to queue, without Apply changes', async ({ page }) => {
  await mount(page);
  await page.evaluate(([artist, trackArtists]) => {
    document.getElementById('utility-modal').setAttribute('data-active-tab', 'problematic-files');
    document.getElementById('utility-problematic-detail').innerHTML = buildMusicBrainzCorrectionProblemDetail({
      key: 'musicbrainz-correction:wurdah', entity_kind: 'musicbrainz_correction', name: 'Wurdah Ïtah',
      album_artist: 'Christian Vander', year: 1974, track_count: 12, file_types: ['FLAC'],
      musicbrainz_correction: { album_key: 'wurdah', queued_at: null, corrections: [artist, trackArtists] },
    });
  }, [ARTIST, TRACK_ARTISTS]);
  const detail = page.locator('#utility-problematic-detail');

  await expect(detail.locator('.alert-label--warning')).toHaveText('Data Correction Needed');
  await expect(detail.getByRole('columnheader')).toHaveText(['Tag', 'In your files', 'MusicBrainz']);
  await expect(detail.getByRole('row').nth(2).getByRole('cell')).toHaveText(['Artist (12 tracks)', 'Christian Vander', 'Magma']);
  await expect(detail.getByRole('row').nth(1).locator('.alert-label--info')).toHaveText('Magma');
  const add = detail.getByRole('button', { name: 'Add to queue' });
  await expect(add).toBeEnabled();
  await expect(detail.getByRole('button', { name: 'Apply changes' })).toHaveCount(0);
  const [table, button] = await Promise.all([detail.locator('.compact-data-table').boundingBox(), add.boundingBox()]);
  expect(button.y).toBeGreaterThan(table.y + table.height);
  expect(Math.abs((button.x + button.width) - (table.x + table.width))).toBeLessThanOrEqual(2);
});

test('E1: the Edits Queue is one page: Data Correction list, Auto submit bulks off, Bulk Correction visibly disabled', async ({ page }) => {
  await mount(page);
  await showQueue(page, 'data-correction');

  await expect(page.locator('.utility-sidebar')).toBeHidden();
  const detail = page.locator('#utility-problematic-detail');
  await expect(detail.getByRole('tab')).toHaveText(['Data Correction', 'MusicBrainz Look Up']);
  await expect(detail.getByRole('tab', { name: 'Data Correction' })).toHaveAttribute('aria-selected', 'true');
  const autoSubmit = detail.getByRole('switch', { name: 'Auto submit bulks' });
  await expect(autoSubmit).toHaveAttribute('aria-checked', 'false');
  const bulk = detail.getByRole('button', { name: 'Bulk Correction' });
  await expect(bulk).toBeDisabled();
  await expect(bulk).toHaveAttribute('title', 'Bulk Correction arrives soon.');
  expect(Number(await bulk.evaluate((node) => getComputedStyle(node).opacity))).toBeLessThan(1);
  const rows = detail.locator('.version-picker-option');
  await expect(rows).toHaveCount(2);
  await expect(rows.first().locator('.version-picker-option-subtitle'))
    .toHaveText('Christian Vander · 1974 — Album artist and 12 track artists: Christian Vander → Magma');
  await expect(rows.first().getByRole('button', { name: 'Open Wurdah Ïtah' })).toBeVisible();
  await expect(rows.first().getByRole('button', { name: 'Remove Wurdah Ïtah from the queue' })).toBeVisible();
  // The list spans the page, the actions end at its right edge.
  const [list, row, remove] = await Promise.all([detail.locator('.version-picker-list').boundingBox(), rows.first().boundingBox(),
    rows.first().getByRole('button', { name: /^Remove/ }).boundingBox()]);
  expect(list.width).toBeGreaterThan(1000);
  expect(row.x + row.width - (remove.x + remove.width)).toBeLessThan(24);
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
