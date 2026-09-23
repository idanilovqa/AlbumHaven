const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const appearanceCss = fs.readFileSync(
  path.join(__dirname, '../../../music_app/static/css/appearance-backgrounds.css'),
  'utf8',
);
const playerCss = fs.readFileSync(
  path.join(__dirname, '../../../music_app/static/css/runtime/non-album-and-player.css'),
  'utf8',
);

test('docked players merge into the sidebar surface with an edge-safe player-color glow', () => {
  assert.match(
    appearanceCss,
    /:root\[data-appearance-player\]:not\(\[data-appearance-native-surface\]\) \.global-player:not\(\.is-docked-compact\)/,
  );
  assert.match(
    appearanceCss,
    /:root \.global-player\.is-docked-compact\s*\{[^}]*radial-gradient\([^}]*var\(--appearance-play,[^}]*transparent 80%[^}]*var\(--appearance-panel-background,\s*var\(--app-chrome\)\);[^}]*color:\s*var\(--appearance-panel-ink,[^}]*box-shadow:\s*none;[^}]*backdrop-filter:\s*none;/s,
  );
  assert.match(
    playerCss,
    /\.global-player\.is-rail-compact\s*\{[^}]*height:\s*100px;[^}]*border:\s*0;[^}]*\}/s,
  );
  assert.doesNotMatch(playerCss, /\.global-player\.is-rail-compact\s*\{[^}]*background:/s);
});

test('compact player metadata bubble uses a soft layered player-color glow', () => {
  assert.match(
    playerCss,
    /\.compact-player-hover-bubble\s*\{[^}]*box-shadow:\s*0 0 12px color-mix\(in srgb, var\(--appearance-play,[^}]*28%, transparent\),\s*0 0 30px color-mix\(in srgb, var\(--appearance-play,[^}]*16%, transparent\),\s*0 8px 24px #0006;/s,
  );
});
