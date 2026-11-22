// The shared identity table (owner-approved X4, batch 5c): artist problems and "MusicBrainz:
// artist undecided" use one builder, and MusicBrainz Info will take it as it is.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const repoRoot = path.join(__dirname, '..', '..', '..');
const read = (relative) => fs.readFileSync(path.join(repoRoot, relative), 'utf8');
const ButtonComponent = require(path.join(repoRoot, 'music_app/static/js/button-component.js'));

function loadContext() {
  const context = { console, ButtonComponent, state: { utility: {} }, window: {}, document: { querySelector: () => null } };
  vm.createContext(context);
  for (const name of ['markup-format-helpers', 'alert-components', 'compact-data-table', 'utility-list-builders']) {
    vm.runInContext(read(`music_app/static/js/runtime/${name}.js`), context);
  }
  return context;
}

const FIRST = '00000000-0000-4000-8000-0000000000c1';
const SECOND = '00000000-0000-4000-8000-0000000000c2';
const ROWS = [
  { mbid: FIRST, name: 'Example', prefix: 'Suggested: ', facts: 'example metal band', evidence: '1 of 3 sampled recordings',
    url: `https://musicbrainz.org/artist/${FIRST}` },
  { mbid: SECOND, name: 'Example', evidence: 'No sampled recordings', url: `https://musicbrainz.org/artist/${SECOND}` },
];

test('the table draws the rows and selection it is given, reading no Problematic Files state', () => {
  const html = loadContext().buildMusicBrainzIdentityTableHtml({
    rows: ROWS, selectedMbid: FIRST, ariaLabel: 'MusicBrainz artist candidates', targetLabel: 'Candidate artist / MBID',
  });
  assert.match(html, /aria-label="MusicBrainz artist candidates"/);
  assert.match(html, />Candidate artist \/ MBID</);
  assert.match(html, /<strong>Suggested: Example<\/strong><small>example metal band<\/small>/);
  assert.equal((html.match(/ checked/g) || []).length, 1);
  assert.match(html, new RegExp(`value="${FIRST}"[^>]* checked`));
  assert.match(html, /No sampled recordings/);
  assert.equal((html.match(/data-open-musicbrainz-url=/g) || []).length, 2);
});

test('with nothing selected no row is checked', () => {
  const html = loadContext().buildMusicBrainzIdentityTableHtml({
    rows: ROWS, selectedMbid: null, ariaLabel: 'MusicBrainz artist candidates', targetLabel: 'Candidate artist / MBID',
  });
  assert.doesNotMatch(html, / checked|is-selected/);
});

test('names and facts are escaped', () => {
  const html = loadContext().buildMusicBrainzIdentityTableHtml({
    rows: [{ ...ROWS[0], name: '<img src=x>', facts: '<b>x</b>' }], selectedMbid: null, ariaLabel: 'a', targetLabel: 't',
  });
  assert.doesNotMatch(html, /<img src=x>|<b>x<\/b>/);
});

test('name, details and MBID each take their own line in every row (X4)', () => {
  const css = read('music_app/static/css/runtime/utilities.css');
  const rule = css.match(/\.musicbrainz-identity-line \{([^}]*)\}/)[1];
  assert.match(rule, /display:\s*grid/);
  assert.doesNotMatch(rule, /flex-wrap/);
});

test('a bare action button hovers with a background, never an outline (approved P1, X3)', () => {
  const css = read('music_app/static/css/button-component.css');
  const rule = css.match(/\.action-button--bare[^{]*:hover[^{]*\{([^}]*)\}/)[1];
  assert.match(rule, /border-color:\s*transparent\s*!important/, "the page's hover border must not win over it");
  assert.match(rule, /background:/);
});
