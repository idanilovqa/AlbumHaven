const assert = require('node:assert/strict');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const helper = import(pathToFileURL(path.resolve(__dirname, '../e2e/helpers/problematicPayloadEvidence.js')).href);

for (const field of ['track_problem_rows', 'repair_preview_rows', 'problematic_track_paths']) {
  test(`summary guard rejects ${field} on an off-screen item`, async () => {
    const { assertCompactProblematicSummary } = await helper;
    const payload = { items: Array.from({ length: 100 }, (_, key) => ({ key, detail_loaded: false })) };
    assert.doesNotThrow(() => assertCompactProblematicSummary(payload));
    payload.items[99][field] = [];
    assert.throws(() => assertCompactProblematicSummary(payload), new RegExp(field));
  });
}

test('summary guard rejects empty, malformed, and eagerly hydrated payloads', async () => {
  const { assertCompactProblematicSummary } = await helper;
  for (const payload of [{}, { items: [] }, { items: [{ key: 'late', detail_loaded: true }] }]) {
    assert.throws(() => assertCompactProblematicSummary(payload));
  }
});


test('network evidence counts repeated summary requests and releases its listener', async () => {
  const { measureProblematicFilesSettingsOpenWithNetworkEvidence } = await import(
    pathToFileURL(path.resolve(__dirname, '../e2e/helpers/utilityPerformanceHelpers.js')).href
  );
  let listener;
  let released = false;
  const page = {
    on(event, handler) { assert.equal(event, 'request'); listener = handler; },
    off(event, handler) { assert.equal(event, 'request'); assert.equal(handler, listener); released = true; },
    async evaluate() { return { sequence: 0, preemptions: [] }; },
    async waitForResponse() { return {}; },
  };
  const evidence = await measureProblematicFilesSettingsOpenWithNetworkEvidence(page, {
    async prepareToOpenSettings() {},
    async openSettings() {
      for (const route of ['/utilities/problematic-files?limit=50', '/utilities/problematic-files',
        '/utilities/problematic-files', '/utilities/problematic-files/detail?album_key=late']) {
        listener({ url: () => `http://localhost${route}` });
      }
    },
  }, { async waitForReady() {} });
  assert.equal(evidence.summaryRequestCount, 3, 'Duplicate requests must remain observable');
  assert.equal(evidence.detailRequestCount, 1);
  assert.equal(released, true);
});


test('browser benchmark enforces the approved payload budget on the complete response', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(path.resolve(__dirname,
    '../e2e/utilityProblematicFiles/utilitiesResponsiveness.spec.js'), 'utf8');
  assert.match(source, /completeSummaryResponse\.text\(\)/);
  assert.match(source, /encode\(completeResponseBody\)\.byteLength/);
  assert.match(source, /expect\(completeResponseBytes,[\s\S]*?toBeLessThanOrEqual\(payloadBudget\.maxAllowed\)/);
  assert.match(source, /problematicResponseBytes: responseBytes/);
});
