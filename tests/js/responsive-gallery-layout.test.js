const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(
  __dirname,
  '../e2e/helpers/responsiveGalleryHelpers.js',
)).href);

function layout(overrides = {}) {
  return {
    columnCount: 3,
    fullRowRightGaps: [0.5],
    cardWidths: [240, 240, 240],
    cardsInsideGallery: true,
    galleryHasHorizontalOverflow: false,
    documentHasHorizontalOverflow: false,
    rating: { attached: true },
    ...overrides,
  };
}

test('responsive gallery settlement rejects a stable two-pixel right gap', async () => {
  const { responsiveGalleryLayoutMeetsFillContract } = await load();

  assert.equal(responsiveGalleryLayoutMeetsFillContract(layout({
    fullRowRightGaps: [2],
  })), false);
  assert.equal(responsiveGalleryLayoutMeetsFillContract(layout()), true);
});
