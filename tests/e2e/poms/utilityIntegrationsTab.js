import { BasePage } from './basePage.js';
import { UtilityMainBody } from './utilityMainBody.js';
import { UtilitySidebarSection } from './utilitySidebarSection.js';

export class UtilityIntegrationsTab extends BasePage {
  constructor(page, testInfo = null) {
    super(page, testInfo);
    this.sidebar = new UtilitySidebarSection(page, testInfo);
    this.mainBody = new UtilityMainBody(page, testInfo);
    this.listItems = page.locator(this.listItemSelector);
    this.activeListItem = page.locator('[data-utility-integration-key].is-active');
    this.lastfmForm = page.locator(this.lastfmFormSelector);
    this.lastfmUsername = page.locator(this.lastfmUsernameSelector);
    this.lastfmPassword = page.locator('[data-lastfm-field="password"]');
    this.lastfmTimeZone = page.locator(this.lastfmTimeZoneSelector);
    this.lastfmConnectButton = page.locator('[data-save-lastfm-integration="1"]');
    this.lastfmStatusMeta = page.locator(this.lastfmStatusMetaSelector);
    this.errorToasts = page.locator('#toast-layer .toast.is-error');
    this.libraryRootInputs = page.locator('[data-library-root-id]');
  }

  get listItemSelector() {
    return '[data-utility-integration-key]';
  }

  get lastfmFormSelector() {
    return '[data-lastfm-integration-form="1"]';
  }

  get lastfmUsernameSelector() {
    return '[data-lastfm-field="username"]';
  }

  get lastfmTimeZoneSelector() {
    return '[data-lastfm-field="timezone"]';
  }

  get lastfmStatusMetaSelector() {
    return '#utility-problematic-detail .utility-rule-album-meta';
  }
}
