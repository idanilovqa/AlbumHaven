import { BasePage } from './basePage.js';

export class AppBar extends BasePage {
  constructor(page, testInfo = null) {
    super(page, testInfo);
    this.root = page.locator('.app-bar').first();
    this.toolbar = page.locator(this.toolbarSelector);
    this.scanIndicator = page.locator(this.scanIndicatorSelector);
    this.statusContextMenu = page.locator(this.statusContextMenuSelector);
    this.scanActionButton = page.locator(this.scanActionButtonSelector);
    this.coverActionButton = page.locator(this.coverActionButtonSelector);
    this.scanAlreadyRunningToast = page.locator(this.scanAlreadyRunningToastSelector);
    this.errorToasts = page.locator(this.errorToastSelector);
    this.brandArt = this.root.locator('.app-bar-brand-art');
    this.brandLabel = this.root.locator('.app-bar-brand-label');
    this.notificationGlyph = this.root.locator('.cover-lookup-drawer-glyph');
    this.notificationGlyphDefaultImage = this.notificationGlyph.locator('.cover-lookup-drawer-glyph-default');
    this.notificationGlyphHoverImage = this.notificationGlyph.locator('.cover-lookup-drawer-glyph-hover');
  }

  async readAppearanceCheckpoint() {
    // parity-check: allow-read-only-measurement-evaluate -- inspect the shared app-bar palette treatment
    return this.root.evaluate((appBar) => {
      const brandArt = appBar.querySelector('.app-bar-brand-art');
      const brandLabel = appBar.querySelector('.app-bar-brand-label');
      const glyph = appBar.querySelector('.cover-lookup-drawer-glyph');
      const glyphImage = glyph?.querySelector('img');
      const style = (element, pseudo = null) => (
        element instanceof Element ? getComputedStyle(element, pseudo) : null
      );
      const appBarStyle = style(appBar);
      const brandArtStyle = style(brandArt);
      const brandLabelStyle = style(brandLabel);
      const glyphStyle = style(glyph);
      const glyphBeforeStyle = style(glyph, '::before');
      const glyphImageStyle = style(glyphImage);
      return {
        backgroundColor: appBarStyle?.backgroundColor || '',
        brandArt: {
          filter: brandArtStyle?.filter || '',
          opacity: brandArtStyle?.opacity || '',
        },
        brandLabel: {
          backgroundColor: brandLabelStyle?.backgroundColor || '',
        },
        notificationGlyph: {
          imageOpacity: glyphImageStyle?.opacity || '',
          pseudoBackgroundColor: glyphBeforeStyle?.backgroundColor || '',
          pseudoMaskImage: glyphBeforeStyle?.maskImage || glyphBeforeStyle?.webkitMaskImage || '',
          width: glyphStyle?.width || '',
          height: glyphStyle?.height || '',
        },
      };
    });
  }

  get toolbarSelector() {
    return '#search-form';
  }

  get scanIndicatorSelector() {
    return '#scan-indicator';
  }

  get statusContextMenuSelector() {
    return '#status-context-menu';
  }

  get scanActionButtonSelector() {
    return '#status-context-menu [data-status-role="scan-action"]';
  }

  get coverActionButtonSelector() {
    return '#status-context-menu [data-status-role="cover-action"]';
  }

  get scanAlreadyRunningToastSelector() {
    return '#toast-layer .toast';
  }

  get errorToastSelector() {
    return '#toast-layer .toast.is-error';
  }
}
