import { BasePage } from './basePage.js';
import { AppBar } from './appBar.js';
import { AppConfirmDialog } from './components/appConfirmDialog.js';
import { CompactPlayerStyleControl } from './components/compactPlayerStyleControl.js';
import { EditorFooter } from './components/editorFooter.js';
import { NavigationTree } from './components/navigationTree.js';
import { UtilityMainBody } from './utilityMainBody.js';
import { UtilitySidebarSection } from './utilitySidebarSection.js';

export class UtilityAppearanceTab extends BasePage {
  constructor(page, testInfo = null) {
    super(page, testInfo);
    this.sidebar = new UtilitySidebarSection(page, testInfo);
    this.documentRoot = page.locator('html');
    this.documentBody = page.locator('body');
    this.mainBody = new UtilityMainBody(page, testInfo);
    this.detailScroller = this.mainBody.detail;
    this.editor = page.locator('.appearance-background-editor');
    this.editorHeading = this.editor.getByRole('heading', { level: 3 });
    this.navigationTree = new NavigationTree(this.sidebar.list);
    this.seekbarModeInputs = page.locator(this.seekbarModeSelector);
    this.colorInputs = page.locator('[data-appearance-color]');
    this.compactPlayerStyle = new CompactPlayerStyleControl(
      this.editor.locator('.compact-player-style-section'),
    );
    this.playerAngleInput = page.locator('[data-player-style-angle]');
    this.playerAngleOutput = page.locator('[data-player-angle-output]');
    this.playerLivePreview = page.locator('[data-player-live-preview]');
    this.playerPreviewDock = this.editor.locator('.player-preview-dock');
    this.mainPreviewColumn = this.editor.locator('.background-preview-column');
    this.selectionAccentEnabledInput = this.editor.locator('[data-aggregate-accent-enabled]');
    this.selectionAccentCustomInput = page.locator('[data-aggregate-accent-custom]');
    this.matchPaletteButton = this.editor.getByRole('button', { name: 'Match palette', exact: true });
    this.customPlayerColorsButton = this.editor.getByRole('button', { name: 'Custom player colors', exact: true });
    this.matchPlayerButton = this.editor.getByRole('button', { name: 'Match player', exact: true });
    this.customizePlayerButton = this.editor.getByRole('button', { name: 'Customize', exact: true });
    this.recentSetsHeading = this.editor.getByText('Recent sets', { exact: true });
    this.latestPlayerSetButton = this.editor.getByRole('button', { name: 'Restore latest set', exact: true });
    this.useThemeInteractionsButton = this.editor.getByRole('button', { name: 'Use theme', exact: true });
    this.requestError = this.editor.locator('[data-background-request-error]');
    this.editorFooter = new EditorFooter(page.locator('#utility-modal-footer'));
    this.appBar = new AppBar(page, testInfo);
    this.navigationRail = page.locator('#shell-navigation-rail');
    this.globalPlayer = page.locator('.global-player');
    this.globalPlayerLoopSelection = this.globalPlayer.locator('.loop-range-selection');
    this.playerPlayButton = page.locator('#player-play');
    this.playerTimeline = page.locator('#player-timeline');
    this.playerCoverButton = page.locator('#player-cover-button');
    this.appConfirmDialog = new AppConfirmDialog(page);
  }

  get seekbarModeSelector() {
    return '[data-appearance-seekbar-mode]';
  }

  seekbarModeInput(mode) {
    return this.page.locator(this.seekbarModeSelectorFor(mode));
  }

  seekbarModeSelectorFor(mode) {
    return `[data-appearance-seekbar-mode="${mode}"]`;
  }

  compactStyleButton(style) {
    return this.compactPlayerStyle.button(style);
  }

  sectionButton(key) {
    return this.navigationTree.itemByKey(key).root;
  }

  get sectionButtons() {
    return this.navigationTree.items;
  }

  paletteButton(paletteId) {
    return this.page.locator(`[data-background-palette="${paletteId}"]`);
  }

  panelButton(index) {
    return this.page.locator(`[data-background-panel="${index}"]`);
  }

  playerThemeButton(themeId) {
    return this.page.locator(`[data-player-theme="${themeId}"]`);
  }

  playerTabButton(tab, group) {
    const groupSelector = group ? `[data-player-tab-group="${group}"]` : '';
    return this.page.locator(`${groupSelector}[data-player-tab="${tab}"]`);
  }

  playerTabPanel(tab, group) {
    return this.page.locator(`[data-player-panel-group="${group}"][data-player-panel="${tab}"]`);
  }

  playerSurfaceModeButton(mode) {
    return this.page.locator(`[data-player-surface-mode="${mode}"]`);
  }

  playerStyleHex(path) {
    return this.page.locator(`[data-player-style-hex="${path}"]`);
  }

  waveformHex(field) {
    return this.page.locator(`[data-player-hex="${field}"]`);
  }

  waveformRecentButton(field, color) {
    return this.editor.locator(
      `[data-waveform-recent="${color}"][data-waveform-field="${field}"]`,
    );
  }

  async readPlayerPreviewColors() {
    // parity-check: allow-read-only-measurement-evaluate -- read the live preview's resolved CSS custom properties
    return this.playerLivePreview.evaluate((preview) => {
      const style = getComputedStyle(preview);
      return {
        waveformFill: style.getPropertyValue('--preview-waveform-fill').trim(),
        waveformEdge: style.getPropertyValue('--preview-waveform-edge').trim(),
      };
    });
  }

  interactionColorButton(role, family) {
    const colorAttribute = role === 'item_outline'
      ? 'data-item-outline-color'
      : `data-interaction-color="${role}"`;
    return this.editor.locator(`[${colorAttribute}][data-color-family="${family}"]`);
  }

  selectionAccentButton(color) {
    return this.editor.locator(`[data-aggregate-accent-color="${color}"]`);
  }

  previewState(state) {
    return this.page.locator(`[data-preview-state="${state}"]`);
  }

  alertFamilyButton(family) {
    return this.editor.locator(`button[data-alert-family="${family}"]`);
  }

  alertSeverityButton(severity) {
    return this.editor.locator(`[data-alert-preview-severity="${severity}"]`);
  }

  get alertLivePreview() {
    return this.editor.locator('[data-alert-live-preview]');
  }

  albumLayoutButton(layout) {
    return this.editor.locator(`[data-album-details-layout="${layout}"]`);
  }

  albumPreviewStateButton(state) {
    return this.editor.locator(`[data-album-preview-state="${state}"]`);
  }

  albumPlayingRowAnimationButton(value) {
    return this.editor.locator(`button[data-album-playing-row-animation="${value}"]`);
  }

  get albumPageLivePreview() {
    return this.editor.locator('[data-album-page-live-preview]');
  }

  get albumPreviewFileActions() {
    return this.editor.locator('[data-album-preview-file-action]');
  }

  get albumPreviewPresentContent() {
    return this.editor.locator('[data-album-preview-present]');
  }

  get albumPreviewTracks() {
    return this.albumPageLivePreview.locator('.appearance-album-preview__track');
  }

  get albumPreviewPlayingTrack() {
    return this.albumPageLivePreview.locator('.appearance-album-preview__track.is-playing');
  }

  get albumPreviewMissingContent() {
    return this.editor.locator('[data-album-preview-missing]');
  }
}
