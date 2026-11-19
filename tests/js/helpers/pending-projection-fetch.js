const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'pending-projection-fetch.js');
const source = fs.readFileSync(sourcePath, 'utf8');

// Installs the real shared pending-projection retry into a runtime test context.
function loadPendingProjectionFetch(context) {
  vm.runInContext(source, context, { filename: sourcePath });
  return context;
}

module.exports = { loadPendingProjectionFetch };
