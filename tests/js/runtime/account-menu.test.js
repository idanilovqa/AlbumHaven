const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function harness() {
  const source = fs.readFileSync(path.join(__dirname, '../../../music_app/static/js/runtime/account-menu.js'), 'utf8');
  const document = { activeElement: null };
  function element(attributes = {}) {
    return {
      attributes, hidden: false, disabled: false, listeners: {},
      getAttribute(name) { return this.attributes[name] ?? null; },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      addEventListener(name, handler) { this.listeners[name] = handler; },
      focus() { document.activeElement = this; },
      contains(target) { return target === this; },
      closest(selector) { return selector === '[role="menuitem"]' && this.attributes.role === 'menuitem' ? this : null; },
    };
  }
  const trigger = element();
  const menu = element();
  menu.hidden = true;
  const items = [element({ role: 'menuitem' }), element({ role: 'menuitem', 'aria-disabled': 'true' }), element({ role: 'menuitem' })];
  menu.querySelectorAll = () => items;
  menu.contains = (target) => target === menu || items.includes(target);
  const component = element();
  component.querySelector = (selector) => selector === '[data-account-menu-trigger]' ? trigger : menu;
  component.contains = (target) => target === trigger || menu.contains(target);
  document.listeners = {};
  document.addEventListener = (name, handler) => { document.listeners[name] = handler; };
  const context = vm.createContext({ document });
  vm.runInContext(source, context);
  context.attachAccountMenu(component);
  const fire = (target, type, values = {}) => {
    const event = {
      target, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.stopped = true; },
      stopImmediatePropagation() { this.stopped = true; },
      ...values,
    };
    target.listeners[type]?.(event);
    return event;
  };
  return { document, component, trigger, menu, items, fire };
}

test('toggle synchronizes visibility, expanded state, and first enabled item focus', () => {
  const { trigger, menu, items, document, fire } = harness();
  fire(trigger, 'click');
  assert.equal(menu.hidden, false);
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  assert.equal(document.activeElement, items[0]);
  fire(trigger, 'click');
  assert.equal(menu.hidden, true);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(document.activeElement, trigger);
});

test('keyboard navigation skips disabled actions and Escape restores trigger focus', () => {
  const { component, trigger, menu, items, document, fire } = harness();
  fire(component, 'keydown', { target: trigger, key: 'ArrowDown' });
  assert.equal(document.activeElement, items[0]);
  fire(component, 'keydown', { target: items[0], key: 'ArrowDown' });
  assert.equal(document.activeElement, items[2]);
  fire(component, 'keydown', { target: items[2], key: 'Home' });
  assert.equal(document.activeElement, items[0]);
  const escape = fire(component, 'keydown', { target: items[0], key: 'Escape' });
  assert.equal(menu.hidden, true);
  assert.equal(document.activeElement, trigger);
  assert.equal(escape.defaultPrevented, true);
  assert.equal(escape.stopped, true);
});

test('disabled actions reject click and keyboard activation without closing the menu', () => {
  const { component, trigger, menu, items, fire } = harness();
  fire(trigger, 'click');
  for (const disabled of [items[1], items[2]]) {
    disabled.disabled = disabled === items[2];
    const click = fire(menu, 'click', { target: disabled });
    assert.equal(click.defaultPrevented, true);
    assert.equal(click.stopped, true);
    const key = fire(component, 'keydown', { target: disabled, key: 'Enter' });
    assert.equal(key.defaultPrevented, true);
    assert.equal(menu.hidden, false);
  }
});

test('enabled activation closes without suppressing the action; outside click and focus dismiss', () => {
  const { component, trigger, menu, items, document, fire } = harness();
  fire(trigger, 'click');
  const click = fire(menu, 'click', { target: items[0] });
  assert.equal(menu.hidden, true);
  assert.equal(click.defaultPrevented, false);
  assert.equal(document.activeElement, trigger);
  fire(trigger, 'click');
  fire(document, 'click', { target: {} });
  assert.equal(menu.hidden, true);
  fire(trigger, 'click');
  fire(component, 'focusout', { relatedTarget: items[2] });
  assert.equal(menu.hidden, false);
  fire(component, 'focusout', { relatedTarget: {} });
  assert.equal(menu.hidden, true);
});
