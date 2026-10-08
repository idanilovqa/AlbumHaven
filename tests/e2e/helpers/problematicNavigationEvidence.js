import assert from 'node:assert/strict';

export function expectProblematicNavigationRecords(records, expectedKey, expectedTitle) {
  assert.ok(expectedKey && expectedTitle, 'Navigation requires independent key and title');
  for (const record of records) {
    assert.ok(Number.isInteger(record.detailRenderCount) && record.detailRenderCount >= 0,
      'Every observation must retain its exact detail mutation count');
    assert.equal(record.detailRender, record.detailRenderCount > 0);
  }
  const detailRenders = records.filter(record => record.detailRender);
  assert.equal(detailRenders.reduce((total, record) => total + record.detailRenderCount, 0), 1,
    'Exactly one root detail content replacement is required');
  assert.equal(detailRenders.length, 1);
  assert.equal(detailRenders[0].activeKey, expectedKey);
  assert.equal(detailRenders[0].detailTitle, expectedTitle);
  for (const record of records) {
    if (record.activeKey) assert.equal(record.activeKey, expectedKey, 'No wrong transient active selection');
    if (record.detailTitle) {
      assert.equal(record.selectedKey, expectedKey, 'A titled detail must retain its canonical selected key');
      assert.equal(record.runtimeKey, expectedKey, 'A titled detail must retain its canonical detail model key');
      assert.equal(record.detailTitle, expectedTitle, 'No wrong transient detail');
      if (!record.activeKey) {
        assert.equal(record.detailMutation, false, 'Only list-only observations may lack the mounted active row');
        assert.equal(record.selectedRowMounted, false, 'A mounted selected row must retain its active marker');
      }
    }
  }
}
