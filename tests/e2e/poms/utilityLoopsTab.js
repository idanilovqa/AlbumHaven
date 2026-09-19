import { BasePage } from './basePage.js';
import { UtilityLoopEntryCard } from './utilityLoopEntryCard.js';
import { UtilityLoopTree } from './utilityLoopTree.js';
import { UtilityMainBody } from './utilityMainBody.js';
import { UtilitySidebarSection } from './utilitySidebarSection.js';

export class UtilityLoopsTab extends BasePage {
  constructor(page, testInfo = null) {
    super(page, testInfo);
    this.sidebar = new UtilitySidebarSection(page, testInfo);
    this.mainBody = new UtilityMainBody(page, testInfo);
    this.loopTree = new UtilityLoopTree(page, testInfo);
    this.loopEntryCard = new UtilityLoopEntryCard(page, testInfo);
    this.neutralKeyboardTarget = page.locator('body');
    this.emptyState = page.locator('#utility-problematic-detail .utility-empty-state').first();
    this.headerArtbox = page.locator('.utility-loop-detail-header .album-artbox');
    this.headerArtworkTrigger = page.locator('.utility-loop-detail-header .utility-artbox-trigger');
    this.lightbox = page.locator('#image-lightbox');
    this.lightboxImage = page.locator('#image-lightbox-image');
    this.lightboxClose = page.getByRole('button', { name: 'Close full-screen cover', exact: true });
  }
}
