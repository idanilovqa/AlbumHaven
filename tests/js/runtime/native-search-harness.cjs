const vm = require('node:vm');
const {readRepo} = require('./native-home-harness.cjs');
function installNativeSearch(env) {
  // Exercise the production macro's fixed no-suggestions shape. Jinja/browser
  // rendering stays a separate acceptance gate; no cloned live search is used.
  const macro = readRepo('music_app/templates/partials/search-input.html')
    .match(/\{% macro search_input\([^]*?-?%\}([^]*?)\{%- endmacro %\}/)[1]
    .replace(/\{% if suggestions_id %\}[^]*?\{% endif %\}/g, '')
    .replace(/\{% if caller is defined %\}[^]*?\{% endif %\}/g, '')
    .replace(/\{\{[^]*?\}\}/g, '');
  const template = env.document.createElement('template'); template.id = 'native-search-field-template';
  template.innerHTML = macro; env.document.body.appendChild(template);
  vm.runInContext(readRepo('music_app/static/js/runtime/search-input.js'), env.context);
  return {template, render: env.owner('buildSearchInputHtml')};
}

module.exports = {installNativeSearch};
