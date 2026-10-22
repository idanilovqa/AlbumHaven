'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const ROOT = path.resolve(process.env.ALBUMHAVEN_FRONTEND_ROOT || path.join(__dirname, '../../../..'));
const local = createRequire(path.join(ROOT, 'package.json'));
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
  };
  return {...env, runtime};
}
// Canonical renderers own these visible facts; there is no replacement React wrapper.
function renderNative(t, kind, props) {
  const env = native(), host = env.document.createElement('section');
  env.document.body.append(host);
  t.after(() => host.remove());
  require('node:assert/strict').equal(typeof (kind === 'info' ? env.runtime.artistInfoHtml : env.runtime.artistFamilyHtml), 'function');
  host.innerHTML = kind === 'info'
    ? env.runtime.artistInfoHtml({presentation: 'embedded', ...props})
    : env.runtime.artistFamilyHtml({presentation: 'navigation', ...props});
  return {...env, host};
}
async function disclosureComponent() {
  return (await import(require('node:url').pathToFileURL(path.join(ROOT,
    'music_app/static/js/home-friends/native-controls.mjs')).href)).mountIntrinsicDisclosure;
}
function renderDisclosure(t, mount, props) {
  const env = disclosureRuntime();
  local('./tests/js/runtime/playlist-dom-platform.cjs').withPlaylistDomPlatform(env);
  const host = env.document.createElement('section'); env.document.body.append(host);
  const before = env.listeners().length;
  env.runtime.createIntrinsicDisclosure = env.owner('createIntrinsicDisclosure');
  let owner;
  t.after(() => {
    try {
      owner?.dispose();
      require('node:assert/strict').equal(env.listeners().length, before, 'all mounted disclosure listeners retire');
      require('node:assert/strict').equal(host.childNodes.length, 0);
    } finally {host.remove();}
  });
  owner = mount(host, env.runtime, props);
  if (props.childText) {
    const child = env.document.createElement(props.childTag || 'button');
    if (child.tagName === 'BUTTON') child.type = 'button';
    child.textContent = props.childText; owner.slots.panel.append(child);
  }
  if (props.actionText) {
    const action = env.document.createElement('button'); action.type = 'button';
    action.setAttribute('data-independent-header-action', 'true'); action.textContent = props.actionText;
    owner.slots.actions.append(action);
  }
  return {...env, host, owner};
}
module.exports = {ROOT, local, native, renderNative, disclosureComponent, renderDisclosure};

function disclosureRuntime() {
  const env = require('./focus-fixture.cjs').withFocus(native());
  const manifest = local('./scripts/build-runtime-bundle.cjs').RUNTIME_SCRIPT_PATHS;
  for (const relative of manifest.filter(value => value === 'js/runtime/intrinsic-disclosure.js')) {
    vm.runInContext(read(path.join('music_app/static', relative)), env.context, {filename: relative});
  }
  return env;
}
module.exports.disclosureRuntime = disclosureRuntime;
