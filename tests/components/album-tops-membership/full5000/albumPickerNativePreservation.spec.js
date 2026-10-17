const {test} = require('./browser-fixture.cjs');

test('actual React Selected query edit does not regenerate unchanged native cards or row Buttons', async ({picker}) => {
  await picker.queryPreservesNativeRows();
});

test('actual React Selected removal retains surviving row nodes and does not regenerate their native markup', async ({picker}) => {
  await picker.removePreservesSurvivors();
});

test('actual React shared End/Home reorder moves keyed rows while retaining the same physical handle and focus', async ({picker}) => {
  await picker.endHomePreservesHandle();
});

for (const reason of ['busy', 'metadata authority']) test(`actual React ${reason} transition disables retained controls and restores the same native owners`, async ({picker}) => {
  await picker.disabledRecovery(reason);
});
