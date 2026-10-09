// Existing native fixtures represent a valid authenticated server. Supply its
// newly required shell/response stamp while executing the real transport.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const STAMP = 'a'.repeat(64);
function installPrivateContext(context) {
  const document = context.document, get = document.getElementById.bind(document);
  const fallback = {dataset: {privateUiContext: STAMP}};
  const shell = get('app-shell') || fallback;
  shell.dataset.privateUiContext = STAMP;
  document.getElementById = id => id === 'app-shell' ? get(id) || fallback : get(id);
  const stamped = value => value && typeof value === 'object' && !Array.isArray(value)
    ? {...value, context_ref: Object.hasOwn(value, 'context_ref') ? value.context_ref : STAMP} : value;
  if (context.state?.view && !Object.hasOwn(context.state.view, 'context_ref')) context.state.view.context_ref = STAMP;
  let fetch = context.fetch;
  Object.defineProperty(context, 'fetch', {configurable: true,
    get: () => {const handler = fetch; return async (...args) => {
      const response = await handler(...args);
      return response && typeof response.json === 'function' ? {...response,
        json: async () => stamped(await response.json())} : response;
    };}, set: value => {fetch = value;}});
  context.URLSearchParams ||= URLSearchParams;
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../../music_app/static/js/runtime/private-ui-transport.js'), 'utf8'), context,
    {filename: 'private-ui-transport.js'});
}
module.exports = {installPrivateContext, STAMP};
