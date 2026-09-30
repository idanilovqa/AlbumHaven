const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');

const expectedArtists = ['Neal Morse', 'Transatlantic', 'Neal Morse & The Resonance', 'Morse Portnoy George', 'The Neal Morse Band'];

async function readInventory(names, missingKeyIndex = -1, options = { expectedArtists }) {
  const { GalleryActions } = await import('../e2e/actions/galleryActions.js');
  const headings = names.map((textContent, index) => ({
    textContent,
    closest: () => index === missingKeyIndex ? null : { getAttribute: () => `artist:${index}` },
  }));
  const actions = new GalleryActions({
    artistHeadingSelector: '.artist-name',
    page: {
      evaluate: async (callback, selectors) => vm.runInNewContext(`(${callback})(selectors)`, {
        selectors, document: { querySelectorAll: () => headings },
      }),
    },
  });
  actions.readGalleryScrollState = async () => ({ scrollTop: 0, maxScrollTop: 0, clientHeight: 800 });
  return actions.readArtistHeadingOccurrencesAcrossGallery(options);
}

test('existing observation-only callers retain repeated section headings without an expected inventory', async () => {
  const artists = ['Neal Morse', 'Neal Morse', 'Transatlantic'];
  const result = await readInventory(artists, -1, { timeout: 60000 });
  assert.deepEqual(result.map(({ artist }) => artist), artists);
});

test('complete native heading inventory preserves all five independently expected identities in order', async () => {
  const result = await readInventory(expectedArtists);
  assert.deepEqual(result.map(({ artist }) => artist), expectedArtists);
});

for (const [name, artists, missingKeyIndex] of [
  ['empty', [], -1],
  ['missing family', expectedArtists.slice(0, 3), -1],
  ['duplicate family', [...expectedArtists.slice(0, 4), expectedArtists[3]], -1],
  ['unkeyed heading omitted by virtual-section observation', expectedArtists, 3],
  ['reordered family', [...expectedArtists].reverse(), -1],
]) {
  test(`complete heading inventory rejects ${name}`, async () => {
    await assert.rejects(readInventory(artists, missingKeyIndex));
  });
}
