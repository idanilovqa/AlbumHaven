const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const appChromeCss = fs.readFileSync(
  path.join(__dirname, '..', '..', 'music_app', 'static', 'css', 'app-chrome.css'),
  'utf8',
);

test('desktop library search aligns to the main panel outer edge', () => {
  assert.match(
    appChromeCss,
    /\.app-bar \.toolbar-left\s*\{[^}]*padding-left:\s*0;/,
  );
});

test('app-bar search keeps the native clear control close to the search action', () => {
  assert.match(
    appChromeCss,
    /\.app-bar \.search-field \.search-field-control\s*>\s*input\[type='search'\]\s*\{[^}]*padding-right:\s*0;/,
  );
});
