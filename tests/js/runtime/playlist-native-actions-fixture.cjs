const assert = require('node:assert/strict');
const vm = require('node:vm');
const {readRepo} = require('./native-home-harness.cjs');
const {nativeDialogFixture} = require('./playlist-native-dialog-fixture.cjs');
// The real dialog and menu helpers own behavior. Only bounded DOM platform
// geometry is supplied; this fixture makes no browser-layout claim.
function actionFixture() {
  const env = nativeDialogFixture(), {context, document, runtime} = env;
  const windowNode = document.createElement('window'); windowNode.appendChild(document);
  context.addEventListener = (...args) => windowNode.addEventListener(...args);
  context.removeEventListener = (...args) => windowNode.removeEventListener(...args);
  context.Element.prototype.scrollIntoView = function () {};
  context.Element.prototype.getBoundingClientRect = function () {
    return this.rect || {left: 10, right: 210, top: 40, bottom: 70, width: 200, height: 180};
  };
  context.getComputedStyle = () => ({direction: 'ltr', zIndex: '125', backgroundColor: 'rgb(250, 250, 250)', getPropertyValue: () => ''});
  for (const file of ['trigger-anchor.js', 'library-settings.js']) vm.runInContext(readRepo(`music_app/static/js/runtime/${file}`), context);
  runtime.openChoice = context.openUtilityChoiceDropdown;
  const click = target => {assert.ok(target, 'Expected a real native control'); target.dispatchEvent(new target.ownerDocument.defaultView.Event('click'));};
  const button = (label, root = document.body) => [...root.querySelectorAll('button')].find(node => node.textContent.trim() === label);
  const choice = label => [...document.querySelectorAll('.ui-choice')].find(node => node.querySelector('.ui-choice__label')?.textContent === label)?.querySelector('button');
  const choose = (label, value) => {click(choice(label)); const row = document.querySelector(`[role="menu"] [data-foobar-format="${value}"]`); assert.ok(row); click(row);};
  return {...env, windowNode, click, button, choice, choose};
}
const flush = async () => {for (let i = 0; i < 8; i++) await Promise.resolve();};
module.exports = {actionFixture, flush};
