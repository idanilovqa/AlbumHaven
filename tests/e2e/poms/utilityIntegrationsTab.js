import { BasePage } from './basePage.js';
import { UtilityMainBody } from './utilityMainBody.js';
import { UtilitySidebarSection } from './utilitySidebarSection.js';
import { authenticatedPageGet } from '../helpers/authenticatedPageRequest.js';

export class UtilityIntegrationsTab extends BasePage {
  constructor(page, testInfo = null) {
    super(page, testInfo);
    this.sidebar = new UtilitySidebarSection(page, testInfo);
    this.mainBody = new UtilityMainBody(page, testInfo);
    this.listItems = page.locator(this.listItemSelector);
    this.activeListItem = page.locator('[data-utility-integration-key][aria-current="true"]');
    this.scrobbling = page.locator('[data-utility-integration-key="lastfm"]');
    this.connectedStatus = page.locator('.settings-connected-status');
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

  async readPersistedLastfmTimeZone() {
    const response = await authenticatedPageGet(this.page, '/utilities/integrations');
    if (!response.ok()) throw new Error(`Integration read returned HTTP ${response.status()}.`);
    const payload = await response.json();
    return payload.integrations.find(item => item.key === 'lastfm')?.user_timezone || '';
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
