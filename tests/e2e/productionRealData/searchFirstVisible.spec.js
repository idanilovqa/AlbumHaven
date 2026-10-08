import { createRequire } from 'node:module';

import { expect, test as base } from '../support/baseFixtures.js';
import {
  PRODUCTION_SEARCH_FIRST_VISIBLE_BUDGET,
  availableTiming,
  calculateProductionSearchPhaseDurations,
  classifyProductionSearchFirstVisible,
  isProductionSearchHostTelemetryRequest,
  readProductionSearchReadiness,
} from '../helpers/productionSearchBenchmark.js';
import { readProductionSearchStorageState } from '../support/productionSearchAuthentication.js';

const require = createRequire(import.meta.url);
const { readProductionSearchDatabaseAttestation } = require(
  '../support/productionSearchBenchmarkGuard.cjs',
);

const CASE_ID = 'FTC-GALLERY-STARTUP-005P';
const ALLOWED_ORIGIN = 'https://sandbox1.albumhaven.org';
const SEARCHES = Object.freeze([
  { query: 'Devin', expectedArtist: 'Devin Townsend' },
  { query: 'Neal Morse', expectedArtist: 'Neal Morse' },
]);

const test = base.extend({
  storageState: async ({}, use) => {
    await use(readProductionSearchStorageState());
  },
});

test.use({
  requestInterceptionGuardEnabled: false,
  reuseAuthentication: false,
});

test.describe(`${CASE_ID} production-backed read-only search`, () => {
  for (const scenario of SEARCHES) {
    test(`${scenario.query} submit to first expected album visible`, async ({
      context,
      galleryActions,
      page,
      searchToolbarActions,
    }, testInfo) => {
      const forbiddenRequests = [];
      const hostTelemetryRequests = [];
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (!['http:', 'https:'].includes(url.protocol)) return;
        if (isProductionSearchHostTelemetryRequest({
          method: request.method(),
          url,
          allowedOrigin: ALLOWED_ORIGIN,
        })) return;
        if (!['GET', 'HEAD'].includes(request.method()) || url.origin !== ALLOWED_ORIGIN) {
          forbiddenRequests.push({
            method: request.method(),
            origin: url.origin,
            pathname: url.pathname,
          });
        }
      });

      await galleryActions.goto('/?surface=albums');
      await expect(page).not.toHaveURL(/\/login(?:\?|$)/u);
      await searchToolbarActions.waitForVisible({ timeout: 120000 });
      const expectedDatabaseIdentityProof = readProductionSearchDatabaseAttestation()
        .databaseIdentityProof;
      const readiness = await galleryActions.waitForStatusResult(
        (statusPayload) => readProductionSearchReadiness(
          statusPayload,
          expectedDatabaseIdentityProof,
        ),
        { timeout: 120000 },
      );

      const result = await galleryActions.measureSearchFirstVisible(
        searchToolbarActions,
        scenario.query,
        { expectedArtist: scenario.expectedArtist, timeout: 120000 },
      );
      const classification = classifyProductionSearchFirstVisible(result.elapsedMs);
      const phaseDurations = calculateProductionSearchPhaseDurations(result);
      const metrics = {
        caseId: CASE_ID,
        query: scenario.query,
        budget: PRODUCTION_SEARCH_FIRST_VISIBLE_BUDGET,
        classification,
        hostTelemetryRequests,
        readiness,
        timing: {
          api: availableTiming(result.responseDurationMs),
          browserProcessing: availableTiming(phaseDurations.browserProcessingMs),
          render: availableTiming(phaseDurations.renderMs),
          responseToFirstVisible: availableTiming(phaseDurations.responseToFirstVisibleMs),
          submitToFirstVisible: availableTiming(phaseDurations.submitToFirstVisibleMs),
        },
      };

      expect(result.directSearchMatch, `${scenario.query} must be a direct search match.`)
        .toBe(true);
      expect(result.generationAfter.requestGeneration)
        .toBeGreaterThan(result.generationBefore.requestGeneration);
      expect(result.generationAfter.renderGeneration)
        .toBeGreaterThan(result.generationBefore.renderGeneration);
      expect(forbiddenRequests, 'Benchmark attempted a forbidden method or origin.').toEqual([]);
      testInfo.annotations.push({
        type: 'production-search-performance',
        description: `${scenario.query}: ${metrics.timing.submitToFirstVisible.valueMs} ms (${classification})`,
      });
      await testInfo.attach('production-search-metrics', {
        body: Buffer.from(JSON.stringify(metrics, null, 2)),
        contentType: 'application/json',
      });
      expect(
        forbiddenRequests,
        `${scenario.query} issued a write or foreign-origin request.`,
      ).toEqual([]);
      expect(result.elapsedMs, `${scenario.query} exceeded the 1200 ms hard ceiling.`)
        .toBeLessThanOrEqual(PRODUCTION_SEARCH_FIRST_VISIBLE_BUDGET.hardCeilingMs);
    });
  }
});
