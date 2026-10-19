'use strict';
// New additive platform support only. The protected DOM harness stays intact.
// Supports selector-list/descendant compounds with standards-consistent :not()
// and :scope/:hover; unsupported combinators/pseudo-classes still fail explicitly.
function withDomPlatform(env) {
  const {context: c, document} = env, proto = c.Element.prototype;
  const basicMatches = proto.matches, rectangles = new WeakMap();
  // Synthetic DOM events do not change browser hit-testing state. Tests may
  // explicitly place the pointer over one element; its connected ancestors hover.
  let hoveredElement = null;
  const setHoveredElement = node => {
    if (node !== null && (!(node instanceof c.Element) || node.nodeType !== 1)) throw new TypeError('Hover target must be an element in this fixture or null');
    hoveredElement = node;
  };
  function split(value, whitespace = false) {
    const result = []; let start = 0, quote = '', square = 0, round = 0;
    for (let i = 0; i < value.length; i++) {
      const ch = value[i];
      if (quote) {if (ch === quote && value[i - 1] !== '\\') quote = ''; continue;}
      if (ch === '"' || ch === "'") {quote = ch; continue;}
      if (ch === '[') square++; if (ch === ']') square--;
      if (ch === '(') round++; if (ch === ')') round--;
      if (square < 0 || round < 0) throw new SyntaxError('Unbalanced selector');
      if (!square && !round && (whitespace ? /\s/.test(ch) : ch === ',')) {
        const part = value.slice(start, i).trim();
        if (part) result.push(part); else if (!whitespace) throw new SyntaxError('Empty selector branch');
        start = i + 1;
      }
    }
    if (quote || square || round) throw new SyntaxError('Unbalanced selector');
    const final = value.slice(start).trim();
    if (final) result.push(final); else if (!whitespace) throw new SyntaxError('Empty selector branch');
    return result;
  }
  function compound(value) {
    let basic = '', scoped = false, hovered = false, square = 0, quote = ''; const excluded = [];
    for (let i = 0; i < value.length;) {
      const ch = value[i];
      if (quote) {basic += ch; if (ch === quote && value[i - 1] !== '\\') quote = ''; i++; continue;}
      if (ch === '"' || ch === "'") {quote = ch; basic += ch; i++; continue;}
      if (ch === '[') square++; if (ch === ']') square--;
      if (square) {basic += ch; i++; continue;}
      if (value.startsWith(':hover', i) && !/[\w-]/.test(value[i + 6] || '')) {hovered = true; i += 6; continue;}
      if (value.startsWith(':scope', i)) {scoped = true; i += 6; continue;}
      if (!value.startsWith(':not(', i)) {basic += value[i++]; continue;}
      let depth = 1, end = i + 5, negationQuote = '';
      for (; end < value.length && depth; end++) {
        const ch = value[end];
        if (negationQuote) {if (ch === negationQuote && value[end - 1] !== '\\') negationQuote = ''; continue;}
        if (ch === '"' || ch === "'") negationQuote = ch;
        else if (ch === '(') depth++; else if (ch === ')') depth--;
      }
      if (depth) throw new SyntaxError('Unclosed :not()');
      excluded.push(compile(value.slice(i + 5, end - 1))); i = end;
    }
    basic ||= '*';
    basicMatches.call(document, basic); // Validate even an empty result set.
    return (node, scope) => (!scoped || node === scope) && basicMatches.call(node, basic)
      && (!hovered || Boolean(node.nodeType === 1 && hoveredElement?.isConnected && node.contains(hoveredElement)))
      && excluded.every(predicate => !predicate(node, scope));
  }
  function compile(selector) {
    if (typeof selector !== 'string' || !selector.trim()) throw new SyntaxError('Empty selector');
    const branches = split(selector).map(branch => split(branch, true).map(compound));
    return (node, scope) => branches.some(parts => {
      if (!(node instanceof c.Element) || !parts.at(-1)(node, scope)) return false;
      let ancestor = node.parentElement;
      for (let i = parts.length - 2; i >= 0; i--) {
        while (ancestor && !parts[i](ancestor, scope)) ancestor = ancestor.parentElement;
        if (!ancestor) return false; ancestor = ancestor.parentElement;
      }
      return true;
    });
  }
  proto.matches = function (selector) {return compile(selector)(this, this);};
  proto.closest = function (selector) {const predicate = compile(selector); for (let node = this; node instanceof c.Element; node = node.parentElement) if (predicate(node, this)) return node; return null;};
  proto.querySelectorAll = function (selector) {
    const predicate = compile(selector), result = [];
    const visit = node => {for (const child of node.children) {if (predicate(child, this)) result.push(child); visit(child);}};
    visit(this); return result;
  };
  proto.querySelector = function (selector) {return this.querySelectorAll(selector)[0] || null;};
  proto.getBoundingClientRect = function () {
    const rect = rectangles.get(this) || {x: 0, y: 0, width: 0, height: 0};
    return {...rect, left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height};
  };
  proto.getClientRects = function () {const rect = this.getBoundingClientRect(); return this.isConnected && !this.closest('[hidden]') && (rect.width || rect.height) ? [rect] : [];};
  const setRect = (node, rect) => rectangles.set(node, {x: 0, y: 0, width: 0, height: 0, ...rect});
  return {...env, setRect, setHoveredElement};
}
module.exports = {withDomPlatform};
