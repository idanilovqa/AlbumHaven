import { randomUUID } from 'node:crypto';
import { expect, test } from '../support/baseFixtures.js';
import { SaveCardFrames } from '../poms/saveCardFrames.js';
import {
  albumFilenames, createSaveCardsFixture, makeFixtureFilesReadOnly, makeFixtureFilesWritable,
  removeSaveCardsFixture,
} from '../helpers/saveCardsFixture.js';
import {
  holdFoldDecision, holdFoldDecisionThenOutdateIt, holdSaveBeforeMediaWrite, holdStructuralSavePersistence,
} from '../helpers/structuralSavePollWindowHelpers.js';

// Owner, 2026-11-22: cards change 150 ms after the Save click, with 200 ms of grace.
const BUDGET_MS = 150 + 200;
const SAVE_PATH = '**/utilities/edit-tags';
const FOLD_UNCHECKED = /fold couldn.t be checked/iu;
const TWIN = 'Twin Release';
// After TWIN by name: a scan numbers albums by name, and an equal-size fold keeps the older album's card.
const OTHER = 'Unrelated Release';
const NEW = 'Brand New Release';
// Album keys keep accents while duplicate identities fold them: this name folds into TWIN.
const COPY = 'Twin Réléase';

let ownedFixture;
let persistenceGate;
let saveGate;
let decisionGate;

async function rescan({ galleryActions, appBarActions }) {
  await galleryActions.goto();
  await galleryActions.waitForGalleryReady();
  await appBarActions.triggerFullRescanAndWait();
  await appBarActions.waitForScanAndCoverRefreshIdle();
}

async function openLibrary(fixtures, albums) {
  await fixtures.managedAppLifecycle.stop();
  try {
    ownedFixture = await createSaveCardsFixture(`E2E Save Cards ${randomUUID().replaceAll('-', '')}`, albums);
  } finally {
    await fixtures.managedAppLifecycle.restart();
  }
  await rescan(fixtures);
  await openArtist(fixtures.galleryActions);
}

async function openArtist(galleryActions) {
  await galleryActions.goto(`/?surface=albums&artist=${encodeURIComponent(ownedFixture.artist)}`);
  await galleryActions.waitForGalleryReady();
}

test.afterEach(async ({ galleryActions, appBarActions }) => {
  await decisionGate?.dispose();
  decisionGate = null;
  await saveGate?.dispose();
  saveGate = null;
  await persistenceGate?.dispose();
  persistenceGate = null;
  try {
    if (ownedFixture) await removeSaveCardsFixture(ownedFixture);
  } finally {
    ownedFixture = null;
  }
  // No restart: the functional app's cover-cache seeder refuses to start over a folded pair of albums.
  await rescan({ galleryActions, appBarActions });
});

async function holdSave() {
  saveGate = await holdSaveBeforeMediaWrite();
}

// A fast click: the confirmation is clicked as soon as it can be, never after the decision.
async function clickSave({ page, galleryActions, tagEditorActions }, album, edit, { copyIndex, holdOnceOpen } = {}) {
  await galleryActions.openAlbumTagEditorFromContextMenu(album);
  if (copyIndex === undefined) {
    await tagEditorActions.waitForOpen({ expectedTrackCount: 2 });
    await tagEditorActions.selectAllTracks();
  } else {
    // With the pair's marker, the folded card lists one copy; naming its files proves which.
    await tagEditorActions.waitForOpen({ expectedTrackCount: 2 });
    await tagEditorActions.selectTracksByFilenames(albumFilenames(copyIndex));
  }
  // Only now: album details read the table these holds lock, so a hold taken earlier keeps the editor shut.
  if (holdOnceOpen) decisionGate = await holdOnceOpen();
  await edit(tagEditorActions);
  const frames = new SaveCardFrames(page);
  await frames.start();
  const { tagEditor } = tagEditorActions;
  await tagEditor.applyButton.click();
  await tagEditor.confirmButton.click();
  return frames;
}

// A Full Rescan marks more albums than a request evaluates inline, so a scanned pair's marker follows
// the index's background pass: a precondition here, not what any of these cases is about.
async function waitForSeededPair(galleryActions) {
  const { albumCard } = galleryActions.galleryPage;
  await expect.poll(async () => {
    await openArtist(galleryActions);
    return albumCard.duplicateMarkerByAlbumName(TWIN).count();
  }, { timeout: 60000, intervals: [1000, 2000, 5000] }).toBe(1);
}

const renameTo = album => actions => actions.setAlbumName(album);

// Shown within the budget, and never anything else in a later frame.
async function expectFromTheClick(frames, albums, { within = BUDGET_MS } = {}) {
  const wanted = JSON.stringify([...albums].sort());
  const shows = frame => JSON.stringify(frame.albums) === wanted;
  await expect.poll(async () => (await frames.read()).at(-1)?.at ?? 0).toBeGreaterThan(within + 500);
  const seen = await frames.read();
  const first = seen.findIndex(shows);
  expect(first, `No frame showed ${wanted}; the last showed ${JSON.stringify(seen.at(-1)?.albums)}.`)
    .toBeGreaterThanOrEqual(0);
  expect(seen[first].at, 'The cards changed too long after the Save click.').toBeLessThanOrEqual(within);
  expect(seen.slice(first).filter(frame => !shows(frame)), 'A later frame went back on the change.').toEqual([]);
}

async function finishSave(page) {
  const response = page.waitForResponse(SAVE_PATH);
  await saveGate.release();
  saveGate = null;
  const saved = await response;
  expect((await saved.json()).save_task_status).toBe('completed');
}

async function expectKeptThroughCompletion(frames, page, albums, options) {
  await expectFromTheClick(frames, albums, options);
  await finishSave(page);
  await expectFromTheClick(frames, albums, options);
  await frames.stop();
}

test.describe('Cards change at Save', () => {
  test.describe.configure({ timeout: 240000 });

  test("FTC-TAGS-034 Save removes an album's card within 350 ms of the click, while the files are still being written, when no second album remains", { tag: '@area:tag-edit' }, async ({
    page, managedAppLifecycle, galleryActions, appBarActions, tagEditorActions,
  }) => {
    await openLibrary({ managedAppLifecycle, galleryActions, appBarActions }, [TWIN, OTHER]);
    await holdSave();
    const frames = await clickSave({ page, galleryActions, tagEditorActions }, OTHER, renameTo(TWIN));
    await expectKeptThroughCompletion(frames, page, [TWIN]);
  });

  test("FTC-TAGS-035 Save shows a new or renamed album's card within 350 ms of the click, while the files are still being written", { tag: '@area:tag-edit' }, async ({
    page, managedAppLifecycle, galleryActions, appBarActions, tagEditorActions,
  }) => {
    await openLibrary({ managedAppLifecycle, galleryActions, appBarActions }, [TWIN, OTHER]);
    await holdSave();
    const frames = await clickSave({ page, galleryActions, tagEditorActions }, OTHER, renameTo(NEW));
    await expectKeptThroughCompletion(frames, page, [TWIN, NEW]);
  });

  test('FTC-TAGS-036 A copy that a save folds into another album leaves the gallery at Save, and no frame shows both cards afterwards', { tag: '@area:tag-edit' }, async ({
    page, managedAppLifecycle, galleryActions, appBarActions, tagEditorActions,
  }) => {
    await openLibrary({ managedAppLifecycle, galleryActions, appBarActions }, [TWIN, OTHER]);
    await holdSave();
    const frames = await clickSave({ page, galleryActions, tagEditorActions }, OTHER, renameTo(COPY));
    await expectKeptThroughCompletion(frames, page, [TWIN]);
    await expect(galleryActions.galleryPage.albumCard.duplicateMarkerByAlbumName(TWIN)).toBeVisible();
  });

  test('FTC-TAGS-037 A copy that a save unfolds gets its own card at Save', { tag: '@area:tag-edit' }, async ({
    page, managedAppLifecycle, galleryActions, appBarActions, tagEditorActions,
  }) => {
    await openLibrary({ managedAppLifecycle, galleryActions, appBarActions }, [TWIN, COPY]);
    await waitForSeededPair(galleryActions);
    await expect(galleryActions.galleryPage.albumCard.cards).toHaveCount(1);
    await holdSave();
    const frames = await clickSave({ page, galleryActions, tagEditorActions }, TWIN, renameTo(NEW), { copyIndex: 0 });
    // The seed stores the pair as one album, so the copy left behind keeps that album and its stored title.
    await expectKeptThroughCompletion(frames, page, [NEW, TWIN]);
  });

  test('FTC-TAGS-038 Clicking Save before the fold is decided still updates every other card at once; only the fold follows, when its decision arrives', { tag: '@area:tag-edit' }, async ({
    page, managedAppLifecycle, galleryActions, appBarActions, tagEditorActions,
  }) => {
    await openLibrary({ managedAppLifecycle, galleryActions, appBarActions }, [TWIN, OTHER]);
    await holdSave();
    const frames = await clickSave({ page, galleryActions, tagEditorActions }, OTHER, renameTo(COPY), {
      holdOnceOpen: holdFoldDecision,
    });
    await expectFromTheClick(frames, [TWIN, COPY]);
    const decidedAt = (await frames.read()).at(-1).at;
    await decisionGate.release();
    decisionGate = null;
    await expectKeptThroughCompletion(frames, page, [TWIN], { within: decidedAt + BUDGET_MS });
  });

  test('FTC-TAGS-039 A failed or outdated fold decision is shown readably and never waits for the save to finish to change cards', { tag: '@area:tag-edit' }, async ({
    page, managedAppLifecycle, galleryActions, appBarActions, tagEditorActions,
  }) => {
    await openLibrary({ managedAppLifecycle, galleryActions, appBarActions }, [TWIN, OTHER, 'Third Release']);
    const alert = tagEditorActions.tagEditor.repairAlert;
    for (const [album, renamed, holdDecision, outdated] of [
      // Never answered: the decision's own time limit fails it.
      [OTHER, COPY, holdFoldDecision, false],
      ['Third Release', 'Twin Rélease', holdFoldDecisionThenOutdateIt, true],
    ]) {
      await holdSave();
      const before = await galleryActions.galleryPage.albumCard.cards.locator(
        galleryActions.galleryPage.albumCard.titleButtonSelector,
      ).allTextContents();
      const frames = await clickSave({ page, galleryActions, tagEditorActions }, album, renameTo(renamed), {
        holdOnceOpen: holdDecision,
      });
      // The copy keeps its card: nothing can say yet that it folds.
      await expectFromTheClick(frames, before.map(name => name.trim()).map(name => (name === album ? renamed : name)));
      if (outdated) {
        await decisionGate.release();
        decisionGate = null;
      }
      await expect(alert).toBeVisible();
      await expect(alert).toContainText(FOLD_UNCHECKED);
      await decisionGate?.dispose();
      decisionGate = null;
      await finishSave(page);
      await frames.stop();
    }
  });

  test('FTC-TAGS-040 A failed save puts cards, counts, markers and the artist tree back, and says why', { tag: '@area:tag-edit' }, async ({
    page, managedAppLifecycle, galleryActions, appBarActions, tagEditorActions,
  }) => {
    await openLibrary({ managedAppLifecycle, galleryActions, appBarActions }, [TWIN, COPY]);
    const { albumCard } = galleryActions.galleryPage;
    const readCount = async () => (
      await galleryActions.galleryPage.readProductionVisibleAlbumObservation(ownedFixture.artist, [TWIN, COPY, NEW])
    ).albumCount;
    const movedArtist = `${ownedFixture.artist} moved`;
    const treeEntry = page.getByRole('navigation').getByText(movedArtist, { exact: true });
    await waitForSeededPair(galleryActions);
    await expect(albumCard.cards).toHaveCount(1);
    await expect(albumCard.duplicateMarkerByAlbumName(TWIN)).toBeVisible();
    const countBefore = await readCount();
    await makeFixtureFilesReadOnly(ownedFixture);
    await holdSave();
    const frames = await clickSave({ page, galleryActions, tagEditorActions }, TWIN, async (actions) => {
      // Both credits: an album still credited to the selected artist keeps a card in its view.
      await actions.setArtist(movedArtist);
      await actions.setAlbumArtist(movedArtist);
    }, { copyIndex: 0 });
    // The copy left behind keeps the stored album and its title.
    await expectFromTheClick(frames, [TWIN]);
    await expect(treeEntry).toBeVisible();

    const failed = page.waitForResponse(SAVE_PATH);
    await saveGate.release();
    saveGate = null;
    await failed;
    await expect(albumCard.cards).toHaveCount(1);
    await expect(albumCard.cardByAlbumName(TWIN)).toBeVisible();
    await expect(albumCard.duplicateMarkerByAlbumName(TWIN)).toBeVisible();
    await expect(treeEntry).toHaveCount(0);
    expect(await readCount()).toBe(countBefore);
    await expect(tagEditorActions.tagEditor.repairAlert).toBeVisible();
    await expect(tagEditorActions.tagEditor.repairAlert).toContainText(/read.only|permission|denied|could ?n.t (write|save)/iu);
    await makeFixtureFilesWritable(ownedFixture);
  });

  test('FTC-TAGS-041 A page opened during a save shows the edited albums as the save will leave them', { tag: '@area:tag-edit' }, async ({
    page, managedAppLifecycle, galleryActions, appBarActions, tagEditorActions,
  }) => {
    await openLibrary({ managedAppLifecycle, galleryActions, appBarActions }, [TWIN, OTHER]);
    persistenceGate = await holdStructuralSavePersistence();
    const frames = await clickSave({ page, galleryActions, tagEditorActions }, OTHER, renameTo(COPY));
    await expectFromTheClick(frames, [TWIN]);
    const opened = await page.context().newPage();
    try {
      await opened.goto(page.url());
      const cards = opened.locator(galleryActions.galleryPage.albumCard.cardSelector);
      await expect(cards).toHaveCount(1);
      await expect(cards.first()).toContainText(TWIN);
      await expect(cards.filter({ hasText: OTHER })).toHaveCount(0);
    } finally {
      await opened.close();
      await persistenceGate.release();
      persistenceGate = null;
    }
  });

  test('FTC-TAGS-042 Save keeps the selected artist and gallery position while cards appear and disappear', { tag: '@area:tag-edit' }, async ({
    page, managedAppLifecycle, galleryActions, appBarActions, tagEditorActions,
  }) => {
    const fillers = Array.from({ length: 24 }, (_, index) => `Filler ${String(index).padStart(2, '0')}`);
    await openLibrary({ managedAppLifecycle, galleryActions, appBarActions }, [...fillers, TWIN, OTHER]);
    const { albumCard, galleryScroll } = galleryActions.galleryPage;
    await albumCard.cardByAlbumName(TWIN).scrollIntoViewIfNeeded();
    const selected = new URL(page.url()).searchParams.get('artist');
    // parity-check: allow-read-only-measurement-evaluate -- read the Gallery's scroll position
    const readPosition = () => galleryScroll.evaluate(element => element.scrollTop);
    const position = await readPosition();
    expect(position).toBeGreaterThan(0);
    await holdSave();
    await clickSave({ page, galleryActions, tagEditorActions }, TWIN, renameTo('A Renamed Release'));
    const expectKept = async () => {
      expect(new URL(page.url()).searchParams.get('artist')).toBe(selected);
      expect(Math.abs(await readPosition() - position)).toBeLessThanOrEqual(2);
    };
    await expect(albumCard.cardByAlbumName(TWIN)).toHaveCount(0, { timeout: BUDGET_MS });
    await expectKept();
    await finishSave(page);
    await expectKept();
  });
});
