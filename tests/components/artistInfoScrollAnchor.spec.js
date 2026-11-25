const { test, expect } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');

// The artist info panel follows its own "i" while the gallery scrolls: it moves
// from a divider "i" to the gallery header "i" when that artist becomes the
// header context, back to the divider when the artist leaves the header, and
// closes once no "i" of its artist is on screen. Drives the production scroll
// owner (initGalleryMain) and header context renderer on real builder markup.
const repositoryRoot = path.resolve(__dirname, '../..');
const ARTISTS = ['Alpha Fixture Band', 'Beta Single Release', 'Gamma Rating Set', 'Delta Signal Guest',
  'Epsilon Signal Lead', 'Zeta Fixture'];
const gridSource = fs.readFileSync(path.join(repositoryRoot, 'music_app/static/js/runtime/virtual-artist-grid.js'), 'utf8');

// The panel content mirrors renderGalleryArtistInfo: portrait, heading, summary text.
const FULL_PANEL = `<header><div class="artist-info-overlay__image" aria-hidden="true">♪</div><div><span>Artist</span><h2></h2></div></header>
  <div class="artist-info-overlay__body"><p>${'Fixture artist biography sentence that fills the summary. '.repeat(12)}</p></div>`;

async function mountGallery(page, { width = 1440, height = 900, playerHeight = 60, fullPanel = false } = {}) {
  await page.setViewportSize({ width, height });
  await page.setContent(`<!doctype html><html data-appearance-mode="dark"><body>
    <main class="shell-main-surface" id="shell-main-surface">
      <header class="gallery-bar" data-gallery-bar data-gallery-bar-instance="gallery"></header>
      <div class="albums-scroll" id="albums-scroll"><div id="albums-spacer-top"></div><div id="artist-groups"></div><div id="albums-spacer-bottom"></div></div>
    </main>
    <div class="global-player" data-shell-slot="bottom_player"></div>
    <aside class="artist-info-overlay" data-artist-info-overlay role="dialog" aria-label="Artist information" hidden>
      ${fullPanel ? FULL_PANEL : `<header><div><span>Artist</span><h2></h2></div></header>
      <div class="artist-info-overlay__body">Artist information.</div>`}
    </aside>
  </body></html>`);
  for (const stylesheet of ['runtime/base-layout.css', 'runtime/non-album-and-player.css', 'app-chrome.css', 'gallery-main.css', 'runtime/trigger-anchor.css',
    'appearance-backgrounds.css', 'button-component.css']) {
    await page.addStyleTag({ path: path.join(repositoryRoot, 'music_app/static/css', stylesheet) });
  }
  await page.addStyleTag({ content: `
    :root { --appearance-card: #171717; --appearance-panel-background: #171717;
      --appearance-line: #526173; --appearance-selected-accent: #55c7ff; }
    body { margin: 0; background: #090909; }
    #shell-main-surface { position: fixed; inset: 0 0 ${playerHeight}px 0; display: flex; flex-direction: column; }
    .gallery-bar { flex: 0 0 auto; }
    #albums-scroll { flex: 1 1 auto; overflow: auto; overflow-anchor: none; padding-bottom: var(--artist-info-reveal-space, 0px); }
    .global-player { position: fixed; left: 0; right: 0; bottom: 0; height: ${playerHeight}px; background: #102430; z-index: 200; }
    ${fullPanel ? '' : '[data-artist-info-overlay] { width: 420px; height: 220px; }'}
  ` });
  await page.evaluate(() => {
    window.escapeHtml = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
    window.cssEscape = value => CSS.escape(value);
    window.usesMobilePageLayout = () => false;
    window.state = {
      gallery: { mainState: { sources: {}, albumTypes: [], view: 'cards' } },
      view: { selected_artist: '', query: '', surface: { active: 'albums' } },
    };
    window.ensureGalleryMainState = () => window.state.gallery.mainState;
    window.prefetchGallerySourceTotalsForAllScopes = () => {};
    window.buildDisplayGroups = groups => groups;
    window.getAlbumIdentity = album => album.key;
    window.getAlbumRequestKey = album => album.key;
    window.getAlbumPathSignature = album => album.key;
    window.resolveGalleryRendererMode = () => 'cards';
    window.getGalleryArtistMusicBrainzStatus = () => ({ problem: '', state: '' });
    window.scheduleBrowserAnimationFrame = callback => requestAnimationFrame(callback);
    window.cancelBrowserAnimationFrame = id => cancelAnimationFrame(id);
    window.clearBrowserTimeout = id => clearTimeout(id);
    window.scheduleBrowserTimeout = (callback, delay) => setTimeout(callback, delay);
  });
  for (const script of ['gallery-main-state.js', 'gallery-main-components.js', 'trigger-anchor.js', 'gallery-main-interactions.js']) {
    await page.addScriptTag({ path: path.join(repositoryRoot, 'music_app/static/js/runtime', script) });
  }
  // The production virtual grid, which owns the section model and the rendered dividers.
  await page.addScriptTag({ content: `${gridSource.slice(0, gridSource.indexOf('const virtualGrid ='))}
    var virtualGrid = new VirtualArtistGrid();` });
  await page.evaluate(({ artists }) => {
    document.querySelector('[data-gallery-bar]').innerHTML = buildGalleryBarHtml({ contextKind: 'gallery', artistCount: artists.length, albumCount: 8 });
    for (const method of ['activateGalleryCoverImages', 'scheduleSelectedFamilyCoverPrefetch', 'primeVisibleCoverImages', 'prewarmVisibleAlbumDetails']) {
      virtualGrid[method] = () => {};
    }
    // Album counts shaped like the functional fixture's first artists: a one-album
    // section sits between two multi-row sections.
    const counts = [10, 1, 8, 13, 12, 9];
    const groups = artists.map((artist, artistIndex) => ({ artist,
      albums: Array.from({ length: counts[artistIndex] }, (_, index) => ({ key: `${artist}-${index}`, name: `${artist} ${index}` })) }));
    virtualGrid.setGroups([], [], groups, { showArtistSectionHeaders: true }, {
      mode: 'cards', cardMinWidth: 300,
      renderAlbumHtml: album => `<article class="album-card" style="height:260px">${album.name}</article>`,
    });
    window.updateGalleryMainChrome = () => {};
    window.observeArtistFamilyPanelBounds = () => ({ disconnect() {}, refresh() {} });
    window.renderGalleryArtistInfo = anchor => {
      const overlay = document.querySelector('[data-artist-info-overlay]');
      overlay.querySelector('h2').textContent = anchor.dataset.artist;
      return overlay;
    };
    initGalleryMain();
    // The chrome inputs updateGalleryMainChrome records for a gallery without a selected artist.
    galleryMainChromeInputs = { token: galleryMainChromeToken(),
      context: { primaryArtist: '', artistCount: artists.length, albumCount: 8, hasFamily: false } };
  }, { artists: ARTISTS });
}

async function scrollGallery(page, top) {
  await page.locator('#albums-scroll').evaluate((scroll, value) => { scroll.scrollTop = value; }, top);
  // One frame for the scroll owner, one for layout to settle.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

const sectionTop = (page, index) => page.evaluate(i => virtualGrid.sections[i].top, index);

async function readPanel(page) {
  return page.evaluate(() => {
    const panel = document.querySelector('[data-artist-info-overlay]');
    const open = !panel.hidden && panel.getAttribute('aria-hidden') !== 'true';
    const anchor = document.querySelector('[data-artist-info-trigger].trigger-anchor-open');
    const anchorBounds = anchor?.getBoundingClientRect();
    const panelBounds = panel.getBoundingClientRect();
    return {
      open,
      header: document.querySelector('[data-gallery-context-name]').textContent,
      panelArtist: panel.querySelector('h2').textContent,
      anchorArtist: anchor?.dataset.artist || null,
      anchorInHeader: Boolean(anchor?.closest('[data-gallery-bar-instance="gallery"]')),
      // The panel hangs from its trigger: its top meets the trigger's bottom edge.
      joined: Boolean(anchorBounds) && Math.abs(panelBounds.top - (anchorBounds.bottom - 1)) <= 1.5,
      anchorVisible: Boolean(anchorBounds) && anchorBounds.bottom > 0 && anchorBounds.top < innerHeight - 60,
    };
  });
}

async function openFromDivider(page, artist) {
  await page.locator(`.family-artist-header[data-scroll-artist="${artist}"] [data-artist-info-trigger]`).click();
  await expect.poll(async () => (await readPanel(page)).open).toBe(true);
}

test.beforeEach(async ({ page }, testInfo) => {
  await mountGallery(page, testInfo.title.includes('1200x500')
    ? { width: 1200, height: 500, playerHeight: 76, fullPanel: true } : {});
  await page.evaluate(() => document.addEventListener('click', event => handleGalleryMainClick(event)));
});

test('the panel follows its divider "i", then re-anchors to the header "i" when its artist becomes the header', async ({ page }) => {
  await scrollGallery(page, 40);
  await openFromDivider(page, ARTISTS[1]);
  let panel = await readPanel(page);
  expect(panel).toMatchObject({ panelArtist: ARTISTS[1], anchorArtist: ARTISTS[1], anchorInHeader: false, joined: true });
  // The divider moves up but stays below the header: the panel moves with it.
  await scrollGallery(page, 200);
  panel = await readPanel(page);
  expect(panel).toMatchObject({ open: true, anchorArtist: ARTISTS[1], anchorInHeader: false, joined: true });
  // The divider's label passes the header: the header now names the artist and owns the panel.
  await scrollGallery(page, await sectionTop(page, 1) + 60);
  panel = await readPanel(page);
  expect(panel).toMatchObject({ open: true, header: ARTISTS[1], anchorArtist: ARTISTS[1], anchorInHeader: true, joined: true });
});

test('the panel returns from the header "i" to the divider "i" when its artist moves back below the header', async ({ page }) => {
  await scrollGallery(page, await sectionTop(page, 1) + 60);
  await expect.poll(async () => (await readPanel(page)).header).toBe(ARTISTS[1]);
  await page.locator('[data-gallery-bar-instance="gallery"] [data-artist-info-trigger]').click();
  await expect.poll(async () => (await readPanel(page)).anchorInHeader).toBe(true);
  await scrollGallery(page, await sectionTop(page, 1) - 200);
  const panel = await readPanel(page);
  expect(panel).toMatchObject({ open: true, header: ARTISTS[0], panelArtist: ARTISTS[1],
    anchorArtist: ARTISTS[1], anchorInHeader: false, joined: true });
});

test('the panel closes once the header moves on to the next artist', async ({ page }) => {
  await scrollGallery(page, await sectionTop(page, 1) + 60);
  await page.locator('[data-gallery-bar-instance="gallery"] [data-artist-info-trigger]').click();
  await expect.poll(async () => (await readPanel(page)).open).toBe(true);
  const [second, third] = [await sectionTop(page, 1), await sectionTop(page, 2)];
  for (const top of [second + 160, second + 320, third + 60]) {
    await scrollGallery(page, top);
    const panel = await readPanel(page);
    if (panel.header === ARTISTS[1]) {
      expect(panel, `still ${ARTISTS[1]} at ${top}`).toMatchObject({ open: true, anchorInHeader: true, joined: true });
    } else {
      expect(panel, `header moved to ${panel.header} at ${top}`).toMatchObject({ open: false });
    }
  }
  const panel = await readPanel(page);
  expect(panel.header).toBe(ARTISTS[2]);
  expect(panel.open).toBe(false);
});

test('the panel closes when its divider "i" leaves the bottom of the gallery', async ({ page }) => {
  await scrollGallery(page, await sectionTop(page, 2) - 300);
  await openFromDivider(page, ARTISTS[2]);
  await scrollGallery(page, 0);
  const panel = await readPanel(page);
  expect(panel.anchorVisible).toBe(false);
  expect(panel.open).toBe(false);
});

for (const [start, wheel] of [[1, 120], [0, 900]]) {
test(`wheel steps of ${wheel} px never leave the panel on an artist the gallery has moved past`, async ({ page }) => {
  await scrollGallery(page, 40);
  await openFromDivider(page, ARTISTS[start]);
  await page.mouse.move(1100, 650);
  for (let step = 0; step < (wheel > 200 ? 6 : 24); step += 1) {
    await page.mouse.wheel(0, wheel);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const panel = await readPanel(page);
    const passed = await page.evaluate(() => {
      const scroll = document.getElementById('albums-scroll');
      const top = scroll.getBoundingClientRect().top;
      return [...scroll.querySelectorAll('[data-scroll-artist] .artist-name')]
        .filter(label => label.getBoundingClientRect().bottom <= top)
        .map(label => label.closest('[data-scroll-artist]').dataset.scrollArtist).at(-1) || null;
    });
    if (passed) expect(panel.header, `header follows the gallery at step ${step}`).toBe(passed);
    if (panel.open) {
      expect(panel, `open panel stays on its own visible "i" at step ${step}`)
        .toMatchObject({ anchorArtist: panel.panelArtist, joined: true, anchorVisible: true });
    }
  }
  expect((await readPanel(page)).open).toBe(false);
});
}

test('at 1200x500 the opened panel fits above the player once its reveal scroll settles', async ({ page }) => {
  await scrollGallery(page, 40);
  await openFromDivider(page, ARTISTS[1]);
  // The reveal scroll's own scroll event and two more frames must leave the fit in place.
  await page.evaluate(() => new Promise(resolve => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(resolve)), 100)));
  const geometry = await page.evaluate(() => ({
    panelBottom: document.querySelector('[data-artist-info-overlay]').getBoundingClientRect().bottom,
    playerTop: document.querySelector('[data-shell-slot="bottom_player"]').getBoundingClientRect().top,
  }));
  expect(geometry.panelBottom, 'panel bottom stays above the player').toBeLessThanOrEqual(geometry.playerTop + 1);
  expect(await readPanel(page)).toMatchObject({ open: true, anchorArtist: ARTISTS[1], joined: true });
});
