// Instant return: the app notices by itself that Album Haven answers again, so a returned
// network never needs a reload and Offline does not outlast the outage by minutes.
// With the device offline (W15) or the server down behind its tunnel (W16), Album
// Details, an artist and the end of the gallery each say Offline; once the server answers, each
// loads again within the budget, without a reload and without anyone clicking again.
import { expect, test } from '../support/baseFixtures.js';
import { defineTimingBudget, expectTimingBudget } from '../helpers/timingBudget.js';
import { setAppPageHold } from '../helpers/instantReturnHelpers.js';

// A short page, so the root gallery has more albums to load below the first ones.
test.use({ serviceWorkers: 'allow', viewport: { width: 1024, height: 480 } });

// Recovery within about 5 s of the server answering again.
const RECOVERY_BUDGET = defineTimingBudget({ metricId: 'instant-return.recoveryMs', targetMaximum: 5000, graceMs: 400 });

// Each surface says Offline while [cutOff] is in force, then loads again by itself after [restore].
async function provesRecovery({ page, galleryActions, navigationPanelActions, trackModalActions }, cutOff, restore) {
  const { galleryPage } = galleryActions;
  const { trackModal } = trackModalActions;
  await galleryActions.goto('/');
  await galleryActions.waitForGalleryReady();
  // Full page loads: recovering must never reload the page.
  let loads = 0;
  page.on('load', () => { loads += 1; });

  // Album Details: an album never on screen while online. The gallery fetches (and the copy may
  // keep) the details of the albums it shows, so one shown online could open offline. Three
  // screens down, short of the end of the loaded albums; scrolling there offline may also fail to
  // load more albums, which the end-of-gallery step below covers.
  const firstScreen = await galleryActions.readGalleryScrollState();
  const { clientHeight } = firstScreen;
  const below = Math.min(3 * clientHeight, firstScreen.maxScrollTop - clientHeight);
  expect(below, 'the loaded albums reach well below the first screen').toBeGreaterThan(clientHeight);
  await cutOff();
  await galleryActions.scrollGalleryBy(below);
  await expect.poll(() => galleryActions.readGalleryScrollTop()).toBeGreaterThanOrEqual(below - 1);
  await galleryActions.clickFirstAlbumDetailsInView();
  await expect(trackModal.unreachableTitle).toHaveText('Offline');
  await expect(trackModal.unreachableDetail).toHaveText("Can't load the details, check your network or try again later");
  let loadsBefore = loads;
  let restored = Date.now();
  await restore();
  await expect(trackModal.unreachableNotice).toHaveCount(0, { timeout: 15_000 });
  await expect(trackModal.trackRows.first()).toBeVisible();
  expectTimingBudget(expect, Date.now() - restored, RECOVERY_BUDGET, 'Album Details loads again');
  expect(loads, 'Album Details recovers without a reload').toBe(loadsBefore);
  await trackModalActions.close();

  // An artist further down the tree than the loaded albums.
  await cutOff();
  await navigationPanelActions.openArtistTree();
  const rendered = await navigationPanelActions.navigationPanel.sidebarArtists.count();
  const artist = await navigationPanelActions.selectSidebarArtistAt(rendered - 1);
  await expect(galleryPage.unreachableTitle).toHaveText('Offline');
  await expect(galleryPage.unreachableDetail).toHaveText(`Can't load ${artist}, check your network or try again later`);
  loadsBefore = loads;
  restored = Date.now();
  await restore();
  await expect(galleryPage.unreachable).toHaveCount(0, { timeout: 15_000 });
  await expect(galleryPage.galleryContextName).toHaveText(artist);
  // Its albums are on screen (at this short height their titles are below the fold).
  await expect(galleryPage.albumCards.first()).toBeInViewport();
  expectTimingBudget(expect, Date.now() - restored, RECOVERY_BUDGET, `${artist} loads again`);
  expect(loads, 'the artist recovers without a reload').toBe(loadsBefore);

  // The end of the gallery.
  await galleryActions.goto('/');
  await galleryActions.waitForGalleryReady();
  await cutOff();
  const loadedBefore = await galleryPage.albumCards.count();
  const { maxScrollTop } = await galleryActions.readGalleryScrollState();
  await galleryActions.scrollGalleryBy(maxScrollTop);
  await expect(galleryPage.galleryEndOffline).toHaveText("Offline. Can't load more albums, check your network or try again later");
  loadsBefore = loads;
  restored = Date.now();
  await restore();
  await expect(galleryPage.galleryEndOffline).toBeHidden({ timeout: 15_000 });
  await expect.poll(() => galleryPage.albumCards.count()).toBeGreaterThan(loadedBefore);
  expectTimingBudget(expect, Date.now() - restored, RECOVERY_BUDGET, 'more albums load again');
  expect(loads, 'the gallery continues without a reload').toBe(loadsBefore);
}

test('FTC-IAR-W15 offline, album details, an artist and more albums say Offline, and each loads again by itself within 5 s of the network returning, without a reload', {
  tag: '@area:gallery-search',
}, async ({ page, context, galleryActions, navigationPanelActions, trackModalActions }) => {
  await provesRecovery(
    { page, galleryActions, navigationPanelActions, trackModalActions },
    () => context.setOffline(true),
    () => context.setOffline(false),
  );
});

test('FTC-IAR-W16 with the server down behind its tunnel (502), album details, an artist and more albums say Offline, and each loads again by itself within 5 s of the server answering, without a reload', {
  tag: '@area:gallery-search',
}, async ({ page, galleryActions, navigationPanelActions, trackModalActions }, testInfo) => {
  try {
    await provesRecovery(
      { page, galleryActions, navigationPanelActions, trackModalActions },
      () => setAppPageHold(testInfo, 'down'),
      () => setAppPageHold(testInfo, 'up'),
    );
  } finally {
    await setAppPageHold(testInfo, 'up');
  }
});
