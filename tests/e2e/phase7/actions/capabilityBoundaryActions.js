import { expect } from '@playwright/test';
import { CapabilityBoundaryPage } from '../poms/capabilityBoundaryPage.js';
import { GalleryPage } from '../../poms/galleryPage.js';
import { GalleryActions } from '../../actions/galleryActions.js';
import { TrackModal } from '../../poms/trackModal.js';
import { TrackModalActions } from '../../actions/trackModalActions.js';
import { CoverLookup } from '../../poms/coverLookup.js';
import { CoverLookupActions } from '../../actions/coverLookupActions.js';
import { UtilityProblematicFilesTab } from '../../poms/utilityProblematicFilesTab.js';
import { UtilityProblematicFilesActions } from '../../actions/utilityProblematicFilesActions.js';
import { openCapabilityFixtureAlbum } from './capabilityEditorActions.js';

async function expectControl(control, allowed) {
  if (allowed) await expect(control).toBeVisible();
  else await expect(control).toBeHidden();
}

export async function assertCapabilityBoundary(page, profile, testInfo) {
  const allowed = new Set(profile.visible);
  const ui = new CapabilityBoundaryPage(page);
  if (profile.noView) {
    await page.goto('/admin/members');
    await expect(ui.usersHeading).toBeVisible();
    await expect(ui.addUser).toBeVisible();
    await expect(ui.ownerActions).toHaveCount(0);
    const response = await page.goto('/');
    expect(response.status()).toBe(403);
    await expect(ui.forbidden).toBeVisible();
    await expect(ui.libraryShell).toHaveCount(0);
    await expect(ui.player).toHaveCount(0);
    return;
  }
  const galleryPage = new GalleryPage(page, testInfo);
  const gallery = new GalleryActions(galleryPage);
  const album = new TrackModal(page, testInfo);
  const tracks = new TrackModalActions(album);
  const covers = new CoverLookupActions(new CoverLookup(page, testInfo));
  await page.goto('/');
  await openCapabilityFixtureAlbum(gallery);
  await expect(album.title).toContainText('Uninterrupted Session');
  await expect(album.trackRows).toHaveCount(1);
  await expect(album.detailedCoverImage).toBeVisible();
  await expectControl(album.playButtonAt(0), allowed.has('play'));
  await expectControl(album.editTagsButton, allowed.has('edit'));
  await expectControl(album.coverLookupButton, allowed.has('covers'));
  await expectControl(ui.folder, allowed.has('folder'));
  await expectControl(ui.coverLookup, allowed.has('covers'));
  await expectControl(ui.scanIndicator, allowed.has('scan'));
  if (!allowed.has('play')) await expect(ui.player).toBeHidden();
  if (!allowed.has('create')) await expect(ui.visibleLoopCreation).toHaveCount(0);
  if (allowed.has('covers')) {
    await tracks.openCoverLookup();
    await covers.waitForModalReady();
    await expect(covers.coverLookup.findBetterButton).toBeVisible();
    await expectControl(covers.coverLookup.manualUrlInput, !profile.providerOnly);
    await expectControl(covers.coverLookup.addImageButton, !profile.providerOnly);
    await expectControl(covers.coverLookup.manualExtractButton, !profile.providerOnly);
    await expectControl(covers.coverLookup.activeLocalCoverCard, !profile.providerOnly);
    await expectControl(ui.coverDelete.first(), allowed.has('delete'));
    await covers.closeModal();
  }
  await tracks.close();
  const card = galleryPage.albumCard.cardByIdentity('Settings Navigation Fixture', 'Boundary Arrival', '2026');
  await expect(card).toBeVisible();
  await card.click({ button: 'right' });
  if (profile.name === 'mobile') {
    await expect(ui.galleryContextMenu).toBeHidden();
    await expect(ui.galleryFolder).toBeHidden();
    await expect(ui.galleryVersion).toBeHidden();
  } else {
    await expectControl(ui.galleryFolder, allowed.has('folder'));
    await expectControl(ui.galleryVersion, allowed.has('repair'));
  }
  await page.keyboard.press('Escape');
  await gallery.selectAlbumDetailsByIdentity({
    artist: 'Settings Navigation Fixture', album: 'Missing Boundary Session', year: '2026',
  });
  await expect(album.title).toContainText('Missing Boundary Session');
  await expect(album.missingAlert).toBeVisible();
  await expectControl(album.removeMissingAlbumButton, allowed.has('delete'));
  await tracks.close();
  await ui.menu.settingsButton.click();
  await expect(ui.menu.accountMenu).toBeVisible();
  await expectControl(ui.menu.adminPanelMenuItem, allowed.has('admin'));
  await ui.menu.settingsMenuItem.click();
  await expect(ui.settingsDialog).toBeVisible();
  await expect(ui.tab('appearance')).toBeVisible();
  for (const key of ['problematic-files', 'rules', 'log-history']) {
    await expectControl(ui.tab(key), allowed.has('repair'));
  }
  await expectControl(ui.tab('loops'), allowed.has('practice'));
  await expectControl(ui.tab('integrations'), allowed.has('integrations'));
  await ui.tab('appearance').click();
  await expect(ui.tab('appearance')).toHaveAttribute('aria-selected', 'true');
  await expect(ui.notice).toBeHidden();
  if (allowed.has('repair')) {
    await ui.tab('problematic-files').click();
    await expect(ui.tab('problematic-files')).toHaveAttribute('aria-selected', 'true');
    const problems = new UtilityProblematicFilesTab(page, testInfo);
    await new UtilityProblematicFilesActions(problems).selectAlbumByTitle('Boundary Arrival');
    await expect(problems.detailTitle).toContainText('Boundary Arrival');
    await expect(problems.detectedProblemsHeading).toBeVisible();
    await expect(problems.albumProblemPills.first()).toBeVisible();
    await expect(problems.excludeProblemButton).toBeVisible();
    await expectControl(problems.detailEditTagsButton, allowed.has('edit'));
    await expectControl(problems.detailOpenInExplorerButton, allowed.has('folder'));
    for (const key of ['rules', 'log-history']) {
      await ui.tab(key).click();
      await expect(ui.tab(key)).toHaveAttribute('aria-selected', 'true');
      await expect(ui.notice).toBeHidden();
    }
  }
  if (allowed.has('practice')) {
    await ui.tab('loops').click();
    await expect(ui.tab('loops')).toHaveAttribute('aria-selected', 'true');
    await expect(ui.notice).toBeHidden();
  }
  await ui.settings.closeSettings();
  if (allowed.has('admin')) {
    await page.goto('/admin/members');
    await expect(ui.usersHeading).toBeVisible();
    await expect(ui.addUser).toBeVisible();
    await expect(ui.ownerActions).toHaveCount(0);
  } else {
    const response = await page.goto('/admin/members');
    expect(response.status()).toBe(403);
    await expect(ui.adminForbidden).toBeVisible();
  }
}
