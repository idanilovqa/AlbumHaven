// Back and Forward load the page again and then return to the place it was left at (IAR-W27). The
// place is kept per history entry for the signed-in account: opaque album ids, never a file path, and
// it goes with sign-out.
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { createReturnPlace, STORAGE_KEY } = require(path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'return-place.js'));

function memoryStorage() {
  const values = new Map();
  return {
    values,
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}

const PLACE = { top: 48000, offset: -82, artist: 'Artist 041', album: { id: 1500 } };

function load({
  storage = memoryStorage(), account = 'acct-a', copyAccount = '', type = 'navigate', key = 'entry-1', api = true, clock = { now: 1000 },
} = {}) {
  const listeners = new Map();
  const timers = [];
  const style = new Map();
  const attributes = new Set();
  const env = { reloads: 0 };
  const metas = {
    'meta[name="album-haven-account"]': account ? { getAttribute: () => account } : null,
    'meta[name="album-haven-app-copy"]': copyAccount ? { getAttribute: () => copyAccount } : null,
  };
  const place = createReturnPlace({
    storage,
    now: () => clock.now,
    document: {
      querySelector: selector => metas[selector] || null,
      addEventListener: (name, listener) => listeners.set(`document:${name}`, listener),
      documentElement: {
        style: { setProperty: (name, value) => style.set(name, value) },
        setAttribute: name => attributes.add(name),
        removeAttribute: name => attributes.delete(name),
      },
    },
    window: {
      navigation: api ? { currentEntry: { key } } : undefined,
      performance: { getEntriesByType: () => [{ type }] },
      location: { reload: () => { env.reloads += 1; } },
      setTimeout: (callback, ms) => timers.push({ callback, ms }),
      clearTimeout: () => {},
      addEventListener: (name, listener) => listeners.set(`window:${name}`, listener),
    },
  });
  return {
    place, env, storage, listeners, timers, clock, hidden: () => attributes.has('data-returning-to-place'), opacity: () => style.get('opacity'),
  };
}

function leftAt(place = PLACE, options = {}) {
  const left = load(options);
  left.place.save('entry-1', place);
  return left.storage;
}

test('IAR-W27: Back and Forward return to the place kept for that history entry', () => {
  const storage = leftAt();

  const returned = load({ storage, type: 'back_forward' });

  assert.deepEqual(returned.place.returning(), PLACE);
  assert.equal(returned.hidden(), true, 'the top of the gallery is not painted first');
  returned.place.done();
  assert.equal(returned.hidden(), false);
  assert.equal(returned.place.returning(), null);
});

test('IAR-W27: the gallery is never left unpainted: it shows after 10 s at the latest', () => {
  const returned = load({ storage: leftAt(), type: 'back_forward' });

  returned.timers.find(timer => timer.ms === 10000).callback();

  assert.equal(returned.hidden(), false);
});

test('IAR-W27: a place at the top, with no album open, hides nothing', () => {
  const returned = load({ storage: leftAt({ top: 0 }), type: 'back_forward' });

  assert.equal(returned.hidden(), false);
});

for (const [name, options] of [
  ['an ordinary navigation', { type: 'navigate' }],
  ['a reload', { type: 'reload' }],
  ['another entry', { type: 'back_forward', key: 'entry-2' }],
  ['a browser without history entry keys', { type: 'back_forward', api: false }],
]) {
  test(`IAR-W27: ${name} starts where it always did`, () => {
    const loaded = load({ storage: leftAt(), ...options });

    assert.equal(loaded.place.returning(), null);
    assert.equal(loaded.hidden(), false);
  });
}

test('IAR-W27: another account gets none of it, and it is gone from the device', () => {
  const storage = leftAt();

  const loaded = load({ storage, account: 'acct-b', type: 'back_forward' });

  assert.equal(loaded.place.returning(), null);
  assert.equal(loaded.hidden(), false);
  assert.doesNotMatch(storage.getItem(STORAGE_KEY) || '', /Artist 041|1500/);
});

test('IAR-W27: without a signed-in account nothing is returned or kept', () => {
  const storage = leftAt();
  const loaded = load({ storage, account: '', type: 'back_forward' });

  assert.equal(loaded.place.returning(), null);
  loaded.place.save('entry-9', PLACE);
  assert.doesNotMatch(storage.getItem(STORAGE_KEY) || '', /entry-9/);
});

test('IAR-W27: a page from the copy of an earlier build takes its account from the copy', () => {
  const storage = leftAt(PLACE, { account: '', copyAccount: 'acct-a' });

  assert.deepEqual(load({ storage, account: '', copyAccount: 'acct-a', type: 'back_forward' }).place.returning(), PLACE);
});

test('IAR-W27: signing out takes every place, and a page still open writes none back', () => {
  const storage = memoryStorage();
  const first = load({ storage });
  const other = load({ storage, key: 'entry-2' });
  first.place.save('entry-1', PLACE);

  first.listeners.get('document:submit')({ target: { getAttribute: () => '/logout' } });
  other.place.save('entry-2', PLACE);
  first.place.save('entry-1', PLACE);

  assert.equal(storage.getItem(STORAGE_KEY), null);
});

test('IAR-W27: a page still open writes nothing into the next sign-in', () => {
  const storage = memoryStorage();
  const stale = load({ storage });
  stale.place.clear();
  load({ storage, clock: { now: 2000 } });

  stale.place.save('entry-1', PLACE);

  assert.equal(load({ storage, type: 'back_forward' }).place.returning(), null);
});

test('IAR-W27: submitting any other form takes nothing', () => {
  const storage = memoryStorage();
  const page = load({ storage });
  page.place.save('entry-1', PLACE);

  page.listeners.get('document:submit')({ target: { getAttribute: () => '/account/password' } });

  assert.match(storage.getItem(STORAGE_KEY), /entry-1/);
});

for (const [name, bad] of [
  ['a drive path', 'Q:\\Made Up\\Album\\01.flac'],
  ['a drive path with slashes', 'Q:/Made Up/Album/01.flac'],
  ['a share', '\\\\made-up-server\\share\\01.flac'],
  ['a POSIX path', '/srv/music/album/01.flac'],
  ['a path signature', 'made up|Q:/Made Up/Album/02.flac'],
  ['a stand-in from the copy', 'offline:4|offline:5'],
]) {
  test(`IAR-W27: what is kept never holds ${name}`, () => {
    const { place, storage } = load();

    place.save('entry-1', { top: 10, offset: 4, artist: bad, album: { id: 7, key: bad }, open: { key: bad }, extra: bad });

    assert.deepEqual(place.placeFor('entry-1'), { top: 10, offset: 4, album: { id: 7 } });
    assert.doesNotMatch(storage.getItem(STORAGE_KEY), /Made Up|made-up-server|srv|offline:/);
  });
}

test('IAR-W27: an album keeps its name key only where it has no id, and an open album both', () => {
  const { place } = load();

  place.save('entry-1', {
    top: 9, artist: 'AC/DC', album: { id: 7, key: 'ac/dc::back in black' },
    open: { id: 8, key: 'ac/dc::powerage', top: 120, page: 3 },
  });
  place.save('entry-2', { top: 9, album: { key: 'ac/dc::back in black' } });

  assert.deepEqual(place.placeFor('entry-1'), {
    top: 9, artist: 'AC/DC', album: { id: 7 }, open: { id: 8, key: 'ac/dc::powerage', top: 120, page: 3 },
  });
  assert.deepEqual(place.placeFor('entry-2'), { top: 9, album: { key: 'ac/dc::back in black' } });
});

test('IAR-W27: the fifty places left last are kept', () => {
  const page = load();
  for (let index = 1; index <= 52; index += 1) {
    page.clock.now += 1;
    page.place.save(`entry-${index}`, { top: index });
  }

  assert.equal(page.place.placeFor('entry-2'), null);
  assert.deepEqual(page.place.placeFor('entry-3'), { top: 3 });
  assert.deepEqual(page.place.placeFor('entry-52'), { top: 52 });
});

test('IAR-W27: a page Back took from memory leaves hidden and is loaded again at its place', () => {
  const page = load();
  page.place.save('entry-1', PLACE);
  page.listeners.get('window:pagehide')({ persisted: true });
  assert.equal(page.opacity(), '0');

  let stopped = false;
  page.listeners.get('window:pageshow')({ persisted: true, stopImmediatePropagation: () => { stopped = true; } });

  assert.equal(stopped, true, 'nothing of the page resumes');
  assert.equal(page.env.reloads, 1);
  const again = load({ storage: page.storage, type: 'reload' });
  assert.deepEqual(again.place.returning(), PLACE);
  assert.equal(load({ storage: page.storage, type: 'reload' }).place.returning(), null, 'that reload alone');
});

test('IAR-W27: a page that is not kept in memory is not hidden', () => {
  const page = load();
  page.listeners.get('window:pagehide')({ persisted: false });
  page.listeners.get('window:pageshow')({ persisted: false });

  assert.equal(page.opacity(), undefined);
  assert.equal(page.env.reloads, 0);
});

test('IAR-W27: without storage the page works as before', () => {
  const refuse = () => { throw new Error('storage is off'); };
  const page = load({ storage: { getItem: refuse, setItem: refuse, removeItem: refuse }, type: 'back_forward' });

  page.place.save('entry-1', PLACE);
  page.place.clear();

  assert.equal(page.place.returning(), null);
});
