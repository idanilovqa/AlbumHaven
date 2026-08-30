import { expect, test } from '../support/performanceFixtures.js';

import {
  collectJsonResponsesDuringAction,
  expectPostgresLibraryBrowseTelemetry,
  expectTimingBudget,
  measureRulesOpen,
  measureUtilityTabSwitch,
  performanceTimingBudget,
} from '../helpers/index.js';
import { requirePostgresRuntimeEnv } from '../helpers/realAppBenchmarkHelpers.js';

const CASE_ID = 'FTC-UTIL-RULES-002P';
const RULES_PATHNAME = '/utilities/rules';
const RULES_TIMING_BUDGETS = Object.freeze({
  rules: performanceTimingBudget('utility-rules-local-managed-chrome.rulesReadyMs'),
  loops: performanceTimingBudget('utility-rules-local-managed-chrome.loopsReadyMs'),
  'log-history': performanceTimingBudget('utility-rules-local-managed-chrome.logHistoryReadyMs'),
  integrations: performanceTimingBudget('utility-rules-local-managed-chrome.integrationsReadyMs'),
  appearance: performanceTimingBudget('utility-rules-local-managed-chrome.appearanceReadyMs'),
});
const RULES_TIMING_KEYS = Object.freeze({
  rules: 'rulesReadyMs',
  loops: 'loopsReadyMs',
  'log-history': 'logHistoryReadyMs',
  integrations: 'integrationsReadyMs',
  appearance: 'appearanceReadyMs',
});

test.describe(`${CASE_ID} synthetic-large utility rules and sibling-tab UI`, () => {

  test('Rules and sibling utility tabs report library_browse telemetry and timing', async ({
    utilityAppearanceActions,
    galleryActions,
    utilityIntegrationsActions,
    utilityLogHistoryActions,
    navigationPanelActions,
    page,
    rulesFocusedLocalReport,
    settingsModalAppBarActions,
    stepLogger,
    utilityLoopsActions,
    utilityRulesActions,
    utilityTabBarActions,
  }) => {
    requirePostgresRuntimeEnv('the utility rules benchmark');

    await stepLogger.step('Warm the real app root before opening Settings > Rules', async () => {
      const timeout = 120000;
      await galleryActions.goto('/');
      await navigationPanelActions.waitForSidebarFullyHydrated({ timeout });
      await galleryActions.waitForInitialAllArtistsSections({ timeout });
      await galleryActions.waitForInitialRefreshCompleted({ timeout });
      await galleryActions.waitForVisibleGalleryCoversLoaded({ minimumCount: 2, timeout });
    });

    let rulesPayloads = [];
    const rulesApiMs = await stepLogger.step('Open Rules through the visible Settings UI', async () => {
      let timingMs = 0;
      rulesPayloads = await collectJsonResponsesDuringAction(
        page,
        (response) => new URL(response.url()).pathname === RULES_PATHNAME,
        async () => {
          timingMs = await measureRulesOpen(
            settingsModalAppBarActions,
            utilityTabBarActions,
            utilityRulesActions,
            { timeout: 120000 },
          );
        },
      );
      return timingMs;
    });
    const rulesPayload = rulesPayloads.at(-1);
    await stepLogger.step('Assert the Rules UI came from the utility projection', async () => {
      expect(rulesPayload, 'Expected a live Rules response during the visible Settings flow.').toBeTruthy();
      expectPostgresLibraryBrowseTelemetry(rulesPayload);
      expect(rulesPayload.ok).toBe(true);
      expect(Array.isArray(rulesPayload.rules)).toBe(true);
      expect(rulesPayload.rules.length).toBeGreaterThan(0);
      expect(Array.isArray(rulesPayload.ignored_version_keys)).toBe(true);
      await utilityRulesActions.expectLayoutVisible();
    });

    const secondaryTabResults = [];
    await stepLogger.step('Open every other utility tab and verify its main information', async () => {
      const tabDefinitions = [
        {
          key: 'loops',
          readyAction: (options) => utilityLoopsActions.waitForReady(options),
          readSummary: () => utilityLoopsActions.readSummary(),
          checkpointKey: 'utility-loops-ready',
          checkpointLabel: 'Utility Loops ready after switching from Rules',
          assertSummary(summary) {
            expect(
              summary.groupCount > 0 || Boolean(summary.emptyState),
              'Expected the Loops tab to show either loop groups or its empty state.',
            ).toBe(true);
          },
        },
        {
          key: 'log-history',
          readyAction: (options) => utilityLogHistoryActions.waitForReady(options),
          readSummary: () => utilityLogHistoryActions.readSummary(),
          checkpointKey: 'utility-log-history-ready',
          checkpointLabel: 'Utility Log History ready after switching from Rules',
          assertSummary(summary) {
            expect(
              summary.itemCount > 0 || Boolean(summary.emptyState),
              'Expected the Log History tab to show either history entries or its empty state.',
            ).toBe(true);
          },
        },
        {
          key: 'integrations',
          readyAction: (options) => utilityIntegrationsActions.waitForReady(options),
          readSummary: () => utilityIntegrationsActions.readSummary(),
          checkpointKey: 'utility-integrations-ready',
          checkpointLabel: 'Utility Integrations ready after switching from Rules',
          assertSummary(summary) {
            expect(summary.itemCount, 'Expected at least one Integrations list item.').toBeGreaterThan(0);
            expect(summary.detailTitle, 'Expected the Integrations detail title to render.').not.toBe('');
            expect(
              summary.hasLastfmForm || summary.libraryRootInputCount > 0,
              'Expected Integrations detail to show the Last.FM form or library settings inputs.',
            ).toBe(true);
          },
        },
        {
          key: 'appearance',
          readyAction: (options) => utilityAppearanceActions.waitForReady(options),
          readSummary: () => utilityAppearanceActions.readSummary(),
          checkpointKey: 'utility-appearance-ready',
          checkpointLabel: 'Utility Appearance ready after switching from Rules',
          assertSummary(summary) {
            expect(summary.itemCount, 'Expected the Appearance tab to show its seekbar entry.').toBeGreaterThan(0);
            expect(summary.seekbarModeCount, 'Expected both Appearance seekbar mode radios to render.').toBeGreaterThanOrEqual(2);
            expect(summary.colorInputCount, 'Expected Appearance waveform color inputs to render.').toBeGreaterThanOrEqual(2);
            expect(summary.detailTitle).toBe('Seekbar');
          },
        },
      ];

      for (const definition of tabDefinitions) {
        const readyMs = await measureUtilityTabSwitch(
          definition.key,
          utilityTabBarActions,
          definition.readyAction,
          { timeout: 120000 },
        );
        await rulesFocusedLocalReport.recordTimingCheckpoint({
          key: definition.checkpointKey,
          label: definition.checkpointLabel,
          timingMs: readyMs,
          details: {
            phase: definition.key,
          },
        });
        const timingBudget = RULES_TIMING_BUDGETS[definition.key];
        rulesFocusedLocalReport.recordTerminalTimingOutcome(
          timingBudget.metricId,
          RULES_TIMING_KEYS[definition.key],
          expectTimingBudget(
            expect.soft,
            readyMs,
            timingBudget,
            `${definition.checkpointLabel} readiness`,
          ),
        );

        const summary = await definition.readSummary();
        definition.assertSummary(summary);
        secondaryTabResults.push({
          key: definition.key,
          readyMs,
          summary,
        });
      }
    });

    await rulesFocusedLocalReport.recordTimingCheckpoint({
      key: 'rules-focused-api',
      label: 'Utility Rules UI ready',
      timingMs: rulesApiMs,
      details: {
        phase: 'focused_utility_rules',
        ruleCount: rulesPayload.rules.length,
        ignoredVersionKeyCount: rulesPayload.ignored_version_keys.length,
        persistenceBackend: rulesPayload.persistence_backend,
        persistenceSeam: rulesPayload.persistence_seam,
        viewDataSource: rulesPayload.view_data_source,
      },
    });

    rulesFocusedLocalReport.setMetricsPayload({
      rulesApiMs,
      loopsReadyMs: secondaryTabResults.find((result) => result.key === 'loops')?.readyMs || 0,
      logHistoryReadyMs: secondaryTabResults.find((result) => result.key === 'log-history')?.readyMs || 0,
      integrationsReadyMs: secondaryTabResults.find((result) => result.key === 'integrations')?.readyMs || 0,
      appearanceReadyMs: secondaryTabResults.find((result) => result.key === 'appearance')?.readyMs || 0,
      validatedTabCount: secondaryTabResults.length + 1,
      secondaryTabResults,
      ruleCount: rulesPayload.rules.length,
      ignoredVersionKeyCount: rulesPayload.ignored_version_keys.length,
      persistenceBackend: rulesPayload.persistence_backend,
      persistenceSeam: rulesPayload.persistence_seam,
      viewDataSource: rulesPayload.view_data_source,
    });
    rulesFocusedLocalReport.recordTerminalTimingOutcome(
      RULES_TIMING_BUDGETS.rules.metricId,
      RULES_TIMING_KEYS.rules,
      expectTimingBudget(
        expect.soft,
        rulesApiMs,
        RULES_TIMING_BUDGETS.rules,
        'Utility Rules UI readiness',
      ),
    );
    rulesFocusedLocalReport.recordContractCompletion();
  });
});
