import { expect } from '@playwright/test';

export class ArtistPageSettingsActions {
  constructor(artistPageSettings) {
    this.artistPageSettings = artistPageSettings;
  }

  async open(options = {}) {
    const menuVisible = await this.artistPageSettings.menu.isVisible();
    if (!menuVisible) {
      await this.artistPageSettings.button.click({ noWaitAfter: true, ...options });
    }
    await this.artistPageSettings.waitForVisible(this.artistPageSettings.menu, { timeout: options.timeout || 10000 });
  }

  async expectOpen(options = {}) {
    await expect(this.artistPageSettings.menu).toBeVisible({
      timeout: options.timeout || 10000,
    });
  }

  async toggleCombineSimilarArtists(options = {}) {
    await this.open(options);
    await this.artistPageSettings.combineSimilarArtistsButton.click({ noWaitAfter: true, ...options });
  }

  async waitForCombineState(expectedStateText, options = {}) {
    await this.artistPageSettings.waitForPageCondition((selectors) => {
      const button = document.querySelector(selectors.combineButtonSelector);
      if (!(button instanceof HTMLElement)) return false;
      const count = button.querySelector(selectors.combineStateCountSelector);
      return (count?.textContent || '').trim() === selectors.expectedStateText;
    }, {
      timeout: options.timeout || 10000,
    }, {
      combineButtonSelector: this.artistPageSettings.combineSimilarArtistsButtonSelector,
      combineStateCountSelector: this.artistPageSettings.combineStateCountSelector,
      expectedStateText,
    });
  }

  async openNonAlbumTracks(expectedCount, options = {}) {
    const timeout = options.timeout || 10000;
    await this.open(options);
    await expect(this.artistPageSettings.nonAlbumTracksButton).toBeEnabled({ timeout });
    await expect(this.artistPageSettings.nonAlbumTracksCount).toHaveText(
      String(Number(expectedCount)),
      { timeout },
    );
    await this.artistPageSettings.nonAlbumTracksButton.click({ noWaitAfter: true });
    await expect(this.artistPageSettings.nonAlbumTracksModal).toBeVisible({ timeout });
    await expect(this.artistPageSettings.nonAlbumTrackRows).toHaveCount(
      Number(expectedCount),
      { timeout },
    );
  }

  async readNonAlbumTrackTitles() {
    return (await this.artistPageSettings.nonAlbumTrackTitles.allTextContents())
      .map((title) => title.trim())
      .filter(Boolean);
  }

  async closeNonAlbumTracks(options = {}) {
    await this.artistPageSettings.nonAlbumTracksCloseButton.click();
    await expect(this.artistPageSettings.nonAlbumTracksModal).toBeHidden({
      timeout: options.timeout || 10000,
    });
  }

  async expectCompactGroupedNonAlbumTable({ sections, tracks }, options = {}) {
    const timeout = options.timeout || 10000;
    await expect(this.artistPageSettings.nonAlbumTrackSectionTitles).toHaveText(
      sections,
      { timeout },
    );
    await expect(this.artistPageSettings.nonAlbumTrackSections).toHaveCount(sections.length);
    await expect(this.artistPageSettings.nonAlbumCompactTables).toHaveCount(sections.length);
    await expect(this.artistPageSettings.nonAlbumColumnHeaders).toHaveText(
      sections.flatMap(() => ['Track', 'File path']),
    );
    await expect(this.artistPageSettings.nonAlbumControlCells).toHaveCount(tracks.length);
    await expect(this.artistPageSettings.nonAlbumTrackCells).toHaveCount(tracks.length);
    await expect(this.artistPageSettings.nonAlbumPathCells).toHaveCount(tracks.length);
    await expect(this.artistPageSettings.nonAlbumExceptionLabels).toHaveCount(0);

    for (const track of tracks) {
      const row = this.artistPageSettings.nonAlbumTrackRowByTitle(track.title);
      await expect(row).toHaveCount(1);
      await expect(row.getByRole('button', { name: `Play ${track.title}`, exact: true })).toBeVisible();
      await expect(this.artistPageSettings.nonAlbumTrackArtistByTitle(track.title)).toHaveText(track.artist);
      await expect(this.artistPageSettings.nonAlbumTrackPathByTitle(track.title)).toContainText(track.pathSuffix);
      await expect(this.artistPageSettings.nonAlbumTrackControlByTitle(track.title)).toContainText(
        `${track.number}.`,
      );
    }

    expect(await this.artistPageSettings.readNonAlbumDialogWidth()).toBeGreaterThan(720);
    const firstRow = this.artistPageSettings.nonAlbumTrackRows.first();
    expect(
      await this.artistPageSettings.readNonAlbumPlayToTrackGap(tracks[0].title),
    ).toBeGreaterThanOrEqual(8);
    const headerAlignment = await this.artistPageSettings.readFirstNonAlbumHeaderAlignment();
    expect(headerAlignment).not.toBeNull();
    expect(headerAlignment.trackOffset).toBeLessThanOrEqual(1);
    expect(headerAlignment.pathOffset).toBeLessThanOrEqual(1);
    await firstRow.hover();
    await expect(firstRow).toHaveCSS('background-color', 'rgba(148, 163, 184, 0.08)');
  }

  async expectNonAlbumTracksOpen(expectedCount, options = {}) {
    const timeout = options.timeout || 10000;
    await expect(this.artistPageSettings.nonAlbumTracksModal).toBeVisible({ timeout });
    await expect(this.artistPageSettings.nonAlbumTrackRows).toHaveCount(Number(expectedCount), { timeout });
  }

  async openProblematicFilesForNonAlbumTrack(trackTitle, options = {}) {
    await this.artistPageSettings.problemButtonForNonAlbumTrack(trackTitle).click({
      timeout: options.timeout || 30000,
    });
  }

  async openNonAlbumTracksInTagEditor(options = {}) {
    const timeout = options.timeout || 10000;
    await expect(this.artistPageSettings.nonAlbumTracksEditTagsButton).toBeVisible({ timeout });
    await this.artistPageSettings.nonAlbumTracksEditTagsButton.click();
    await expect(this.artistPageSettings.nonAlbumTracksModal).toBeHidden({ timeout });
  }
}
