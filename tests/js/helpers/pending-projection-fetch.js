const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'pending-projection-fetch.js');
const source = fs.readFileSync(sourcePath, 'utf8');

// Installs the real shared pending-projection retry (and the reachability probe beside it) into a
// runtime test context, giving it the timer and abort globals a browser has when it lacks them.
function loadPendingProjectionFetch(context) {
  // Unref'd, so a probe left waiting for an unreachable server never keeps the test process alive.
  const unrefTimeout = (...args) => {
    const timer = setTimeout(...args);
    timer.unref?.();
    return timer;
  };
  for (const [name, value] of Object.entries({ setTimeout: unrefTimeout, clearTimeout, AbortController })) {
    if (typeof context[name] === 'undefined') context[name] = value;
  }
  vm.runInContext(source, context, { filename: sourcePath });
  return context;
}

module.exports = { loadPendingProjectionFetch };
