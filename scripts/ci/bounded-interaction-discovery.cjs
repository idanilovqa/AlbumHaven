'use strict';

// Static inventory of frontend interaction entrypoints and the bounded-work
// hazards reachable from them. Discovery proves coverage, not boundedness:
// direct hazards inside a high-frequency handler are rejected outright, while
// hazards reached through helpers are reported so the registry can require a
// deterministic runtime contract for that entry.

const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');

const JS_ROOT = 'music_app/static/js';
const EXCLUDED_JS = [/(^|\/)runtime-bundle\.js$/, /(^|\/)vendor\//, /(^|\/)dist\//, /\.min\.js$/];

const HIGH_FREQUENCY_EVENTS = new Set(['pointermove', 'mousemove', 'scroll', 'wheel', 'touchmove', 'input']);
const TIMER_CALLS = new Set(['setInterval', 'setTimeout', 'requestAnimationFrame']);
const DEFERRED_CALLBACK_CALLS = new Set(['setTimeout', 'requestAnimationFrame', 'queueMicrotask', 'requestIdleCallback']);
const OBSERVERS = new Set(['MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'PerformanceObserver']);
// fetch plus the runtime helpers whose first argument is the request URL.
const REQUEST_CALLS = new Set(['fetch', 'fetchAndRender', 'fetchGalleryViewResponse', 'fetchPage', 'requestJson']);
const GLOBAL_OBJECTS = new Set(['window', 'globalThis', 'global', 'self']);
const ITERATION_METHODS = new Set(['forEach', 'map', 'filter', 'reduce', 'sort', 'find', 'findIndex', 'some', 'every', 'flatMap']);
const DOM_COLLECTION_QUERIES = new Set(['querySelectorAll', 'getElementsByClassName', 'getElementsByTagName', 'getElementsByName']);
const OBJECT_ENUMERATION = new Set(['keys', 'values', 'entries']);
const STORAGE_OBJECTS = new Set(['localStorage', 'sessionStorage']);
const STRING_METHODS = new Set(['split', 'trim', 'toLowerCase', 'toUpperCase', 'replace', 'replaceAll', 'match', 'matchAll']);
const MARKUP_PROPERTIES = new Set(['innerHTML', 'outerHTML']);
const GENERIC_ENDPOINTS = ['/view-data'];
const DEDICATED_SURFACES = new Map([['home', '/home-data']]);
const MAX_CALL_DEPTH = 6;

function normalizePath(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\//, '');
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

function stringValue(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral') return node.quasis.map(quasi => quasi.value.cooked).join('${}');
  return null;
}

// Each named function, variable-assigned function, or class method owns the
// anonymous callbacks nested inside it.
function annotateOwners(ast) {
  const owners = new Map();
  const visit = (node, owner, className) => {
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
    owners.set(node, { owner: nextOwner, className: nextClass });
    for (const key of Object.keys(node)) {
      if (key === 'loc') continue;
      const child = node[key];
      if (Array.isArray(child)) child.forEach(item => visit(item, nextOwner, nextClass));
      else if (child && typeof child.type === 'string') visit(child, nextOwner, nextClass);
    }
  };
  visit(ast, '<top-level>', '');
  return owners;
}

function parseFile(source, filePath) {
  const ast = parseSource(source, filePath);
  return { path: normalizePath(filePath), ast, owners: annotateOwners(ast) };
}

function ownerOf(file, node) {
  return file.owners.get(node) || { owner: '<top-level>', className: '' };
}

// Global function and class-method definitions. Runtime scripts share one
// global scope through the runtime bundle, so name resolution is cross-file.
function indexDefinitions(files) {
  const functions = new Map();
  const methods = new Map();
  const add = (map, name, def) => {
    if (!name) return;
    if (!map.has(name)) map.set(name, []);
    map.get(name).push(def);
  };
  for (const file of files) {
    walkAst(file.ast, (node) => {
      const { className } = ownerOf(file, node);
      if (node.type === 'FunctionDeclaration' && node.id) {
        add(functions, node.id.name, { file, node, name: node.id.name });
      } else if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && isFunction(node.init)) {
        add(functions, node.id.name, { file, node: node.init, name: node.id.name });
      } else if (node.type === 'MethodDefinition' || (node.type === 'PropertyDefinition' && isFunction(node.value))) {
        const name = propertyName(node.key);
        add(methods, `${className}.${name}`, { file, node: node.value, name: `${className}.${name}` });
      }
    });
  }
  return { functions, methods };
}

function resolveCallable(node, context, index) {
  if (!node) return [];
  if (isFunction(node)) return [{ file: context.file, node, name: '<inline>' }];
  if (node.type === 'Identifier') return index.functions.get(node.name) || [];
  if (node.type === 'MemberExpression' && node.object.type === 'ThisExpression') {
    return index.methods.get(`${context.className}.${memberProperty(node)}`) || [];
  }
  if (node.type === 'CallExpression' && memberProperty(node.callee) === 'bind') {
    return resolveCallable(node.callee.object, context, index);
  }
  return [];
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

// True when a receiver can carry a shared collection whose size is unrelated to
// the event: DOM collection queries, instance state, globals, or aliases of them.
function isSharedCollection(node, bindings) {
  let current = node;
  while (current) {
    if (current.type === 'CallExpression') {
      const name = calleeName(current);
      if (DOM_COLLECTION_QUERIES.has(name)) return true;
      if (STRING_METHODS.has(name)) return false;
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

function hazardAt(rule, operation, node, file) {
  return { rule, operation, path: file.path, line: node.loc.start.line, position: node.start };
}

// Direct hazards inside one function body (nested inline callbacks included,
// because they run on the same event).
const hazardCache = new WeakMap();

function functionHazards(fnNode, file) {
  if (!hazardCache.has(fnNode)) hazardCache.set(fnNode, computeFunctionHazards(fnNode, file));
  return hazardCache.get(fnNode);
}

function computeFunctionHazards(fnNode, file) {
  const bindings = collectBindings(fnNode);
  const hazards = [];
  walkAst(fnNode.body || fnNode, (node) => {
    if (node.type === 'CallExpression') {
      const name = calleeName(node);
      const callee = node.callee;
      const at = callee.type === 'MemberExpression' ? callee.property : callee;
      if (DOM_COLLECTION_QUERIES.has(name)) hazards.push(hazardAt('BI-01', name, at, file));
      else if (ITERATION_METHODS.has(name) && callee.type === 'MemberExpression' && isSharedCollection(callee.object, bindings)) {
        hazards.push(hazardAt('BI-01', name, at, file));
      } else if (name === 'from' && callee.object?.name === 'Array' && node.arguments[0] && isSharedCollection(node.arguments[0], bindings)) {
        hazards.push(hazardAt('BI-01', 'Array.from', at, file));
      } else if (OBJECT_ENUMERATION.has(name) && callee.object?.name === 'Object' && node.arguments[0] && isSharedCollection(node.arguments[0], bindings)) {
        hazards.push(hazardAt('BI-01', `Object.${name}`, at, file));
      } else if ((name === 'stringify' || name === 'parse') && callee.object?.name === 'JSON') {
        hazards.push(hazardAt('BI-13', `JSON.${name}`, at, file));
      } else if (REQUEST_CALLS.has(name) && callee.type === 'Identifier') {
        hazards.push(hazardAt('BI-03', name, at, file));
      } else if (callee.type === 'MemberExpression' && STORAGE_OBJECTS.has(callee.object?.name)) {
        hazards.push(hazardAt('BI-01', `${callee.object.name}.${name}`, at, file));
      } else if (name === 'insertAdjacentHTML') {
        hazards.push(hazardAt('BI-02', name, at, file));
      }
    } else if (node.type === 'NewExpression' && ['Set', 'Map'].includes(node.callee?.name) && node.arguments[0] && isSharedCollection(node.arguments[0], bindings)) {
      hazards.push(hazardAt('BI-01', `new ${node.callee.name}`, node, file));
    } else if ((node.type === 'ForOfStatement' || node.type === 'ForInStatement') && isSharedCollection(node.right, bindings)) {
      hazards.push(hazardAt('BI-01', node.type === 'ForOfStatement' ? 'for-of' : 'for-in', node, file));
    } else if (node.type === 'SpreadElement' && isSharedCollection(node.argument, bindings)) {
      hazards.push(hazardAt('BI-01', 'spread', node, file));
    } else if (node.type === 'AssignmentExpression' && MARKUP_PROPERTIES.has(memberProperty(node.left))) {
      hazards.push(hazardAt('BI-02', memberProperty(node.left), node.left.property, file));
    }
  });
  return hazards.sort((a, b) => a.position - b.position);
}

// Functions called (or scheduled) from a function body.
function calledFunctions(fnNode, context, index) {
  const callees = [];
  walkAst(fnNode.body || fnNode, (node) => {
    if (node.type !== 'CallExpression') return;
    callees.push(...resolveCallable(node.callee, context, index));
    if (DEFERRED_CALLBACK_CALLS.has(calleeName(node)) && node.arguments[0] && !isFunction(node.arguments[0])) {
      callees.push(...resolveCallable(node.arguments[0], context, index));
    }
  });
  return callees;
}

function reachableHazards(handler, context, index) {
  const direct = functionHazards(handler.node, handler.file).map(hazard => ({ ...hazard, via: [] }));
  const indirect = [];
  const seen = new Set([handler.node]);
  const queue = calledFunctions(handler.node, context, index).map(def => ({ def, via: [def.name] }));
  while (queue.length) {
    const { def, via } = queue.shift();
    if (seen.has(def.node) || via.length > MAX_CALL_DEPTH) continue;
    seen.add(def.node);
    for (const hazard of functionHazards(def.node, def.file)) indirect.push({ ...hazard, via });
    const defContext = { file: def.file, className: ownerOf(def.file, def.node).className };
    for (const next of calledFunctions(def.node, defContext, index)) queue.push({ def: next, via: [...via, next.name] });
  }
  return { direct, indirect };
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
  };
}

// Entry points plus the handler node for high-frequency events.
function fileEntrypoints(file) {
  const found = [];
  walkAst(file.ast, (node) => {
    if (node.type === 'CallExpression') {
      const name = calleeName(node);
      if (name === 'addEventListener') {
        const trigger = stringValue(node.arguments[0]);
        if (trigger) found.push({ ...entry(file, node, 'event', trigger), handler: node.arguments[1] });
      } else if (TIMER_CALLS.has(name) && (node.callee.type === 'Identifier' || GLOBAL_OBJECTS.has(node.callee.object?.name))) {
        found.push(entry(file, node, 'timer', name));
      } else if (REQUEST_CALLS.has(name) && node.callee.type === 'Identifier') {
        // Only a target with a literal leading path is statically owned; the rest
        // need a deterministic request-capture contract.
        const target = stringValue(node.arguments[0]);
        const call = entry(file, node, 'request', name);
        found.push({ ...call, targets: [{ target: target?.startsWith('/') ? target : null, line: call.line }] });
      }
    } else if (node.type === 'NewExpression') {
      const name = node.callee?.name;
      if (OBSERVERS.has(name)) found.push(entry(file, node, 'observer', name));
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
  return [...byKey.values()];
}

function publicEntry({ handler, ...rest }) {
  return rest;
}

function discoverJavaScriptSource(source, filePath) {
  return dedupeEntrypoints(fileEntrypoints(parseFile(source, filePath)).map(publicEntry));
}

function analyzeFiles(files) {
  const index = indexDefinitions(files);
  const entrypoints = [];
  const hazards = [];
  for (const file of files) {
    for (const found of fileEntrypoints(file)) {
      entrypoints.push(publicEntry(found));
      if (found.kind !== 'event' || !HIGH_FREQUENCY_EVENTS.has(found.trigger) || !found.handler) continue;
      const context = { file, className: ownerOf(file, found.handler).className };
      for (const handler of resolveCallable(found.handler, context, index)) {
        const handlerContext = { file: handler.file, className: ownerOf(handler.file, handler.node).className };
        const { direct, indirect } = reachableHazards(handler, handlerContext, index);
        // Broad work directly inside a high-frequency handler is rejected; work
        // reached through helpers requires a runtime contract.
        for (const hazard of direct) hazards.push({ ...hazard, entrypoint: found.key, depth: 'direct', reject: true });
        for (const hazard of indirect) hazards.push({ ...hazard, entrypoint: found.key, depth: 'indirect', reject: false });
      }
    }
    hazards.push(...routeOwnershipHazards(file).map(hazard => ({ ...hazard, entrypoint: hazard.key, depth: 'direct', via: [], reject: true })));
  }
  const keyed = hazards.map(hazard => ({
    ...hazard,
    key: hazard.key || `${hazard.entrypoint}:${hazard.rule}:${hazard.operation}@${hazard.path}#${hazard.via.at(-1) || '<handler>'}`,
  }));
  const uniqueHazards = new Map();
  for (const hazard of sortEntries(keyed)) if (!uniqueHazards.has(hazard.key)) uniqueHazards.set(hazard.key, hazard);
  return { entrypoints: dedupeEntrypoints(entrypoints), hazards: [...uniqueHazards.values()] };
}

function findJavaScriptHazards(source, filePath) {
  const { hazards } = analyzeFiles([parseFile(source, filePath)]);
  return hazards
    .filter(hazard => hazard.depth === 'direct')
    .sort((a, b) => a.line - b.line || a.position - b.position || a.rule.localeCompare(b.rule));
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
  analyzeJavaScriptRepository,
  analyzeJavaScriptSources,
  discoverJavaScriptEntrypoints,
  discoverJavaScriptSource,
  findJavaScriptHazards,
  walkAst,
};
