from pathlib import Path
root=Path.cwd()
def replace(file, old, new, count=1):
 p=root/file;s=p.read_text();assert s.count(old)==count,(file,s.count(old),old[:100]);p.write_text(s.replace(old,new))
replace('tests/e2e/poms/trackModal.js', '    this.dialog = page.locator(this.dialogSelector);', '    this.dialog = page.locator(this.dialogSelector);\n    this.trackTable = new AlbumTrackTable(this.dialog);')
replace('music_app/static/js/button-component.js', '  const api = { renderButton, renderActionButton, renderIconSvg };', '''  function setDisabled(element, disabled) {
    element.disabled = Boolean(disabled);
    element.setAttribute('aria-disabled', String(element.disabled));
  }

  const api = { renderButton, renderActionButton, renderIconSvg, setDisabled };''')
replace('music_app/static/js/runtime/utility-list-builders.js', "    apply.disabled = !getSelectedProblematicAlbum()?.allowed_actions?.['library.files.edit_tags'] || !getApplicableProblemSuggestions().length || Boolean(state.utility.proposalApplyBusy);", "    ButtonComponent.setDisabled(apply, !getSelectedProblematicAlbum()?.allowed_actions?.['library.files.edit_tags'] || !getApplicableProblemSuggestions().length || Boolean(state.utility.proposalApplyBusy));")
replace('music_app/static/js/runtime/utility-list-builders.js', "  if (action) action.disabled = !getIgnoredRepairRowKeys().length || !getSelectedProblematicAlbum()?.allowed_actions?.['library.rules.manage'];", "  if (action) ButtonComponent.setDisabled(action, !getIgnoredRepairRowKeys().length || !getSelectedProblematicAlbum()?.allowed_actions?.['library.rules.manage']);")
replace('music_app/static/js/runtime/core-state-and-helpers.js', '''  const canBrowseScanned = shouldShow && !hasSearch
    && !pendingViewTransition
    && (
      finalizingActiveScan
      || shouldOfferBrowseScannedLibraryAction(state.view, data, state.awaitingInitialDataRefresh)
    );''', '''  // The dedicated page hides, but deliberately retains, the previous gallery and
  // query. Its Browse action must not wait for that retained view to become empty.
  const retainedBrowseAvailable = scanPageVisible
    && (scanBusy || relBusy || state.awaitingInitialDataRefresh)
    && Number(state.view?.album_count || 0) > 0;
  const canBrowseScanned = shouldShow && (scanPageVisible || !hasSearch)
    && !pendingViewTransition
    && (
      finalizingActiveScan
      || retainedBrowseAvailable
      || shouldOfferBrowseScannedLibraryAction(scanPageVisible ? {} : state.view, data, state.awaitingInitialDataRefresh)
    );''')
replace('tests/e2e/actions/utilityAppearanceActions.js', '''    await this.utilityAppearanceTab.waitForPageCondition((expected) => {
      const selected = document.querySelector(expected.selector);
      return selected instanceof HTMLInputElement
        && selected.checked
        && state.player?.appearance?.seekbarMode === expected.mode;
    }, { timeout: 60000 }, {
      mode: normalized,
      selector: this.utilityAppearanceTab.seekbarModeSelectorFor(normalized),
    });''', '''    await expect(input).toBeChecked();
  }

  async saveSeekbarMode(mode) {
    const normalized = mode === 'waveform' ? 'waveform' : 'default';
    await this.selectSeekbarMode(normalized);
    // Selection is a draft; playback changes only through the shared Save action.
    if (await this.utilityAppearanceTab.editorFooter.primary.root.isEnabled()) await this.save();
    await expect(this.utilityAppearanceTab.globalPlayer).toHaveAttribute(
      'data-player-seekbar-presentation', normalized === 'waveform' ? 'waveform' : 'regular',
    );''')
for f in ['tests/e2e/performance/gaplessPlayback.spec.js','tests/e2e/specs/loops.functional.spec.js','tests/e2e/specs/playerViewModes.spec.js']:
 p=root/f;s=p.read_text();assert 'utilityAppearanceActions.selectSeekbarMode(' in s;p.write_text(s.replace('utilityAppearanceActions.selectSeekbarMode(', 'utilityAppearanceActions.saveSeekbarMode('))
replace('tests/js/e2e-action-production-paths.test.js', r"utilityAppearanceActions\.selectSeekbarMode\('waveform'\)", r"utilityAppearanceActions\.saveSeekbarMode\('waveform'\)")
replace('tests/e2e/actions/utilityLogHistoryActions.js', '    const emptyState = this.utilityLogHistoryTab.mainBody.emptyState;', '    const emptyState = this.utilityLogHistoryTab.emptySnapshot;')
replace('tests/e2e/poms/utilityLogHistoryTab.js', "    this.console = page.locator('#utility-problematic-detail .console-log');", "    this.console = page.locator('#utility-problematic-detail .console-log');\n    this.emptySnapshot = this.console.getByText('No events in this snapshot.', { exact: true });")
replace('tests/e2e/actions/globalPlayerActions.js', '''    if (target === 'cancel') {
      await expect(locator).toHaveCSS('color', 'rgb(239, 68, 68)');
    } else if (target === 'create') {
      const themedPlayerInk = await this.globalPlayer.readThemedPlayerInkColor();
      await expect(locator).toHaveCSS(
        'color',
        themedPlayerInk.active ? themedPlayerInk.color : 'rgb(74, 222, 128)',
      );
    }''', '''    if (target === 'cancel' || target === 'create') {
      const semanticColor = await this.globalPlayer.readLoopActionHoverColor(target);
      await expect(locator).toHaveCSS('color', semanticColor);
    }''')
replace('tests/e2e/poms/globalPlayer.js', '''  async readThemedPlayerInkColor() {
    // parity-check: allow-read-only-measurement-evaluate -- read the production player theme boundary
    return this.player.evaluate((player) => ({
      active: document.documentElement.hasAttribute('data-appearance-player'),
      color: getComputedStyle(player).color,
    }));
  }''', r'''  async readLoopActionHoverColor(target) {
    // parity-check: allow-read-only-measurement-evaluate -- read the shared semantic token independently of the action's painted color
    return this.loopAction.evaluate((root, action) => {
      const token = action === 'cancel' ? '--loop-action-cancel-color' : '--loop-action-save-color';
      const value = getComputedStyle(root).getPropertyValue(token).trim();
      const hex = /^#([\da-f]{3}|[\da-f]{6})$/iu.exec(value);
      if (hex) {
        const digits = hex[1].length === 3 ? [...hex[1]].map(digit => digit + digit).join('') : hex[1];
        const channels = [0, 2, 4].map(offset => Number.parseInt(digits.slice(offset, offset + 2), 16));
        return `rgb(${channels.join(', ')})`;
      }
      if (/^rgba?\(/u.test(value)) return value;
      throw new Error(`Expected a resolved semantic loop color for ${token}; received ${value}`);
    }, target);
  }''')
replace('tests/e2e/poms/utilityProblematicFilesTab.js', '''    this.detailDetectedProblemsSection = page.locator('[data-utility-section-toggle="detected"]').first();
    this.detailSuggestedEditsSection = page.locator('[data-utility-section-toggle="suggested"]').first();''', r'''    this.noTrackProblems = page.locator('#utility-problematic-detail .utility-detail-meta').filter({
      hasText: /^(Only album-level problems found\. )?No per-track problems( found| match the selected filters)?\.$/u,
    });''')
replace('tests/e2e/actions/utilityProblematicFilesActions.js', '''    await this.utilityProblematicFilesTab.waitForVisible(this.utilityProblematicFilesTab.detailDetectedProblemsSection);
    if (await this.utilityProblematicFilesTab.detailSuggestedEditsSection.count()) {
      await this.utilityProblematicFilesTab.waitForVisible(this.utilityProblematicFilesTab.detailSuggestedEditsSection);
    }''', '''    await this.utilityProblematicFilesTab.waitForVisible(this.utilityProblematicFilesTab.detectedProblemsHeading);
    if (await this.utilityProblematicFilesTab.trackProblemsTable.count()) {
      await this.utilityProblematicFilesTab.waitForVisible(this.utilityProblematicFilesTab.trackProblemsTable);
      const headers = await this.utilityProblematicFilesTab.trackProblemHeaders.allTextContents();
      assert.deepEqual(headers.map(text => text.trim()), ['Track / file', 'Problems', 'Suggested edits']);
    } else {
      await this.utilityProblematicFilesTab.waitForVisible(this.utilityProblematicFilesTab.noTrackProblems);
    }''')
replace('tests/e2e/phase7/admin-management/adminManagement.spec.js', "  'View operational logs',\n  'View virtual discography',", "  'View operational logs',\n  'Export operational logs',\n  'View virtual discography',")
replace('tests/e2e/phase7/admin-management/adminManagement.spec.js', "  await expect(menu.settingsMenuItem).toBeFocused();\n  await menu.adminPanelMenuItem.hover();", "  await expect(menu.settingsMenuItem).not.toBeFocused();\n  await menu.settingsButton.press('Escape');\n  await expect(menu.accountMenu).toBeHidden();\n  await menu.settingsButton.press('ArrowDown');\n  await expect(menu.accountMenu).toBeVisible();\n  await expect(menu.settingsMenuItem).toBeFocused();\n  await menu.adminPanelMenuItem.hover();")
replace('tests/e2e/specs/searchTreeCorrectness.spec.js', '''  await stepLogger.step('Selecting a different primary artist clears search and restores its complete gallery', async () => {
    await navigationPanelActions.selectSidebarArtistByName(FAMILY_ARTIST);
    await searchToolbarActions.waitForQuery('');''', '''  await stepLogger.step('Selecting a different primary artist preserves the query until explicit Clear restores its complete gallery', async () => {
    await navigationPanelActions.selectSidebarArtistByName(FAMILY_ARTIST);
    await searchToolbarActions.waitForQuery(TRANSATLANTIC_QUERY);
    await galleryActions.waitForSelectedArtistGallery(FAMILY_ARTIST, { queryValue: TRANSATLANTIC_QUERY });
    expect(await galleryActions.readAlbumNamesByHeading(FAMILY_ARTIST)).toEqual([TRANSATLANTIC_NEAL_ALBUM]);
    expect(await galleryActions.readArtistHeadings()).toEqual([FAMILY_ARTIST]);
    await searchToolbarActions.clearSearch();
    await searchToolbarActions.waitForQuery('');''')
replace('tests/e2e/scanPerformance/scanPerformance.spec.js', "      // Selecting a different primary artist clears search under the approved Gallery contract.\n      await searchToolbarActions.waitForQuery('', { timeout: 60000 });", "      // Primary-artist navigation preserves the committed query and its filtered tree.\n      await searchToolbarActions.waitForQuery(BACKGROUND_BROWSE_QUERY, { timeout: 60000 });")
p=root/'tests/e2e/scanPerformance/scanPerformance.spec.js';s=p.read_text();a=s.index("    await stepLogger.step('Reopen Scan Page and choose Artist 002");b=s.index('    const browseContinuityObservation',a);x=s[a:b];assert x.count("queryValue: '',")==1;s=s[:a]+x.replace("queryValue: '',",'queryValue: BACKGROUND_BROWSE_QUERY,')+s[b:];p.write_text(s)
replace('tests/e2e/poms/utilityLogHistoryTab.js', "    this.periodDialog = page.getByRole('dialog', { name: 'Filter log period', exact: true });", "    this.periodDialog = page.getByRole('dialog', { name: 'Date range', exact: true });\n    this.periodFrom = this.periodDialog.getByRole('textbox', { name: 'From date', exact: true });\n    this.periodTo = this.periodDialog.getByRole('textbox', { name: 'To date', exact: true });")
replace('tests/e2e/specs/loops.functional.spec.js', "  await history.periodDialog.getByRole('button', { name: 'Today', exact: true }).click();", r"""  // The shared calendar opens with today's start/end; presets belong to Export all logs.
  await expect(history.periodFrom).toHaveValue(/^\d{4}-\d{2}-\d{2}$/u);
  await expect(history.periodTo).toHaveValue(await history.periodFrom.inputValue());""")
replace('tests/e2e/poms/settingsIntegrations.js', '    this.save = this.detail.getByRole', "    this.watcherWarning = page.locator('#toast-layer .system-warning-notification').filter({ hasText: 'Library watcher needs attention' });\n    this.dismissWatcherWarning = this.watcherWarning.getByRole('button', { name: 'Dismiss', exact: true });\n    this.save = this.detail.getByRole")
replace('tests/e2e/poms/settingsIntegrations.js', "  async saveResult() {\n    const pending = this.page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/library-settings');\n    await this.save.click();\n    const response = await pending;", "  async acknowledgeUnavailableRootWarning() {\n    await expect(this.watcherWarning).toBeVisible();\n    await this.dismissWatcherWarning.click();\n    await expect(this.watcherWarning).toBeHidden();\n  }\n  async saveResult() {\n    const [response] = await Promise.all([\n      this.page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/library-settings'),\n      this.save.click(),\n    ]);")
replace('tests/e2e/specs/settingsIntegrations.functional.spec.js', "      expect(await ui.readSettings()).toEqual(saved);\n    });", "      expect(await ui.readSettings()).toEqual(saved);\n      // Making the saved root unavailable intentionally raises the persistent warning.\n      // Acknowledge it as a user before further Settings actions or reload.\n      await ui.acknowledgeUnavailableRootWarning();\n    });")
print('Recovered prior runtime and E2E repair batch')
