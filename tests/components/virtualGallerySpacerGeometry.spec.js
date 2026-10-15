const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'music_app/static/js/runtime/virtual-artist-grid.js'), 'utf8');
const gridClass = source.slice(source.indexOf('class VirtualArtistGrid'), source.indexOf('const virtualGrid ='));

for (const width of [390, 1280]) {
  test(`presentation changes preserve the visible album during pending scrolling at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.setContent('<div id="albums-scroll" style="height:300px;width:320px;overflow:auto;overflow-anchor:none"><div id="albums-spacer-top"></div><div id="artist-groups"></div><div id="albums-spacer-bottom"></div></div>');
    await page.addStyleTag({ path: path.join(root, 'music_app/static/css/runtime/non-album-and-player.css') });
    await page.addScriptTag({ content: `${source.slice(0, source.indexOf('const virtualGrid ='))}; window.Grid = VirtualArtistGrid;` });
    const result = await page.evaluate(async () => {
      // Component fixture: real grid rendering and browser geometry, not an app E2E.
      window.state = { view: {}, gallery: { mainState: { view: 'cards' } } };
      window.escapeHtml = value => String(value);
      window.buildDisplayGroups = groups => groups;
      window.getAlbumIdentity = album => album.key;
      window.getAlbumRequestKey = album => album.key;
      window.resolveGalleryRendererMode = () => state.gallery.mainState.view;
      window.scheduleBrowserAnimationFrame = callback => requestAnimationFrame(callback);
      window.cancelBrowserAnimationFrame = id => cancelAnimationFrame(id);
      window.clearBrowserTimeout = id => clearTimeout(id);
      window.scheduleBrowserTimeout = (callback, delay) => setTimeout(callback, delay);
      const grid = new window.Grid();
      for (const method of ['activateGalleryCoverImages', 'scheduleSelectedFamilyCoverPrefetch', 'primeVisibleCoverImages', 'prewarmVisibleAlbumDetails']) grid[method] = () => {};
      grid.sectionMarginBottom = 0;
      const groups = ['A', 'B', 'C'].map(artist => ({ artist, albums: Array.from({ length: 8 }, (_, i) => ({ key: `${artist}-${i}`, name: `${artist}-${i}` })) }));
      const layout = height => ({
        mode: state.gallery.mainState.view, cardMinWidth: 300,
        renderAlbumHtml: album => `<article class="album-card" style="height:${height}px"><button data-open-tracklist="1" data-album-key="${album.key}" data-album='${JSON.stringify(album)}' style="display:block;height:100%;padding:0;border:0">${album.name}</button></article>`,
      });
      const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
      grid.setGroups([], [], groups, { showArtistSectionHeaders: false }, layout(90));
      await frame(); await frame();
      grid.scrollEl.scrollTop = 208;
      grid.render(true);
      await frame(); await frame();
      const target = () => document.querySelector('[data-album-key="A-2"]');
      const initialTop = target().getBoundingClientRect().top;
      grid.scrollEl.dispatchEvent(new Event('scroll'));
      const pending = Boolean(grid._raf);
      state.gallery.mainState.view = 'covers';
      grid.lastKey = '';
      grid.setGroups([], [], groups, { showArtistSectionHeaders: false, preserveScroll: true, preserveAbsoluteScroll: false }, layout(150));
      const samples = [];
      for (let i = 0; i < 8; i += 1) {
        await frame();
        samples.push(target()?.getBoundingClientRect().top ?? null);
      }
      grid.destroy();
      return { pending, initialTop, samples };
    });
    expect(result.pending).toBe(true);
    expect(result.samples).toHaveLength(8);
    expect(result.samples).toEqual(result.samples.map(() => result.initialTop));
  });
}

test('virtual row spacers retain row positions and section extent in browser layout', async ({ page }) => {
  await page.setContent('<main id="fixture"></main>');
  await page.addStyleTag({ path: path.join(root, 'music_app/static/css/runtime/non-album-and-player.css') });
  await page.addScriptTag({ content: `${gridClass}; window.Grid = VirtualArtistGrid;` });
  const measurements = await page.evaluate(() => {
    // Isolated component fixture: mount production row rendering with fixed-height album content.
    window.escapeHtml = value => String(value);
    window.buildAlbumRowGridTemplate = () => '1fr';
    window.state = { gallery: { mainState: { view: 'cards' } } };
    const grid = Object.create(window.Grid.prototype);
    Object.assign(grid, { rowGap: 14, sectionHeaderHeight: 0, columns: 1, cardTrackWidth: 300 });
    grid.getLayoutConfig = () => ({ renderAlbumHtml: album => `<div data-row="${album.index}" style="height:90px"></div>` });
    const section = {
      kind: 'artist', top: 0, sectionKey: 'artist:test', sectionType: 'all',
      group: { artist: 'Fixture', albums: [] },
      blocksData: Array.from({ length: 5 }, (_, index) => ({ kind: 'albums', albums: [{ index }] })),
      blockHeights: Array(5).fill(90), blockOffsets: [0, 104, 208, 312, 416], blocksHeight: 506,
    };
    const fixture = document.getElementById('fixture');
    const read = (start, end) => {
      fixture.innerHTML = grid.renderSection(section, start, end);
      const rows = fixture.querySelector('.artist-rows');
      const rect = rows.getBoundingClientRect();
      return {
        height: rect.height,
        retainedTop: fixture.querySelector('[data-row="2"]').getBoundingClientRect().top - rect.top,
      };
    };
    return { full: read(0, 506), middle: read(208, 311), tail: read(208, 506), head: read(0, 311) };
  });
  expect(measurements.full).toEqual({ height: 506, retainedTop: 208 });
  expect(measurements.middle).toEqual(measurements.full);
  expect(measurements.tail).toEqual(measurements.full);
  expect(measurements.head).toEqual(measurements.full);
});


for (const bufferSections of [0, 1]) {
 test(`prepending unmeasured groups preserves the visible album before every paint with ${bufferSections} buffered sections`, async ({ page }) => {
  await page.setContent('<div id="albums-scroll" style="height:300px;width:320px;overflow:auto;overflow-anchor:none"><div id="albums-spacer-top"></div><div id="artist-groups"></div><div id="albums-spacer-bottom"></div></div>');
  await page.addStyleTag({ path: path.join(root, 'music_app/static/css/runtime/non-album-and-player.css') });
  await page.addScriptTag({ content: `${source.slice(0, source.indexOf('const virtualGrid ='))}; window.Grid = VirtualArtistGrid;` });
  const result = await page.evaluate(async bufferSections => {
    window.state = { view: {}, gallery: { mainState: { view: 'cards' } } };
    window.escapeHtml = value => String(value);
    window.buildDisplayGroups = groups => groups;
    window.getAlbumIdentity = album => album.key;
    window.getAlbumRequestKey = album => album.key;
    window.resolveGalleryRendererMode = () => 'cards';
    window.scheduleBrowserAnimationFrame = callback => requestAnimationFrame(callback);
    window.cancelBrowserAnimationFrame = id => cancelAnimationFrame(id);
    window.clearBrowserTimeout = id => clearTimeout(id);
    window.scheduleBrowserTimeout = (callback, delay) => setTimeout(callback, delay);
    const grid = new window.Grid();
    for (const method of ['activateGalleryCoverImages', 'scheduleSelectedFamilyCoverPrefetch', 'primeVisibleCoverImages', 'prewarmVisibleAlbumDetails']) grid[method] = () => {};
    grid.bufferSections = bufferSections;
    grid.overscanPx = 0;
    grid.sectionMarginBottom = 0;
    grid.collapsedRowHeight = 90;
    const layout = {
      mode: 'cards', cardMinWidth: 300,
      renderAlbumHtml: album => `<article class="album-card" style="height:${album.height}px"><button data-open-tracklist="1" data-album-key="${album.key}" data-album='${JSON.stringify(album)}' style="display:block;height:100%;padding:0;border:0">${album.name}</button></article>`,
    };
    const group = (artist, height) => ({ artist, albums: Array.from({ length: 5 }, (_, i) => ({ key: `${artist}-${i}`, name: `${artist}-${i}`, height })) });
    const original = [group('B', 90), group('C', 90), group('D', 90)];
    const options = { showArtistSectionHeaders: false };
    grid.setGroups([], [], original, options, layout);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    grid.scrollEl.scrollTop = 104;
    grid.render(true);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const target = () => document.querySelector('[data-album-key="B-1"]');
    const initialTop = target().getBoundingClientRect().top;
    const samples = [];
    let frame;
    const observe = () => {
      samples.push(target()?.getBoundingClientRect().top ?? null);
      frame = requestAnimationFrame(observe);
    };
    frame = requestAnimationFrame(observe);
    const started = performance.now();
    grid.setGroups([], [], [group('A', 210), ...original], { ...options, preserveScroll: true }, layout);
    const renderDurationMs = performance.now() - started;
    for (let i = 0; i < 8; i += 1) await new Promise(resolve => requestAnimationFrame(resolve));
    cancelAnimationFrame(frame);
    grid.destroy();
    return { initialTop, samples, renderDurationMs };
  }, bufferSections);
  console.log(JSON.stringify({ bufferSections, renderDurationMs: result.renderDurationMs }));
  expect(result.samples.length).toBeGreaterThanOrEqual(8);
  expect(result.samples).toEqual(result.samples.map(() => result.initialTop));
});

}
