'use strict';

// Static inventory of frontend interaction entrypoints and the bounded-work
// hazards reachable from them. Discovery proves coverage, not boundedness:
// hazards are computed for every entrypoint (listener, timer, observer, worker
// message, request owner). Direct hazards inside a high-frequency handler are
// rejected outright. Every hazard records whether its entrypoint is a hot path
// (see isHotEntrypoint); only hot-path hazards require a deterministic runtime
// contract, while the others still select contracts for changed files.

const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');

const JS_ROOT = 'music_app/static/js';
const EXCLUDED_JS = [/(^|\/)runtime-bundle\.js$/, /(^|\/)vendor\//, /(^|\/)dist\//, /\.min\.js$/];

const HIGH_FREQUENCY_EVENTS = new Set([
  'pointermove', 'mousemove', 'scroll', 'wheel', 'touchmove', 'input', 'mouseover', 'pointerover', 'dragover', 'resize',
]);
// Events that keep firing while they last but are not per-frame input:
// channel and worker messages (worker, worklet port, socket, broadcast), media
// playback progress, and an ongoing text selection or drag. Their handlers are
// hot paths without rejecting per-event work outright.
const REPEATING_EVENTS = new Set([...HIGH_FREQUENCY_EVENTS, 'message', 'timeupdate', 'selectionchange', 'drag', 'pointerrawupdate']);
const TIMER_CALLS = new Set(['setInterval', 'setTimeout', 'requestAnimationFrame']);
const DEFERRED_CALLBACK_CALLS = new Set(['setTimeout', 'requestAnimationFrame', 'queueMicrotask', 'requestIdleCallback']);
const OBSERVERS = new Set(['MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'PerformanceObserver']);
const MAX_RESOLUTION_DEPTH = 8;
const GLOBAL_OBJECTS = new Set(['window', 'globalThis', 'global', 'self']);
const ITERATION_METHODS = new Set([
  'forEach', 'map', 'filter', 'reduce', 'sort', 'find', 'findIndex', 'findLast', 'some', 'every', 'flatMap',
  'includes', 'indexOf', 'join', 'slice',
]);
const LOOP_BOUND_OPERATORS = new Set(['<', '<=', '>', '>=', '!==', '!=']);
const DOM_COLLECTION_QUERIES = new Set(['querySelectorAll', 'getElementsByClassName', 'getElementsByTagName', 'getElementsByName']);
const OBJECT_ENUMERATION = new Set(['keys', 'values', 'entries']);
const STORAGE_OBJECTS = new Set(['localStorage', 'sessionStorage']);
const STRING_METHODS = new Set(['split', 'trim', 'toLowerCase', 'toUpperCase', 'replace', 'replaceAll', 'match', 'matchAll']);
const STRING_ARRAY_METHODS = new Set(['split', 'match', 'matchAll']);
// Global calls that return a primitive, never a shared collection.
const PRIMITIVE_RESULTS = new Set(['String', 'Number', 'Boolean', 'encodeURIComponent', 'decodeURIComponent', 'parseInt', 'parseFloat']);
// Methods whose result is always a primitive, whatever the receiver.
const SCALAR_METHODS = new Set([
  'join', 'toString', 'toFixed', 'toPrecision', 'toISOString', 'toLocaleString', 'padStart', 'padEnd', 'substring',
  'charAt', 'charCodeAt', 'codePointAt', 'trimStart', 'trimEnd', 'localeCompare', 'normalize', 'startsWith',
  'endsWith', 'getAttribute',
]);
// Copying methods: the result is no longer than a bounded receiver.
const BOUNDED_COPY_METHODS = new Set(['map', 'filter', 'slice', 'reverse']);
// Reads and copies that return part of their receiver and never merge in
// another value: on a value bounded by construction, the result is too.
const DERIVED_READ_METHODS = new Set(['filter', 'slice', 'reverse', 'at', 'find', 'findLast', 'keys', 'values', 'entries', 'get', 'getAll']);
const MUTATOR_METHODS = new Set(['push', 'unshift', 'splice', 'fill', 'copyWithin', 'set', 'add', 'append']);
const FIXED_LENGTH_CONSTRUCTORS = new Set([
  'Array', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
  'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
]);
// Calls that read an argument without retaining or mutating it.
const READ_ONLY_CALLS = new Set(['Object.keys', 'Object.values', 'Object.entries', 'Object.freeze', 'JSON.stringify', 'String', 'Boolean', 'Number']);
const MARKUP_PROPERTIES = new Set(['innerHTML', 'outerHTML']);
const GENERIC_ENDPOINTS = ['/view-data'];
const DEDICATED_SURFACES = new Map([['home', '/home-data']]);
const MAX_CALL_DEPTH = 6;

function normalizePath(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\//, '');
}

// Request path without query; template holes become one-segment wildcards.
function normalizeEndpoint(target) {
  return String(target || '').split('?')[0].replaceAll('${}', '*').replace(/\/+$/, '') || '/';
}

function parseSource(source, filePath) {
  const options = { ecmaVersion: 'latest', locations: true, allowHashBang: true };
  try {
    return acorn.parse(source, { ...options, sourceType: 'module' });
  } catch (moduleError) {
    try {
      return acorn.parse(source, { ...options, sourceType: 'script', allowReturnOutsideFunction: true });
    } catch (scriptError) {
      throw new Error(`cannot parse ${filePath}: ${scriptError.message}`);
    }
  }
}

function walkAst(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  if (visit(node) === false) return;
  for (const key of Object.keys(node)) {
    if (key === 'loc') continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) walkAst(item, visit);
    } else if (child && typeof child.type === 'string') {
      walkAst(child, visit);
    }
  }
}

function isFunction(node) {
  return node?.type === 'FunctionExpression' || node?.type === 'ArrowFunctionExpression' || node?.type === 'FunctionDeclaration';
}

function propertyName(node) {
  if (!node) return '';
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'Literal') return String(node.value);
  if (node.type === 'PrivateIdentifier') return `#${node.name}`;
  return '';
}

function memberProperty(node) {
  return node?.type === 'MemberExpression' && !node.computed ? propertyName(node.property) : '';
}

function calleeName(call) {
  const callee = call?.callee;
  if (callee?.type === 'Identifier') return callee.name;
  if (callee?.type === 'MemberExpression') return memberProperty(callee);
  return '';
}

// True for a template hole that renders either nothing or a query string, as in
// `/view-data${qs ? `?${qs}` : ''}`: the request path does not depend on it.
function isQuerySuffix(node) {
  if (node?.type === 'ConditionalExpression') return isQuerySuffix(node.consequent) && isQuerySuffix(node.alternate);
  if (node?.type === 'LogicalExpression' && node.operator === '&&') return isQuerySuffix(node.right);
  if (node?.type === 'Literal') return node.value === '' || (typeof node.value === 'string' && node.value.startsWith('?'));
  return node?.type === 'TemplateLiteral' && node.quasis[0].value.cooked.startsWith('?');
}

function stringValue(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type !== 'TemplateLiteral') return null;
  return node.quasis.map((quasi, index) => {
    const hole = node.expressions[index];
    if (!hole) return quasi.value.cooked;
    return `${quasi.value.cooked}${isQuerySuffix(hole) ? '?${}' : '${}'}`;
  }).join('');
}

// Each named function, variable-assigned function, or class method owns the
// anonymous callbacks nested inside it.
function annotateOwners(ast) {
  const owners = new Map();
  const visit = (node, owner, className, scope, parent) => {
    if (!node || typeof node.type !== 'string') return;
    let nextOwner = owner;
    let nextClass = className;
    if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
      nextClass = node.id?.name || className;
    } else if (node.type === 'FunctionDeclaration' && node.id) {
      nextOwner = node.id.name;
    } else if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier') {
      if (isFunction(node.init)) nextOwner = node.id.name;
      if (node.init?.type === 'ClassExpression') nextClass = node.id.name;
    } else if (node.type === 'MethodDefinition' || node.type === 'PropertyDefinition') {
      if (node.type === 'MethodDefinition' || isFunction(node.value)) {
        nextOwner = `${className || '<class>'}.${propertyName(node.key)}`;
      }
    }
    // `scope` is the enclosing function of the node; a function's own scope is
    // its parent, and its children are scoped to it.
    owners.set(node, { owner: nextOwner, className: nextClass, scope, parent });
    const childScope = isFunction(node) ? node : scope;
    for (const key of Object.keys(node)) {
      if (key === 'loc') continue;
      const child = node[key];
      if (Array.isArray(child)) child.forEach(item => visit(item, nextOwner, nextClass, childScope, node));
      else if (child && typeof child.type === 'string') visit(child, nextOwner, nextClass, childScope, node);
    }
  };
  visit(ast, '<top-level>', '', null, null);
  return owners;
}

function parseFile(source, filePath) {
  const ast = parseSource(source, filePath);
  return { path: normalizePath(filePath), ast, owners: annotateOwners(ast) };
}

function ownerOf(file, node) {
  return file.owners.get(node) || { owner: '<top-level>', className: '', scope: null };
}

// Global function and class-method definitions plus the classes of known
// instances: global singletons (`const virtualGrid = new VirtualArtistGrid()`,
// `window.x = new C()`) and instance fields (`this.grid = new C()`). Runtime
// scripts share one global scope through the runtime bundle, so name
// resolution is cross-file.
function indexDefinitions(files) {
  const functions = new Map();
  const methods = new Map();
  const instances = new Map();
  const add = (map, name, def) => {
    if (!name) return;
    if (!map.has(name)) map.set(name, []);
    map.get(name).push(def);
  };
  const constructed = node => (node?.type === 'NewExpression' && node.callee.type === 'Identifier' ? node.callee.name : '');
  for (const file of files) {
    walkAst(file.ast, (node) => {
      const { className, scope } = ownerOf(file, node);
      if (node.type === 'FunctionDeclaration' && node.id) {
        add(functions, node.id.name, { file, node, name: node.id.name });
      } else if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && isFunction(node.init)) {
        add(functions, node.id.name, { file, node: node.init, name: node.id.name });
      } else if (node.type === 'MethodDefinition' || (node.type === 'PropertyDefinition' && isFunction(node.value))) {
        const name = propertyName(node.key);
        add(methods, `${className}.${name}`, { file, node: node.value, name: `${className}.${name}` });
      } else if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && !scope && constructed(node.init)) {
        add(instances, node.id.name, constructed(node.init));
      } else if (node.type === 'AssignmentExpression' && constructed(node.right) && node.left.type === 'MemberExpression') {
        const target = node.left.object;
        if (GLOBAL_OBJECTS.has(target.name)) add(instances, memberProperty(node.left), constructed(node.right));
        else if (target.type === 'ThisExpression' && className) add(instances, `${className}#${memberProperty(node.left)}`, constructed(node.right));
      }
    });
  }
  return { files, functions, methods, instances };
}

function unwrapChain(node) {
  return node?.type === 'ChainExpression' ? node.expression : node;
}

// Classes a call receiver is known to hold: a global singleton, `window.x`, or
// a field assigned from a constructor on the enclosing class.
function receiverClasses(receiver, context, index) {
  const node = unwrapChain(receiver);
  if (node?.type === 'Identifier') return index.instances.get(node.name) || [];
  if (node?.type !== 'MemberExpression') return [];
  if (GLOBAL_OBJECTS.has(node.object.name)) return index.instances.get(memberProperty(node)) || [];
  if (node.object.type === 'ThisExpression') return index.instances.get(`${context.className}#${memberProperty(node)}`) || [];
  return [];
}

// A name bound inside an enclosing function (a local function, a parameter, a
// local value) is that binding, never a same-named function elsewhere: a
// callback parameter called `resolve` or a local `cancel` must not stand for
// every `resolve` or `cancel` in the runtime. Other names are global.
function resolveIdentifier(reference, file, index) {
  const defs = index.functions.get(reference.name) || [];
  for (let scope = ownerOf(file, reference).scope; scope; scope = ownerOf(file, scope).scope) {
    const local = defs.filter(def => def.file === file && ownerOf(file, def.node).scope === scope);
    if (local.length) return local;
    if (scopeDeclarations(file, scope).has(reference.name)) return [];
  }
  return defs;
}

function resolveCallable(target, context, index) {
  const node = unwrapChain(target);
  if (!node) return [];
  if (isFunction(node)) return [{ file: context.file, node, name: '<inline>' }];
  if (node.type === 'Identifier') return resolveIdentifier(node, context.file, index);
  if (node.type === 'CallExpression' && memberProperty(node.callee) === 'bind') {
    return resolveCallable(node.callee.object, context, index);
  }
  if (node.type !== 'MemberExpression') return [];
  const property = memberProperty(node);
  // `fn.call(...)` and `fn.apply(...)` run `fn`.
  if (property === 'call' || property === 'apply') return resolveCallable(node.object, context, index);
  if (node.object.type === 'ThisExpression') return index.methods.get(`${context.className}.${property}`) || [];
  if (GLOBAL_OBJECTS.has(node.object.name)) return index.functions.get(property) || [];
  return receiverClasses(node.object, context, index).flatMap(className => index.methods.get(`${className}.${property}`) || []);
}

// Classifies local bindings so iteration over freshly built local collections
// (the delta being applied) is not confused with iteration over shared state.
function collectBindings(fnNode) {
  const bindings = new Map();
  const markPattern = (pattern, kind) => {
    walkAst(pattern, (node) => {
      if (node.type === 'Identifier') bindings.set(node.name, kind);
      if (node.type === 'MemberExpression') return false;
      return undefined;
    });
  };
  const isFreshCollection = init => (
    (init?.type === 'NewExpression' && ['Map', 'Set', 'WeakMap', 'WeakSet'].includes(init.callee?.name) && init.arguments.length === 0)
    || (init?.type === 'ArrayExpression' && init.elements.every(element => element && element.type !== 'SpreadElement'))
    || init?.type === 'ObjectExpression'
    || init?.type === 'Literal'
  );
  walkAst(fnNode, (node) => {
    if (isFunction(node)) node.params.forEach(param => markPattern(param, 'param'));
    if (node.type === 'VariableDeclarator') {
      if (node.id.type === 'Identifier') bindings.set(node.id.name, isFreshCollection(node.init) ? 'owned' : 'external');
      else markPattern(node.id, 'external');
    }
    if (node.type === 'CatchClause' && node.param) markPattern(node.param, 'param');
  });
  return bindings;
}

// ---------------------------------------------------------------------------
// Value shapes proven from how a value is constructed, never from its name.
//   scalar   a primitive (a string's methods are not collection work);
//   derived  content wholly fixed by construction: a fixed-length typed array,
//            a URL parsed from one string, a string's split, or a copy of one;
//   bounded  a fixed number of elements (an array literal), elements unknown;
//   fixed    an object with a static key set, values unknown: only spreading or
//            enumerating its keys is bounded.
// Anything else is unknown (null) and keeps being reported.
const SHAPE_RANK = { scalar: 0, derived: 1, bounded: 2, fixed: 3 };
const COLLECTION_SHAPES = new Set(['scalar', 'derived', 'bounded']);

function joinShapes(shapes) {
  if (shapes.some(shape => !shape)) return null;
  return shapes.reduce((a, b) => (SHAPE_RANK[a] >= SHAPE_RANK[b] ? a : b), 'scalar');
}

function qualifiedCallee(call) {
  const callee = unwrapChain(call.callee);
  if (callee?.type === 'Identifier') return callee.name;
  if (callee?.type === 'MemberExpression' && callee.object.type === 'Identifier') return `${callee.object.name}.${memberProperty(callee)}`;
  return '';
}

function isFixedLengthArray(node) {
  const value = unwrapChain(node);
  if (value?.type === 'CallExpression' && calleeName(value) === 'getRandomValues') return isFixedLengthArray(value.arguments[0]);
  return value?.type === 'NewExpression' && FIXED_LENGTH_CONSTRUCTORS.has(value.callee?.name) && value.arguments.length === 1
    && value.arguments[0].type === 'Literal' && typeof value.arguments[0].value === 'number';
}

// Walks a subtree, passing each node's parent and the parent field holding it.
function walkWithParent(node, visit, parent = null, key = '') {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parent, key);
  for (const childKey of Object.keys(node)) {
    if (childKey === 'loc') continue;
    const child = node[childKey];
    if (Array.isArray(child)) child.forEach(item => walkWithParent(item, visit, node, childKey));
    else if (child && typeof child.type === 'string') walkWithParent(child, visit, node, childKey);
  }
}

function patternNames(pattern) {
  const names = [];
  walkAst(pattern, (node) => {
    if (node.type === 'Identifier') names.push(node.name);
    if (node.type === 'MemberExpression' || node.type === 'AssignmentPattern') {
      if (node.type === 'AssignmentPattern') names.push(...patternNames(node.left));
      return false;
    }
    return undefined;
  });
  return names;
}

// Names declared directly in one scope (a function, or the file when null). A
// name bound any way other than one plain `x = init` declarator is opaque.
const scopeDeclarationCache = new WeakMap();
function scopeDeclarations(file, scope) {
  const owner = scope || file.ast;
  if (scopeDeclarationCache.has(owner)) return scopeDeclarationCache.get(owner);
  const declarations = new Map();
  const opaque = (name) => declarations.set(name, null);
  const declare = (name, value) => (declarations.has(name) ? opaque(name) : declarations.set(name, value));
  if (scope) scope.params.forEach(param => patternNames(param).forEach(opaque));
  walkAst(scope ? scope.body : file.ast, (node) => {
    if (isFunction(node) && node.type !== 'FunctionDeclaration') return false;
    if (node.type === 'VariableDeclarator') {
      if (node.id.type === 'Identifier') declare(node.id.name, node);
      else patternNames(node.id).forEach(opaque);
    } else if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') && node.id) {
      opaque(node.id.name);
      if (node.type === 'FunctionDeclaration') return false;
    } else if (node.type === 'CatchClause' && node.param) {
      patternNames(node.param).forEach(opaque);
    } else if (node.type === 'ImportSpecifier' || node.type === 'ImportDefaultSpecifier' || node.type === 'ImportNamespaceSpecifier') {
      opaque(node.local.name);
    } else if ((node.type === 'ForOfStatement' || node.type === 'ForInStatement') && node.left.type === 'VariableDeclaration') {
      // A loop variable holds one element of the iterated value, not an init.
      for (const declarator of node.left.declarations) loopHeaders.set(declarator, node);
    }
    return undefined;
  });
  scopeDeclarationCache.set(owner, declarations);
  return declarations;
}

const loopHeaders = new WeakMap();

// The single plain declarator a reference resolves to, searching outward
// through enclosing functions; null when the name is opaque or global.
function lexicalDeclaration(file, reference) {
  for (let scope = ownerOf(file, reference).scope; ; scope = ownerOf(file, scope).scope) {
    const declarations = scopeDeclarations(file, scope);
    if (declarations.has(reference.name)) {
      const declarator = declarations.get(reference.name);
      return declarator ? { declarator, scope } : null;
    }
    if (!scope) return null;
  }
}

// How a binding is used across its whole scope, nested closures included:
// every later value it is assigned, whether it can grow by a computed-key write
// or a mutating method, and whether it escapes (aliased, returned, passed on),
// after which its size is no longer known.
const usageCache = new WeakMap();
function bindingUsage(file, scope) {
  const owner = scope || file.ast;
  if (usageCache.has(owner)) return usageCache.get(owner);
  const usage = new Map();
  const of = name => (usage.has(name) || usage.set(name, { assigned: [], grows: false, escapes: false }), usage.get(name));
  const parentOf = node => ownerOf(file, node).parent;
  walkWithParent(scope ? scope.body : file.ast, (node, parent, key) => {
    if (node.type !== 'Identifier' || !parent) return;
    if ((parent.type === 'MemberExpression' && key === 'property' && !parent.computed)
      || (parent.type === 'Property' && key === 'key' && !parent.computed && !parent.shorthand)
      || ((parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition') && key === 'key')
      || (parent.type === 'VariableDeclarator' && key === 'id')
      || (isFunction(parent) && key !== 'body')
      || ['LabeledStatement', 'BreakStatement', 'ContinueStatement'].includes(parent.type)) return;
    const facts = of(node.name);
    const inPattern = ['ArrayPattern', 'RestElement', 'AssignmentPattern'].includes(parent.type)
      || (parent.type === 'Property' && parentOf(parent)?.type === 'ObjectPattern')
      || (['ForOfStatement', 'ForInStatement'].includes(parent.type) && key === 'left');
    if (inPattern) {
      facts.assigned.push(null);
    } else if (parent.type === 'AssignmentExpression' && key === 'left') {
      facts.assigned.push(['=', '||=', '&&=', '??='].includes(parent.operator) ? parent.right : 'scalar');
    } else if (parent.type === 'UpdateExpression') {
      facts.assigned.push('scalar');
    } else if (parent.type === 'MemberExpression' && key === 'object') {
      // `x[key] = value` adds keys; `x.items.push(value)` grows a member.
      const above = parentOf(parent);
      if (parent.computed && ((above?.type === 'AssignmentExpression' && above.left === parent) || above?.type === 'UpdateExpression'
        || (above?.type === 'UnaryExpression' && above.operator === 'delete'))) facts.grows = true;
      let top = parent;
      while (parentOf(top)?.type === 'MemberExpression' && parentOf(top).object === top) top = parentOf(top);
      const call = parentOf(top);
      if (call?.type === 'CallExpression' && call.callee === top && MUTATOR_METHODS.has(memberProperty(top))) facts.grows = true;
    } else if (['CallExpression', 'NewExpression'].includes(parent.type) && key === 'arguments') {
      if (!READ_ONLY_CALLS.has(qualifiedCallee(parent))) facts.escapes = true;
    } else if (!['SpreadElement', 'BinaryExpression', 'UnaryExpression', 'TemplateLiteral', 'IfStatement', 'WhileStatement',
      'DoWhileStatement', 'SwitchStatement', 'SwitchCase', 'ForOfStatement', 'ForInStatement', 'ExpressionStatement', 'CallExpression',
      'NewExpression'].includes(parent.type) && !(parent.type === 'ConditionalExpression' && key === 'test')) {
      facts.escapes = true;
    }
  });
  usageCache.set(owner, usage);
  return usage;
}

// A function or binding whose shape depends on itself is solved as a least
// fixpoint: start from the narrowest assumption and widen it until the result
// agrees (`path = path.slice(1)` stays a string; `rows = rows.concat(more)`
// becomes unknown). Results reached through an unsettled assumption are not
// cached, so the order of analysis never changes a result.
const shapeAssumptions = new Map();
const returnShapeCache = new WeakMap();
let shapeCycles = 0;

function guardedShape(key, compute) {
  if (shapeAssumptions.has(key)) {
    shapeCycles += 1;
    return shapeAssumptions.get(key);
  }
  let assumption = 'scalar';
  try {
    // Shapes only widen, so this settles within the lattice height.
    for (let round = 0; round <= Object.keys(SHAPE_RANK).length; round += 1) {
      shapeAssumptions.set(key, assumption);
      const shape = compute();
      if (shape === assumption || !shape) return shape;
      assumption = shape;
    }
    return null;
  } finally {
    shapeAssumptions.delete(key);
  }
}

function returnShape(def, index) {
  if (returnShapeCache.has(def.node)) return returnShapeCache.get(def.node);
  const cycles = shapeCycles;
  const shape = guardedShape(def.node, () => {
    if (def.node.async || def.node.generator) return null;
    const implicit = def.node.body?.type === 'BlockStatement' ? ['scalar'] : [];
    return joinShapes([...implicit, ...returnExpressions(def.node).map(value => valueShape(value, def.file, index))]);
  });
  if (cycles === shapeCycles) returnShapeCache.set(def.node, shape);
  return shape;
}

// Every top-level runtime script shares one global scope, so a top-level
// binding is only proven when no other script redeclares, grows, or leaks it.
function bindingFacts(file, scope, name, index) {
  const files = scope ? [file] : index.files;
  const facts = { assigned: [], grows: false, escapes: false };
  for (const other of files) {
    if (other !== file && scopeDeclarations(other, null).has(name)) return null;
    const found = bindingUsage(other, scope).get(name);
    if (!found) continue;
    facts.assigned.push(...found.assigned);
    facts.grows ||= found.grows;
    facts.escapes ||= found.escapes;
  }
  return facts;
}

function identifierShape(reference, file, index) {
  if (reference.name === 'undefined') return 'scalar';
  const found = lexicalDeclaration(file, reference);
  if (!found) return null;
  const { declarator, scope } = found;
  return guardedShape(declarator, () => {
    const facts = bindingFacts(file, scope, reference.name, index);
    if (!facts) return null;
    const header = loopHeaders.get(declarator);
    let initial;
    if (header?.type === 'ForInStatement') initial = 'scalar';
    else if (header) initial = ['scalar', 'derived'].includes(valueShape(header.right, file, index)) ? 'derived' : null;
    else initial = declarator.init ? valueShape(declarator.init, file, index) : 'scalar';
    const shape = joinShapes([initial, ...facts.assigned.map(value => (
      value === 'scalar' || value === null ? value : valueShape(value, file, index)
    ))]);
    if (!shape || shape === 'scalar') return shape;
    if (facts.escapes) return null;
    // Index writes into a fixed-length typed array never grow it.
    if (facts.grows && !(isFixedLengthArray(declarator.init) && !facts.assigned.length)) return null;
    return shape;
  });
}

function callShape(call, file, index) {
  const callee = unwrapChain(call.callee);
  const name = calleeName(call);
  const qualified = qualifiedCallee(call);
  const argument = call.arguments[0] && call.arguments[0].type !== 'SpreadElement' ? call.arguments[0] : null;
  const argumentShape = () => (argument ? valueShape(argument, file, index) : null);
  if (DOM_COLLECTION_QUERIES.has(name)) return null;
  if (callee.type === 'Identifier' && PRIMITIVE_RESULTS.has(name)) return 'scalar';
  if (qualified === 'Object.keys') return argumentShape() ? 'derived' : null;
  if (qualified === 'Object.values' || qualified === 'Object.entries') {
    const shape = argumentShape();
    return shape === 'scalar' || shape === 'derived' ? 'derived' : shape ? 'bounded' : null;
  }
  if (qualified === 'Array.from') {
    const shape = argumentShape();
    if (shape === 'scalar' || shape === 'derived') return call.arguments.length > 1 ? 'bounded' : 'derived';
    return shape === 'bounded' ? 'bounded' : null;
  }
  if (callee.type === 'MemberExpression' && !(callee.object.type === 'ThisExpression' || GLOBAL_OBJECTS.has(callee.object.name))) {
    if (name === 'getRandomValues') return isFixedLengthArray(argument) ? 'derived' : null;
    if (SCALAR_METHODS.has(name)) return 'scalar';
    // Only strings define these: a string, or a split of that one string.
    if (STRING_METHODS.has(name)) return STRING_ARRAY_METHODS.has(name) ? 'derived' : 'scalar';
    const receiver = valueShape(callee.object, file, index);
    if (receiver === 'scalar') return STRING_ARRAY_METHODS.has(name) ? 'derived' : 'scalar';
    if (receiver === 'derived') return name === 'map' ? 'bounded' : DERIVED_READ_METHODS.has(name) ? 'derived' : null;
    if (receiver === 'bounded' && BOUNDED_COPY_METHODS.has(name)) return 'bounded';
    return null;
  }
  const defs = resolveCallable(callee, { file, className: ownerOf(file, call).className }, index);
  return defs.length ? joinShapes(defs.map(def => returnShape(def, index))) : null;
}

function valueShape(node, file, index) {
  const value = unwrapChain(node);
  switch (value?.type) {
    case 'Literal':
    case 'TemplateLiteral':
    case 'BinaryExpression':
    case 'UnaryExpression':
    case 'UpdateExpression':
      return 'scalar';
    case 'ArrayExpression':
      return joinShapes(['derived', ...value.elements.map((element) => {
        if (!element) return 'derived';
        if (element.type !== 'SpreadElement') {
          return ['scalar', 'derived'].includes(valueShape(element, file, index)) ? 'derived' : 'bounded';
        }
        const shape = valueShape(element.argument, file, index);
        return shape === 'scalar' ? 'derived' : COLLECTION_SHAPES.has(shape) ? shape : null;
      })]);
    case 'ObjectExpression':
      return value.properties.every(property => property.type !== 'SpreadElement' || valueShape(property.argument, file, index))
        ? 'fixed' : null;
    case 'ConditionalExpression':
      return joinShapes([valueShape(value.consequent, file, index), valueShape(value.alternate, file, index)]);
    case 'LogicalExpression':
      return joinShapes([valueShape(value.left, file, index), valueShape(value.right, file, index)]);
    case 'SequenceExpression':
      return valueShape(value.expressions.at(-1), file, index);
    case 'NewExpression':
      if (isFixedLengthArray(value)) return 'derived';
      // A URL parsed from one string is bounded by that string.
      if (value.callee.name === 'URL') return 'derived';
      if (value.callee.name === 'URLSearchParams' && value.arguments.every(arg => valueShape(arg, file, index) === 'scalar')) return 'derived';
      return null;
    case 'MemberExpression': {
      if (!value.computed && memberProperty(value) === 'length') return 'scalar';
      const owner = valueShape(value.object, file, index);
      return owner === 'scalar' || owner === 'derived' ? owner : null;
    }
    case 'Identifier':
      return identifierShape(value, file, index);
    case 'CallExpression':
      return callShape(value, file, index);
    default:
      return null;
  }
}

// True when a receiver can carry a shared collection whose size is unrelated to
// the event: DOM collection queries, instance state, globals, or aliases of them.
// A value whose construction proves it a primitive or a bounded copy is not.
function isSharedCollection(node, analysis) {
  const { bindings, shapeOf } = analysis;
  if (COLLECTION_SHAPES.has(shapeOf(node))) return false;
  let current = node;
  while (current) {
    if (current.type === 'CallExpression') {
      const name = calleeName(current);
      if (DOM_COLLECTION_QUERIES.has(name)) return true;
      // `Object.entries(x)` and `Array.from(x)` are as large as `x`.
      if (['Object.keys', 'Object.values', 'Object.entries', 'Array.from'].includes(qualifiedCallee(current))) {
        return Boolean(current.arguments[0]) && isSharedCollection(current.arguments[0], analysis);
      }
      if (STRING_METHODS.has(name)) return false;
      if (current.callee.type === 'Identifier' && PRIMITIVE_RESULTS.has(name)) return false;
      if (current.callee.type === 'MemberExpression') {
        current = current.callee.object;
        continue;
      }
      return current.callee.type === 'Identifier' && !bindings.has(current.callee.name);
    }
    if (current.type === 'MemberExpression') {
      current = current.object;
      continue;
    }
    if (current.type === 'ChainExpression') {
      current = current.expression;
      continue;
    }
    if (current.type === 'ThisExpression') return true;
    if (current.type === 'Identifier') {
      const kind = bindings.get(current.name);
      if (kind === 'owned' || kind === 'param') return false;
      return true;
    }
    return false;
  }
  return false;
}

// `scale` hazards grow with a shared collection (rows, library state, DOM
// lists) and need a contract wherever they are reachable. The others (a
// request, storage access, JSON, markup) are bounded once per event and are
// hazards only on high-frequency events, where they repeat per frame.
function hazardAt(rule, operation, node, file, scale = true) {
  return { rule, operation, path: file.path, line: node.loc.start.line, position: node.start, scale };
}

// True for `i < shared.length` style loop bounds.
function isSharedLengthBound(test, analysis) {
  if (test?.type === 'LogicalExpression') return isSharedLengthBound(test.left, analysis) || isSharedLengthBound(test.right, analysis);
  if (test?.type !== 'BinaryExpression' || !LOOP_BOUND_OPERATORS.has(test.operator)) return false;
  return [test.left, test.right].some(side => memberProperty(side) === 'length' && isSharedCollection(side.object, analysis));
}

// Direct hazards inside one function body (nested inline callbacks included,
// because they run on the same event).
const hazardCache = new WeakMap();

function functionHazards(fnNode, file, index) {
  if (!hazardCache.has(fnNode)) hazardCache.set(fnNode, computeFunctionHazards(fnNode, file, index));
  return hazardCache.get(fnNode);
}

function computeFunctionHazards(fnNode, file, index) {
  const analysis = { bindings: collectBindings(fnNode), shapeOf: node => valueShape(node, file, index) };
  const shared = node => isSharedCollection(node, analysis);
  // Spreading or enumerating the keys of a fixed-shape object is bounded.
  const sharedKeys = node => shared(node) && !analysis.shapeOf(node);
  const objectSpreads = new Set();
  const hazards = [];
  walkAst(fnNode.body || fnNode, (node) => {
    if (node.type === 'ObjectExpression') node.properties.forEach(property => property.type === 'SpreadElement' && objectSpreads.add(property));
    if (node.type === 'CallExpression') {
      const name = calleeName(node);
      const callee = node.callee;
      const at = callee.type === 'MemberExpression' ? callee.property : callee;
      if (DOM_COLLECTION_QUERIES.has(name)) hazards.push(hazardAt('BI-01', name, at, file));
      else if (ITERATION_METHODS.has(name) && callee.type === 'MemberExpression' && shared(callee.object)) {
        hazards.push(hazardAt('BI-01', name, at, file));
      } else if (name === 'from' && callee.object?.name === 'Array' && node.arguments[0] && shared(node.arguments[0])) {
        hazards.push(hazardAt('BI-01', 'Array.from', at, file));
      } else if (OBJECT_ENUMERATION.has(name) && callee.object?.name === 'Object' && node.arguments[0] && sharedKeys(node.arguments[0])) {
        hazards.push(hazardAt('BI-01', `Object.${name}`, at, file));
      } else if ((name === 'stringify' || name === 'parse') && callee.object?.name === 'JSON') {
        const scale = name === 'stringify' && Boolean(node.arguments[0]) && shared(node.arguments[0]);
        hazards.push(hazardAt('BI-13', `JSON.${name}`, at, file, scale));
      } else if (name === 'fetch' && callee.type === 'Identifier') {
        hazards.push(hazardAt('BI-03', name, at, file, false));
      } else if (callee.type === 'MemberExpression' && STORAGE_OBJECTS.has(callee.object?.name)) {
        hazards.push(hazardAt('BI-01', `${callee.object.name}.${name}`, at, file, false));
      } else if (name === 'insertAdjacentHTML') {
        hazards.push(hazardAt('BI-02', name, at, file, false));
      }
    } else if (node.type === 'NewExpression' && ['Set', 'Map'].includes(node.callee?.name) && node.arguments[0] && shared(node.arguments[0])) {
      hazards.push(hazardAt('BI-01', `new ${node.callee.name}`, node, file));
    } else if ((node.type === 'ForOfStatement' && shared(node.right)) || (node.type === 'ForInStatement' && sharedKeys(node.right))) {
      hazards.push(hazardAt('BI-01', node.type === 'ForOfStatement' ? 'for-of' : 'for-in', node, file));
    } else if (['ForStatement', 'WhileStatement', 'DoWhileStatement'].includes(node.type) && isSharedLengthBound(node.test, analysis)) {
      hazards.push(hazardAt('BI-01', 'indexed-loop', node, file));
    } else if (node.type === 'SpreadElement' && (objectSpreads.has(node) ? sharedKeys(node.argument) : shared(node.argument))) {
      hazards.push(hazardAt('BI-01', 'spread', node, file));
    } else if (node.type === 'AssignmentExpression' && MARKUP_PROPERTIES.has(memberProperty(node.left))) {
      hazards.push(hazardAt('BI-02', memberProperty(node.left), node.left.property, file, false));
    }
  });
  return hazards.sort((a, b) => a.position - b.position);
}

// Functions called (or scheduled) from a function body. A callback passed to a
// timer or a timer helper runs as part of the caller's work, so a one-shot
// frame or timeout scheduled from a hot handler is analyzed with that handler.
function calledFunctions(fnNode, context, index) {
  const callees = [];
  walkAst(fnNode.body || fnNode, (node) => {
    if (node.type !== 'CallExpression') return;
    callees.push(...resolveCallable(node.callee, context, index));
    const name = calleeName(node);
    const helper = node.callee.type === 'Identifier' ? index.timers?.get(name) : undefined;
    const callback = DEFERRED_CALLBACK_CALLS.has(name) ? node.arguments[0] : helper && node.arguments[helper.param];
    if (callback && !isFunction(callback)) callees.push(...resolveCallable(callback, context, index));
  });
  return callees;
}

// A call chain deeper than MAX_CALL_DEPTH is not proven bounded: the first
// function past the limit is reported as a hazard instead of silently ignored.
function reachableHazards(handler, context, index) {
  const direct = functionHazards(handler.node, handler.file, index).map(hazard => ({ ...hazard, via: [] }));
  const indirect = [];
  const seen = new Set([handler.node]);
  const queue = calledFunctions(handler.node, context, index).map(def => ({ def, via: [def.name] }));
  while (queue.length) {
    const { def, via } = queue.shift();
    if (seen.has(def.node)) continue;
    seen.add(def.node);
    if (via.length > MAX_CALL_DEPTH) {
      indirect.push({ ...hazardAt('BI-01', 'call-depth-exceeded', def.node, def.file), via });
      continue;
    }
    for (const hazard of functionHazards(def.node, def.file, index)) indirect.push({ ...hazard, via });
    const defContext = { file: def.file, className: ownerOf(def.file, def.node).className };
    for (const next of calledFunctions(def.node, defContext, index)) queue.push({ def: next, via: [...via, next.name] });
  }
  return { direct, indirect };
}

// Every function a handler can call, at any depth (the call graph is finite,
// so a visited set ends the walk), the handler itself included.
const reachableCache = new WeakMap();
function reachableFunctions(handler, index) {
  if (reachableCache.has(handler.node)) return reachableCache.get(handler.node);
  const seen = new Set();
  const queue = [handler];
  while (queue.length) {
    const def = queue.pop();
    if (seen.has(def.node)) continue;
    seen.add(def.node);
    queue.push(...calledFunctions(def.node, { file: def.file, className: ownerOf(def.file, def.node).className }, index));
  }
  reachableCache.set(handler.node, seen);
  return seen;
}

// Hot paths need every reachable hazard proven by a contract: high-frequency
// and repeating events, observers, workers, and repeating timers. A timer is
// repeating when it is `setInterval`, or a `requestAnimationFrame` or
// `setTimeout` whose callback can reach the function that schedules it again
// (an animation loop or a poller); a call to a timer helper is classified by
// the timer the helper uses. A one-shot frame or timeout is not hot by itself:
// when a hot entrypoint schedules it, that entrypoint's reachable analysis
// already includes the callback (see calledFunctions). Every other entrypoint
// (one-shot events, frames, and timeouts, request owners) is not hot: it keeps
// route, request, and registration checks only.
function isHotEntrypoint(found, file, handlers, index) {
  if (found.kind === 'event') return REPEATING_EVENTS.has(found.trigger);
  if (found.kind === 'observer' || found.kind === 'worker') return true;
  if (found.kind !== 'timer') return false;
  if (found.timer === 'setInterval') return true;
  const reached = new Set(handlers.flatMap(handler => [...reachableFunctions(handler, index)]));
  for (let scope = ownerOf(file, found.node).scope; scope; scope = ownerOf(file, scope).scope) {
    if (reached.has(scope)) return true;
  }
  return false;
}

// The function that runs when the entrypoint fires: a listener, timer, or
// observer callback, or the function that owns a request.
function entrypointHandler(found, file) {
  if (found.kind === 'request') return ownerOf(file, found.node).scope;
  return found.handler;
}


// ---------------------------------------------------------------------------
// Request target resolution. A request target is resolved to literal paths when
// it is a string, a local or module constant, `new URL(...)`/`.href`, a
// conditional, or a call to a function whose returns resolve (URL builders).
// A target that is the enclosing function's own parameter makes that function
// a request helper: its callers become request entrypoints and its own call is
// delegated. Anything else stays dynamic and needs a request-capture contract.

function functionParamIndex(fnNode, name) {
  return fnNode.params.findIndex(param => (
    (param.type === 'Identifier' && param.name === name)
    || (param.type === 'AssignmentPattern' && param.left.type === 'Identifier' && param.left.name === name)
  ));
}

function findDeclaration(file, scope, name) {
  let found = null;
  walkAst(scope ? scope.body : file.ast, (node) => {
    if (found) return false;
    if (isFunction(node) && node !== scope) return false;
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.id.name === name) {
      found = node;
      return false;
    }
    return undefined;
  });
  return found;
}

function bindingOf(file, scope, name) {
  for (let current = scope; ; current = ownerOf(file, current).scope) {
    if (current) {
      const index = functionParamIndex(current, name);
      if (index >= 0) return { param: index, fn: current };
    }
    const declaration = findDeclaration(file, current, name);
    if (declaration) return { declaration, scope: current };
    if (!current) return null;
  }
}

function functionDefinitions(name, file, index) {
  const defs = index.functions.get(name) || [];
  const local = defs.filter(def => def.file === file);
  return local.length ? local : defs;
}

function returnExpressions(fnNode) {
  if (fnNode.body?.type !== 'BlockStatement') return [fnNode.body];
  const returns = [];
  walkAst(fnNode.body, (node) => {
    if (isFunction(node)) return false;
    if (node.type === 'ReturnStatement' && node.argument) returns.push(node.argument);
    return undefined;
  });
  return returns;
}

function resolveTargets(node, file, scope, index, depth = 0) {
  const recurse = (child, childFile = file, childScope = scope) => resolveTargets(child, childFile, childScope, index, depth + 1);
  if (!node || depth > MAX_RESOLUTION_DEPTH) return [{ target: null }];
  const text = stringValue(node);
  if (text !== null) return [{ target: text.startsWith('/') ? text : null }];
  if (node.type === 'ConditionalExpression') return [...recurse(node.consequent), ...recurse(node.alternate)];
  if (node.type === 'LogicalExpression') return [...recurse(node.left), ...recurse(node.right)];
  if (node.type === 'AwaitExpression' || node.type === 'ChainExpression') return recurse(node.argument || node.expression);
  if (node.type === 'NewExpression' && ['URL', 'Request'].includes(node.callee?.name)) return recurse(node.arguments[0]);
  if (node.type === 'MemberExpression' && ['href', 'pathname'].includes(memberProperty(node))) {
    // A parameter's `.href` is an element or URL object, not a forwarded URL.
    return recurse(node.object).map(resolved => (resolved.param === undefined ? resolved : { target: null }));
  }
  if (node.type === 'Identifier') {
    const binding = bindingOf(file, scope, node.name);
    if (binding?.param !== undefined) return [{ target: null, param: binding.param, fn: binding.fn }];
    if (binding?.declaration?.init) return recurse(binding.declaration.init, file, binding.scope);
    return [{ target: null }];
  }
  if (node.type === 'CallExpression') {
    if (node.callee.type === 'Identifier' && node.callee.name === 'String') return recurse(node.arguments[0]);
    const defs = node.callee.type === 'Identifier' ? functionDefinitions(node.callee.name, file, index) : [];
    if (defs.length) {
      return defs.flatMap(def => returnExpressions(def.node).flatMap(expression => recurse(expression, def.file, def.node)))
        .map(({ param, fn, ...rest }) => (param === undefined ? rest : { target: null }));
    }
  }
  return [{ target: null }];
}

// Functions that pass one of their own parameters to a request become request
// helpers, to a fixpoint (helpers of helpers).
function requestHelpers(files, index) {
  const helpers = new Map([['fetch', null]]);
  const helperNodes = new Map();
  for (let changed = true; changed;) {
    changed = false;
    for (const file of files) {
      walkAst(file.ast, (node) => {
        if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier') return;
        const helper = helpers.get(node.callee.name);
        if (helper === undefined) return;
        const argumentIndex = helper ?? 0;
        const { scope } = ownerOf(file, node);
        for (const resolved of resolveTargets(node.arguments[argumentIndex], file, scope, index)) {
          if (resolved.param === undefined) continue;
          const def = [...index.functions.values()].flat().find(candidate => candidate.node === resolved.fn);
          if (!def || helpers.has(def.name)) continue;
          helpers.set(def.name, resolved.param);
          helperNodes.set(def.node, def.name);
          changed = true;
        }
      });
    }
  }
  return helpers;
}

function isTimerCall(node) {
  return TIMER_CALLS.has(calleeName(node)) && (node.callee.type === 'Identifier' || GLOBAL_OBJECTS.has(node.callee.object?.name));
}

// Functions that schedule one of their own parameters with a timer (such as
// `scheduleBrowserTimeout(callback, delay)`) become timer helpers, to a
// fixpoint: each call to one is a timer entrypoint that runs the passed
// callback, classified by the timer it ultimately uses.
function timerHelpers(files, index) {
  const helpers = new Map();
  const definitions = new Map([...index.functions.values()].flat().map(def => [def.node, def]));
  for (let changed = true; changed;) {
    changed = false;
    for (const file of files) {
      walkAst(file.ast, (node) => {
        if (node.type !== 'CallExpression') return;
        const helper = node.callee.type === 'Identifier' ? helpers.get(node.callee.name) : undefined;
        const timer = isTimerCall(node) ? calleeName(node) : helper?.timer;
        const callback = node.arguments[helper ? helper.param : 0];
        if (!timer || callback?.type !== 'Identifier') return;
        const { scope } = ownerOf(file, node);
        const def = scope && definitions.get(scope);
        const param = def ? functionParamIndex(scope, callback.name) : -1;
        if (param < 0 || helpers.has(def.name)) return;
        helpers.set(def.name, { param, timer });
        changed = true;
      });
    }
  }
  return helpers;
}

function entry(file, node, kind, trigger) {
  const { owner } = ownerOf(file, node);
  return {
    key: `js:${file.path}#${owner}:${kind}:${trigger}`,
    language: 'javascript',
    path: file.path,
    owner,
    kind,
    trigger,
    line: node.loc.start.line,
    node,
  };
}

// Entry points plus the callback node each one runs.
function fileEntrypoints(file, index, helpers, timers) {
  const found = [];
  walkAst(file.ast, (node) => {
    if (node.type === 'CallExpression') {
      const name = calleeName(node);
      if (name === 'addEventListener') {
        const trigger = stringValue(node.arguments[0]);
        if (trigger) found.push({ ...entry(file, node, 'event', trigger), handler: node.arguments[1] });
      } else if (isTimerCall(node)) {
        found.push({ ...entry(file, node, 'timer', name), handler: node.arguments[0], timer: name });
      } else if (node.callee.type === 'Identifier' && timers.has(name)) {
        const { param, timer } = timers.get(name);
        found.push({ ...entry(file, node, 'timer', name), handler: node.arguments[param], timer });
      } else if (node.callee.type === 'Identifier' && helpers.has(name)) {
        const call = entry(file, node, 'request', name);
        const { scope } = ownerOf(file, node);
        const targets = resolveTargets(node.arguments[helpers.get(name) ?? 0], file, scope, index)
          .map(({ target, param }) => ({ target, line: call.line, ...(param === undefined ? {} : { delegated: true }) }));
        found.push({ ...call, targets });
      }
    } else if (node.type === 'NewExpression') {
      const name = node.callee?.name;
      if (OBSERVERS.has(name)) found.push({ ...entry(file, node, 'observer', name), handler: node.arguments[0] });
      if (name === 'Worker' || name === 'SharedWorker') found.push(entry(file, node, 'worker', name));
    } else if (node.type === 'Property' && HIGH_FREQUENCY_EVENTS.has(propertyName(node.key)) && isFunction(node.value)) {
      // Handler maps such as `{ pointermove: event => ... }` installed in a loop.
      found.push({ ...entry(file, node, 'event', propertyName(node.key)), handler: node.value });
    } else if (node.type === 'AssignmentExpression' && /^on[a-z]+$/.test(memberProperty(node.left))) {
      found.push({ ...entry(file, node, 'event', memberProperty(node.left).slice(2)), handler: node.right });
    }
  });
  return found;
}

// Dedicated surfaces may never be requested through a generic endpoint, whether
// the surface is a literal query (`'/view-data?surface=home'`, even when the
// URL is only returned for a later fetch) or a parameter object passed in the
// same call as the generic endpoint.
function routeOwnershipHazards(file) {
  const hazards = [];
  const report = (node, generic, surface) => {
    if (!DEDICATED_SURFACES.has(surface)) return;
    const { owner } = ownerOf(file, node);
    const operation = `route-owner:${generic}?surface=${surface}`;
    const base = { path: file.path, owner, line: node.loc.start.line, position: node.start };
    hazards.push({ ...base, rule: 'BI-04', operation, key: `js:${file.path}#${owner}:route:${operation}` });
    hazards.push({
      ...base,
      rule: 'BI-13',
      operation: 'generic-endpoint-for-dedicated-surface',
      key: `js:${file.path}#${owner}:route:${generic}->${DEDICATED_SURFACES.get(surface)}`,
    });
  };
  const genericOf = text => GENERIC_ENDPOINTS.find(generic => text === generic || text.startsWith(`${generic}?`));
  walkAst(file.ast, (node) => {
    const text = stringValue(node);
    if (text !== null) {
      const generic = genericOf(text);
      const surface = new URLSearchParams(text.split('?')[1] || '').get('surface');
      if (generic && surface) report(node, generic, surface.toLowerCase());
      return;
    }
    if (node.type !== 'CallExpression') return;
    let generic = null;
    const surfaces = [];
    walkAst(node, (child) => {
      if (child.type === 'CallExpression' && child !== node) return false;
      const value = stringValue(child);
      if (value !== null) generic = generic || genericOf(value);
      if (child.type === 'Property' && propertyName(child.key) === 'surface') {
        const surface = stringValue(child.value);
        if (surface) surfaces.push(surface.toLowerCase());
      }
      return undefined;
    });
    if (generic) surfaces.forEach(surface => report(node, generic, surface));
  });
  return hazards;
}

function sortEntries(entries) {
  return entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.line - b.line));
}

// One key per owner, kind, and trigger; every request target under that key is
// kept so a second, broader request in the same owner is still checked.
function dedupeEntrypoints(entries) {
  const byKey = new Map();
  for (const item of sortEntries(entries)) {
    const existing = byKey.get(item.key);
    if (!existing) byKey.set(item.key, item.targets ? { ...item, targets: [...item.targets] } : item);
    else if (item.targets) existing.targets.push(...item.targets);
  }
  for (const item of byKey.values()) {
    if (!item.targets) continue;
    const seen = new Set();
    item.targets = item.targets.filter(({ target, delegated }) => {
      const id = `${target}|${Boolean(delegated)}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }
  return [...byKey.values()];
}

function publicEntry({ handler, node, timer, ...rest }) {
  return rest;
}

function discoverJavaScriptSource(source, filePath) {
  return analyzeFiles([parseFile(source, filePath)]).entrypoints;
}

function analyzeFiles(files) {
  const index = indexDefinitions(files);
  const helpers = requestHelpers(files, index);
  const timers = timerHelpers(files, index);
  index.timers = timers;
  const entrypoints = [];
  const hazards = [];
  const hotKeys = new Set();
  for (const file of files) {
    for (const found of fileEntrypoints(file, index, helpers, timers)) {
      entrypoints.push(publicEntry(found));
      const callback = entrypointHandler(found, file);
      const handlers = callback ? resolveCallable(callback, { file, className: ownerOf(file, callback).className }, index) : [];
      if (isHotEntrypoint(found, file, handlers, index)) hotKeys.add(found.key);
      const highFrequency = found.kind === 'event' && HIGH_FREQUENCY_EVENTS.has(found.trigger);
      for (const handler of handlers) {
        const handlerContext = { file: handler.file, className: ownerOf(handler.file, handler.node).className };
        const { direct, indirect } = reachableHazards(handler, handlerContext, index);
        // Broad work directly inside a high-frequency handler is rejected; any
        // other reachable hazard of a hot path requires a runtime contract.
        // Work bounded once per event matters only when the event repeats per frame.
        const counted = hazard => highFrequency || hazard.scale;
        for (const hazard of direct.filter(counted)) hazards.push({ ...hazard, entrypoint: found.key, depth: 'direct', reject: highFrequency });
        for (const hazard of indirect.filter(counted)) hazards.push({ ...hazard, entrypoint: found.key, depth: 'indirect', reject: false });
      }
    }
    hazards.push(...routeOwnershipHazards(file).map(hazard => ({ ...hazard, entrypoint: hazard.key, depth: 'direct', via: [], reject: true })));
  }
  // Hotness belongs to the entrypoint key: one repeating timer makes every
  // timer of that kind in its owner hot.
  const keyed = hazards.map(hazard => ({
    ...hazard,
    hot: hotKeys.has(hazard.entrypoint),
    key: hazard.key || `${hazard.entrypoint}:${hazard.rule}:${hazard.operation}@${hazard.path}#${hazard.via.at(-1) || '<handler>'}`,
  }));
  const uniqueHazards = new Map();
  for (const hazard of sortEntries(keyed)) if (!uniqueHazards.has(hazard.key)) uniqueHazards.set(hazard.key, hazard);
  const inventory = dedupeEntrypoints(entrypoints).map(item => ({ ...item, hot: hotKeys.has(item.key) }));
  return { entrypoints: inventory, hazards: [...uniqueHazards.values()] };
}

// Direct hazards in one source, once per source position even when several
// entrypoints (a listener and the request it owns) reach the same code.
function findJavaScriptHazards(source, filePath) {
  const { hazards } = analyzeFiles([parseFile(source, filePath)]);
  const unique = new Map();
  for (const hazard of hazards.filter(item => item.depth === 'direct')) {
    const id = `${hazard.position}:${hazard.rule}:${hazard.operation}`;
    if (!unique.has(id) || hazard.reject) unique.set(id, hazard);
  }
  return [...unique.values()].sort((a, b) => a.line - b.line || a.position - b.position || a.rule.localeCompare(b.rule));
}

function listJavaScriptFiles(root) {
  const base = path.join(root, JS_ROOT);
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base, { recursive: true })
    .map(entryPath => normalizePath(path.posix.join(JS_ROOT, normalizePath(entryPath))))
    .filter(filePath => filePath.endsWith('.js') && !EXCLUDED_JS.some(pattern => pattern.test(filePath)))
    .sort();
}

function loadJavaScriptFiles(root, overrides = {}) {
  return listJavaScriptFiles(root).map(filePath => parseFile(
    Object.hasOwn(overrides, filePath) ? overrides[filePath] : fs.readFileSync(path.join(root, filePath), 'utf8'),
    filePath,
  ));
}

function analyzeJavaScriptSources(sources) {
  return analyzeFiles(Object.entries(sources).map(([filePath, source]) => parseFile(source, filePath)));
}

function analyzeJavaScriptRepository(root, overrides = {}) {
  return analyzeFiles(loadJavaScriptFiles(root, overrides));
}

function discoverJavaScriptEntrypoints(root) {
  return analyzeJavaScriptRepository(root).entrypoints;
}

module.exports = {
  HIGH_FREQUENCY_EVENTS,
  normalizeEndpoint,
  analyzeJavaScriptRepository,
  analyzeJavaScriptSources,
  discoverJavaScriptEntrypoints,
  discoverJavaScriptSource,
  findJavaScriptHazards,
  walkAst,
};
