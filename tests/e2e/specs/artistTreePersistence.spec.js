import { expect, test } from '../support/baseFixtures.js';

test('FTC-ARTIST-TREE-002 preserves collapsed and expanded preferences after reload', {
  tag: '@area:gallery-search',
}, async ({ galleryActions, navigationPanelActions, page, stepLogger }) => {
  const navigation = navigationPanelActions.navigationPanel;
  await stepLogger.step('Expand the account preference through the normal control', async () => {
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    await navigationPanelActions.setArtistTreeFolded(false);
    await expect(navigation.layoutPreferenceSync).toHaveAttribute('data-preferences-sync', 'saved');
    await expect(navigation.artistTreeFoldButton).toBeVisible();
    expect(await navigation.readArtistTreeFoldState()).toMatchObject({ folded: false, transitioning: false });
  });
  await stepLogger.step('Collapse through the control and retain it after reload', async () => {
    await navigationPanelActions.setArtistTreeFolded(true);
    await expect(navigation.layoutPreferenceSync).toHaveAttribute('data-preferences-sync', 'saved');
    await page.reload();
    await galleryActions.waitForGalleryReady();
    await expect(navigation.artistTreeNavigationButton).toBeVisible();
    await expect(navigation.artistTreeFoldButton).toBeHidden();
    expect(await navigation.readArtistTreeFoldState()).toMatchObject({ folded: true, transitioning: false });
  });
  await stepLogger.step('Expand through the control and retain it after reload', async () => {
    await navigationPanelActions.setArtistTreeFolded(false);
    await expect(navigation.layoutPreferenceSync).toHaveAttribute('data-preferences-sync', 'saved');
    await page.reload();
    await galleryActions.waitForGalleryReady();
    await expect(navigation.artistTreeFoldButton).toBeVisible();
    await expect(navigation.artistTreeNavigationButton).toBeHidden();
    expect(await navigation.readArtistTreeFoldState()).toMatchObject({ folded: false, transitioning: false });
  });
});

test('FTC-ARTIST-TREE-003 keeps the web navigation-tree header free of buttons and Loose Tracks as one side-bar button', {
  tag: '@area:gallery-search',
}, async ({ artistPageSettingsActions, freshBrowserSession, galleryActions, navigationPanelActions, page, searchToolbarActions, stepLogger }) => {
  // Owner rule (11-08): no buttons in the web navigation-tree header; a new side-bar entry goes vertically under
  // the existing side-bar buttons; one control in one place; never an empty or icon-less button.
  const navigation = navigationPanelActions.navigationPanel;
  await stepLogger.step('Full Gallery omits the artist-only Non-album tracks action', async () => {
    await galleryActions.goto('/?surface=albums');
    await galleryActions.waitForGalleryReady();
    await artistPageSettingsActions.open();
    await expect(artistPageSettingsActions.artistPageSettings.nonAlbumTracksButton).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(artistPageSettingsActions.artistPageSettings.menu).toBeHidden();
  });
  await stepLogger.step('Expanded panel: only the fold control in the header, no Loose Tracks entry', async () => {
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    await navigationPanelActions.setArtistTreeFolded(false);
    await expect(navigation.navigationTreeHeaderButtons).toHaveCount(1);
    await expect(navigation.navigationTreeHeaderButtons.first()).toHaveAccessibleName('Collapse Artist Tree');
    await expect(navigation.looseTracksEntryPoints).toHaveCount(0);
    await expect(page.locator('#sidebar-collections')).toBeHidden();
  });
  await stepLogger.step('Folded panel: Loose Tracks is one drawn button directly under Artist Tree', async () => {
    await navigationPanelActions.setArtistTreeFolded(true);
    await expect(navigation.looseTracksEntryPoints).toHaveCount(1);
    await expect(navigation.looseTracksSideBarButton).toBeVisible();
    const geometry = await page.evaluate(() => {
      const box = (node) => node.getBoundingClientRect();
      const tree = box(document.getElementById('artist-tree-navigation-button'));
      const loose = document.querySelector('#shell-navigation-compact [data-open-non-album-tracks]');
      const icon = loose.querySelector('svg');
      const iconBox = box(icon);
      const style = getComputedStyle(icon);
      return {
        below: box(loose).top >= tree.bottom, aligned: Math.abs(box(loose).left - tree.left) <= 1,
        iconWidth: iconBox.width, iconHeight: iconBox.height, shapes: icon.querySelectorAll('path, circle').length,
        stroke: style.stroke, visible: style.visibility === 'visible' && Number(style.opacity) > 0,
      };
    });
    expect(geometry).toMatchObject({ below: true, aligned: true, visible: true });
    expect(geometry.iconWidth).toBeGreaterThan(12);
    expect(geometry.iconHeight).toBeGreaterThan(12);
    expect(geometry.shapes).toBeGreaterThan(0);
    expect(geometry.stroke).not.toBe('none');
  });
  await stepLogger.step('The side-bar button opens library-wide Loose Tracks', async () => {
    await artistPageSettingsActions.openLibraryWideNonAlbumTracks();
    await expect(artistPageSettingsActions.artistPageSettings.nonAlbumTracksModal).toBeVisible();
    await expect(page.locator('#non-album-modal-subtitle')).toHaveText(/^\d+ tracks?$/);
  });
  await stepLogger.step('NEW-005: a new search from Loose Tracks never flashes the previous search tree entry', async () => {
    // Owner (11-08 evening): after a Folkstone search, Loose Tracks, then a Devin search, Folkstone blinked as the
    // selected tree entry before Devin's results. While a search runs the Loading page shows and the tree waits.
    await searchToolbarActions.search('Metallica', { submitWithEnter: true });
    await searchToolbarActions.waitForQuery('Metallica');
    await artistPageSettingsActions.openLibraryWideNonAlbumTracks();
    await expect(artistPageSettingsActions.artistPageSettings.nonAlbumTracksModal).toBeVisible();
    // Expanding Artist Tree is an explicit navigation action: it leaves Loose Tracks selected as the
    // open main surface, but the navigation panel itself must switch back to the Artists tree.
    await navigationPanelActions.setArtistTreeFolded(false);
    await expect(page.locator('#sidebar-list')).toBeVisible();
    await expect(page.locator('#sidebar-collections')).toBeHidden();
    await expect(page.locator('#artist-tree-navigation-button')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#shell-navigation-compact [data-open-non-album-tracks][data-library-wide="1"]'))
      .toHaveAttribute('aria-pressed', 'false');
    // parity-check: allow-read-only-measurement-evaluate -- record, on every frame, which tree entries are visible
    await page.evaluate(() => {
      const frames = [];
      window.__new005Frames = frames;
      const read = () => {
        const visible = [...document.querySelectorAll('#sidebar-list [data-sidebar-artist]')]
          .filter((node) => node.checkVisibility?.({ visibilityProperty: true }))
          .map((node) => node.getAttribute('data-sidebar-artist'));
        const loader = document.getElementById('library-loader');
        frames.push({ metallica: visible.includes('Metallica'), mastodon: visible.includes('Mastodon'),
          loading: Boolean(loader && !loader.hidden) });
        if (!window.__new005Stop) requestAnimationFrame(read);
      };
      requestAnimationFrame(read);
    });
    await searchToolbarActions.search('Mastodon', { submitWithEnter: true });
    await searchToolbarActions.waitForQuery('Mastodon');
    await expect(page.locator('#sidebar-list [data-sidebar-artist="Mastodon"]').first()).toBeVisible();
    await expect(artistPageSettingsActions.artistPageSettings.nonAlbumTracksModal).toBeHidden();
    const frames = await page.evaluate(() => { window.__new005Stop = true; return window.__new005Frames; });
    const firstMastodon = frames.findIndex((frame) => frame.mastodon);
    expect(firstMastodon, 'the new results render in the tree').toBeGreaterThanOrEqual(0);
    const beforeResults = frames.slice(0, firstMastodon);
    expect(beforeResults.filter((frame) => frame.metallica), JSON.stringify(frames.slice(0, firstMastodon + 1))).toEqual([]);
    expect(frames.slice(firstMastodon).some((frame) => frame.metallica)).toBe(false);
  });
  await stepLogger.step('INT-033: on a phone the Loose Tracks page header shows "Loose Tracks / N tracks"', async () => {
    const desktopCount = (await page.locator('#non-album-modal-subtitle').textContent()).trim();
    const phone = (await freshBrowserSession.create({ phone: true })).page;
    await phone.goto('/');
    await phone.locator('#mobile-library-button').click();
    await phone.locator('#shell-navigation-rail [data-navigation-mode="collections"]').tap();
    const title = phone.locator('#mobile-page-title');
    const summary = phone.locator('#mobile-page-summary');
    await expect(title).toBeVisible();
    await expect(title).toHaveText('Loose Tracks');
    await expect(summary).toBeVisible();
    await expect(summary).toHaveText(desktopCount);
    const header = await phone.evaluate(() => {
      const box = (id) => document.getElementById(id).getBoundingClientRect();
      const t = box('mobile-page-title'), s = box('mobile-page-summary');
      return { below: s.top >= t.bottom - 1, height: s.height, inView: s.bottom <= window.innerHeight && s.top >= 0 };
    });
    expect(header).toMatchObject({ below: true, inView: true });
    expect(header.height).toBeGreaterThan(8);
  });
});

for (const hydrationCase of [
  {
    name: 'FTC-ARTIST-TREE-004 keeps Loose Tracks selected after cold hydration without another navigation action',
    expandArtistTree: false,
  },
  {
    name: 'FTC-ARTIST-TREE-005 keeps Artist Tree selected when expanded during cold Loose Tracks hydration',
    expandArtistTree: true,
  },
]) {
  test(hydrationCase.name, { tag: '@area:gallery-search' }, async ({
    artistPageSettingsActions,
    galleryActions,
    navigationPanelActions,
    page,
  }) => {
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    await navigationPanelActions.setArtistTreeFolded(true);
    const isLibraryWideLooseTracks = (url) => {
      const parsed = new URL(url);
      return parsed.pathname === '/library/loose-tracks' && !parsed.searchParams.has('artist');
    };
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditionsByRule', {
      matchedNetworkConditions: [{
        urlPattern: `${new URL(page.url()).origin}/library/loose-tracks*`,
        latency: 5000,
        downloadThroughput: -1,
        uploadThroughput: -1,
      }],
    });

    try {
      const hydrationRequested = page.waitForRequest((request) => isLibraryWideLooseTracks(request.url()));
      const hydrationResponse = page.waitForResponse((response) => isLibraryWideLooseTracks(response.url()));
      const openingLooseTracks = artistPageSettingsActions.openLibraryWideNonAlbumTracks();
      await hydrationRequested;
      await openingLooseTracks;
      await expect(page.locator('#non-album-modal-subtitle'))
        .toHaveText(/^Loading loose tracks across library/);

      if (hydrationCase.expandArtistTree) {
        await navigationPanelActions.setArtistTreeFolded(false);
        await expect(page.locator('#artist-tree-navigation-button')).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('#shell-navigation-compact [data-open-non-album-tracks][data-library-wide="1"]'))
          .toHaveAttribute('aria-pressed', 'false');
      }

      await hydrationResponse;
      await expect(page.locator('#non-album-modal-subtitle')).toHaveText(/^\d+ tracks?$/);
      await expect(artistPageSettingsActions.artistPageSettings.nonAlbumTracksModal).toBeVisible();
      await expect(page.locator('#artist-tree-navigation-button'))
        .toHaveAttribute('aria-pressed', hydrationCase.expandArtistTree ? 'true' : 'false');
      await expect(page.locator('#shell-navigation-compact [data-open-non-album-tracks][data-library-wide="1"]'))
        .toHaveAttribute('aria-pressed', hydrationCase.expandArtistTree ? 'false' : 'true');

      if (hydrationCase.expandArtistTree) {
        await expect(page.locator('#sidebar-list')).toBeVisible();
        await expect(page.locator('#sidebar-collections')).toBeHidden();
      }
    } finally {
      await cdp.send('Network.emulateNetworkConditionsByRule', { matchedNetworkConditions: [] });
      await cdp.detach();
    }
  });
}
