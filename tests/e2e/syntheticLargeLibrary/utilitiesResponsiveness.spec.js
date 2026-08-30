import { expect, test } from '../support/performanceFixtures.js';

import {
  buildBenchmarkValidationPayload,
  collectJsonResponsesDuringAction,
  evaluateUtilityRulesLocalBenchmark,
  expectPostgresLibraryBrowseTelemetry,
  logBenchmarkTimingResults,
  measureRulesOpen,
  measureUtilityTabSwitch,
  summarizePeakBytes,
  waitForUtilitiesBenchmarkWarmRoot,
} from '../helpers/index.js';
import { requirePostgresRuntimeEnv } from '../helpers/realAppBenchmarkHelpers.js';

const RULES_CASE_ID = 'FTC-UTIL-RULES-002';
const RULES_PATHNAME = '/utilities/rules';

test.describe(`${RULES_CASE_ID} synthetic-large utilities rules and sibling-tab responsiveness`, () => {

  test(`${RULES_CASE_ID} warmed Rules and the other utility tabs stay responsive and render their main information`, async ({
    galleryActions,
    navigationPanelActions,
    page,
    settingsModalAppBarActions,
    stepLogger,
    utilityAppearanceActions,
    utilityIntegrationsActions,
    utilityLogHistoryActions,
    utilityLoopsActions,
    utilityRulesActions,
    utilityRulesLocalReport,
    utilityTabBarActions,
  }) => {
    requirePostgresRuntimeEnv('the Rules benchmark');
    await galleryActions.goto();

    await stepLogger.step('Warm the root browse before opening Utilities into Rules', async () => {
      await waitForUtilitiesBenchmarkWarmRoot(galleryActions, navigationPanelActions);
    });

    let rulesPayloads = [];
    const rulesReadyMs = await stepLogger.step('Open Settings and switch directly into Rules', async () => {
      let timingMs = 0;
      rulesPayloads = await collectJsonResponsesDuringAction(
        page,
        (response) => new URL(response.url()).pathname === RULES_PATHNAME,
        async () => {
          timingMs = await measureRulesOpen(
            settingsModalAppBarActions,
            utilityTabBarActions,
            utilityRulesActions,
          );
        },
      );
      await utilityRulesLocalReport.recordTimingCheckpoint({
        key: 'rules-ready',
        label: 'Rules ready after opening Settings',
        timingMs,
      });
      return timingMs;
    });

    const rulesSummary = await stepLogger.step('Verify the Rules tab layout and selected rule detail', async () => {
      const rulesPayload = rulesPayloads.at(-1);
      expect(rulesPayload, 'Expected a live Rules response during the visible Settings flow.').toBeTruthy();
      expectPostgresLibraryBrowseTelemetry(rulesPayload);
      expect(Array.isArray(rulesPayload.rules)).toBe(true);
      expect(rulesPayload.rules.length).toBeGreaterThan(0);
      await utilityRulesActions.expectLayoutVisible();
      const summary = await utilityRulesActions.readSelectedRuleSummary();
      expect(summary.title, 'Expected the Rules detail title to render.').not.toBe('');
      expect(summary.description, 'Expected the Rules detail description to render.').not.toBe('');
      return summary;
    });

    const rulesMemory = await stepLogger.step('Sample idle memory after Rules becomes ready', async () => (
      utilityRulesLocalReport.recordPeakMemoryCheckpoint({
        key: 'rules-memory',
        label: 'Rules idle memory after initial load',
        details: {
          phase: 'rules_ready',
        },
      })
    ));

    const secondaryTabResults = [];
    await stepLogger.step('Open every other utility tab and verify its main information', async () => {
      const tabDefinitions = [
        {
          key: 'loops',
          readyAction: (options) => utilityLoopsActions.waitForReady(options),
          readSummary: () => utilityLoopsActions.readSummary(),
          checkpointKey: 'loops-ready',
          checkpointLabel: 'Loops ready after switching from Rules',
          memoryKey: 'loops-memory',
          memoryLabel: 'Loops idle memory after ready',
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
          checkpointKey: 'log-history-ready',
          checkpointLabel: 'Log History ready after switching from Rules',
          memoryKey: 'log-history-memory',
          memoryLabel: 'Log History idle memory after ready',
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
          checkpointKey: 'integrations-ready',
          checkpointLabel: 'Integrations ready after switching from Rules',
          memoryKey: 'integrations-memory',
          memoryLabel: 'Integrations idle memory after ready',
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
          checkpointKey: 'appearance-ready',
          checkpointLabel: 'Appearance ready after switching from Rules',
          memoryKey: 'appearance-memory',
          memoryLabel: 'Appearance idle memory after ready',
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
        );
        await utilityRulesLocalReport.recordTimingCheckpoint({
          key: definition.checkpointKey,
          label: definition.checkpointLabel,
          timingMs: readyMs,
        });

        const summary = await definition.readSummary();
        definition.assertSummary(summary);

        const memorySummary = await utilityRulesLocalReport.recordPeakMemoryCheckpoint({
          key: definition.memoryKey,
          label: definition.memoryLabel,
          details: {
            phase: definition.key,
          },
        });

        secondaryTabResults.push({
          key: definition.key,
          readyMs,
          summary,
          memorySummary,
        });
      }
    });

    await stepLogger.step('Close Settings cleanly after the Rules tab pass', async () => {
      await settingsModalAppBarActions.closeSettings();
    });

    const rawMetrics = {
      rulesReadyMs,
      rulesSummary,
      rulesCount: Number(await utilityRulesActions.utilityRulesTab.sidebar.count.textContent() || 0),
      rulesMemory,
      loopsReadyMs: secondaryTabResults.find((result) => result.key === 'loops')?.readyMs || 0,
      logHistoryReadyMs: secondaryTabResults.find((result) => result.key === 'log-history')?.readyMs || 0,
      integrationsReadyMs: secondaryTabResults.find((result) => result.key === 'integrations')?.readyMs || 0,
      appearanceReadyMs: secondaryTabResults.find((result) => result.key === 'appearance')?.readyMs || 0,
      peakTabMemoryBytes: summarizePeakBytes([
        rulesMemory,
        ...secondaryTabResults.map((result) => result.memorySummary),
      ]),
      validatedTabCount: secondaryTabResults.length + 1,
      secondaryTabResults,
    };

    const benchmarkEvaluation = evaluateUtilityRulesLocalBenchmark(rawMetrics);
    logBenchmarkTimingResults(benchmarkEvaluation);
    utilityRulesLocalReport.setMetricsPayload({
      ...rawMetrics,
      benchmarkValidation: buildBenchmarkValidationPayload(benchmarkEvaluation),
      benchmark: benchmarkEvaluation.benchmark,
      benchmarkResults: benchmarkEvaluation.results,
      benchmarkFailures: benchmarkEvaluation.failures,
    });
    expect(benchmarkEvaluation.failures, benchmarkEvaluation.failures.join('\n')).toEqual([]);
  });
});
