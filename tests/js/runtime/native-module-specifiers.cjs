'use strict';
const {tokens, moduleImports} = require('./native-module-reader.cjs');
// Reuse the existing delivery grammar; retain the Library Mix fixture's
// conservative policy for executable property calls as well as ordinary calls.
function nativeModuleSpecifiers(source) {
  if (typeof source !== 'string') throw new TypeError('Native module source must be text.');
  try {
    const input = tokens(source);
    for (let index = 0; index < input.length; index++) {
      if (input[index].kind === 'word' && ['import', 'require'].includes(input[index].value)
          && input[index + 1]?.value === '(') throw new TypeError('Dynamic import/require is not allowed in the native closure.');
    }
    const specifiers = moduleImports(source);
    for (const specifier of specifiers) {
      if (!specifier.startsWith('.')) throw new TypeError('Bare native dependency: ' + specifier);
    }
    return specifiers;
  } catch (error) {
    throw new TypeError(error?.message || 'Unsupported native module syntax.');
  }
}
module.exports = {nativeModuleSpecifiers};
