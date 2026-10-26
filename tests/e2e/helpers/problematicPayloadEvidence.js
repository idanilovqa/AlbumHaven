import assert from 'node:assert/strict';

// Both first-page and complete summaries must stay compact, including off-screen rows.
export function assertCompactProblematicSummary(payload) {
  assert.ok(Array.isArray(payload.items), 'Problematic Files summary must contain items');
  assert.ok(payload.items.length > 0, 'The performance fixture must be populated');
  for (const item of payload.items) {
    assert.equal(item.detail_loaded, false, `Summary ${item.key} eagerly hydrated detail`);
    for (const field of ['track_problem_rows', 'repair_preview_rows', 'problematic_track_paths']) {
      assert.equal(item[field], undefined, `Summary ${item.key} carries heavy ${field}`);
    }
  }
}
