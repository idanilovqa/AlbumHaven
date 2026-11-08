import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '../support/baseFixtures.js';
import {
  generatePlayableMp3Source,
  materializeTaggedAlbum,
  materializeTaggedTrack,
} from '../helpers/libraryFilesystemWatcherFixture.js';
import { GallerySourceSwitch } from '../poms/gallerySourceSwitch.js';
import { SettingsIntegrations } from '../poms/settingsIntegrations.js';

const ARTIST = 'Source Switch Arrivals Artist';
const ALBUM = 'Source Switch Arrivals Album';
const OWNED_FOLDER = 'New Arrivals source switch';

async function writeNewArrivalsAlbum(ownedRoot) {
  const sourceRoot = fs.mkdtempSync(path.join(path.dirname(ownedRoot), '.source-switch-'));
  try {
    const source = path.join(sourceRoot, 'source.mp3');
    await generatePlayableMp3Source(source);
    await materializeTaggedAlbum({
      stagingParent: path.dirname(ownedRoot),
      destination: path.join(ownedRoot, ARTIST, ALBUM),
      buildAlbum: album => materializeTaggedTrack({
        source,
        destination: path.join(album, '01 - Arrival Signal.mp3'),
        metadata: { trackArtist: ARTIST, albumArtist: ARTIST, album: ALBUM, year: 2026, title: 'Arrival Signal', trackNumber: 1 },
      }),
    });
  } finally {
    fs.rmSync(sourceRoot, { recursive: true });
  }
}

test('FTC-GALLERY-SOURCES-001 switching to only New Arrivals shows loading, never an empty Library', {
  tag: '@area:gallery-search',
}, async ({
  page, appBarActions, galleryActions, settingsModalAppBarActions, stepLogger,
  utilityIntegrationsActions, utilityTabBarActions,
}) => {
  test.setTimeout(240000);
  const settings = new SettingsIntegrations(page);
  const gallery = new GallerySourceSwitch(page);
  let before;
  let ownedRoot;
  const openLibrarySettings = async () => {
    await settingsModalAppBarActions.openSettings();
    await utilityTabBarActions.openTab('integrations');
    await utilityIntegrationsActions.waitForReady();
    await settings.navigation('Library').click();
    await expect(settings.save).toBeEnabled();
  };
  try {
    await stepLogger.step('Add a New Arrivals folder holding one album', async () => {
      await galleryActions.goto();
      await galleryActions.waitForGalleryReady();
      await openLibrarySettings();
      before = await settings.readSettings();
      if (before.new_arrivals_roots.length) await settings.add('New Arrivals');
      await settings.chooseLast('New Arrivals', 'Incoming additional');
      ownedRoot = path.join(path.dirname(await settings.roots('New Arrivals').last().inputValue()), OWNED_FOLDER);
      await writeNewArrivalsAlbum(ownedRoot);
      await settings.chooseLast('New Arrivals', OWNED_FOLDER);
      expect((await settings.saveResult()).status).toBe(200);
      await appBarActions.waitForIncrementalScanComplete();
    });

    await stepLogger.step('Open the Main Library alone, then turn every source off', async () => {
      await galleryActions.goto('/?surface=albums&gallery_scope=all&category=main_library');
      await galleryActions.waitForGalleryReady();
      await expect(gallery.cards.first()).toBeVisible();
      await expect(galleryActions.hasVisibleAlbum(ALBUM)).resolves.toBe(false);
      await gallery.openSources();
      await gallery.source('Main Library').click();
      await expect(gallery.source('Main Library')).toHaveAttribute('aria-checked', 'false');
      await expect(gallery.emptySelection).toHaveText('Select at least one of the sources to see the Library');
    });

    await stepLogger.step('Switch to only New Arrivals: loading shows until its album renders', async () => {
      const observation = await gallery.observeFramesWhileEnabling('new_arrivals');
      let frames;
      try {
        await gallery.source('New Arrivals').click();
        await galleryActions.waitForAlbumVisible(ALBUM, { timeout: 60000 });
        await expect(gallery.loader).toBeHidden();
      } finally {
        frames = (await observation.finish()).filter(frame => frame.sourceOn);
      }
      expect(frames.length).toBeGreaterThan(0);
      expect(frames.filter(frame => !frame.loaderVisible && frame.cards === 0)).toEqual([]);
      expect(frames.some(frame => frame.loaderVisible && !frame.galleryVisible
        && frame.loaderTitle === 'Loading selection')).toBe(true);
      await expect(gallery.cards).toHaveCount(1);
      await expect(gallery.cards.first()).toContainText(ALBUM);
    });
  } finally {
    if (before) {
      await openLibrarySettings();
      const retained = Math.max(1, before.new_arrivals_roots.length);
      while (await settings.roots('New Arrivals').count() > retained) await settings.removeLast('New Arrivals');
      if (!before.new_arrivals_roots.length) await settings.removeLast('New Arrivals');
      expect((await settings.saveResult()).status).toBe(200);
      expect(await settings.readSettings()).toEqual(before);
      await appBarActions.waitForIncrementalScanComplete();
    }
    if (ownedRoot && fs.existsSync(ownedRoot)) fs.rmSync(ownedRoot, { recursive: true, maxRetries: 10, retryDelay: 200 });
  }
});
