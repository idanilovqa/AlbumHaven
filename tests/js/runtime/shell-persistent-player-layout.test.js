const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.join(__dirname, '..', '..', '..');
const stylesheetPath = path.join(
  repoRoot,
  'music_app',
  'static',
  'css',
  'runtime',
  'shell-persistent-player.css',
);
const templatePath = path.join(repoRoot, 'music_app', 'templates', 'index.html');

function readPersistentPlayerStylesheet() {
  assert.ok(
    fs.existsSync(stylesheetPath),
    'the runtime shell must provide shell-persistent-player.css',
  );
  return fs.readFileSync(stylesheetPath, 'utf8');
}

function declarationBlockFor(css, selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = new RegExp(`(?:^|})\\s*([^{}]*${escapedSelector}[^{}]*)\\{([^{}]*)\\}`, 'm');
  const match = css.match(rule);
  assert.ok(match, `Expected ${selector} in the persistent-player shell stylesheet.`);
  return match[2];
}

test('the persistent shell stylesheet foregrounds the global player', () => {
  const css = readPersistentPlayerStylesheet();
  const declarations = declarationBlockFor(css, '.global-player');

  assert.match(declarations, /position:\s*(?:relative|fixed|sticky)\s*;/);
  assert.match(declarations, /z-index:\s*[1-9]\d*\s*;/);
  assert.match(declarations, /isolation:\s*isolate\s*;/);
});

test('every app-owned fixed surface reserves the persistent player lane', () => {
  const css = readPersistentPlayerStylesheet();
  const surfaces = [
    '.track-modal',
    '.utility-modal',
    '.confirm-modal',
    '.repair-progress-overlay',
    '.tag-editor-modal',
    '.cover-lookup-modal',
    '.non-album-modal',
  ];

  for (const selector of surfaces) {
    assert.match(
      declarationBlockFor(css, selector),
      /bottom:\s*var\(--player-height\)\s*;/,
      `${selector} must stop at the top of the persistent player lane`,
    );
  }

  assert.match(
    declarationBlockFor(css, '.cover-lookup-drawer'),
    /height:\s*calc\(100vh\s*-\s*var\(--player-height\)\)\s*;/,
  );
});

test('the cover lookup dialog reserves clearance below top-center alerts', () => {
  const css = readPersistentPlayerStylesheet();

  assert.match(
    declarationBlockFor(css, '.cover-lookup-modal-dialog'),
    /calc\(100vh\s*-\s*var\(--player-height\)\s*-\s*96px\)/,
  );
});

test('full-cover lightbox restores viewport coverage above the persistent player', () => {
  const css = readPersistentPlayerStylesheet();
  const playerDeclarations = declarationBlockFor(css, '.global-player');
  const lightboxDeclarations = declarationBlockFor(css, '.image-lightbox');
  const imageDeclarations = declarationBlockFor(css, '.image-lightbox-image');
  const playerZ = Number(playerDeclarations.match(/z-index:\s*(\d+)/)?.[1] || 0);
  const lightboxZ = Number(lightboxDeclarations.match(/z-index:\s*(\d+)/)?.[1] || 0);

  assert.match(lightboxDeclarations, /bottom:\s*0\s*;/);
  assert.ok(lightboxZ > playerZ, 'full-cover lightbox must stack above the player');
  assert.match(imageDeclarations, /max-height:\s*calc\(100vh\s*-\s*40px\)\s*;/);
});

test('the template loads the persistent shell ownership layer last', () => {
  const template = fs.readFileSync(templatePath, 'utf8');
  const runtimeStyles = Array.from(
    template.matchAll(/filename='css\/runtime\/([^']+\.css)'/g),
    (match) => match[1],
  );

  assert.equal(runtimeStyles.at(-1), 'shell-persistent-player.css');
  assert.ok(
    runtimeStyles.indexOf('shell-persistent-player.css')
      > runtimeStyles.indexOf('cover-lookup-modal.css'),
    'the persistent shell stylesheet must load after the existing modal and drawer styles',
  );
});
