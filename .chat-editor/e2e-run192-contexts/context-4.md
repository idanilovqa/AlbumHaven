# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: appearanceControls.spec.js >> FTC-APPEARANCE-001 applies every Appearance control family to real UI and preserves it across reload
- Location: tests\e2e\specs\appearanceControls.spec.js:111:1

# Error details

```
Error: expect(locator).toBeDisabled() failed

Locator:  locator('#utility-modal-footer').locator('[data-editor-footer]').locator('[data-editor-footer-action="secondary"]')
Expected: disabled
Received: enabled
Timeout:  10000ms

Call log:
  - Expect "toBeDisabled" with timeout 10000ms
  - waiting for locator('#utility-modal-footer').locator('[data-editor-footer]').locator('[data-editor-footer-action="secondary"]')
    24 × locator resolved to <button type="button" data-background-cancel="" data-ui-button-action="secondary" data-editor-footer-action="secondary" class="button ui-button ui-button--secondary ui-button--medium ui-button--quiet button-secondary">…</button>
       - unexpected value "enabled"

```

```yaml
- button "Cancel"
```

# Test source

```ts
  278 |       selectionAccentWidth: '3px',
  279 |     });
  280 |     expect(savedSnapshot.tokens).toMatchObject({
  281 |       'main-surface': '#FFFFFF',
  282 |       'panel-background': '#E6E6E6',
  283 |       'player-surface-start': PLAYER_COLORS.surfaceStart,
  284 |       'player-surface-end': PLAYER_COLORS.surfaceEnd,
  285 |       'player-surface-angle': '137deg',
  286 |       play: PLAYER_COLORS.pairedControlFill,
  287 |       'player-control-border': PLAYER_COLORS.pairedControlBorder,
  288 |       'waveform-fill': PLAYER_COLORS.waveformFill,
  289 |       'waveform-edge': PLAYER_COLORS.waveformEdge,
  290 |       'player-handle': PLAYER_COLORS.handle,
  291 |       'item-hover': '#31465D',
  292 |       'item-selected': '#3F5F7E',
  293 |       'item-action-hover-background': '#27384B',
  294 |       'item-action-pressed': '#203246',
  295 |       'interaction-outline': '#86B7EF',
  296 |     });
  297 |     expect(savedSnapshot.body.backgroundColor).toBe('rgb(255, 255, 255)');
  298 |     expect(savedSnapshot.appBar.backgroundColor).toBe('rgb(230, 230, 230)');
  299 |     expect(savedSnapshot.appBar.brandArt).toEqual({ filter: 'brightness(0)', opacity: '0.78' });
  300 |     expect(savedSnapshot.appBar.brandLabel.backgroundColor).toBe('rgb(81, 161, 196)');
  301 |     expect(savedSnapshot.appBar.notificationGlyph.imageOpacity).toBe('0');
  302 |     expect(savedSnapshot.appBar.notificationGlyph.pseudoBackgroundColor).toBe('rgb(32, 33, 36)');
  303 |     expect(savedSnapshot.appBar.notificationGlyph.pseudoMaskImage).not.toBe('none');
  304 |     expect(savedSnapshot.appBar.notificationGlyph).toMatchObject({ width: '20px', height: '20px' });
  305 |     expect(savedSnapshot.navigationRail.backgroundColor).toBe('rgb(230, 230, 230)');
  306 |     expect(savedSnapshot.selectedAppearanceItem.backgroundColor).toBe(INTERACTION_COLORS.navigationSelected);
  307 |     expect(savedSnapshot.selectedAppearanceItem.boxShadow).toContain('rgb(161, 178, 195)');
  308 |     expect(savedSnapshot.player.backgroundImage).toContain('137deg');
  309 |     expect(savedSnapshot.player.backgroundImage).toContain('rgb(18, 52, 86)');
  310 |     expect(savedSnapshot.player.backgroundImage).toContain('rgb(35, 69, 103)');
  311 |     expect(savedSnapshot.playButton.backgroundColor).toBe('rgb(81, 161, 196)');
  312 |     expect(savedSnapshot.playButton.borderColor).toBe('rgb(47, 145, 209)');
  313 |     expect(savedSnapshot.timeline.accentColor).toBe('rgb(86, 120, 154)');
  314 |     expect(savedSnapshot.coverButton.borderColor).toBe('rgb(103, 137, 171)');
  315 |     expect(savedSnapshot.loopSelection.borderLeftColor).toBe('rgb(120, 154, 188)');
  316 |     expect(savedSnapshot.loopSelection.borderRightColor).toBe('rgb(120, 154, 188)');
  317 |     expect(savedSnapshot.loopSelection.backgroundColor).toMatch(
  318 |       /rgba\(120,\s*154,\s*188,\s*0\.1\)|color\(srgb\s+0\.470588\s+0\.603922\s+0\.737255\s*\/\s*0\.1\)/,
  319 |     );
  320 |     expect(savedSnapshot.loopSelection.boxShadow).toMatch(
  321 |       /rgb\(120,\s*154,\s*188\)|color\(srgb\s+0\.470588\s+0\.603922\s+0\.737255/,
  322 |     );
  323 |   });
  324 | 
  325 |   await stepLogger.step('Apply palette integration tokens to real shell components and Artist Family controls', async () => {
  326 |     await settingsModalAppBarActions.closeSettings();
  327 |     const galleryOptionsIdle = await galleryActions.galleryPage.readGalleryOptionsAppearance();
  328 |     expect(galleryOptionsIdle).toEqual({
  329 |       backgroundColor: 'rgb(244, 245, 246)',
  330 |       borderColor: 'rgb(184, 189, 197)',
  331 |       color: 'rgb(32, 33, 36)',
  332 |     });
  333 |     await galleryActions.galleryPage.galleryOptionsButton.hover();
  334 |     const galleryOptionsHover = await galleryActions.galleryPage.readGalleryOptionsAppearance();
  335 |     expect(galleryOptionsHover.backgroundColor).toBe(INTERACTION_COLORS.itemHover);
  336 |     expect(galleryOptionsHover.borderColor).toBe(INTERACTION_COLORS.itemBorder);
  337 | 
  338 |     await navigationPanelActions.selectSidebarArtistByName('Neal Morse');
  339 |     await artistFamilyActions.waitForViewReady('Neal Morse');
  340 |     await artistFamilyActions.expand();
  341 |     await artistFamilyActions.waitForPrimaryChipActive('Neal Morse');
  342 |     await artistFamilyActions.selectOnlyChipByName('Neal Morse');
  343 |     const familySelected = await artistFamilyActions.artistFamily.readAppearanceCheckpoint();
  344 |     expect(familySelected.box.backgroundColor).toBe('rgb(255, 255, 255)');
  345 |     expect(familySelected.box.borderColor).toBe('rgb(184, 189, 197)');
  346 |     expect(familySelected.primary.backgroundColor).toBe(INTERACTION_COLORS.navigationSelected);
  347 |     await artistFamilyActions.artistFamily.firstInactiveChip.hover();
  348 |     await expect(artistFamilyActions.artistFamily.firstInactiveChip)
  349 |       .toHaveCSS('background-color', INTERACTION_COLORS.navigationHover);
  350 |     const familyHover = await artistFamilyActions.artistFamily.readAppearanceCheckpoint();
  351 |     expect(familyHover.firstInactive.backgroundColor).toBe(INTERACTION_COLORS.navigationHover);
  352 | 
  353 |     await settingsModalAppBarActions.openSettings();
  354 |     await utilityTabBarActions.openTab('appearance');
  355 |     await utilityAppearanceActions.waitForReady();
  356 |   });
  357 | 
  358 |   await stepLogger.step('Restore the saved complete player set from Recent sets', async () => {
  359 |     await utilityAppearanceActions.openSection('seekbar');
  360 |     await utilityAppearanceActions.selectPlayerTab('waveform');
  361 |     await utilityAppearanceActions.chooseRecentWaveformColor('fill', PLAYER_COLORS.waveformEdge);
  362 |     await utilityAppearanceActions.cancel();
  363 |     await utilityAppearanceActions.choosePlayerTheme('classic-green');
  364 |     await expect(appearance.playerStyleHex('surface.start')).not.toHaveValue(PLAYER_COLORS.surfaceStart);
  365 |     const latestSet = appearance.latestPlayerSetButton;
  366 |     await expect(latestSet).toBeVisible();
  367 |     await latestSet.click();
  368 |     await expect(appearance.playerStyleHex('surface.start')).toHaveValue(PLAYER_COLORS.surfaceStart);
  369 |     await expect(appearance.playerStyleHex('surface.end')).toHaveValue(PLAYER_COLORS.surfaceEnd);
  370 |     await expect(appearance.playerAngleInput).toHaveValue('137');
  371 |     await expect(appearance.playerSurfaceModeButton('gradient')).toHaveAttribute('aria-pressed', 'true');
  372 |     await expect(appearance.playerStyleHex('controls.fill')).toHaveValue(PLAYER_COLORS.pairedControlFill);
  373 |     await expect(appearance.playerStyleHex('controls.border')).toHaveValue(PLAYER_COLORS.pairedControlBorder);
  374 |     await expect(appearance.waveformHex('fill')).toHaveValue(PLAYER_COLORS.waveformFill);
  375 |     await expect(appearance.waveformHex('edge')).toHaveValue(PLAYER_COLORS.waveformEdge);
  376 |     await expect(appearance.playerStyleHex('handles.color')).toHaveValue(PLAYER_COLORS.handle);
  377 |     await expect(appearance.compactStyleButton('floating')).toHaveAttribute('aria-pressed', 'true');
> 378 |     await expect(appearance.editorFooter.secondary.root).toBeDisabled();
      |                                                          ^ Error: expect(locator).toBeDisabled() failed
  379 |   });
  380 | 
  381 |   await stepLogger.step('Keep other pending pages while Reset affects only Player and Seekbar', async () => {
  382 |     await utilityAppearanceActions.openSection('backgrounds');
  383 |     await utilityAppearanceActions.choosePalette('steelblue', 2);
  384 |     await utilityAppearanceActions.openSection('seekbar');
  385 |     await utilityAppearanceActions.choosePlayerTheme('soft-black');
  386 |     await appearance.editorFooter.reset.root.click();
  387 |     await expect(appearance.editorFooter.status).toHaveText('Unsaved appearance changes');
  388 |     await utilityAppearanceActions.openSection('backgrounds');
  389 |     await expect(appearance.paletteButton('steelblue')).toHaveAttribute('aria-pressed', 'true');
  390 |     await utilityAppearanceActions.cancel();
  391 |     await expect(appearance.paletteButton('paper')).toHaveAttribute('aria-pressed', 'true');
  392 |   });
  393 | 
  394 |   await stepLogger.step('Use theme interactions, then use Cancel to restore the saved set', async () => {
  395 |     await utilityAppearanceActions.openSection('selection-accent');
  396 |     await appearance.useThemeInteractionsButton.click();
  397 |     const interactionRoles = [
  398 |       'item_hover',
  399 |       'item_selected',
  400 |       'button_hover_background',
  401 |       'item_outline',
  402 |       'button_pressed',
  403 |     ];
  404 |     for (const role of interactionRoles) {
  405 |       await expect(appearance.interactionColorButton(role, 'blue')).toHaveAttribute('aria-pressed', 'false');
  406 |     }
  407 |     await utilityAppearanceActions.cancel();
  408 |     for (const role of interactionRoles) {
  409 |       await expect(appearance.interactionColorButton(role, 'blue')).toHaveAttribute('aria-pressed', 'true');
  410 |     }
  411 |     const restored = await utilityAppearanceActions.readPreviewStyles();
  412 |     expect(restored['navigation-hover'].backgroundColor).toBe(INTERACTION_COLORS.navigationHover);
  413 |   });
  414 | 
  415 |   await stepLogger.step('Use the app confirmation dialog to keep or discard an unsaved draft', async () => {
  416 |     await utilityAppearanceActions.openSection('backgrounds');
  417 |     await utilityAppearanceActions.choosePalette('black', 0);
  418 |     await utilityTabBarActions.utilityTabBar.tabByKey('rules').click();
  419 |     await expect(appearance.appConfirmDialog.overlay).toBeVisible();
  420 |     const confirmationStack = await appearance.appConfirmDialog
  421 |       .readStackingCheckpoint('#utility-modal');
  422 |     expect(confirmationStack.confirmationZIndex).toBeGreaterThan(confirmationStack.underlyingZIndex);
  423 |     expect(confirmationStack.confirmationOwnsTopElement).toBe(true);
  424 |     await expect(appearance.appConfirmDialog.message)
  425 |       .toHaveText('Your unsaved Appearance changes will be lost.');
  426 |     await expect(appearance.appConfirmDialog.cancelButton).toHaveText('Keep editing');
  427 |     await appearance.appConfirmDialog.cancelButton.click();
  428 |     await utilityTabBarActions.waitForTabActive('appearance');
  429 |     await expect(appearance.paletteButton('black')).toHaveAttribute('aria-pressed', 'true');
  430 | 
  431 |     await utilityTabBarActions.utilityTabBar.tabByKey('rules').click();
  432 |     await expect(appearance.appConfirmDialog.overlay).toBeVisible();
  433 |     await expect(appearance.appConfirmDialog.acceptButton).toHaveText('Discard changes');
  434 |     await appearance.appConfirmDialog.acceptButton.click();
  435 |     await utilityTabBarActions.waitForTabActive('rules');
  436 |   });
  437 | 
  438 |   await stepLogger.step('Reload and hydrate the same account-owned colors from Postgres', async () => {
  439 |     await page.reload();
  440 |     await galleryActions.waitForGalleryReady();
  441 |     await settingsModalAppBarActions.openSettings();
  442 |     await utilityTabBarActions.openTab('appearance');
  443 |     await utilityAppearanceActions.waitForReady();
  444 |     const reloaded = await utilityAppearanceActions.readAppliedStyleSnapshot();
  445 |     expect(reloaded.palette).toBe(savedSnapshot.palette);
  446 |     expect(reloaded.mode).toBe(savedSnapshot.mode);
  447 |     expect(reloaded.compactPlayerStyle).toBe(savedSnapshot.compactPlayerStyle);
  448 |     expect(reloaded.alertFamily).toBe(savedSnapshot.alertFamily);
  449 |     expect(reloaded.albumDetailsLayout).toBe(savedSnapshot.albumDetailsLayout);
  450 |     expect(reloaded.albumPlayingRowAnimation).toBe(savedSnapshot.albumPlayingRowAnimation);
  451 |     expect(reloaded.selectionAccentColor.toUpperCase())
  452 |       .toBe(savedSnapshot.selectionAccentColor.toUpperCase());
  453 |     expect(reloaded.tokens).toEqual(savedSnapshot.tokens);
  454 |     expect(reloaded.body.backgroundColor).toBe(savedSnapshot.body.backgroundColor);
  455 |     expect(reloaded.appBar.backgroundColor).toBe(savedSnapshot.appBar.backgroundColor);
  456 |     expect(reloaded.player.backgroundImage).toBe(savedSnapshot.player.backgroundImage);
  457 |     expect(reloaded.playButton.backgroundColor).toBe(savedSnapshot.playButton.backgroundColor);
  458 |     expect(reloaded.timeline.accentColor).toBe(savedSnapshot.timeline.accentColor);
  459 |     expect(reloaded.loopSelection.borderLeftColor).toBe(savedSnapshot.loopSelection.borderLeftColor);
  460 |     expect(reloaded.loopSelection.borderRightColor).toBe(savedSnapshot.loopSelection.borderRightColor);
  461 |     expect(reloaded.loopSelection.backgroundColor).toBe(savedSnapshot.loopSelection.backgroundColor);
  462 |   });
  463 | 
  464 |   await stepLogger.step('Keep a stale complete draft through a real revision conflict and retry it', async () => {
  465 |     const peerPage = await page.context().newPage();
  466 |     const peerSettings = new SettingsModalAppBarActions(new SettingsModalAppBar(peerPage));
  467 |     const peerTabs = new UtilityTabBarActions(new UtilityTabBar(peerPage));
  468 |     const peerAppearance = new UtilityAppearanceActions(new UtilityAppearanceTab(peerPage));
  469 |     try {
  470 |       await peerPage.goto(page.url());
  471 |       await expect(peerSettings.settingsModalAppBar.settingsButton).toBeVisible({ timeout: 60000 });
  472 |       await peerSettings.openSettings();
  473 |       await peerTabs.openTab('appearance');
  474 |       await peerAppearance.waitForReady();
  475 |       await peerAppearance.choosePalette('graphite', 0);
  476 | 
  477 |       await utilityAppearanceActions.openSection('backgrounds');
  478 |       await utilityAppearanceActions.choosePalette('navy', 0);
```