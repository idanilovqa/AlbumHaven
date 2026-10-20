'use strict';
const assert = require('node:assert/strict');

// A bounded lexical reader, not a JavaScript evaluator. Keep quoted text,
// comments and regexp bodies out of dependency discovery; inspect ${...} code.
function tokens(source) {
  const result = [];
  let i = 0;
  function quoted(quote) {
    let value = '';
    i++;
    while (i < source.length) {
      const character = source[i++];
      if (character === quote) return {kind: 'string', value};
      if (character === '\\') {
        assert.ok(i < source.length, 'Unterminated string escape');
        value += '\\' + source[i++];
      } else value += character;
    }
    throw new Error('Unterminated string');
  }
  function code(untilBrace = false) {
    let depth = 0;
    while (i < source.length) {
      const character = source[i];
      if (/\s/.test(character)) {i++; continue;}
      if (source.startsWith('//', i)) {
        const end = source.indexOf('\n', i + 2); i = end < 0 ? source.length : end + 1; continue;
      }
      if (source.startsWith('/*', i)) {
        const end = source.indexOf('*/', i + 2);
        assert.notEqual(end, -1, 'Unterminated comment'); i = end + 2; continue;
      }
      if (character === '"' || character === "'") {result.push(quoted(character)); continue;}
      if (character === '`') {
        i++;
        let closed = false;
        while (i < source.length) {
          if (source[i] === '\\') {i += 2; continue;}
          if (source[i] === '`') {i++; closed = true; break;}
          if (source.startsWith('${', i)) {i += 2; code(true); continue;}
          i++;
        }
        assert.ok(closed, 'Unterminated template literal');
        result.push({kind: 'literal', value: '`'}); continue;
      }
      const previous = result.at(-1), beforePrevious = result.at(-2);
      // Quoted values and property names such as object.return are expression
      // operands, even when their text looks like an expression-start keyword.
      // Unclassified slash positions remain visible tokens: never discard a
      // potential import as a regexp body merely because context is ambiguous.
      const regexpStart = previous === undefined
        || (previous.kind === 'punctuation' && /^(?:[=(:,;!&|?{\[]|=>)$/.test(previous.value))
        || (previous.kind === 'word' && /^(?:return|throw|case)$/.test(previous.value)
          && beforePrevious?.value !== '.');
      if (character === '/' && regexpStart) {
        i++;
        let inClass = false, closed = false;
        while (i < source.length) {
          const next = source[i++];
          if (next === '\\') {i++; continue;}
          if (next === '[') inClass = true;
          if (next === ']') inClass = false;
          if (next === '/' && !inClass) {closed = true; break;}
          assert.ok(next !== '\n' && next !== '\r', 'Unterminated regexp');
        }
        assert.ok(closed, 'Unterminated regexp');
        while (/[a-z]/i.test(source[i] || '') && i < source.length) i++;
        result.push({kind: 'literal', value: '/regexp/'}); continue;
      }
      if (/[A-Za-z_$]/.test(character)) {
        const start = i++;
        while (i < source.length && /[\w$]/.test(source[i])) i++;
        result.push({kind: 'word', value: source.slice(start, i)}); continue;
      }
      if (character === '}' && untilBrace && depth === 0) {i++; return;}
      if (character === '{') depth++;
      if (character === '}') depth--;
      const punctuation = source.startsWith('=>', i) ? '=>' : character;
      result.push({kind: 'punctuation', value: punctuation}); i += punctuation.length;
    }
    assert.equal(untilBrace, false, 'Unterminated template interpolation');
  }
  code();
  return result;
}

function moduleImports(source) {
  const input = tokens(source), imports = [];
  const value = index => input[index]?.value;
  function specifier(index) {
    assert.equal(input[index]?.kind, 'string', 'Module specifier must be a quoted literal');
    assert.ok(!/[\\\r\n]/.test(value(index)), 'Escaped module specifiers are not supported');
    imports.push(value(index));
    assert.ok(value(index + 1) !== 'with' && value(index + 1) !== 'assert', 'Import attributes require a reviewed delivery contract');
    return index;
  }
  for (let i = 0; i < input.length; i++) {
    if (input[i].kind !== 'word' || value(i - 1) === '.') continue;
    if (value(i) === 'require' && value(i + 1) === '(') {
      throw new Error('CommonJS dependencies are not browser-native imports');
    }
    if (value(i) === 'import') {
      assert.notEqual(value(i + 1), '(', 'Dynamic imports require a reviewed delivery contract');
      assert.notEqual(value(i + 1), '.', 'import.meta requires a reviewed delivery contract');
      if (input[i + 1]?.kind === 'string') {i = specifier(i + 1); continue;}
      let cursor = i + 1;
      while (cursor < input.length && value(cursor) !== 'from') {
        assert.ok(input[cursor].kind === 'word' || ['{', '}', ',', '*'].includes(value(cursor)), 'Unrecognized static import syntax');
        cursor++;
      }
      assert.ok(cursor < input.length, 'Static import is missing from');
      i = specifier(cursor + 1);
    } else if (value(i) === 'export' && ['*', '{'].includes(value(i + 1))) {
      let cursor = i + 1;
      if (value(cursor) === '{') {
        while (cursor < input.length && value(cursor) !== '}') cursor++;
        assert.ok(cursor < input.length, 'Unterminated export list');
        cursor++;
        if (value(cursor) !== 'from') continue;
      } else {
        cursor++;
        if (value(cursor) === 'as') cursor += 2;
        assert.equal(value(cursor), 'from', 'Unrecognized export-from syntax');
      }
      i = specifier(cursor + 1);
    }
  }
  return imports;
}

module.exports = {tokens, moduleImports};
