const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'music_app/static/js/runtime/virtual-artist-grid.js'), 'utf8');
const gridClass = source.slice(source.indexOf('class VirtualArtistGrid'), source.indexOf('const virtualGrid ='));

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
