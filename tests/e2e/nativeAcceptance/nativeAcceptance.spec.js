import { test } from '../fixtures/nativeAcceptanceTest.js';

test('FTC-NATIVE-ACCEPT-001 Home preserves native own preferences and friend read-only taste', { tag: '@area:native-acceptance' }, async ({ native }) => {
  await native.preferences();
});
test('FTC-NATIVE-ACCEPT-002 Goals empty state keeps period and admission dismissal native', { tag: '@area:native-acceptance' }, async ({ native }) => {
  await native.goals();
});
test('FTC-NATIVE-ACCEPT-003 Album Top preserves order and explicit manual completion', { tag: '@area:native-acceptance' }, async ({ native }) => {
  await native.top();
});
test('FTC-NATIVE-ACCEPT-004 Advanced Search commits once and Popularity Album results mark only selected siblings', { tag: '@area:native-acceptance' }, async ({ native }) => {
  await native.search();
});
test('FTC-NATIVE-ACCEPT-005 Mobile artist album sheet and native navigation retain ownership', { tag: '@area:native-acceptance' }, async ({ native }) => {
  const mobile = await native.mobileSession();
  await mobile.mobile();
});
