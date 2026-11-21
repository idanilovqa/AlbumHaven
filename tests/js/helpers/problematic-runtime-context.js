const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = path.join(__dirname, '../../../music_app/static/js/runtime/utility-list-builders.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const companionSource = [
  source.slice(
    source.indexOf('function getSelectedProblematicAlbum('),
    source.indexOf('function markProblematicSearchFactsChanged('),
  ),
  source.slice(
    source.indexOf('function markProblematicSearchFactsChanged('),
    source.indexOf('function getAlbumTrackPaths('),
  ),
  source.slice(
    source.indexOf('function normalizeProblemFilterReason('),
    source.indexOf('const renderedProblemFilterOptions '),
  ),
  source.slice(
    source.indexOf('function getProblematicMainSearchText('),
    source.indexOf('function getSelectedUtilityRule('),
  ),
].join('\n');

// Load the real query/selection owners without replacing a test's DOM builders.
function loadProblematicCompanions(context) {
  vm.runInContext(companionSource, context, { filename: sourcePath });
}

module.exports = { loadProblematicCompanions };
