import { expect, test } from '../support/baseFixtures.js';
import {
  createCompilationTitleSearchFixture,
  removeCompilationTitleSearchFixture,
} from '../helpers/compilationTitleSearchFixture.js';

let ownedFixture;

test.beforeEach(async ({ appBarActions, galleryActions, managedAppLifecycle }) => {
  await managedAppLifecycle.stop();
  try {
    ownedFixture = await createCompilationTitleSearchFixture();
  } finally {
    await managedAppLifecycle.restart();
  }
  await galleryActions.goto();
  await galleryActions.waitForGalleryReady();
  await appBarActions.triggerFullRescanAndWait();
  await appBarActions.waitForScanAndCoverRefreshIdle();
});

test.afterEach(async ({ appBarActions, galleryActions, managedAppLifecycle }) => {
  try {
    if (ownedFixture) await removeCompilationTitleSearchFixture(ownedFixture);
    ownedFixture = null;
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    await appBarActions.triggerFullRescanAndWait();
    await appBarActions.waitForScanAndCoverRefreshIdle();
  } finally {
    ownedFixture = null;
    await managedAppLifecycle.stop();
    await managedAppLifecycle.restart();
  }
});

async function expectOwnerGalleryWithEveryPart({ galleryActions, navigationPanelActions, searchToolbarActions }, query) {
  const owner = ownedFixture.ownerName;
  await searchToolbarActions.waitForQuery(query);
  await navigationPanelActions.waitForSidebarSelection(owner);
  await galleryActions.waitForSelectedArtistGallery(owner, { queryValue: query });
  expect(await navigationPanelActions.readActiveSidebarArtistName()).toBe(owner);
  for (const album of ownedFixture.albums) {
    await expect.poll(
      () => galleryActions.readAlbumCardCount({ artist: owner, album }),
      { message: `${album} is shown under ${owner}`, timeout: 15000 },
    ).toBe(1);
  }
}

test(
  'FTC-SEARCH-NAV-036 a title-only search selects the artist owning every matching compilation',
  { tag: '@area:gallery-search' },
  async ({ galleryActions, navigationPanelActions, searchToolbarActions, stepLogger }) => {
    test.setTimeout(300000);
    const query = ownedFixture.saga;
    const session = { galleryActions, navigationPanelActions, searchToolbarActions };

    await stepLogger.step('Search the compilation title and select its owner, not a track artist', async () => {
      await galleryActions.goto('/');
      await galleryActions.waitForGalleryReady();
      await searchToolbarActions.search(query, { submitWithEnter: true });
      await expectOwnerGalleryWithEveryPart(session, query);
    });

    await stepLogger.step('Open the same search as a pasted q-only URL', async () => {
      await galleryActions.goto(`/?surface=albums&q=${encodeURIComponent(query)}`);
      await expectOwnerGalleryWithEveryPart(session, query);
    });
  },
);
