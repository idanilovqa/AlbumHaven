'use strict';
// Bounded text/search input value semantics. The attribute remains the default
// serialized value; a property edit becomes dirty and stops following it.
// Other element/type expandos retain this fixture's existing behavior.
const installed = new WeakSet();
function installSearchValuePlatform(context) {
  const proto = context.Element.prototype;
  if (installed.has(proto)) return;
  if (Object.getOwnPropertyDescriptor(proto, 'value')) throw new Error('Input value already has a platform owner');
  const values = new WeakMap();
  const supported = node => node.tagName === 'INPUT'
    && ['', 'text', 'search'].includes((node.getAttribute('type') || '').toLowerCase());
  const sanitize = value => String(value).replace(/[\r\n]/g, '');
  Object.defineProperty(proto, 'value', {configurable: true,
    get() {return supported(this) ? values.has(this) ? values.get(this) : sanitize(this.getAttribute('value') || '') : undefined;},
    set(value) {
      if (supported(this)) values.set(this, sanitize(value === null ? '' : value));
      else Object.defineProperty(this, 'value', {value, writable: true, configurable: true, enumerable: true});
    },
  });
  installed.add(proto);
}
module.exports = {installSearchValuePlatform};
