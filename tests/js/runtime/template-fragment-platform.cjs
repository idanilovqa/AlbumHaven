'use strict';
// Shared bounded fragment support for actual native registry/index fixtures.
// The retained DOM owner already owns parsing and fragment insertion semantics.
const installed = new WeakSet();
function installTemplateFragmentPlatform(document) {
  if (installed.has(document)) return;
  const createElement = document.createElement;
  document.createElement = function (...args) {
    const node = Reflect.apply(createElement, this, args);
    if (node.content && !('firstElementChild' in node.content)) {
      Object.defineProperty(node.content, 'firstElementChild', {
        get() {return this.childNodes.find(child => child.nodeType === 1) || null;},
      });
    }
    return node;
  };
  installed.add(document);
}
module.exports = {installTemplateFragmentPlatform};
