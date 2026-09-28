import { CapabilityEditorPage } from './capabilityEditorPage.js';

export class CapabilityPresentationPage extends CapabilityEditorPage {
  constructor(page) {
    super(page);
    this.username = page.locator('.detail-person strong');
    this.heading = page.getByRole('heading', { name: 'Edit user', exact: true });
    this.root = page.locator('html');
    this.appBar = page.locator('.shell-app-bar');
    this.help = page.locator('#roles-only-help');
    this.notices = page.locator('[data-capability-assignment] .on-page-alert');
    this.noticeMessages = this.notices.locator('.on-page-alert__message');
    this.followingNotice = page.locator('.roles-only-action + .on-page-alert');
    this.viewerRow = this.roles.locator('.gallery-switch').filter({ has: page.getByRole('checkbox', { name: 'Viewer', exact: true }) });
  }

  memberAction(username) { return this.page.getByRole('button', { name: `Actions for ${username}`, exact: true }); }

  async contentCardColor() {
    // parity-check: allow-read-only-measurement-evaluate -- read the saved content palette token for comparison with painted popup
    return this.root.evaluate(element => getComputedStyle(element).getPropertyValue('--appearance-card').trim());
  }

  async style(locator) {
    // parity-check: allow-read-only-measurement-evaluate -- read painted colors and interaction state without changing the app
    return locator.evaluate(async (element) => {
      await Promise.all(element.getAnimations().filter((animation) =>
        Number.isFinite(animation.effect?.getComputedTiming().endTime)).map((animation) => animation.finished));
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, backgroundImage: style.backgroundImage,
        bridgeBackground: getComputedStyle(element, '::after').backgroundColor,
        color: style.color, opacity: Number(style.opacity),
        cursor: style.cursor, shadow: style.boxShadow, outline: style.outlineStyle };
    });
  }
}
