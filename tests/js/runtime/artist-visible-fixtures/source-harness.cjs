'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const ROOT = path.resolve(process.env.ALBUMHAVEN_FRONTEND_ROOT || path.join(__dirname, '../../../..'));
const local = createRequire(path.join(ROOT, 'package.json'));
const React = local('react');
const {renderToStaticMarkup} = local('react-dom/server');
const {buildSync} = local('esbuild');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');
function native() {
  const {createNativeHomeRuntime} = local('./tests/js/runtime/native-home-harness.cjs');
  const env = createNativeHomeRuntime();
  // Existing whole files, never rewritten bodies or copied production logic.
  for (const relative of ['music_app/static/js/navigation-tree.js', 'music_app/static/js/runtime/gallery-main-components.js']) {
    vm.runInContext(read(relative), env.context, {filename: relative});
  }
  const template = env.document.createElement('script'); template.id = 'navigation-tree-item-template';
  template.textContent = read('music_app/templates/components/navigation-tree-item.html'); env.document.body.appendChild(template);
  const runtime = {
    buttonHtml: options => env.context.ButtonComponent.renderButton(options),
    actionHtml: options => env.context.ButtonComponent.renderActionButton(options),
    artistInfoHtml: options => env.context.buildArtistInfoOverlayHtml(options),
    artistFamilyHtml: options => env.context.buildArtistFamilyPanelHtml(options),
    createIntrinsicDisclosure() {throw new Error('SSR must not acquire mounted native listeners');},
  };
  return {...env, runtime};
}
function components() {
  const code = buildSync({entryPoints: [path.join(ROOT, 'music_app/static/js/home-friends/components.jsx')],
    bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react', 'react-dom']}).outputFiles[0].text;
  const loaded = {exports: {}};
  vm.runInNewContext(code, {module: loaded, exports: loaded.exports, require: local});
  return loaded.exports;
}
function render(Component, props) {
  const env = native();
  const markup = renderToStaticMarkup(React.createElement(Component, {runtime: env.runtime, ...props}));
  const host = env.document.createElement('div'); host.innerHTML = markup;
  return {...env, markup, host};
}
module.exports = {ROOT, local, React, native, components, render};

function disclosureRuntime() {
  const env = require('./focus-fixture.cjs').withFocus(native());
  const manifest = local('./scripts/build-runtime-bundle.cjs').RUNTIME_SCRIPT_PATHS;
  for (const relative of manifest.filter(value => value === 'js/runtime/intrinsic-disclosure.js')) {
    vm.runInContext(read(path.join('music_app/static', relative)), env.context, {filename: relative});
  }
  return env;
}
module.exports.disclosureRuntime = disclosureRuntime;
