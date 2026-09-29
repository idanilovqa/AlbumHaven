const test = require('node:test');
const assert = require('node:assert/strict');
const { create, bind } = require('../../../music_app/static/js/surface-dismissal.js');

function harness() {
  const inside = {}, anchor = {}, background = {};
  let closes = 0;
  let active = { surface: { contains: target => target === inside },
    anchor: { contains: target => target === anchor }, dismiss() { closes++; active = null; } };
  const handlers = create(() => active);
  function send(type, target = background, extra = {}) {
    const event = { target, pointerId: 1, isPrimary: true, button: 0, clientX: 12, clientY: 12,
      detail: 1, prevented: false, stopped: false,
      preventDefault() { this.prevented = true; },
      stopImmediatePropagation() { this.stopped = true; }, ...extra };
    handlers[type](event);
    return event;
  }
  return { handlers, send, inside, anchor, background, closes: () => closes,
    setActive: value => { active = value; } };
}

for (const pointerType of ['touch', 'mouse', 'pen']) {
  test(`${pointerType}: dismiss once and consume down, up and retargeted click; the next tap works`, () => {
    const h = harness();
    for (const type of ['pointerdown', 'pointerup', 'click']) {
      const event = h.send(type, undefined, { pointerType });
      assert.equal(event.prevented, true, type);
      assert.equal(event.stopped, true, type);
    }
    assert.equal(h.closes(), 1);
    for (const type of ['pointerdown', 'pointerup', 'click']) assert.equal(h.send(type).stopped, false);
  });
}

test('inside actions and the opener retain normal activation', () => {
  const h = harness();
  for (const target of [h.inside, h.anchor]) {
    for (const type of ['pointerdown', 'pointerup', 'click']) assert.equal(h.send(type, target).stopped, false);
  }
  assert.equal(h.closes(), 0);
});

test('dragging from inside to outside never dismisses or activates background', () => {
  const h = harness();
  h.send('pointerdown', h.inside);
  h.send('pointerup', h.background);
  assert.equal(h.send('click', h.background).stopped, true);
  assert.equal(h.closes(), 0);
});

test('outside scroll/cancel is not a tap and cannot activate background', () => {
  const h = harness();
  h.send('pointerdown');
  h.send('pointerup', undefined, { clientY: 80 });
  assert.equal(h.send('click').stopped, true);
  assert.equal(h.closes(), 0);
  h.send('pointerdown'); h.send('pointercancel');
  assert.equal(h.closes(), 0);
});

test('only the foreground child is dismissed by one gesture', () => {
  const h = harness();
  let parentCloses = 0;
  const parent = { surface: { contains: () => false }, dismiss() { parentCloses++; } };
  h.setActive({ surface: { contains: () => false }, dismiss() { h.setActive(parent); } });
  h.send('pointerdown'); h.send('pointerup'); h.send('click');
  assert.equal(parentCloses, 0);
  h.send('pointerdown'); h.send('pointerup'); h.send('click');
  assert.equal(parentCloses, 1);
});

test('promise-backed cancellation is not swallowed by the native-click guard', () => {
  const h = harness();
  let cancelHandled = false;
  h.setActive({ surface: { contains: node => node === h.inside }, dismiss() {
    cancelHandled = !h.send('click', h.inside, { detail: 0 }).stopped;
    h.setActive(null);
  } });
  h.send('pointerdown'); h.send('pointerup');
  assert.equal(cancelHandled, true);
  assert.equal(h.send('click').stopped, true);
});

test('a keyboard activation after a touch without synthesized click is not lost', () => {
  const h = harness();
  h.send('pointerdown'); h.send('pointerup'); h.send('keydown');
  assert.equal(h.send('click', h.background, { detail: 0 }).stopped, false);
});

test('keyboard and assistive outside activation dismiss only, without pointer events', () => {
  const h = harness();
  assert.equal(h.send('click', h.background, { detail: 0 }).stopped, true);
  assert.equal(h.closes(), 1);
});

test('non-primary pointers do not replace the captured primary gesture', () => {
  const h = harness(); h.send('pointerdown');
  h.send('pointerdown', h.inside, { isPrimary: false, pointerId: 2 });
  h.send('pointerup', h.inside, { isPrimary: false, pointerId: 2 });
  h.send('pointerup'); assert.equal(h.closes(), 1);
});

test('binding uses capture and releases every listener on disposal', () => {
  const listeners = new Map();
  const window = { addEventListener(type, fn, options) {
    assert.equal(options.capture, true); assert.equal(options.passive, false); listeners.set(type, fn);
  }, removeEventListener(type, fn, capture) {
    assert.equal(capture, true); assert.equal(listeners.get(type), fn); listeners.delete(type);
  } };
  const dispose = bind(window, () => null);
  assert.equal(listeners.size, 6); dispose(); assert.equal(listeners.size, 0);
});


function boundHarness() {
  const listeners = new Map();
  const window = {
    addEventListener(type, handler) { listeners.set(type, handler); },
    removeEventListener(type) { listeners.delete(type); },
  };
  const focusedItem = {}, background = {};
  let active = null, closes = 0;
  const dispose = bind(window, () => active);
  const send = (type, target = background, extra = {}) => {
    const event = { target, currentTarget: window, pointerId: 1, isPrimary: true, button: 0,
      clientX: 12, clientY: 12, detail: 1, prevented: false, stopped: false,
      preventDefault() { this.prevented = true; },
      stopImmediatePropagation() { this.stopped = true; }, ...extra };
    listeners.get(type)(event);
    return event;
  };
  active = { surface: { contains: target => target === focusedItem }, dismiss() {
    closes += 1;
    active = null;
    // Returning focus to the opener blurs the previously focused panel item.
    // Capture listeners on window observe that blur even though window stays focused.
    send('blur', focusedItem);
  } };
  return { send, window, background, dispose, closes: () => closes };
}

for (const pointerType of ['touch', 'mouse', 'pen']) {
  test(`${pointerType}: returning focus during dismissal cannot release the pending background click`, () => {
    const h = boundHarness();
    try {
      for (const type of ['pointerdown', 'pointerup', 'click']) {
        const event = h.send(type, h.background, { pointerType });
        assert.equal(event.prevented, true, type);
        assert.equal(event.stopped, true, type);
      }
      assert.equal(h.closes(), 1);
      for (const type of ['pointerdown', 'pointerup', 'click']) {
        assert.equal(h.send(type, h.background, { pointerType }).stopped, false, type);
      }
    } finally { h.dispose(); }
  });
}

test('losing window focus still clears the pending dismissal gesture', () => {
  const h = boundHarness();
  try {
    h.send('pointerdown'); h.send('pointerup');
    h.send('blur', h.window);
    assert.equal(h.send('click').stopped, false);
  } finally { h.dispose(); }
});
