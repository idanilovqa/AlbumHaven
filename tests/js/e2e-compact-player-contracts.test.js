const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function scenario(presentation) {
  const events = [];
  const style = presentation === 'floating' ? 'floating' : 'docked';
  const player = {
    getAttribute: async name => {
      assert.equal(name, 'data-compact-presentation');
      return presentation;
    },
    css: { height: presentation.startsWith('rail_') ? '100px' : style === 'floating' ? '96px' : '72px', width: '96px' },
  };
  const control = name => ({
    name,
    click: async () => events.push(`${name}:click`),
    hover: async () => events.push(`${name}:hover`),
  });
  const globalPlayer = {
    player,
    collapse: { root: control('collapse') },
    expandedShell: {},
    compactPlayer: {
      root: {},
      coverButton: control('cover'),
      expand: { root: control('expand') },
      controls: { playPauseButton: control('play') },
    },
    readViewCheckpoint: async () => ({
      mode: events.some(event => event === 'expand:click' || event === 'cover:click') ? 'expanded' : 'compact',
      style,
    }),
  };
  const expect = actual => ({
    toBe: expected => assert.equal(actual, expected),
    toHaveClass: async () => {},
    toHaveAttribute: async (name, value) => {
      if (name === 'data-compact-presentation') assert.equal(value, presentation);
    },
    toHaveCSS: async (name, value) => {
      if (actual === player) assert.equal(value, player.css[name]);
    },
    toBeVisible: async () => {
      assert.ok(actual.name !== 'expand' || presentation === 'floating', 'Only floating owns a visible expand chevron');
    },
    not: { toHaveClass: async () => {} },
  });
  const context = vm.createContext({ expect });
  const source = fs.readFileSync(path.resolve(__dirname, '../e2e/actions/globalPlayerActions.js'), 'utf8')
    .replace(/^import[^\n]+\r?\n/gm, '').replace('export class ', 'class ');
  vm.runInContext(`${source};globalThis.Actions = GlobalPlayerActions;`, context);
  return { actions: new context.Actions(globalPlayer), events, style };
}

for (const presentation of ['docked', 'rail_play', 'rail_artbox', 'floating']) {
  test(`compact collapse waits for approved ${presentation} geometry`, async () => {
    const { actions, events, style } = scenario(presentation);
    await actions.collapsePlayer(style, { presentation });
    assert.deepEqual(events, ['collapse:click']);
  });
  test(`compact ${presentation} expands through its supported native control`, async () => {
    const { actions, events } = scenario(presentation);
    await actions.expandPlayer();
    assert.deepEqual(events, presentation === 'floating' ? ['expand:click']
      : presentation === 'rail_play' ? ['play:hover', 'cover:click'] : ['cover:click']);
  });
}
