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

for (const headerLayout of ['hidden', 'real']) {
test(`deep presentation changes retain the visible release through every layout frame with headers ${headerLayout}`, async ({ page }) => {
  const showArtistSectionHeaders = headerLayout !== 'hidden';
  await page.setContent('<div id="albums-scroll" style="height:300px;width:320px;overflow:auto;overflow-anchor:none"><div id="albums-spacer-top"></div><div id="artist-groups"></div><div id="albums-spacer-bottom"></div></div>');
  await page.addStyleTag({ path: path.join(root, 'music_app/static/css/runtime/non-album-and-player.css') });
  if (showArtistSectionHeaders) {
    await page.addStyleTag({ path: path.join(root, 'music_app/static/css/gallery-main.css') });
    await page.addScriptTag({ path: path.join(root, 'music_app/static/js/runtime/gallery-main-components.js') });
  }
  await page.addScriptTag({ content: `${source.slice(0, source.indexOf('const virtualGrid ='))}; window.Grid = VirtualArtistGrid;` });
  const result = await page.evaluate(async (showArtistSectionHeaders) => {
    // Isolated layout regression; the full-app test remains the acceptance gate.
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
    grid.collapsedRowHeight = 90;
    const groups = Array.from({ length: 240 }, (_, artist) => ({
      artist: `Artist ${artist}`,
      albums: Array.from({ length: 8 }, (_, index) => ({
        key: `${artist}-${index}`, name: `Release ${artist}-${index}`,
      })),
    }));
    const layout = (height, titleOffset) => ({
      mode: state.gallery.mainState.view, cardMinWidth: 300,
      renderAlbumHtml: album => `<article class="album-card" style="height:${height}px;position:relative"><button data-open-tracklist="1" data-album-key="${album.key}" data-album='${JSON.stringify(album)}' style="position:absolute;top:${titleOffset}px;height:20px;padding:0;border:0">${album.name}</button></article>`,
    });
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    grid.setGroups([], [], groups, { showArtistSectionHeaders }, layout(90, 40));
    await frame(); await frame();
    grid.scrollEl.scrollTop = grid.sections[100].top;
    grid.render(true);
    for (let i = 0; i < 8; i += 1) await frame();
    const bounds = grid.scrollEl.getBoundingClientRect();
    const trigger = [...document.querySelectorAll('[data-open-tracklist="1"][data-album-key]')].find(element => {
      const rect = element.getBoundingClientRect();
      return rect.bottom >= bounds.top + 1 && rect.top < bounds.bottom;
    });
    if (!trigger) throw new Error(`Deep fixture did not render a visible release: ${JSON.stringify({
      scrollTop: grid.scrollEl.scrollTop, scrollHeight: grid.scrollEl.scrollHeight,
      bounds: bounds.toJSON(),
      cards: [...document.querySelectorAll('.album-card')].slice(0, 3).map(element => element.getBoundingClientRect().toJSON()),
    })}`);
    const card = trigger.closest('.album-card');
    const key = trigger.getAttribute('data-album-key');
    const initialTop = card.getBoundingClientRect().top;
    const capturedAnchor = grid.captureScrollAnchor();
    state.gallery.mainState.view = 'covers';
    grid.setGroups([], [], groups, { showArtistSectionHeaders, preserveScroll: true, preserveAbsoluteScroll: false }, layout(150, 0));
    const samples = [];
    const geometry = [];
    for (let i = 0; i < 12; i += 1) {
      await frame();
      samples.push(document.querySelector(`[data-album-key="${key}"]`)?.closest('.album-card')?.getBoundingClientRect().top ?? null);
      geometry.push({
        scrollTop: grid.scrollEl.scrollTop,
        anchor: grid.captureScrollAnchor(),
        measurement: grid.diagnostics.latestMeasurement?.scrollTop,
        topSpacer: grid.topSpacerEl.style.height,
        render: grid.diagnostics.latestRender,
        events: grid.diagnostics.events.slice(-12),
      });
    }
    grid.destroy();
    return { key, initialTop, capturedAnchor, samples, geometry };
  }, showArtistSectionHeaders);
  console.log(JSON.stringify(result));
  expect(Number(result.key.split('-')[0])).toBeGreaterThan(50);
  expect(result.samples).toHaveLength(12);
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


test('virtualizing a Featured On divider retains the following album position', async ({ page }) => {
  await page.setContent('<main id="fixture"></main>');
  await page.addStyleTag({ path: path.join(root, 'music_app/static/css/runtime/non-album-and-player.css') });
  await page.addScriptTag({ content: `${gridClass}; window.Grid = VirtualArtistGrid;` });
  const measurements = await page.evaluate(() => {
    // Component proof for the real divider markup/CSS, separate from full-app acceptance.
    window.escapeHtml = value => String(value);
    window.buildAlbumRowGridTemplate = () => '1fr';
    window.state = { gallery: { mainState: { view: 'covers' } } };
    const grid = Object.create(window.Grid.prototype);
    Object.assign(grid, { rowGap: 14, sectionHeaderHeight: 0, columns: 1, cardTrackWidth: 300 });
    grid.getLayoutConfig = () => ({
      renderAlbumHtml: album => `<div data-row="${album.index}" style="height:90px"></div>`,
    });
    const section = {
      kind: 'artist', top: 0, sectionKey: 'artist:featured', sectionType: 'all',
      group: { artist: 'Fixture', albums: [] },
      blocksData: [
        { kind: 'row', albums: [{ index: 0 }] },
        { kind: 'subheading', title: 'Featured On', count: 2 },
        { kind: 'row', albums: [{ index: 2 }] },
        { kind: 'row', albums: [{ index: 3 }] },
      ],
      blockHeights: [90, 26, 90, 90], blockOffsets: [0, 104, 144, 248],
      blocksHeight: 338,
    };
    const fixture = document.getElementById('fixture');
    const read = start => {
      fixture.innerHTML = grid.renderSection(section, start, 338);
      const bounds = fixture.querySelector('.artist-rows').getBoundingClientRect();
      return {
        height: bounds.height,
        albumTop: fixture.querySelector('[data-row="2"]').getBoundingClientRect().top - bounds.top,
      };
    };
    return { visibleDivider: read(0), virtualDivider: read(144) };
  });
  expect(measurements.virtualDivider).toEqual(measurements.visibleDivider);
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
