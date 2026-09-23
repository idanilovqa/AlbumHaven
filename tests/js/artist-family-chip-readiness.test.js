const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const actionsUrl = pathToFileURL(path.join(__dirname, '../e2e/actions/artistFamilyActions.js')).href;
const galleryUrl = pathToFileURL(path.join(__dirname, '../e2e/poms/galleryRegressions.js')).href;

test('family selection waits for the exact requested chip before reading an asynchronously populated panel', async () => {
  const { ArtistFamilyActions } = await import(actionsUrl);
  const events = [];
  let ready = false;
  const chip = {
    async waitFor(options) {
      assert.deepEqual(options, { state: 'visible', timeout: 30000 });
      events.push('wait');
      ready = true;
    },
    async getAttribute() { return 'is-active'; },
  };
  const actions = new ArtistFamilyActions({ chipByName(name) { assert.equal(name, 'Control Signal Lead'); return chip; } });
  actions.expand = async () => events.push('expand');
  actions.readChipTexts = async () => {
    assert.equal(ready, true, 'a visible shell must not be mistaken for populated family chips');
    events.push('labels');
    return ['Control Signal Lead'];
  };
  actions.waitForChipActive = async () => events.push('active');
  await actions.selectOnlyChipByName('Control Signal Lead');
  assert.deepEqual(events, ['expand', 'wait', 'labels', 'active']);
});

test('family selection fails when the requested chip never becomes visible', async () => {
  const { ArtistFamilyActions } = await import(actionsUrl);
  const actions = new ArtistFamilyActions({ chipByName() { return { async waitFor() { throw new Error('missing exact chip'); } }; } });
  actions.expand = async () => {};
  actions.readChipTexts = async () => assert.fail('must not accept a different populated family');
  await assert.rejects(actions.selectOnlyChipByName('Control Signal Lead'), /missing exact chip/);
});

test('family panel readiness waits for deferred cover activation to settle', async () => {
  const { ArtistFamilyActions } = await import(actionsUrl);
  const previousDocument = global.document;
  const previousHTMLElement = global.HTMLElement;
  class FakeHTMLElement {}
  const toggle = new FakeHTMLElement();
  const list = new FakeHTMLElement();
  list.childElementCount = 2;
  let deferredCoverPending = true;
  list.querySelector = (selector) => {
    assert.equal(selector, '[data-owned-pending-cover]');
    return deferredCoverPending ? {} : null;
  };
  global.HTMLElement = FakeHTMLElement;
  global.document = {
    querySelector(selector) {
      if (selector === '[data-family-toggle]') return toggle;
      if (selector === '[data-family-list]') return list;
      return null;
    },
  };
  try {
    const actions = new ArtistFamilyActions({
      toggleSelector: '[data-family-toggle]',
      listSelector: '[data-family-list]',
      pendingCoverSelector: '[data-owned-pending-cover]',
      async waitForPageCondition(predicate, _options, selectors) {
        assert.equal(predicate(selectors), false);
        deferredCoverPending = false;
        assert.equal(predicate(selectors), true);
      },
    });
    await actions.waitForVisible();
  } finally {
    global.document = previousDocument;
    global.HTMLElement = previousHTMLElement;
  }
});

test('gallery playback evidence uses the exact clicked production row path and rejects missing identity', async () => {
  const { GalleryRegressions } = await import(galleryUrl);
  const readPath = GalleryRegressions.prototype.readTrackPath;
  const row = { async getAttribute(name) {
    assert.equal(name, 'data-track-row-path');
    return '/owned/Clean Signal.wav';
  } };
  assert.equal(await readPath.call({}, row), '/owned/Clean Signal.wav');
  await assert.rejects(readPath.call({}, { async getAttribute() { return null; } }), /no playback path/);
});
