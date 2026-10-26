const test = require('node:test');
const assert = require('node:assert/strict');
const { create, bind } = require('../../../music_app/static/js/surface-dismissal.js');

function harness() {
  const inside = {}, anchor = {}, background = {};
  let closes = 0;
  let active = { surface: { contains: target => target === inside },
    anchor: { contains: target => target === anchor }, isBackdrop: target => target === background, dismiss() { closes++; active = null; } };
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
    setActive: value => { active = value && { isBackdrop: target => target === background, ...value }; } };
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
  const parent = { surface: { contains: () => false }, isBackdrop: target => target === h.background, dismiss() { parentCloses++; } };
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
  const window = new EventTarget(), listeners = [], timers = new Map();
  const add = window.addEventListener.bind(window), remove = window.removeEventListener.bind(window);
  let now = 0, serial = 0;
  const capture = options => typeof options === 'boolean' ? options : options?.capture === true;
  window.addEventListener = (type, handler, options) => {
    if (!listeners.some(value => value.type === type && value.handler === handler && value.capture === capture(options))) {
      listeners.push({type, handler, capture: capture(options)});
    }
    add(type, handler, options);
  };
  window.removeEventListener = (type, handler, options) => {
    const index = listeners.findIndex(value => value.type === type && value.handler === handler && value.capture === capture(options));
    if (index !== -1) listeners.splice(index, 1);
    // Node's EventTarget requires an options object for capture removal.
    remove(type, handler, {capture: capture(options)});
  };
  window.setTimeout = (callback, delay) => {
    assert.equal(typeof callback, 'function'); assert.ok(Number.isFinite(delay) && delay >= 0);
    const id = ++serial; timers.set(id, {at: now + delay, callback}); return id;
  };
  window.clearTimeout = id => { timers.delete(id); };
  const advance = elapsed => {
    assert.ok(Number.isFinite(elapsed) && elapsed >= 0);
    const until = now + elapsed;
    while (true) {
      const next = [...timers].filter(([, value]) => value.at <= until).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      const [id, value] = next; now = value.at; timers.delete(id); value.callback();
    }
    now = until;
  };
  const focusedItem = {}, background = {};
  let active = null, closes = 0;
  const dispose = bind(window, () => active);
  const send = (type, target = background, extra = {}) => {
    const event = new Event(type, {cancelable: true});
    Object.defineProperty(event, 'target', {value: target});
    Object.defineProperty(event, 'prevented', {get: () => event.defaultPrevented});
    Object.assign(event, {pointerId: 1, isPrimary: true, button: 0,
      clientX: 12, clientY: 12, detail: 1, stopped: false}, extra);
    const stop = event.stopImmediatePropagation.bind(event);
    event.stopImmediatePropagation = () => { event.stopped = true; stop(); };
    window.dispatchEvent(event);
    return event;
  };
  const openSurface = () => { active = { surface: { contains: target => target === focusedItem }, isBackdrop: target => target === background, dismiss() {
    closes += 1;
    active = null;
    // Returning focus to the opener blurs the previously focused panel item.
    // Capture listeners on window observe that blur even though window stays focused.
    send('blur', focusedItem);
  } }; };
  openSurface();
  return { send, window, background, dispose, advance, closes: () => closes,
    pendingTimers: () => timers.size, listenerCount: () => listeners.length,
    closeSurface: () => { active = null; }, openSurface };
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

test('the first backdrop click after losing window focus only restores app focus', () => {
  const h = boundHarness();
  try {
    h.send('blur', h.window);
    for (const type of ['pointerdown', 'pointerup', 'click']) {
      const event = h.send(type);
      assert.equal(event.prevented, true, type);
      assert.equal(event.stopped, true, type);
    }
    assert.equal(h.closes(), 0, 'refocusing the app must not dismiss the modal');

    for (const type of ['pointerdown', 'pointerup', 'click']) h.send(type);
    assert.equal(h.closes(), 1, 'the next deliberate backdrop click dismisses normally');
  } finally { h.dispose(); }
});

test('window refocus without an active surface does not reserve a later modal backdrop click', () => {
  const h = boundHarness();
  try {
    h.closeSurface();
    h.send('blur', h.window);
    h.send('pointerdown');
    h.openSurface();

    for (const type of ['pointerdown', 'pointerup', 'click']) h.send(type);
    assert.equal(h.closes(), 1, 'the later modal must dismiss on its first deliberate backdrop click');
  } finally { h.dispose(); }
});

for (const pointerType of ['mouse', 'touch', 'pen']) {
  test(`${pointerType}: uncovered controls remain actionable outside an open surface`, () => {
    const h = harness();
    const player = {};
    for (const type of ['pointerdown', 'pointerup', 'click']) {
      assert.equal(h.send(type, player, { pointerType }).stopped, false);
    }
    assert.equal(h.closes(), 0);
    assert.equal(h.send('click', player, { detail: 0 }).stopped, false);
  });
}

test('a modal root is a backdrop but its nested controls are not', () => {
  const h = harness();
  const modal = {}, nested = {};
  h.setActive({ surface: modal, contains: target => target === nested,
    isBackdrop: target => target === modal, dismiss: () => h.setActive(null) });
  for (const type of ['pointerdown', 'pointerup', 'click']) assert.equal(h.send(type, nested).stopped, false);
  for (const type of ['pointerdown', 'pointerup', 'click']) assert.equal(h.send(type, modal).stopped, true);
});

test('nonblocking surfaces without a backdrop do not reserve outside activations', () => {
  const h = harness();
  h.setActive({ surface: { contains: () => false }, isBackdrop: undefined,
    dismiss() { throw new Error('Ordinary outside handlers own dismissal'); } });
  for (const type of ['pointerdown', 'pointerup', 'click']) assert.equal(h.send(type).stopped, false);
});


test('disposed dismissal retains exactly one bounded click tail and then removes all listeners', () => {
  const h = boundHarness();
  h.send('pointerdown'); h.send('pointerup'); h.dispose(); h.dispose();
  assert.equal(h.closes(), 1); assert.equal(h.listenerCount(), 4); assert.equal(h.pendingTimers(), 1);
  h.advance(999);
  assert.equal(h.send('click', h.background, {detail: 0}).stopped, false, 'keyboard activation never consumes the pointer tail');
  assert.equal(h.listenerCount(), 4);
  assert.equal(h.send('click').stopped, true);
  assert.equal(h.listenerCount(), 0); assert.equal(h.pendingTimers(), 0);
  assert.equal(h.send('click').stopped, false, 'removed tail cannot consume a later click');
});

test('dismissal click tail expires at its real deadline without a timer sleep', () => {
  const h = boundHarness();
  h.send('pointerdown'); h.send('pointerup'); h.dispose();
  h.advance(999); assert.equal(h.listenerCount(), 4); assert.equal(h.pendingTimers(), 1);
  h.advance(1); assert.equal(h.listenerCount(), 0); assert.equal(h.pendingTimers(), 0);
  assert.equal(h.send('click').stopped, false); assert.equal(h.closes(), 1);
});

test('rearming dismissal cancels its old deadline and subsequent gestures cancel the disposed tail', () => {
  for (const type of ['pointerdown', 'keydown', 'blur']) {
    const h = boundHarness();
    h.dispose.suppressNextClick(); h.advance(500); h.dispose.suppressNextClick();
    assert.equal(h.pendingTimers(), 1); h.dispose(); h.advance(500);
    assert.equal(h.listenerCount(), 4, 'the cancelled first deadline cannot clear the newer tail');
    h.send(type, type === 'blur' ? h.window : h.background);
    assert.equal(h.listenerCount(), 0); assert.equal(h.pendingTimers(), 0);
    h.advance(1000); assert.equal(h.send('click').stopped, false); assert.equal(h.closes(), 0);
  }
});
