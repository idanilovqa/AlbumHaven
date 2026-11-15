// Runs capability-ui.js in a runtime test's VM context, as every page loads it ahead of the runtime
// bundle, so the bridge client's Android shell test is the shipped one. The context's `window`
// needs its `document`; without a capability bootstrap no server policy is installed.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CAPABILITY_UI = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'capability-ui.js');

function loadCapabilityUi(context) {
  if (!context.window.document) context.window.document = context.document || {};
  vm.runInContext(fs.readFileSync(CAPABILITY_UI, 'utf8'), context, { filename: 'capability-ui.js' });
}

module.exports = { loadCapabilityUi };
