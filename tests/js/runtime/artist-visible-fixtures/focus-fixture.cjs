'use strict';
// Bounded DOM focus model for the new disclosure tests. The protected native
// harness remains unchanged. This models programmatic focus, not painted layout,
// tab navigation, browser timing, or actual assistive-technology behavior.
function withFocus(env) {
  const {document, context} = env, proto = context.Element.prototype;
  const focusEvents = [];
  function accepts(node) {
    if (!node?.isConnected || node.disabled || node.closest('[hidden],[inert]')) return false;
    if (['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(node.tagName)) return true;
    if (node.tagName === 'A' && node.hasAttribute('href')) return true;
    return node.hasAttribute('tabindex') && Number.isInteger(Number(node.getAttribute('tabindex')));
  }
  function event(node, type, bubbles) {
    node.dispatchEvent(new context.Event(type, {bubbles, cancelable: false}));
  }
  proto.focus = function focus() {
    if (!accepts(this) || document.activeElement === this) return;
    const previous = document.activeElement;
    // Focusing steps update the active element before firing focus/focusin.
    document.activeElement = this;
    if (previous) {event(previous, 'blur', false); event(previous, 'focusout', true);}
    focusEvents.push({node: this, previous});
    event(this, 'focus', false); event(this, 'focusin', true);
  };
  proto.blur = function blur() {
    if (document.activeElement !== this) return;
    document.activeElement = document.body;
    event(this, 'blur', false); event(this, 'focusout', true);
  };
  const removeChild = context.Node.prototype.removeChild;
  context.Node.prototype.removeChild = function remove(child) {
    const focused = child.contains(document.activeElement);
    const result = removeChild.call(this, child);
    if (focused) document.activeElement = document.body;
    return result;
  };
  return {...env, focusEvents};
}
module.exports = {withFocus};
