import { expect, test } from '../support/baseFixtures.js';
import { SettingsModalAppBarActions } from '../actions/settingsModalAppBarActions.js';
import { UtilityAppearanceActions } from '../actions/utilityAppearanceActions.js';
import { UtilityTabBarActions } from '../actions/utilityTabBarActions.js';
import { SettingsModalAppBar } from '../poms/settingsModalAppBar.js';
import { UtilityAppearanceTab } from '../poms/utilityAppearanceTab.js';
import { UtilityTabBar } from '../poms/utilityTabBar.js';

const CASE_ID = 'FTC-APPEARANCE-001';
const PLAYER_COLORS = Object.freeze({
  surfaceStart: '#123456',
  surfaceEnd: '#234567',
  controlFill: '#345678',
  controlBorder: '#456789',
  waveformFill: '#56789A',
  waveformEdge: '#6789AB',
  pairedControlFill: '#51A1C4',
  pairedControlBorder: '#2F91D1',
  handle: '#789ABC',
});
const INTERACTION_COLORS = Object.freeze({
  navigationHover: 'rgb(49, 70, 93)',
  navigationSelected: 'rgb(63, 95, 126)',
  itemHover: 'rgb(39, 56, 75)',
  itemBorder: 'rgb(134, 183, 239)',
  itemPressed: 'rgb(32, 50, 70)',
  focus: 'rgb(134, 183, 239)',
});

test(`${CASE_ID} applies every Appearance control family to real UI and preserves it across reload`, { tag: '@area:responsive-visual' }, async ({
  artistFamilyActions,
  galleryActions,
  navigationPanelActions,
  page,
  settingsModalAppBarActions,
  stepLogger,
  utilityAppearanceActions,
  utilityTabBarActions,
}) => {
  test.setTimeout(240000);
  const appearance = utilityAppearanceActions.utilityAppearanceTab;
  let savedSnapshot;

  await stepLogger.step('Open the five-page Appearance workspace and keep drafts preview-only', async () => {
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    await settingsModalAppBarActions.openSettings();
    await utilityTabBarActions.openTab('appearance');
    await utilityAppearanceActions.waitForReady();
    expect((await utilityAppearanceActions.readSummary()).sectionLabels)
      .toEqual(['Main elements', 'Player & Seekbar', 'Selection & Hover', 'Alerts', 'Album page']);
    const initialSnapshot = await utilityAppearanceActions.readAppliedStyleSnapshot();

    await appearance.customizePlayerButton.click();
    await expect(appearance.editorHeading).toHaveText('Player & Seekbar');
    await utilityAppearanceActions.openSection('backgrounds');
    await appearance.matchPlayerButton.click();
    await expect(appearance.matchPlayerButton).toHaveAttribute('aria-pressed', 'true');
    await utilityAppearanceActions.choosePalette('paper', 1);
    const mainSticky = await utilityAppearanceActions
      .readStickyPreviewCheckpoint(appearance.mainPreviewColumn);
    expect(mainSticky.scrollTop).toBeGreaterThan(100);
    expect(mainSticky.previewTop).toBeGreaterThanOrEqual(mainSticky.viewportTop);
    expect(mainSticky.previewTop).toBeLessThanOrEqual(mainSticky.viewportTop + 24);
    expect(mainSticky.previewBottom).toBeLessThanOrEqual(mainSticky.viewportBottom);
    await utilityAppearanceActions.openSection('seekbar');
    await utilityAppearanceActions.selectSeekbarMode('default');
    await expect(appearance.playerThemeButton('midnight-blue')).toBeVisible();
    await expect(appearance.recentSetsHeading).toBeVisible();
    await expect(appearance.playerSurfaceModeButton('gradient')).toBeVisible();
    await expect(appearance.playerTabButton('controls')).toBeVisible();
    await expect(appearance.compactStyleButton('floating')).toBeVisible();
    await expect(appearance.waveformHex('fill')).toHaveCount(0);
    await expect(appearance.playerTabButton('waveform')).toHaveCount(0);

    await utilityAppearanceActions.choosePlayerTheme('midnight-blue');
    const beforeSave = await utilityAppearanceActions.readAppliedStyleSnapshot();
    expect(beforeSave.palette).toBe(initialSnapshot.palette);
    expect(beforeSave.tokens).toEqual(initialSnapshot.tokens);
    expect(beforeSave.appBar.brandLabel).toEqual(initialSnapshot.appBar.brandLabel);
  });

  await stepLogger.step('Preview every alert severity and both album states without saving preview state', async () => {
    await utilityAppearanceActions.openSection('alerts');
    await utilityAppearanceActions.selectAlertFamily('signal');
    for (const severity of ['error', 'warning', 'info']) {
      await utilityAppearanceActions.selectAlertPreviewSeverity(severity);
    }

    await utilityAppearanceActions.openSection('album-page');
    for (const layout of ['classic_bar', 'stacked_bar', 'editorial_canvas']) {
      await utilityAppearanceActions.selectAlbumLayout(layout);
    }
    await utilityAppearanceActions.selectAlbumPreviewState('missing');
    await expect(appearance.albumPreviewFileActions).toHaveCount(2);
    await expect(appearance.albumPreviewFileActions.nth(0)).toBeDisabled();
    await expect(appearance.albumPreviewFileActions.nth(1)).toBeDisabled();
    await expect(appearance.albumPreviewMissingContent).toBeVisible();
    await expect(appearance.albumPreviewPresentContent).toBeHidden();
    await utilityAppearanceActions.selectAlbumPreviewState('present');
    await expect(appearance.albumPreviewFileActions.nth(0)).toBeEnabled();
    await expect(appearance.albumPreviewFileActions.nth(1)).toBeEnabled();
    await expect(appearance.albumPreviewPresentContent).toBeVisible();
    await expect(appearance.albumPreviewMissingContent).toBeHidden();

    await utilityAppearanceActions.setAlbumPlayingRowAnimation(true);
    const animatedRow = await utilityAppearanceActions.readAlbumPlayingRowAppearance();
    expect(animatedRow.outlineColor).not.toBe('rgba(0, 0, 0, 0)');
    expect(animatedRow.perimeter.animationName).toBe('appearance-track-spectrum');
    expect(animatedRow.perimeter.backgroundImage).toContain('conic-gradient');
    expect(animatedRow.perimeter.display).not.toBe('none');
    expect(`${animatedRow.perimeter.maskComposite} ${animatedRow.perimeter.webkitMaskComposite}`)
      .toMatch(/exclude|xor/);
    expect(animatedRow.perimeter.opacity).toBe('0.55');
    expect(animatedRow.perimeter.paddingTop).toBe('1px');
    expect(animatedRow.perimeter.transform).toBe('none');

    await utilityAppearanceActions.setAlbumPlayingRowAnimation(false);
    const staticRow = await utilityAppearanceActions.readAlbumPlayingRowAppearance();
    expect(staticRow.outlineColor).toBe(animatedRow.outlineColor);
    expect(staticRow.perimeter.display).toBe('none');
    await utilityAppearanceActions.setAlbumPlayingRowAnimation(true);
  });

  await stepLogger.step('Override one value through every Player and Seekbar control group', async () => {
    await utilityAppearanceActions.openSection('seekbar');
    const matchPalette = appearance.matchPaletteButton;
    await matchPalette.click();
    await expect(matchPalette).toHaveAttribute('aria-pressed', 'true');
    const customPlayer = appearance.customPlayerColorsButton;
    await customPlayer.click();
    await expect(customPlayer).toHaveAttribute('aria-pressed', 'true');
    await utilityAppearanceActions.choosePlayerTheme('midnight-blue');
    await utilityAppearanceActions.selectPlayerSurfaceMode('solid');
    await utilityAppearanceActions.selectPlayerSurfaceMode('gradient');
    await utilityAppearanceActions.setPlayerStyleColor('surface.start', PLAYER_COLORS.surfaceStart);
    await utilityAppearanceActions.setPlayerStyleColor('surface.end', PLAYER_COLORS.surfaceEnd);
    await utilityAppearanceActions.setPlayerAngle(137);
    await utilityAppearanceActions.selectPlayerTab('controls');
    await utilityAppearanceActions.setPlayerStyleColor('controls.fill', PLAYER_COLORS.controlFill);
    await utilityAppearanceActions.setPlayerStyleColor('controls.border', PLAYER_COLORS.controlBorder);

    await utilityAppearanceActions.selectSeekbarMode('waveform');
    await expect(appearance.playerTabPanel('controls', 'player')).toBeVisible();
    await expect(appearance.playerTabPanel('waveform', 'waveform')).toBeVisible();
    await utilityAppearanceActions.selectPlayerTab('waveform');
    await utilityAppearanceActions.setWaveformColor('fill', PLAYER_COLORS.waveformFill);
    await utilityAppearanceActions.setWaveformColor('edge', PLAYER_COLORS.waveformEdge);
    await utilityAppearanceActions.selectPlayerTab('handles');
    await expect(appearance.playerTabPanel('controls', 'player')).toBeVisible();
    await expect(appearance.playerTabPanel('handles', 'waveform')).toBeVisible();
    await utilityAppearanceActions.setPlayerStyleColor('handles.color', PLAYER_COLORS.handle);
    await expect(appearance.playerLivePreview).toHaveAttribute('data-show-handles', 'true');
    await utilityAppearanceActions.selectCompactPlayerStyle('floating');
    const playerSticky = await utilityAppearanceActions
      .readStickyPreviewCheckpoint(appearance.playerPreviewDock);
    expect(playerSticky.scrollTop).toBeGreaterThan(100);
    expect(playerSticky.previewTop).toBeGreaterThanOrEqual(playerSticky.viewportTop);
    expect(playerSticky.previewTop).toBeLessThanOrEqual(playerSticky.viewportTop + 24);
    expect(playerSticky.previewBottom).toBeLessThanOrEqual(playerSticky.viewportBottom);
  });

  await stepLogger.step('Override selection accent plus all five hover and interaction states', async () => {
    await utilityAppearanceActions.openSection('selection-accent');
    await utilityAppearanceActions.setSelectionAccentEnabled(false);
    await utilityAppearanceActions.setSelectionAccentEnabled(true);
    await utilityAppearanceActions.chooseSelectionAccent('#22D3EE');
    await utilityAppearanceActions.setSelectionAccent('#A1B2C3');
    await utilityAppearanceActions.setInteractionFamily('blue');
    const preview = await utilityAppearanceActions.readPreviewStyles();
    expect(preview['navigation-hover'].backgroundColor).toBe(INTERACTION_COLORS.navigationHover);
    expect(preview['navigation-selected'].backgroundColor).toBe(INTERACTION_COLORS.navigationSelected);
    expect(preview['navigation-selected'].borderLeftColor).toBe('rgb(161, 178, 195)');
    expect(preview['item-hover-background'].backgroundColor).toBe(INTERACTION_COLORS.itemHover);
    expect(preview['item-outline'].borderColor).toBe(INTERACTION_COLORS.focus);
    expect(preview['item-outline'].outlineColor).toBe(INTERACTION_COLORS.focus);
    expect(preview['item-pressed'].backgroundColor).toBe(INTERACTION_COLORS.itemPressed);
    await utilityAppearanceActions.save();
  });

  await stepLogger.step('Apply the saved colors to real shell, navigation, and player elements', async () => {
    await expect(appearance.appBar.notificationGlyphDefaultImage).toHaveCSS('opacity', '0');
    savedSnapshot = await utilityAppearanceActions.readAppliedStyleSnapshot();
    expect(savedSnapshot).toMatchObject({
      palette: 'paper',
      mode: 'light',
      compactPlayerStyle: 'floating',
      alertFamily: 'signal',
      albumDetailsLayout: 'editorial_canvas',
      albumPlayingRowAnimation: 'enabled',
      selectionAccentColor: '#A1B2C3',
      selectionAccentWidth: '3px',
    });
    expect(savedSnapshot.tokens).toMatchObject({
      'main-surface': '#FFFFFF',
      'panel-background': '#E6E6E6',
      'player-surface-start': PLAYER_COLORS.surfaceStart,
      'player-surface-end': PLAYER_COLORS.surfaceEnd,
      'player-surface-angle': '137deg',
      play: PLAYER_COLORS.pairedControlFill,
      'player-control-border': PLAYER_COLORS.pairedControlBorder,
      'waveform-fill': PLAYER_COLORS.waveformFill,
      'waveform-edge': PLAYER_COLORS.waveformEdge,
      'player-handle': PLAYER_COLORS.handle,
      'item-hover': '#31465D',
      'item-selected': '#3F5F7E',
      'item-action-hover-background': '#27384B',
      'item-action-pressed': '#203246',
      'interaction-outline': '#86B7EF',
    });
    expect(savedSnapshot.body.backgroundColor).toBe('rgb(255, 255, 255)');
    expect(savedSnapshot.appBar.backgroundColor).toBe('rgb(230, 230, 230)');
    expect(savedSnapshot.appBar.brandArt).toEqual({ filter: 'brightness(0)', opacity: '0.78' });
    expect(savedSnapshot.appBar.brandLabel.backgroundColor).toBe('rgb(81, 161, 196)');
    expect(savedSnapshot.appBar.notificationGlyph.imageOpacity).toBe('0');
    expect(savedSnapshot.appBar.notificationGlyph.pseudoBackgroundColor).toBe('rgb(32, 33, 36)');
    expect(savedSnapshot.appBar.notificationGlyph.pseudoMaskImage).not.toBe('none');
    expect(savedSnapshot.appBar.notificationGlyph).toMatchObject({ width: '20px', height: '20px' });
    expect(savedSnapshot.navigationRail.backgroundColor).toBe('rgb(230, 230, 230)');
    expect(savedSnapshot.selectedAppearanceItem.backgroundColor).toBe(INTERACTION_COLORS.navigationSelected);
    expect(savedSnapshot.selectedAppearanceItem.boxShadow).toContain('rgb(161, 178, 195)');
    expect(savedSnapshot.player.backgroundImage).toContain('137deg');
    expect(savedSnapshot.player.backgroundImage).toContain('rgb(18, 52, 86)');
    expect(savedSnapshot.player.backgroundImage).toContain('rgb(35, 69, 103)');
    expect(savedSnapshot.playButton.backgroundColor).toBe('rgb(81, 161, 196)');
    expect(savedSnapshot.playButton.borderColor).toBe('rgb(47, 145, 209)');
    expect(savedSnapshot.timeline.accentColor).toBe('rgb(86, 120, 154)');
    expect(savedSnapshot.coverButton.borderColor).toBe('rgb(103, 137, 171)');
    expect(savedSnapshot.loopSelection.borderLeftColor).toBe('rgb(120, 154, 188)');
    expect(savedSnapshot.loopSelection.borderRightColor).toBe('rgb(120, 154, 188)');
    expect(savedSnapshot.loopSelection.backgroundColor).toMatch(
      /rgba\(120,\s*154,\s*188,\s*0\.1\)|color\(srgb\s+0\.470588\s+0\.603922\s+0\.737255\s*\/\s*0\.1\)/,
    );
    expect(savedSnapshot.loopSelection.boxShadow).toMatch(
      /rgb\(120,\s*154,\s*188\)|color\(srgb\s+0\.470588\s+0\.603922\s+0\.737255/,
    );
  });

  await stepLogger.step('Apply palette integration tokens to real shell components and Artist Family controls', async () => {
    await settingsModalAppBarActions.closeSettings();
    const galleryOptionsIdle = await galleryActions.galleryPage.readGalleryOptionsAppearance();
    expect(galleryOptionsIdle).toEqual({
      backgroundColor: 'rgb(244, 245, 246)',
      borderColor: 'rgb(184, 189, 197)',
      color: 'rgb(32, 33, 36)',
    });
    await galleryActions.galleryPage.galleryOptionsButton.hover();
    const galleryOptionsHover = await galleryActions.galleryPage.readGalleryOptionsAppearance();
    expect(galleryOptionsHover.backgroundColor).toBe(INTERACTION_COLORS.itemHover);
    expect(galleryOptionsHover.borderColor).toBe(INTERACTION_COLORS.itemBorder);

    await navigationPanelActions.selectSidebarArtistByName('Neal Morse');
    await artistFamilyActions.waitForViewReady('Neal Morse');
    await artistFamilyActions.expand();
    await artistFamilyActions.waitForPrimaryChipActive('Neal Morse');
    await artistFamilyActions.clickPrimaryChip();
    await artistFamilyActions.waitForChipActive('Neal Morse');
    const familySelected = await artistFamilyActions.artistFamily.readAppearanceCheckpoint();
    expect(familySelected.box.backgroundColor).toBe('rgb(255, 255, 255)');
    expect(familySelected.box.borderColor).toBe('rgb(184, 189, 197)');
    expect(familySelected.primary.backgroundColor).toBe(INTERACTION_COLORS.navigationSelected);
    await artistFamilyActions.artistFamily.firstInactiveChip.hover();
    await expect(artistFamilyActions.artistFamily.firstInactiveChip)
      .toHaveCSS('background-color', INTERACTION_COLORS.navigationHover);
    const familyHover = await artistFamilyActions.artistFamily.readAppearanceCheckpoint();
    expect(familyHover.firstInactive.backgroundColor).toBe(INTERACTION_COLORS.navigationHover);

    await settingsModalAppBarActions.openSettings();
    await utilityTabBarActions.openTab('appearance');
    await utilityAppearanceActions.waitForReady();
  });

  await stepLogger.step('Restore the saved complete player set from Recent sets', async () => {
    await utilityAppearanceActions.openSection('seekbar');
    await utilityAppearanceActions.selectPlayerTab('waveform');
    await utilityAppearanceActions.chooseRecentWaveformColor('fill', PLAYER_COLORS.waveformEdge);
    await utilityAppearanceActions.cancel();
    await utilityAppearanceActions.choosePlayerTheme('classic-green');
    await expect(appearance.playerStyleHex('surface.start')).not.toHaveValue(PLAYER_COLORS.surfaceStart);
    const latestSet = appearance.latestPlayerSetButton;
    await expect(latestSet).toBeVisible();
    await latestSet.click();
    await expect(appearance.playerStyleHex('surface.start')).toHaveValue(PLAYER_COLORS.surfaceStart);
    await expect(appearance.playerStyleHex('surface.end')).toHaveValue(PLAYER_COLORS.surfaceEnd);
    await expect(appearance.playerAngleInput).toHaveValue('137');
    await expect(appearance.playerSurfaceModeButton('gradient')).toHaveAttribute('aria-pressed', 'true');
    await expect(appearance.playerStyleHex('controls.fill')).toHaveValue(PLAYER_COLORS.pairedControlFill);
    await expect(appearance.playerStyleHex('controls.border')).toHaveValue(PLAYER_COLORS.pairedControlBorder);
    await expect(appearance.waveformHex('fill')).toHaveValue(PLAYER_COLORS.waveformFill);
    await expect(appearance.waveformHex('edge')).toHaveValue(PLAYER_COLORS.waveformEdge);
    await expect(appearance.playerStyleHex('handles.color')).toHaveValue(PLAYER_COLORS.handle);
    await expect(appearance.compactStyleButton('floating')).toHaveAttribute('aria-pressed', 'true');
    await expect(appearance.editorFooter.secondary.root).toBeDisabled();
  });

  await stepLogger.step('Keep other pending pages while Reset affects only Player and Seekbar', async () => {
    await utilityAppearanceActions.openSection('backgrounds');
    await utilityAppearanceActions.choosePalette('steelblue', 2);
    await utilityAppearanceActions.openSection('seekbar');
    await utilityAppearanceActions.choosePlayerTheme('soft-black');
    await appearance.editorFooter.reset.root.click();
    await expect(appearance.editorFooter.status).toHaveText('Unsaved appearance changes');
    await utilityAppearanceActions.openSection('backgrounds');
    await expect(appearance.paletteButton('steelblue')).toHaveAttribute('aria-pressed', 'true');
    await utilityAppearanceActions.cancel();
    await expect(appearance.paletteButton('paper')).toHaveAttribute('aria-pressed', 'true');
  });

  await stepLogger.step('Use theme interactions, then use Cancel to restore the saved set', async () => {
    await utilityAppearanceActions.openSection('selection-accent');
    await appearance.useThemeInteractionsButton.click();
    const interactionRoles = [
      'item_hover',
      'item_selected',
      'button_hover_background',
      'item_outline',
      'button_pressed',
    ];
    for (const role of interactionRoles) {
      await expect(appearance.interactionColorButton(role, 'blue')).toHaveAttribute('aria-pressed', 'false');
    }
    await utilityAppearanceActions.cancel();
    for (const role of interactionRoles) {
      await expect(appearance.interactionColorButton(role, 'blue')).toHaveAttribute('aria-pressed', 'true');
    }
    const restored = await utilityAppearanceActions.readPreviewStyles();
    expect(restored['navigation-hover'].backgroundColor).toBe(INTERACTION_COLORS.navigationHover);
  });

  await stepLogger.step('Use the app confirmation dialog to keep or discard an unsaved draft', async () => {
    await utilityAppearanceActions.openSection('backgrounds');
    await utilityAppearanceActions.choosePalette('black', 0);
    await utilityTabBarActions.utilityTabBar.tabByKey('rules').click();
    await expect(appearance.appConfirmDialog.overlay).toBeVisible();
    const confirmationStack = await appearance.appConfirmDialog
      .readStackingCheckpoint('#utility-modal');
    expect(confirmationStack.confirmationZIndex).toBeGreaterThan(confirmationStack.underlyingZIndex);
    expect(confirmationStack.confirmationOwnsTopElement).toBe(true);
    await expect(appearance.appConfirmDialog.message)
      .toHaveText('Your unsaved Appearance changes will be lost.');
    await expect(appearance.appConfirmDialog.cancelButton).toHaveText('Keep editing');
    await appearance.appConfirmDialog.cancelButton.click();
    await utilityTabBarActions.waitForTabActive('appearance');
    await expect(appearance.paletteButton('black')).toHaveAttribute('aria-pressed', 'true');

    await utilityTabBarActions.utilityTabBar.tabByKey('rules').click();
    await expect(appearance.appConfirmDialog.overlay).toBeVisible();
    await expect(appearance.appConfirmDialog.acceptButton).toHaveText('Discard changes');
    await appearance.appConfirmDialog.acceptButton.click();
    await utilityTabBarActions.waitForTabActive('rules');
  });

  await stepLogger.step('Reload and hydrate the same account-owned colors from Postgres', async () => {
    await page.reload();
    await galleryActions.waitForGalleryReady();
    await settingsModalAppBarActions.openSettings();
    await utilityTabBarActions.openTab('appearance');
    await utilityAppearanceActions.waitForReady();
    const reloaded = await utilityAppearanceActions.readAppliedStyleSnapshot();
    expect(reloaded.palette).toBe(savedSnapshot.palette);
    expect(reloaded.mode).toBe(savedSnapshot.mode);
    expect(reloaded.compactPlayerStyle).toBe(savedSnapshot.compactPlayerStyle);
    expect(reloaded.alertFamily).toBe(savedSnapshot.alertFamily);
    expect(reloaded.albumDetailsLayout).toBe(savedSnapshot.albumDetailsLayout);
    expect(reloaded.albumPlayingRowAnimation).toBe(savedSnapshot.albumPlayingRowAnimation);
    expect(reloaded.selectionAccentColor.toUpperCase())
      .toBe(savedSnapshot.selectionAccentColor.toUpperCase());
    expect(reloaded.tokens).toEqual(savedSnapshot.tokens);
    expect(reloaded.body.backgroundColor).toBe(savedSnapshot.body.backgroundColor);
    expect(reloaded.appBar.backgroundColor).toBe(savedSnapshot.appBar.backgroundColor);
    expect(reloaded.player.backgroundImage).toBe(savedSnapshot.player.backgroundImage);
    expect(reloaded.playButton.backgroundColor).toBe(savedSnapshot.playButton.backgroundColor);
    expect(reloaded.timeline.accentColor).toBe(savedSnapshot.timeline.accentColor);
    expect(reloaded.loopSelection.borderLeftColor).toBe(savedSnapshot.loopSelection.borderLeftColor);
    expect(reloaded.loopSelection.borderRightColor).toBe(savedSnapshot.loopSelection.borderRightColor);
    expect(reloaded.loopSelection.backgroundColor).toBe(savedSnapshot.loopSelection.backgroundColor);
  });

  await stepLogger.step('Keep a stale complete draft through a real revision conflict and retry it', async () => {
    const peerPage = await page.context().newPage();
    const peerSettings = new SettingsModalAppBarActions(new SettingsModalAppBar(peerPage));
    const peerTabs = new UtilityTabBarActions(new UtilityTabBar(peerPage));
    const peerAppearance = new UtilityAppearanceActions(new UtilityAppearanceTab(peerPage));
    try {
      await peerPage.goto(page.url());
      await expect(peerSettings.settingsModalAppBar.settingsButton).toBeVisible({ timeout: 60000 });
      await peerSettings.openSettings();
      await peerTabs.openTab('appearance');
      await peerAppearance.waitForReady();
      await peerAppearance.choosePalette('graphite', 0);

      await utilityAppearanceActions.openSection('backgrounds');
      await utilityAppearanceActions.choosePalette('navy', 0);
      await utilityAppearanceActions.save();

      await peerAppearance.utilityAppearanceTab.editorFooter.primary.root.click();
      await expect(peerAppearance.utilityAppearanceTab.requestError).toHaveText(
        'Appearance changed elsewhere. Your draft is kept; review it and try Save again.',
        { timeout: 60000 },
      );
      await expect(peerAppearance.utilityAppearanceTab.paletteButton('graphite'))
        .toHaveAttribute('aria-pressed', 'true');
      await expect(peerAppearance.utilityAppearanceTab.editorFooter.primary.root).toBeEnabled();

      await peerAppearance.utilityAppearanceTab.editorFooter.primary.root.click();
      await expect(peerAppearance.utilityAppearanceTab.editorFooter.status)
        .toHaveText('Saved to your account', { timeout: 60000 });
    } finally {
      await peerPage.close();
    }

    await page.reload();
    await galleryActions.waitForGalleryReady();
    await settingsModalAppBarActions.openSettings();
    await utilityTabBarActions.openTab('appearance');
    await utilityAppearanceActions.waitForReady();
    await expect(appearance.paletteButton('graphite')).toHaveAttribute('aria-pressed', 'true');
  });
});
