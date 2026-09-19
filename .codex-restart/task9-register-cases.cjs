const fs = require('node:fs');
const matrixPath = 'tests/ci/test-data-matrix.json';
const matrixText = fs.readFileSync(matrixPath, 'utf8');
const matrix = JSON.parse(matrixText);
const entries = [];
for (const style of ['capsule', 'companion']) {
  for (const title of [
    `waveform metadata and Play preserve approved anchors with actual ${style} controls`,
    ...['expanded-player', 'saved-loop'].map(owner => `${owner} ${style} native Play and revealed actions have independent hit targets`),
  ]) entries.push({ config: 'playwright.component.config.js', project: '', test: 'tests/components/playerViews.spec.js', case: title, profile: null, setupScope: 'suite', stateMode: 'read-only', databaseScenarios: [], filesystemScenarios: [], expectedContracts: ['approved-player-geometry', 'native-control-hit-targets'], ownerApproval: 'approved' });
}
const integrationTitles = [
  'FTC-SETTINGS-I01 real folder picking preserves Cancel and validates saved root membership',
  'FTC-SETTINGS-I02 Scrobbling statistics and readable Foobar help retain disabled playlist import',
];
for (const [index, title] of integrationTitles.entries()) entries.push({
  config: 'playwright.config.js', project: 'functional', test: 'tests/e2e/specs/settingsIntegrations.functional.spec.js', case: title,
  profile: 'functional-core', setupScope: index === 0 ? 'isolated' : 'suite', stateMode: index === 0 ? 'owned-mutation' : 'read-only', executionWave: index === 0 ? 2 : 1,
  databaseScenarios: [index === 0 ? 'settings:owned-root-membership' : 'settings:integration-projections'],
  filesystemScenarios: index === 0 ? ['empty-directories:settings-root-picker'] : [],
  expectedContracts: index === 0 ? ['native-folder-picker-cancel', 'validated-root-membership', 'reload-persistence'] : ['scrobbling-statistics', 'responsive-foobar-guide', 'unsupported-import-disabled'],
  ...(index === 0 ? { mutationOwnership: { databaseIdentity: 'case:settings-root-membership', filesystemCopy: 'settings-root-picker-fixture' } } : {}), ownerApproval: 'approved',
});
if (entries.some(entry => matrix.some(old => old.case === entry.case))) throw new Error('Already registered');
fs.writeFileSync(matrixPath, matrixText.trimEnd().replace(/\]\s*$/, ',\n' + entries.map(entry => '  ' + JSON.stringify(entry)).join(',\n') + '\n]\n').replace(/\n,\n/, ',\n'));
const shardPath = 'tests/ci/functional-shards.json';
const shardsText = fs.readFileSync(shardPath, 'utf8');
const marker = '"name": "playback-utilities"';
const position = shardsText.indexOf('"cases": [', shardsText.indexOf(marker)) + '"cases": ['.length;
if (position < 20) throw new Error('Playback shard absent');
const cases = entries.filter(entry => entry.project === 'functional').map(({ config, project, test, case: title }) => ({ config, project, test, case: title }));
fs.writeFileSync(shardPath, shardsText.slice(0, position) + '\n' + cases.map(entry => '            ' + JSON.stringify(entry) + ',').join('\n') + shardsText.slice(position));
