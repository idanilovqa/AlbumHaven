'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {nativeModuleSpecifiers} = require('./native-module-specifiers.cjs');
const rejected = source => assert.throws(() => nativeModuleSpecifiers(source),
  error => error instanceof TypeError && error.message.trim().length > 0);

// Reserved words are ordinary property names here. None can turn division's
// next operand into inert regex text, including after optional chaining.
for (const property of ['return', 'in', 'throw']) {
  for (const access of ['.', '?.']) {
    for (const dependency of ["import('react')", "require('esbuild')"]) {
      test(`keyword property object${access}${property} cannot hide ${dependency} in division`, () => {
        rejected(`const ratio = object${access}${property} / ${dependency} / 2;`);
      });
    }
  }
}
for (const dependency of ["import('./module.mjs')", "require('./module.mjs')"]) {
  test(`contextual identifier of cannot hide ${dependency} in division`, () => {
    rejected(`const of = 2; const ratio = of / ${dependency} / 2;`);
  });
}

// The established reader intentionally fails closed where a slash after a
// declaration is ambiguous. It does not expand that supported lexical grammar.
const declarations = [
  ['ordinary function', "function ordinary() {} /import('react')/.test(text);"],
  ['async function', "async function ordinary() {} /require('esbuild')/.test(text);"],
  ['generator function', "function* ordinary() {} /import('react')/.test(text);"],
  ['async generator function', "async function* ordinary() {} /require('esbuild')/.test(text);"],
  ['function with returned object and intervening comment', "function ordinary() { return {value: 1}; } /* boundary */ /import('react')/.test(text);"],
  ['nested function declaration followed by a real static import', "function outer() { function inner() {} /require('esbuild')/.test(text); } import './after.mjs';"],
];
for (const [name, source] of declarations) test(`ambiguous regex after ${name} fails closed`, () => {
  rejected(source);
});

// A blanket 'closing brace means regex' change would conceal these real calls.
// Each expression and division operand is otherwise valid JavaScript text.
for (const expression of ['function () {}', 'async function () {}', 'function* () {}', '{}', '(() => {})']) {
  for (const dependency of ["import('./module.mjs')", "require('./module.mjs')"]) {
    test(`division after expression ${expression} cannot hide ${dependency}`, () => {
      rejected(`const ratio = ${expression} / ${dependency} / 2;`);
    });
  }
}

// Separate each unsupported branch so the first rejected construct in a
// combined historical input cannot mask another unsupported grammar branch.
for (const [name, source] of [
  ['import.meta', 'const url = import.meta.url;'],
  ['comment-separated import.meta', 'const meta = import /* current */ . meta;'],
  ['keyword-shaped object import', "const row = {import: 'label'};"],
  ['hex-escaped relative path', String.raw`export * from '.\x2fsecond.mjs';`],
  ['code-point-escaped relative path', String.raw`import '\u{2e}/third.mjs';`],
]) test(`shared reader policy rejects standalone ${name}`, () => {rejected(source);});
