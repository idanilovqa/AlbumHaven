const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..', '..', '..', 'music_app', 'static');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(root, 'js', 'runtime', 'running-line.js'), 'utf8'), context);
const plain = (value) => JSON.parse(JSON.stringify(value));

test('RunningLine ignores rounding and moves overflowing text at a readable 12 px/s', () => {
  assert.deepEqual(plain(context.resolveRunningLineMotion()), { overflowing: false, distance: 0, durationMs: 0 });
  assert.deepEqual(plain(context.resolveRunningLineMotion({ scrollWidth: 101, clientWidth: 100 })), { overflowing: false, distance: 0, durationMs: 0 });
  const long = context.resolveRunningLineMotion({ scrollWidth: 340, clientWidth: 100 });
  assert.equal(long.distance, 240);
  // 70% of each leg moves: 240 px must take 20 s of movement (12 px/s), never the old ~6 s.
  assert.equal(Math.round(long.durationMs * 0.7), 20000);
  assert.equal(context.resolveRunningLineMotion({ scrollWidth: 110, clientWidth: 100 }).durationMs, 4000, 'short overflow keeps a readable minimum');
});

test('every running line uses the one shared keyframe and timing variables', () => {
  const css = ['css/mobile-layout.css', 'css/runtime/non-album-and-player.css', 'css/runtime/album-track-table.css']
    .map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
  const animations = css.match(/animation:\s*[a-z-]*pan[^;]*;/g) || [];
  assert.ok(animations.length >= 4);
  for (const rule of animations) assert.equal(rule, 'animation: running-line-pan var(--running-line-duration) linear infinite alternate;');
  assert.doesNotMatch(css, /@keyframes [a-z-]*pan\b/, 'surfaces do not define their own pan keyframes');
  assert.match(fs.readFileSync(path.join(root, 'css/runtime/running-line.css'), 'utf8'), /@keyframes running-line-pan/);
});
