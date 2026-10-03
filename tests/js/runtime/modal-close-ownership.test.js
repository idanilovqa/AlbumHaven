const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

for (const [kind, source, attach, getter, close] of [
  ['utility', 'track-modal-and-gallery.js', 'attachUtilityModalEvents', 'getUtilityModalElements', 'closeUtilityModal'],
  ['track', 'track-modal-lightbox-helpers.js', 'attachModalEvents', 'getTrackModalElements', 'closeTrackModal'],
]) {
  test(`${kind} modal close gestures reach the dismissal owner exactly once`, () => {
    const node = () => ({ dataset: {}, listeners: new Map(), addEventListener(name, callback) {
      const listeners = this.listeners.get(name) || [];
      listeners.push(callback);
      this.listeners.set(name, listeners);
    } });
    const overlay = node(), button = node();
    let traversals = 0;
    const context = vm.createContext({
      document: { addEventListener() {} },
      [getter]: () => ({ overlay, close: button }),
      bindOverlayPointerOrigin() {},
      overlayClickStartedOnOverlay: (owner, event) => event.target === owner,
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../../music_app/static/js/runtime', source), 'utf8'), context);
    context[close] = () => { traversals++; };
    context[attach]();
    context[attach]();
    const event = { target: { closest: selector => selector === `[data-close-${kind}-modal="1"]` ? button : null } };
    // Native button handlers run before the same click bubbles to the overlay.
    for (const listener of button.listeners.get('click') || []) listener(event);
    for (const listener of overlay.listeners.get('click') || []) listener(event);
    assert.equal(traversals, 1, 'one Close must not queue two asynchronous history traversals');
    for (const listener of overlay.listeners.get('click') || []) listener({ target: overlay });
    assert.equal(traversals, 2, 'a later real backdrop still dismisses once');
    for (const listener of overlay.listeners.get('click') || []) listener({ target: { closest: () => null } });
    assert.equal(traversals, 2, 'ordinary dialog content does not dismiss');
  });
}
