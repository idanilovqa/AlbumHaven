const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const React = require('react');
const {renderToStaticMarkup} = require('react-dom/server');
const {buildSync} = require('esbuild');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');
const repo = path.resolve(__dirname, '../../..');
const read = file => fs.readFileSync(path.join(repo, file), 'utf8');
const bundle = buildSync({entryPoints: [path.join(repo, 'music_app/static/js/home-friends/native-choice.jsx')],
  bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react']}).outputFiles[0].text;
const loadComponent = hooks => {
  const module = {exports: {}};
  vm.runInNewContext(bundle, {module, exports: module.exports, require: name => {
    assert.equal(name, 'react'); return hooks;
  }});
  return module.exports.NativeChoice;
};

// Run the native owner unchanged. This bounded DOM supplies only measurable
// viewport/focus/observer behavior; it makes no browser or CSS-layout claim.
function nativeHarness() {
  const env = createNativeHomeRuntime(), {context, document} = env, observers = [];
  const windowNode = document.createElement('window'); windowNode.appendChild(document);
  const viewport = document.createElement('viewport');
  Object.assign(viewport, {offsetLeft: 0, offsetTop: 0, width: 390, height: 720});
  context.visualViewport = viewport; context.innerWidth = 390; context.innerHeight = 720;
  context.addEventListener = (...args) => windowNode.addEventListener(...args);
  context.removeEventListener = (...args) => windowNode.removeEventListener(...args);
  context.Element.prototype.focus = function () {document.activeElement = this;};
  context.Element.prototype.scrollIntoView = function () {this.scrolled = true;};
  context.Element.prototype.getBoundingClientRect = function () {
    return this.rect || {left: 10, right: 210, top: 40, bottom: 70, width: 200, height: 180};
  };
  Object.defineProperty(context.Element.prototype, 'scrollHeight', {get() {return this.contentHeight || 180;}});
  context.getComputedStyle = node => ({direction: node.direction || 'ltr', zIndex: '125',
    backgroundColor: 'rgb(250, 250, 250)', getPropertyValue: () => ''});
  context.MutationObserver = class {
    constructor(callback) {this.callback = callback; observers.push(this);}
    observe() {this.active = true;}
    disconnect() {this.active = false;}
  };
  for (const file of ['trigger-anchor.js', 'library-settings.js']) vm.runInContext(read(`music_app/static/js/runtime/${file}`), context);
  const trigger = (label = 'Choice') => {
    const host = document.createElement('span'); host.innerHTML = context.ButtonComponent.renderButton({label});
    document.body.append(host); return host.firstElementChild;
  };
  const key = (target, value, extra = {}) => {
    const event = new context.Event('keydown', {key: value}); Object.assign(event, extra); target.dispatchEvent(event); return event;
  };
  return {...env, viewport, windowNode, trigger, key, flush: () => {
    for (const observer of [...observers]) if (observer.active) observer.callback([]);
  }, runtime: {buttonHtml: config => context.ButtonComponent.renderButton(config), openChoice: context.openUtilityChoiceDropdown}};
}
const options = {formats: [{value: '', label: 'Any time'}, {value: 'blocked', label: 'Unavailable', disabled: true},
  {value: 'week', label: 'Last week'}, {value: 'month', label: 'Last month'}], selected: 'week', label: 'Period', onSelect() {}};

test('Choice uses native selected/disabled rows, keyboard navigation and one Escape owner', () => {
  const h = nativeHarness(), trigger = h.trigger();
  const owner = h.runtime.openChoice(trigger, options), menu = h.document.querySelector('[role="menu"]');
  const rows = menu.querySelectorAll('button');
  assert.equal(h.document.activeElement, rows[2]); assert.equal(rows[2].getAttribute('aria-checked'), 'true');
  assert.equal(rows[1].disabled, true);
  assert.equal(trigger.classList.contains('trigger-anchor-open'), true);
  h.key(rows[2], 'ArrowUp'); assert.equal(h.document.activeElement, rows[0]);
  h.key(rows[0], 'End'); assert.equal(h.document.activeElement, rows[3]);
  h.key(rows[3], 'ArrowDown'); assert.equal(h.document.activeElement, rows[0]);
  let modalEscapes = 0; h.document.addEventListener('keydown', event => {if (event.key === 'Escape') modalEscapes++;}, true);
  const escape = h.key(rows[0], 'Escape');
  assert.equal(escape.defaultPrevented, true); assert.equal(modalEscapes, 0);
  assert.equal(owner.isOpen, false); assert.equal(h.document.activeElement, trigger);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false'); assert.equal(trigger.classList.contains('trigger-anchor-open'), false);
  h.key(trigger, 'Escape', {repeat: true}); assert.equal(modalEscapes, 0);
  trigger.dispatchEvent(new h.context.Event('keyup', {key: 'Escape'}));
  h.key(trigger, 'Escape'); assert.equal(modalEscapes, 1);
});

test('held Escape cannot dismiss a replacement Choice and blur releases its exact guard', () => {
  const h = nativeHarness(), first = h.trigger(), second = h.trigger();
  const old = h.runtime.openChoice(first, options);
  h.key(h.document.activeElement, 'Escape');
  const replacement = h.runtime.openChoice(second, options);
  old.close(); h.key(h.document.activeElement, 'Escape', {repeat: true});
  assert.equal(replacement.isOpen, true);
  h.windowNode.dispatchEvent(new h.context.Event('blur'));
  h.key(h.document.activeElement, 'Escape'); assert.equal(replacement.isOpen, false);
  h.windowNode.dispatchEvent(new h.context.Event('blur'));
  assert.equal(h.windowNode.listeners.filter(listener => ['keydown', 'keyup', 'blur'].includes(listener.type)).length, 0);
});

test('Choice rejects disabled/stale selections, preserves blank IDs and exact replacement cleanup', () => {
  const h = nativeHarness(), first = h.trigger(), second = h.trigger(), selected = [];
  const old = h.runtime.openChoice(first, {...options, onSelect: value => selected.push(value)});
  const oldMenu = h.document.querySelector('[role="menu"]'), rows = oldMenu.querySelectorAll('button');
  rows[1].dispatchEvent(new h.context.Event('click')); assert.deepEqual(selected, []);
  const current = h.runtime.openChoice(second, {...options, onSelect: value => selected.push(value)});
  old.close(); assert.equal(current.isOpen, true); assert.equal(second.getAttribute('aria-expanded'), 'true');
  rows[2].dispatchEvent(new h.context.Event('click')); assert.deepEqual(selected, []);
  const nextRows = h.document.querySelector('[role="menu"]').querySelectorAll('button'); h.click(nextRows[0]);
  assert.deepEqual(selected, ['']); assert.equal(second.querySelector('.ui-button__content').textContent, 'Any time');
  assert.equal(current.isOpen, false); assert.equal(h.document.activeElement, second);
  h.runtime.openChoice(first, options); assert.equal(h.runtime.openChoice(first, options), null);
  assert.equal(h.document.querySelector('[role="menu"]'), null);
});

test('Choice outside and Tab dismissal close only the menu and leave the trigger usable', () => {
  const h = nativeHarness(), trigger = h.trigger();
  let owner = h.runtime.openChoice(trigger, options);
  const outside = h.trigger('Other'); outside.focus();
  outside.dispatchEvent(new h.context.Event('pointerdown'));
  assert.equal(owner.isOpen, false); assert.equal(h.document.activeElement, outside);
  owner = h.runtime.openChoice(trigger, options);
  const tab = h.key(h.document.activeElement, 'Tab');
  assert.equal(owner.isOpen, false); assert.equal(h.document.activeElement, trigger);
  assert.equal(tab.defaultPrevented, false);
  assert.equal(h.runtime.openChoice(trigger, {...options, initialFocus: 'first'}).isOpen, true);
  assert.equal(h.document.activeElement.getAttribute('data-foobar-format'), '');
});

test('Choice closes for hidden, inert, disabled or removed triggers and releases its listeners', () => {
  for (const invalidate of [trigger => {trigger.disabled = true;}, trigger => {trigger.parentElement.hidden = true;},
    trigger => {trigger.parentElement.inert = true;}, trigger => {trigger.remove();}]) {
    const h = nativeHarness(), trigger = h.trigger();
    const before = h.listeners().length, owner = h.runtime.openChoice(trigger, options);
    invalidate(trigger); h.flush();
    assert.equal(owner.isOpen, false); assert.equal(h.document.querySelector('[role="menu"]'), null);
    // Removed menu nodes retain only their own unreachable click/key handlers.
    assert.equal(h.listeners().filter(item => item.target === h.windowNode || item.target === h.document || item.target === h.viewport).length, before);
    owner.close();
  }
});

test('Choice placement follows the visual viewport, trigger scrolling and player boundary', () => {
  const h = nativeHarness(), trigger = h.trigger(), player = h.document.createElement('div'); player.className = 'global-player';
  player.rect = {top: 640, height: 80}; h.document.body.append(player);
  trigger.rect = {left: 330, right: 510, top: 590, bottom: 620, width: 180, height: 30};
  const owner = h.runtime.openChoice(trigger, {...options, matchTriggerWidth: true}), menu = h.document.querySelector('[role="menu"]');
  assert.equal(menu.style.width, '180px'); assert.equal(menu.style.left, '202px'); assert.equal(menu.style.top, '406px');
  trigger.rect = {...trigger.rect, left: 20, right: 200, top: 150, bottom: 180};
  h.windowNode.dispatchEvent(new h.context.Event('scroll'));
  assert.equal(menu.style.left, '20px'); assert.equal(menu.style.top, '184px');
  Object.assign(h.viewport, {width: 160, height: 360, offsetTop: 50});
  h.viewport.dispatchEvent(new h.context.Event('resize'));
  assert.equal(menu.style.width, '144px'); assert.equal(menu.style.left, '8px'); assert.equal(menu.style.maxHeight, '218px');
  owner.close(); assert.equal(menu.isConnected, false);
});

test('Choice rejection and synchronous consumer replacement cannot overwrite a replacement label', () => {
  const h = nativeHarness(), trigger = h.trigger('Before');
  h.runtime.openChoice(trigger, {...options, onSelect: () => false}); h.click(h.document.querySelector('[data-foobar-format="month"]'));
  assert.equal(trigger.querySelector('.ui-button__content').textContent, 'Before');
  let replacement;
  const other = h.trigger('Other');
  h.runtime.openChoice(trigger, {...options, onSelect: () => {replacement = h.runtime.openChoice(other, options);}});
  h.click(h.document.querySelector('[data-foobar-format="month"]'));
  assert.equal(trigger.querySelector('.ui-button__content').textContent, 'Before');
  assert.equal(replacement.isOpen, true); assert.equal(other.getAttribute('aria-expanded'), 'true');
});

// Execute the component's actual layout effects with explicit hook commits.
// This checks ownership disposal, independently of React DOM/browser coverage.
function componentHarness(h) {
  let cursor = 0, pending = [], slots = [], mounted = false;
  const hooks = {...React,
    useRef(value) {const index = cursor++; return slots[index] ||= {current: value};},
    useLayoutEffect(callback, dependencies) {
      const index = cursor++, prior = slots[index];
      if (!prior || dependencies.some((value, offset) => !Object.is(value, prior.dependencies[offset]))) {
        pending.push(() => {prior?.cleanup?.(); slots[index] = {dependencies, cleanup: callback()};});
      }
    },
  };
  const Component = loadComponent(hooks), host = h.document.createElement('span'); h.document.body.append(host);
  return {host,
    render(props) {
      cursor = 0; pending = [];
      const tree = Component({runtime: h.runtime, label: 'Period', value: 'week', options: options.formats, ...props});
      const control = tree.props.children[1];
      if (!mounted) {host.innerHTML = control.props.dangerouslySetInnerHTML.__html; mounted = true;}
      control.props.ref.current = host;
      for (const effect of pending) effect(); return tree;
    },
    unmount() {for (const slot of slots) slot.cleanup?.(); host.remove();},
  };
}

test('NativeChoice retains its trigger, fresh callbacks, selected labels and exact unmount lifetime', () => {
  const h = nativeHarness(), component = componentHarness(h), calls = [];
  component.render({onChange: value => calls.push(`old:${value}`)});
  const trigger = component.host.firstElementChild; h.click(trigger);
  component.render({onChange: value => calls.push(`new:${value}`)});
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  h.click(h.document.querySelector('[data-foobar-format="month"]')); assert.deepEqual(calls, ['new:month']);
  component.render({value: 'month'}); assert.equal(component.host.firstElementChild, trigger);
  assert.equal(trigger.getAttribute('aria-label'), 'Period: Last month');
  assert.equal(trigger.querySelector('.ui-button__content').textContent, 'Last month');
  h.key(trigger, 'ArrowUp'); assert.equal(h.document.activeElement.getAttribute('data-foobar-format'), 'month');
  component.render({value: 'month', disabled: true}); assert.equal(trigger.disabled, true);
  assert.equal(h.document.querySelector('[role="menu"]'), null);
  component.render({value: 'month'}); h.click(trigger); component.unmount();
  assert.equal(h.document.querySelector('[role="menu"]'), null);
});

test('NativeChoice closes on changed selected identity even when the visible labels match', () => {
  const h = nativeHarness(), component = componentHarness(h), choices = [['first', 'Same'], ['second', 'Same']];
  component.render({value: 'first', options: choices}); const trigger = component.host.firstElementChild;
  h.click(trigger); component.render({value: 'second', options: choices});
  assert.equal(h.document.querySelector('[role="menu"]'), null); assert.equal(h.document.activeElement, trigger);
  h.click(trigger); assert.equal(h.document.activeElement.getAttribute('data-foobar-format'), 'second');
  component.render({value: 'second', options: [['second', 'Same']]});
  assert.equal(h.document.querySelector('[role="menu"]'), null); component.unmount();
});

test('NativeChoice disables unavailable integrations and escapes values through native Button', () => {
  const h = nativeHarness(), NativeChoice = loadComponent(React);
  const html = renderToStaticMarkup(React.createElement(NativeChoice, {runtime: {buttonHtml: h.runtime.buttonHtml},
    label: 'Style', value: '<private>', options: [['<private>', '<Rock>']], showLabel: false}));
  const host = h.document.createElement('span'); host.innerHTML = html;
  assert.equal(host.querySelector('button').disabled, true);
  assert.equal(host.querySelector('button').getAttribute('aria-label'), 'Style: <Rock>');
  assert.equal(host.querySelector('.ui-button__content').textContent, '<Rock>');
  assert.equal(host.querySelector('select'), null);
});


test('NativeChoice can name a compact field inside its trigger without changing menu values or accessible naming', () => {
  const h = nativeHarness(), component = componentHarness(h), calls = [];
  component.render({label: 'Added', value: 'month', controlLabelPrefix: 'Added', showLabel: false,
    onChange: value => calls.push(value)});
  const trigger = component.host.firstElementChild;
  assert.equal(trigger.querySelector('.ui-button__content').textContent, 'Added: Last month');
  assert.equal(trigger.getAttribute('aria-label'), 'Added: Last month');
  h.click(trigger); h.click(h.document.querySelector('[data-foobar-format="week"]'));
  assert.deepEqual(calls, ['week']);
  component.render({label: 'Added', value: 'week', controlLabelPrefix: '<Added>', showLabel: false});
  assert.equal(trigger.querySelector('.ui-button__content').textContent, '<Added>: Last week');
  assert.equal(trigger.getAttribute('aria-label'), 'Added: Last week');
  component.unmount();
});
