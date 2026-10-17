'use strict';
const {fixture, load, settle} = require('./home-friends-native-app-fixture.cjs');
// Observation only: owners build all markup. The detached serialization omits hidden
// retained control hosts for comparisons formerly made against SSR output.
function visibleHtml(host) {
  const copy = host.ownerDocument.createElement('div'); copy.innerHTML = host.innerHTML;
  for (const node of copy.querySelectorAll('[hidden]')) node.remove();
  return copy.innerHTML;
}
function environment(t) {
  const env = fixture(t), proto = env.c.Element.prototype;
  // Browser IDL reflection needed by retained markup assertions; additive local
  // platform support, without changing any renderer or protected fixture.
  for (const [property, attribute] of Object.entries({type:'type', src:'src', alt:'alt', accept:'accept', referrerPolicy:'referrerpolicy', decoding:'decoding', htmlFor:'for', pattern:'pattern', autocomplete:'autocomplete'})) {
    Object.defineProperty(proto, property, {configurable: true, get() {return this.getAttribute(attribute) || '';}, set(value) {this.setAttribute(attribute, String(value));}});
  }
  Object.defineProperty(proto, 'maxLength', {configurable: true, get() {return this.hasAttribute('maxlength') ? Number(this.getAttribute('maxlength')) : -1;}, set(value) {this.setAttribute('maxlength', String(value));}});
  return env;
}
function snapshot(mount, props) {
  const releases = [], env = environment({after: release => releases.push(release)});
  try {
    const owner = env.own(mount(env.host, env.runtime, props));
    return {html: visibleHtml(env.host), raw: env.host.innerHTML, fileInputs: env.host.querySelectorAll('input').filter(node => node.type === 'file').map(node => ({disabled: node.disabled, accept: node.accept}))};
  } finally {for (const release of releases.reverse()) release();}
}
module.exports = {environment, load, settle, visibleHtml, snapshot};
