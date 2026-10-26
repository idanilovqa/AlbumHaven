const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');

for (const [kind, source, attach, getter, close] of [
  ['utility', 'track-modal-and-gallery.js', 'attachUtilityModalEvents', 'getUtilityModalElements', 'closeUtilityModal'],
  ['track', 'track-modal-lightbox-helpers.js', 'attachModalEvents', 'getTrackModalElements', 'closeTrackModal'],
]) {
  test(`${kind} modal close gestures reach the dismissal owner exactly once`, () => {
    // Use the existing bounded DOM's tree, classList, closest and bubbling;
    // dismissal itself remains the observed request boundary in this owner test.
    const env = createNativeHomeRuntime(), {document, context} = env;
    const overlay = document.createElement('div'), button = document.createElement('button');
    const content = document.createElement('div');
    button.setAttribute(`data-close-${kind}-modal`, '1');
    overlay.append(button, content); document.body.append(overlay);
    let traversals = 0;
    Object.assign(context, {
      [getter]: () => ({ overlay, close: button }),
      bindOverlayPointerOrigin() {},
      overlayClickStartedOnOverlay: (owner, event) => event.target === owner,
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../../music_app/static/js/runtime', source), 'utf8'), context);
    context[close] = () => { traversals++; };
    context[attach]();
    context[attach]();
    // Native button handlers run before the same click bubbles to the overlay.
    env.click(button);
    assert.equal(traversals, 1, 'one Close must not queue two asynchronous history traversals');
    env.click(overlay);
    assert.equal(traversals, 2, 'a later real backdrop still dismisses once');
    env.click(content);
    assert.equal(traversals, 2, 'ordinary dialog content does not dismiss');
    if (kind === 'track') {
      overlay.classList.add('is-artist-discography-sheet');
      env.click(overlay);
      assert.equal(traversals, 2, 'Artist sheet backdrop belongs to its sheet dismissal owner');
      env.click(button);
      assert.equal(traversals, 3, 'Artist sheet explicit Close still reaches the owner once');
    }
  });
}
