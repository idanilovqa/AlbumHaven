import { CapabilityPage } from './capabilityPage.js';

export class CapabilityBoundaryPage extends CapabilityPage {
  constructor(page) {
    super(page);
    this.forbidden = page.getByText('{"detail":"Action not permitted."}', { exact: true });
    this.usersHeading = page.getByRole('heading', { name: 'Users & access', exact: true });
    this.addUser = page.getByRole('link', { name: 'Add user', exact: true });
    this.ownerActions = page.getByRole('button', { name: 'Actions for Rendref', exact: true });
    this.folder = page.locator('#track-modal-folder');
    this.visibleLoopCreation = page.locator('[data-playback-control-loop-actions]:visible');
    this.visibleLoopDelete = page.locator('[data-delete-saved-loop]:visible');
    this.visibleLoopReorder = page.locator('[data-move-utility-loop]:visible');
    this.coverDelete = page.locator('#cover-lookup-modal [data-delete-local-cover]');
    this.galleryMove = page.locator('#album-card-context-menu [data-album-card-action^="move_to_"]');
    this.visibleGalleryMove = page.locator('#album-card-context-menu [data-album-card-action^="move_to_"]:visible');
    this.galleryFolder = page.locator('#album-card-context-menu [data-album-card-action="open-explorer"]');
    this.galleryVersion = page.locator('#album-card-context-menu [data-album-card-action="mark-version"]');
    this.moveButtons = page.locator('[data-move-problematic-album]:visible');
    this.settingsDialog = page.locator('#utility-modal');
    this.libraryShell = page.locator('#app-shell');
  }
}
