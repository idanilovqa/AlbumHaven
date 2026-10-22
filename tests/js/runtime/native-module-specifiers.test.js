'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const {nativeModuleSpecifiers} = require('./native-module-specifiers.cjs');

// These are source strings, never evaluated or imported. The actual scanner is
// the only owner under test; expected specifiers are independently enumerated.
const accepted = [
  ['empty source', '', []],
  ['ordinary executable text is only inspected', "throw new Error('scanner must not execute source');", []],
  ['truthful import operation labels followed by comma', "const labels = {read: 'Loading import', cancel: 'Canceling import', finalize: 'Saving Album Top'};", []],
  ['truthful pending-card title beside other strings', "const card = {title: 'Album Top import', byline: 'Submission result unknown'}; const actions = ['Canceling import', 'Cancellation result unknown'];", []],
  ['quoted import and require lookalikes', "const a = \"import value from 'react'\"; const b = 'require(\"esbuild\")';", []],
  ['escaped quotes do not end an ordinary string early', String.raw`const text = 'quote \' import("react") and from "react-dom"';`, []],
  ['line comments are inert, including end of file', "// import 'react'; require('esbuild')\nconst ok = true; // import('./hidden.mjs')", []],
  ['block comments are inert', "/* import value from 'react'; require('esbuild'); ` ${ import('./hidden.mjs') } */ const ok = true;", []],
  ['regex bodies are inert', String.raw`const pattern = /import\s*\(\s*['"]react['"]\)|require\('esbuild'\)/g;`, []],
  ['regex escaped slashes and character classes stay inside the literal', String.raw`const pattern = /[\/'"](?:import|require)\(['"]react['"]\)/;`, []],
  ['regex after return is not executable import text', String.raw`function check(text) { return /import\('react'\)/.test(text); }`, []],
  ['raw template text is inert', "const label = `import item from 'react'; require('esbuild'); import('./hidden.mjs')`;", []],
  ['escaped template backtick and interpolation marker are raw text', "const label = `escaped \\` import('react') \\${require('esbuild')}`;", []],
  ['safe template interpolation inspects strings without executing their contents', "const text = `value ${({label: \"import('react')\", other: 'require(\"esbuild\")'}).label}`;", []],
  ['nested templates and regex interpolation are balanced', "const text = `outer ${`inner ${({label: 'Loading import'}).label}`} ${/require/.test('import')}`;", []],
  ['division remains ordinary executable arithmetic', "const ratio = left / right / denominator; const value = (left + right) / scale;", []],
  ['default and named static imports', "import first from './first.mjs'; import {second, third as alias} from '../second.mjs';", ['./first.mjs', '../second.mjs']],
  ['namespace and combined imports', "import * as names from './names.mjs'; import main, {extra as local} from './combined.mjs';", ['./names.mjs', './combined.mjs']],
  ['side-effect imports and export-from in source order', "import './side.mjs'; export {value as alias} from './named.mjs'; export * from '../star.mjs'; export * as group from './group.mjs';", ['./side.mjs', './named.mjs', '../star.mjs', './group.mjs']],
  ['multiline static declarations', "import {\n first,\n second as alias\n} from\n './multi.mjs';\nexport {\n first\n} from '../out.mjs';", ['./multi.mjs', '../out.mjs']],
  ['comments may separate static tokens', "import /* a */ value /* b */ from /* c */ './value.mjs'; export /* d */ {value} /* e */ from /* f */ '../out.mjs'; import /* g */ './side.mjs';", ['./value.mjs', '../out.mjs', './side.mjs']],
  ['same-line declarations are not lost to line anchoring', "const label = 'Loading import'; import './one.mjs'; const note = 'Album Top import'; export {value} from './two.mjs';", ['./one.mjs', './two.mjs']],
  ['duplicates are returned in source order for the traversal owner', "import './same.mjs'; export * from './other.mjs'; import './same.mjs';", ['./same.mjs', './other.mjs', './same.mjs']],
  ['lookalikes around actual declarations do not add dependencies', "const label = 'Canceling import'; /* from 'react' */ import './real.mjs'; const text = `require('esbuild')`; export {value} from './out.mjs';", ['./real.mjs', './out.mjs']],
  ['export without from has no dependency', "const value = 'react'; export {value}; export default value;", []],
];
for (const [name, source, expected] of accepted) test(`native scanner accepts ${name}`, () => {
  assert.deepEqual(nativeModuleSpecifiers(source), expected);
});

// Contract R2 reuses the established delivery reader's supported grammar.
// These exact R1 inputs remain covered, now explicitly failing closed.
const unsupported = [
  ['metadata and keyword-shaped object import syntax', "const url = import.meta.url; const meta = import /* current */ . meta; const row = {import: 'label', require: 'label', from: 'react'};"],
  ['escaped relative static specifiers', String.raw`import '\u002e/first.mjs'; export * from '.\x2fsecond.mjs'; import '\u{2e}/third.mjs';`],
  ['static specifier line continuation', "import './fi\\\nle.mjs';"],
];
for (const [name, source] of unsupported) test(`native scanner rejects unsupported ${name}`, () => {
  assert.throws(() => nativeModuleSpecifiers(source), error => error instanceof TypeError && error.message.trim().length > 0);
});

const forbidden = [
  ['bare side-effect React', "import 'react';"],
  ['bare default React', "import React from 'react';"],
  ['bare named React', "import {useState} from 'react';"],
  ['React DOM subpath', "import {createRoot} from 'react-dom/client';"],
  ['esbuild namespace', "import * as build from 'esbuild';"],
  ['other bare package', "import value from '@scope/package';"],
  ['Node bare scheme', "import fs from 'node:fs';"],
  ['bare export-from', "export {build} from 'esbuild';"],
  ['bare star export', "export * from 'react-dom';"],
  ['bare namespace export', "export * as value from 'unrelated-package';"],
  ['escaped bare specifier', String.raw`import 'r\u0065act';`],
  ['escaped bare export specifier', String.raw`export * from 'es\x62uild';`],
  ['bare specifier with line continuation', "import 're\\\nact';"],
  ['bare import after harmless string text', "const label = 'Album Top import'; import /* real */ value from 'react';"],
  ['relative dynamic import', "const value = import('./module.mjs');"],
  ['bare dynamic import', "const value = import('react');"],
  ['dynamic import separated by comments', "const value = import /* real */ ( /* argument */ './module.mjs');"],
  ['dynamic import separated by line breaks', "const value = import\n(\n'./module.mjs'\n);"],
  ['relative require', "const value = require('./module.mjs');"],
  ['bare require separated by comments', "const value = require /* real */ ( /* argument */ 'esbuild');"],
  ['require separated by line breaks', "const value = require\n(\n'./module.mjs'\n);"],
  ['conservative import property call', "const value = object.import('./module.mjs');"],
  ['conservative require property call', "const value = object.require /* real */ ('./module.mjs');"],
  ['dynamic call inside template interpolation', "const label = `value ${import('./module.mjs')}`;"],
  ['require inside nested template interpolation', "const label = `outer ${`inner ${require('./module.mjs')}`}`;"],
  ['dynamic call after nested object and comment inside interpolation', "const label = `value ${({label: 'safe'}).label + /* real */ import('./module.mjs')}`;"],
  ['dynamic call as division operand', "const ratio = numerator / import('./module.mjs');"],
  ['require after chained division', "const ratio = numerator / denominator / require('./module.mjs');"],
  ['dynamic call after a regex literal', String.raw`const value = /import\('inert'\)/.test(text) ? import('./module.mjs') : null;`],
];
for (const [name, source] of forbidden) test(`native scanner rejects ${name}`, () => {
  assert.throws(() => nativeModuleSpecifiers(source), error => error instanceof TypeError && error.message.trim().length > 0);
});

const malformed = [
  ['block comment', "import './valid.mjs'; /* unterminated"],
  ['single-quoted string', "const label = 'unterminated"],
  ['double-quoted string', 'const label = "unterminated'],
  ['string escape at end of input', "const label = 'unterminated\\"],
  ['static specifier', "import './unterminated.mjs"],
  ['raw template', "const label = `unterminated"],
  ['template interpolation', "const label = `value ${({label: 'safe'}).label"],
  ['nested template', "const label = `outer ${`inner"],
  ['regex literal', 'const pattern = /unterminated'],
  ['regex character class', 'const pattern = /[unterminated'],
  ['regex escape at end of input', 'const pattern = /unterminated\\'],
];
for (const [name, source] of malformed) test(`native scanner fails closed for unclosed ${name}`, () => {
  assert.throws(() => nativeModuleSpecifiers(source), error => error instanceof TypeError && error.message.trim().length > 0);
});

// Use the actual delivered sources that exposed the lexical false positive.
// These checks read text only: product modules and their globals are not loaded.
const root = path.resolve(__dirname, '../../..');
for (const [file, expected, labels] of [
  ['source-import-view.mjs', ['../home-friends/native-controls.mjs', '../playlists/reorder.mjs', './builder.mjs', './model.mjs', './source-import-match-session.mjs'], ['Loading import', 'Canceling import']],
  ['source-import-tasks.mjs', ['./source-import-controller.mjs'], ['Canceling import', 'Loading import', 'Album Top import']],
]) test(`native scanner reads truthful labels in actual ${file}`, () => {
  const source = fs.readFileSync(path.join(root, 'music_app/static/js/album-tops', file), 'utf8');
  for (const label of labels) assert.ok(source.includes(label), `actual regression label ${label}`);
  assert.deepEqual(nativeModuleSpecifiers(source), expected);
});
