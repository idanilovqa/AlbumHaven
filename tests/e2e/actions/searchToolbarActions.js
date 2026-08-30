import { expect } from '@playwright/test';

export class SearchToolbarActions {
  constructor(searchToolbar) {
    this.searchToolbar = searchToolbar;
  }

  async waitForVisible(options = {}) {
    await this.searchToolbar.waitForVisible(
      this.searchToolbar.input,
      { timeout: options.timeout || 30000 },
    );
  }

  async search(query, options = {}) {
    await this.searchToolbar.input.fill(query);
    if (options.submitWithEnter) {
      if (typeof options.recordSubmissionBoundary === 'function') {
        await options.recordSubmissionBoundary();
      }
      await this.searchToolbar.input.press('Enter');
      return;
    }
    if (options.clickApply) {
      if (typeof options.recordSubmissionBoundary === 'function') {
        options.recordSubmissionBoundary();
      }
      await this.searchToolbar.applyButton.click();
    }
  }

  async settleDebouncedPrefixesThenSubmit(query, prefixes, options = {}) {
    const completedQuery = String(query || '');
    for (const prefix of prefixes) {
      const typedPrefix = String(prefix || '');
      await this.searchToolbar.input.fill(typedPrefix);
      await this.waitForQuery(typedPrefix, options);
    }
    if (await this.searchToolbar.input.inputValue() !== completedQuery) {
      await this.searchToolbar.input.fill(completedQuery);
      await this.waitForQuery(completedQuery, options);
    }
    await this.searchToolbar.input.press('Enter');
    await this.waitForQuery(completedQuery, options);
  }

  async searchAndReadViewDataPayload(query, options = {}) {
    const expectedQuery = String(query || '').trim();
    const responsePromise = this.searchToolbar.page.waitForResponse((response) => {
      if (response.request().method() !== 'GET' || !response.ok()) return false;
      const url = new URL(response.url());
      return url.pathname === '/view-data'
        && String(url.searchParams.get('q') || '').trim() === expectedQuery;
    });
    await this.search(expectedQuery, options);
    const response = await responsePromise;
    return response.json();
  }

  async clearSearch(options = {}) {
    await this.searchToolbar.input.fill('');
    if (options.submitWithEnter) {
      await this.searchToolbar.input.press('Enter');
      return;
    }
    if (options.clickApply) {
      await this.searchToolbar.applyButton.click();
    }
  }

  async clearSearchByInputDebounce(options = {}) {
    await this.searchToolbar.input.fill('');
    await expect(this.searchToolbar.recentSearchPopover).toBeHidden({
      timeout: options.popoverTimeout || 1000,
    });
    await this.waitForQuery('', options);
  }

  async enterLiteralSpace(options = {}) {
    await this.searchToolbar.input.fill('');
    await this.searchToolbar.input.press('Space');
    await expect(this.searchToolbar.input).toHaveValue(' ', {
      timeout: options.timeout || 30000,
    });
  }

  async clearSearchAndObserveStableGallery(options = {}) {
    await this.searchToolbar.input.focus();
    const transitionObservation = await this.searchToolbar
      .startSearchClearTransitionObservation();
    try {
      await this.clearSearch(options);
      await this.searchToolbar.waitForLocalSearchClearSettled(
        transitionObservation,
        options,
      );
      return await transitionObservation.finish();
    } catch (error) {
      await transitionObservation.finish();
      throw error;
    }
  }

  async observeMountedGalleryTransition(action, settle) {
    const transitionObservation = await this.searchToolbar
      .startSearchClearTransitionObservation();
    try {
      await action();
      await settle();
      // parity-check: allow-read-only-measurement-evaluate -- two paints capture transient loader visibility after a local gallery action
      await this.searchToolbar.page.evaluate(() => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }));
      return await transitionObservation.finish();
    } catch (error) {
      await transitionObservation.finish();
      throw error;
    }
  }

  async waitForQuery(expectedQuery, options = {}) {
    await this.searchToolbar.waitForQuerySettled(expectedQuery, options);
  }

  async waitForUrlWithoutQueryParameter(parameterName, options = {}) {
    const expectedParameterName = String(parameterName || '').trim();
    await this.searchToolbar.page.waitForURL((url) => (
      !url.searchParams.has(expectedParameterName)
    ), {
      timeout: options.timeout || 10000,
    });
  }

  async waitForDefaultRootUrl(options = {}) {
    await this.searchToolbar.page.waitForURL((url) => (
      url.pathname === '/'
      && [...url.searchParams.keys()].length === 0
    ), {
      timeout: options.timeout || 30000,
    });
  }

  readLocation() {
    const url = new URL(this.searchToolbar.page.url());
    return {
      pathname: url.pathname,
      search: url.search,
    };
  }

  readCanonicalSearchState(options = {}) {
    return this.searchToolbar.readCanonicalSearchState(options);
  }

  async expectBrowserAutocompleteDisabled() {
    await expect(this.searchToolbar.input).toHaveAttribute('autocomplete', 'off');
  }

  async openRecentSearches() {
    await this.searchToolbar.input.click();
    await expect(this.searchToolbar.recentSearchPopover).toBeVisible();
    await expect(this.searchToolbar.input).toHaveAttribute('aria-expanded', 'true');
  }

  async expectNoRecentSearches() {
    await this.searchToolbar.input.click();
    await expect(this.searchToolbar.recentSearchOptions).toHaveCount(0);
    await this.expectRecentSearchesDismissed();
  }

  async readRecentSearchQueries() {
    return (await this.searchToolbar.recentSearchOptions.allTextContents())
      .map((query) => String(query || '').trim())
      .filter(Boolean);
  }

  async selectRecentSearchWithMouse(query) {
    await this.searchToolbar.recentSearchOption(query).click();
    await this.expectRecentSearchesDismissed();
  }

  async selectRecentSearchWithKeyboard(expectedActiveQueries) {
    for (const query of expectedActiveQueries) {
      const option = this.searchToolbar.recentSearchOption(query);
      const optionId = await option.getAttribute('id');
      if (!optionId) {
        throw new Error(`Recent-search option "${query}" requires an id for aria-activedescendant.`);
      }
      await this.searchToolbar.input.press('ArrowDown');
      await expect(this.searchToolbar.input).toHaveAttribute('aria-activedescendant', optionId);
      await expect(option).toHaveAttribute('aria-selected', 'true');
    }
    await this.searchToolbar.input.press('Enter');
    await this.expectRecentSearchesDismissed();
  }

  async expectRecentSearchesDismissed() {
    await expect(this.searchToolbar.recentSearchPopover).toBeHidden();
    await expect(this.searchToolbar.input).toHaveAttribute('aria-expanded', 'false');
    await expect(this.searchToolbar.input).not.toHaveAttribute('aria-activedescendant', /.+/);
  }

  async reloadCurrentView() {
    await this.searchToolbar.page.reload();
  }

  async dismissRecentSearchesWithEscape() {
    await this.searchToolbar.input.press('Escape');
    await this.expectRecentSearchesDismissed();
  }

  async dismissRecentSearchesWithEnter() {
    await this.searchToolbar.input.press('Enter');
    await this.expectRecentSearchesDismissed();
  }

  async dismissRecentSearchesWithTab() {
    await this.searchToolbar.input.press('Tab');
    await this.expectRecentSearchesDismissed();
  }

  async dismissRecentSearchesWithFocusLoss() {
    await this.searchToolbar.applyButton.focus();
    await expect(this.searchToolbar.input).not.toBeFocused();
    await this.expectRecentSearchesDismissed();
  }

  async dismissRecentSearchesWithOutsideClick() {
    await this.searchToolbar.mainContent.click({ position: { x: 4, y: 4 } });
    await this.expectRecentSearchesDismissed();
  }

  async readRecentSearchGeometry() {
    await expect(this.searchToolbar.input).toBeVisible();
    await expect(this.searchToolbar.recentSearchPopover).toBeVisible();
    const [input, popover] = await Promise.all([
      this.searchToolbar.input.boundingBox(),
      this.searchToolbar.recentSearchPopover.boundingBox(),
    ]);
    if (!input || !popover) {
      throw new Error('Recent-search geometry requires visible input and popover bounds.');
    }
    return { input, popover };
  }

  async expectRecentSearchControlScreenshot(name, options = {}) {
    const { input, popover } = await this.readRecentSearchGeometry();
    const viewport = this.searchToolbar.page.viewportSize();
    if (!viewport) {
      throw new Error('Recent-search screenshot requires a fixed viewport.');
    }
    const margin = Number(options.margin ?? 4);
    const left = Math.max(0, Math.floor(Math.min(input.x, popover.x) - margin));
    const top = Math.max(0, Math.floor(Math.min(input.y, popover.y) - margin));
    const right = Math.min(
      viewport.width,
      Math.ceil(Math.max(input.x + input.width, popover.x + popover.width) + margin),
    );
    const bottom = Math.min(
      viewport.height,
      Math.ceil(Math.max(input.y + input.height, popover.y + popover.height) + margin),
    );
    await expect(this.searchToolbar.page).toHaveScreenshot(name, {
      animations: 'disabled',
      clip: {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
      },
      maxDiffPixels: 0,
      threshold: 0,
    });
  }
}
