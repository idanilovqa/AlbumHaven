// The owner's manual MusicBrainz lookups (Delivery 2, S5): approved mockups F1, G2, H1, H2.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

const root = path.join(__dirname, '..', '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const { renderActionButton } = require('../../music_app/static/js/button-component.js');
const indexTemplate = read('music_app/templates/index.html');
// The page's own stylesheets, after the shared ones its partials link first.
const stylesheets = [...['css/appearance-backgrounds.css', 'css/button-component.css', 'css/navigation-tree.css'].map((file) => [, file]),
  ...indexTemplate.matchAll(/filename='(css\/[^']+)'|href="\/static\/(css\/[^"?]+)/g)]
  .map((match) => path.join(root, 'music_app', 'static', match[1] || match[2]))
  .filter((file) => fs.existsSync(file));
const drawerRuntime = read('music_app/static/js/runtime/cover-lookup-modal-and-drawer.js');
const cardStart = drawerRuntime.indexOf('const NOTIFICATION_CARD_TITLES');
// The builder ends at its first closing brace line; line endings follow the checkout (CRLF on Windows).
const cardBuilder = drawerRuntime.slice(cardStart).match(/^[\s\S]*?\r?\n\}\r?\n/)[0];
const MBID = '6f3c2a1e-1111-4222-8333-444455556b51';

// The popup exactly as the template writes it, with the shared close button rendered.
function resultsModalMarkup() {
  const block = read('music_app/templates/partials/confirm-modals.html')
    .match(/<div class="confirm-modal musicbrainz-lookup-results-modal"[\s\S]*$/)[0];
  const glyph = block.match(/{% call action_button\('Close MusicBrainz lookup results'[\s\S]*?%}(<svg[\s\S]*?<\/svg>){% endcall %}/)[1];
  const close = renderActionButton({
    ariaLabel: 'Close MusicBrainz lookup results', className: 'musicbrainz-lookup-results-close',
    attributes: { 'data-close-musicbrainz-lookup-results': '1' },
  }).replace('<span class="action-button__icon" aria-hidden="true"></span>', glyph);
  return block.replace(/{% call action_button\('Close MusicBrainz lookup results'[\s\S]*?{% endcall %}/, close)
    .replace(' hidden>', '>');
}

async function mount(page, body, { width = 1440, height = 900 } = {}) {
  await page.setViewportSize({ width, height });
  await page.setContent(`<!doctype html><html><body class="has-dark-theme">
    <script id="navigation-tree-item-template" type="text/plain">${read('music_app/templates/components/navigation-tree-item.html')}</script>
    ${body}</body></html>`);
  for (const file of stylesheets) await page.addStyleTag({ path: file });
  await page.addScriptTag({ content: `
    window.state = { status: { allowed_actions: { 'catalogue.enrichment.request': true } }, coverLookup: {}, utility: {} };
    window.showToast = () => {};
    // The cover URL helpers live in modal-and-overlay-helpers.js, not loaded here: no cover art.
    window.buildAlbumDisplayCoverUrl = () => '';
    window.buildAlbumLightboxCoverUrl = () => '';
  ` });
  for (const file of [
    'music_app/static/js/button-component.js',
    'music_app/static/js/navigation-tree.js',
    'music_app/static/js/runtime/markup-format-helpers.js',
    'music_app/static/js/runtime/alert-components.js',
    'music_app/static/js/runtime/album-artbox.js',
    'music_app/static/js/runtime/cover-lookup-notification-helpers.js',
    'music_app/static/js/runtime/compact-data-table.js',
    'music_app/static/js/runtime/utility-list-builders.js',
    'music_app/static/js/runtime/musicbrainz-lookups.js',
  ]) {
    await page.addScriptTag({ path: path.join(root, file) });
  }
  await page.addScriptTag({ content: cardBuilder });
}

test('F1: the album menu ends after its longest item, every item on its own row, in full MusicBrainz wording', async ({ page }) => {
  await mount(page, '<div id="album-card-context-menu" class="album-card-context-menu" style="left: 495px; top: 313px;"></div>'
    + '<div id="artist-tree-context-menu" class="album-card-context-menu" style="left: 40px; top: 40px;">'
    + '<button type="button" class="album-card-context-menu-item">Scroll to this artist</button></div>');
  const geometry = await page.evaluate(() => {
    const menu = document.getElementById('album-card-context-menu');
    menu.innerHTML = [
      '<button type="button" class="album-card-context-menu-item">Open in File Explorer</button>',
      '<button type="button" class="album-card-context-menu-item">Edit Tags</button>',
      '<button type="button" class="album-card-context-menu-item">Mark as a version</button>',
      ...buildAlbumMenuMusicBrainzItems(),
      '<button type="button" class="album-card-context-menu-item">Search MusicBrainz for the artist</button>',
      '<button type="button" class="album-card-context-menu-item">Search MusicBrainz for the album</button>',
    ].join('');
    const box = menu.getBoundingClientRect();
    const items = [...menu.querySelectorAll('button')].map((item) => {
      const range = document.createRange();
      range.selectNodeContents(item);
      const text = range.getBoundingClientRect();
      const rect = item.getBoundingClientRect();
      return { label: item.textContent, top: rect.top, left: rect.left, textLeft: text.left, textRight: text.right };
    });
    const tree = document.getElementById('artist-tree-context-menu').getBoundingClientRect();
    const treeItem = document.querySelector('#artist-tree-context-menu button');
    const range = document.createRange();
    range.selectNodeContents(treeItem);
    return { left: box.left, right: box.right, items, treeWidth: tree.width, treeTextWidth: range.getBoundingClientRect().width };
  });
  const longest = Math.max(...geometry.items.map((item) => item.textRight));
  expect(geometry.right - longest).toBeLessThanOrEqual(17);
  expect(geometry.right - longest).toBeGreaterThanOrEqual(15);
  for (const item of geometry.items) expect(item.textLeft - geometry.left).toBeCloseTo(17, 0);
  const tops = geometry.items.map((item) => item.top);
  expect(new Set(tops).size).toBe(tops.length);
  expect(geometry.items.map((item) => item.label).join('|')).not.toMatch(/\bMB\b/);
  // The artist-tree menu shares the component: its one short item keeps the 180px minimum.
  expect(geometry.treeWidth).toBeCloseTo(Math.max(180, geometry.treeTextWidth + 34), 0);
  await expect(page.locator('#album-card-context-menu .account-menu-separator')).toBeVisible();
});

test('G2: Problematic Files adds the lookups beside Assign MBID, and the pasted MBID uses the app field', async ({ page }) => {
  await mount(page, '<div id="utility-modal"><div id="utility-problematic-detail" style="width: 760px; padding: 16px;"></div></div>');
  await page.evaluate(() => {
    document.getElementById('utility-problematic-detail').innerHTML = buildMusicBrainzArtistProblemDetail({
      key: 'musicbrainz-artist:7', local_artist_id: 7, name: 'Ktzat Acheret', problem_reasons: ['MBID: Not found'],
      musicbrainz_detail: { local_artist_id: 7, local_artist_name: 'Ktzat Acheret', problem_reason_code: 'musicbrainz_artist_not_found',
        unresolved_reason: 'MBID: Not found', local_album_count: 2, actions_available: true, artist_mbid: null },
      musicbrainz_ui: { manualValue: '' },
    });
  });
  const detail = page.locator('#utility-problematic-detail');
  const buttons = detail.locator('.utility-detected-actions button');
  await expect(buttons).toHaveText(['Search MusicBrainz for the artist', 'Queue MusicBrainz lookup for the artist', 'Assign MBID']);
  const field = await page.evaluate(() => {
    const control = document.querySelector('.musicbrainz-manual-field .search-field-control').getBoundingClientRect();
    const input = document.getElementById('musicbrainz-manual-artist').getBoundingClientRect();
    const link = document.querySelector('.search-field-action [aria-label="Open entered artist on MusicBrainz"]').getBoundingClientRect();
    const style = getComputedStyle(document.getElementById('musicbrainz-manual-artist'));
    return { control, input, link, inputBorder: style.borderTopWidth, inputBackground: style.backgroundColor };
  });
  // One field surface encloses the input and its open-link action.
  expect(field.link.right).toBeLessThanOrEqual(field.control.right);
  expect(field.link.left).toBeGreaterThanOrEqual(field.input.right - 1);
  expect(field.inputBorder).toBe('0px');
  expect(field.inputBackground).toBe('rgba(0, 0, 0, 0)');
  await expect(detail.getByLabel('MusicBrainz artist URL or MBID', { exact: true })).toHaveAttribute('placeholder', 'Paste artist URL or MBID');
});

test('G1: an album MusicBrainz has no info on shows its label and the album lookups', async ({ page }) => {
  await mount(page, '<div id="utility-modal"><div id="utility-problematic-detail" style="width: 760px; padding: 16px;"></div></div>');
  await page.evaluate(() => {
    window.state.coverLookup.optimisticAlbumCovers = {};
    document.getElementById('utility-problematic-detail').innerHTML = buildMusicBrainzAlbumProblemDetail({
      key: 'musicbrainz-album:wings', entity_kind: 'musicbrainz_album', musicbrainz_album_key: 'wings',
      name: '...And the Wings Embraced Us', album_artist: 'Lacrimas Profundere', year: 1995,
      problem_reasons: ['MusicBrainz has no info'], detail_loaded: false,
    });
  });
  const detail = page.locator('#utility-problematic-detail');
  await expect(detail.locator('.utility-detail-title')).toHaveText('...And the Wings Embraced Us');
  await expect(detail.locator('.utility-album-problem-labels')).toHaveText('MusicBrainz has no info');
  await expect(detail.locator('.utility-detected-actions button'))
    .toHaveText(['Search MusicBrainz for the album', 'Queue MusicBrainz lookup for the album']);
  await expect(detail.locator('[data-musicbrainz-lookup-album="wings"]')).toHaveCount(2);
});

test('H1: a MusicBrainz lookup batch is the same card as a cover lookup, titled by its kind', async ({ page }) => {
  await mount(page, '<aside class="cover-lookup-drawer is-open" style="position: static;"><div class="cover-lookup-drawer-pinned" id="cards"></div></aside>', { width: 480, height: 640 });
  await page.evaluate(() => {
    document.getElementById('cards').innerHTML = buildMusicBrainzLookupCardHtml({
      batch_id: 4, started_at: '2026-11-16T10:00:00Z', finished_at: '2026-11-16T10:04:12Z',
      total: 15, matched: 12, not_matched: 3, albums: 15, artists: 0,
    }) + buildNotificationTaskCardHtml({
      kind: 'cover', stateClass: 'is-completed', openAttributes: 'data-open-cover-lookup-task="t1"',
      openLabel: 'Open Cover Look Up: Drones',
      coverHtml: '<span class="cover-lookup-task-cover is-placeholder" aria-hidden="true"></span>', subject: 'Drones',
      byline: 'Muse · 2015', statusLabel: 'Art chosen', elapsedHtml: '', actionsHtml: '', progress: 100,
    });
  });
  const cards = page.locator('.cover-lookup-task-card');
  await expect(cards.nth(0).locator('.cover-lookup-task-title')).toHaveText('MusicBrainz lookup');
  await expect(cards.nth(0).locator('.cover-lookup-task-byline')).toHaveText('12 releases matched, 3 not matched');
  await expect(cards.nth(0).locator('.cover-lookup-task-status-label')).toHaveText('15 looked up');
  await expect(cards.nth(0).getByRole('button', { name: 'Delete notification' })).toBeVisible();
  await expect(cards.nth(1).locator('.cover-lookup-task-title')).toHaveText('Cover lookups');
  await expect(cards.nth(1).locator('.cover-lookup-task-byline')).toHaveText('Drones · Muse · 2015');
  const [lookup, cover] = await cards.evaluateAll((nodes) => nodes.map((node) => {
    const box = node.getBoundingClientRect();
    return [box.width, box.height, getComputedStyle(node.querySelector('.cover-lookup-task-progress span')).backgroundColor];
  }));
  expect(lookup).toEqual(cover);
});

test('H2: the results popup has the modal header and close button, and navigation-tree rows', async ({ page }) => {
  await mount(page, resultsModalMarkup());
  await page.evaluate((mbid) => {
    renderMusicBrainzLookupResults({
      matched: 1, not_matched: 2, finished_at: '2026-11-16T10:04:12Z', items: [
        { request_id: 1, target_kind: 'album', album_key: 'k1', album_title: 'Octavarium', artist_name: 'Dream Theater',
          year: 2005, outcome: 'matched', result_mbid: mbid, result_entity: 'release' },
        { request_id: 2, target_kind: 'album', album_key: 'k2', album_title: '…Карусель Эпох…', artist_name: 'R.D.(Роман Дрозд)',
          outcome: 'not_matched', problem_label: 'Release not found on MusicBrainz' },
        { request_id: 3, target_kind: 'artist', local_artist_id: 7, artist_name: 'Ktzat Acheret', outcome: 'not_matched',
          problem_label: 'MBID: Not found', problem_occurrence_id: 19 },
      ],
    });
  }, MBID);
  const dialog = page.getByRole('dialog', { name: 'MusicBrainz lookup' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('#musicbrainz-lookup-results-summary'))
    .toHaveText('1 matched, 2 not matched. Not matched items are in Problematic Files.');
  const close = dialog.getByRole('button', { name: 'Close MusicBrainz lookup results' });
  await expect(close).toHaveClass(/action-button/);
  const rows = dialog.locator('.navigation-tree-item--wide');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('MBID 6f3c2a1e…6b51');
  await expect(rows.nth(2)).toContainText('MBID: Not found');
  await expect(dialog.getByRole('button', { name: 'Open Problematic Files' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeVisible();
  // The rows are the Problematic Files rows: same height, artwork size and padding.
  const geometry = await rows.evaluateAll((nodes) => nodes.map((node) => {
    const style = getComputedStyle(node);
    const art = node.querySelector('.navigation-tree-artwork').getBoundingClientRect();
    return [Math.round(node.getBoundingClientRect().height), style.paddingLeft, art.width, art.height];
  }));
  for (const row of geometry) expect(row).toEqual([60, '10px', 40, 40]);
  const header = await page.evaluate(() => {
    const title = document.getElementById('musicbrainz-lookup-results-title').getBoundingClientRect();
    const button = document.querySelector('.musicbrainz-lookup-results-close').getBoundingClientRect();
    return { titleTop: title.top, buttonTop: button.top, buttonRight: button.right,
      dialogRight: document.querySelector('.musicbrainz-lookup-results-dialog').getBoundingClientRect().right };
  });
  expect(header.buttonRight).toBeLessThanOrEqual(header.dialogRight);
  expect(Math.abs(header.buttonTop - header.titleTop)).toBeLessThan(12);
});
