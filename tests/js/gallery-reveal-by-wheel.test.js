const assert = require('node:assert/strict');
const test = require('node:test');

async function reveal(targetBoxes) {
  const { GalleryActions } = await import('../e2e/actions/galleryActions.js');
  const calls = [];
  const galleryBox = { x: 0, y: 60, width: 1000, height: 820 };
  let scrollTop = 0;
  const actions = new GalleryActions({
    galleryScroll: { boundingBox: async () => galleryBox },
    waitForGalleryScrollMovement: async (previousScrollTop, direction) => {
      calls.push(['moved', previousScrollTop, direction]);
    },
  });
  actions.readGalleryScrollState = async () => ({ scrollTop });
  actions.scrollGalleryBy = async (deltaY) => {
    calls.push(['wheel', deltaY]);
    scrollTop += deltaY;
  };
  const target = { boundingBox: async () => targetBoxes.shift() || null };
  await actions.revealInGalleryByWheel(target);
  return calls;
}

test('a fully visible target needs no scroll', async () => {
  assert.deepEqual(await reveal([{ x: 10, y: 400, width: 200, height: 20 }]), []);
});

test('a target cut by the gallery bottom edge is revealed with the wheel', async () => {
  const calls = await reveal([
    { x: 10, y: 875, width: 200, height: 20 },
    { x: 10, y: 834, width: 200, height: 20 },
  ]);
  assert.deepEqual(calls, [['wheel', 39], ['moved', 0, 1]]);
});

test('a target above the gallery top edge is revealed upward with the wheel', async () => {
  const calls = await reveal([
    { x: 10, y: 50, width: 200, height: 20 },
    { x: 10, y: 84, width: 200, height: 20 },
  ]);
  assert.deepEqual(calls, [['wheel', -34], ['moved', 0, -1]]);
});
