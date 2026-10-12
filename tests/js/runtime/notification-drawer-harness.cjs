const vm = require('node:vm');
const {createNativeHomeRuntime, readRepo} = require('./native-home-harness.cjs');

function createNotificationDrawerHarness(overrides = {}) {
  const env = createNativeHomeRuntime(), {context, document} = env;
  const intervalCalls = [], clearedIntervals = [], timeouts = [];
  const prototype = context.Element.prototype, query = prototype.querySelector;
  prototype.focus = function() {document.activeElement = this;};
  prototype.querySelector = function(selector) {
    if (selector === '.cover-lookup-task-open:active') return env.pressed || null;
    if (selector.includes(':hover')) return env.hovered || null;
    return query.call(this, selector);
  };
  const create = document.createElement;
  document.createElement = name => {
    const node = create(name);
    if (node.content) Object.defineProperty(node.content, 'firstElementChild', {get: () => node.content.childNodes.find(child => child.nodeType === 1) || null});
    return node;
  };
  document.body.innerHTML = '<button id="cover-lookup-drawer-button"></button><span id="cover-lookup-drawer-badge"></span>'
    + '<aside id="cover-lookup-drawer"><span id="cover-lookup-drawer-summary"></span><button data-close-cover-lookup-drawer="1"></button>'
    + '<button id="cover-lookup-drawer-clear"></button><div id="cover-lookup-drawer-body"></div></aside><div id="cover-lookup-modal" hidden></div>';
  Object.assign(context, {
    state: {coverLookup: {tasks: [], drawerOpen: true, modal: {taskId: ''}, pollingTimer: 0, elapsedTimer: 0}},
    mergeCoverLookupTasksWithNotifications: tasks => tasks,
    showToast() {}, formatCoverLookupTaskElapsedLabel: () => 'Elapsed 1s',
    setInterval(callback, delay) {intervalCalls.push({callback, delay}); return intervalCalls.length;},
    clearInterval(id) {clearedIntervals.push(id);},
    setTimeout(callback) {timeouts.push(callback); return timeouts.length;},
    ...overrides,
  });
  vm.runInContext(readRepo('music_app/static/js/runtime/cover-lookup-modal-and-drawer.js'), context);
  return {...env, context, document, intervalCalls, clearedIntervals, timeouts,
    bodyElement: document.getElementById('cover-lookup-drawer-body'),
    drawerElement: document.getElementById('cover-lookup-drawer'),
    buttonElement: document.getElementById('cover-lookup-drawer-button'),
    badgeElement: document.getElementById('cover-lookup-drawer-badge'),
    clearElement: document.getElementById('cover-lookup-drawer-clear'),
    render: () => context.renderCoverLookupDrawer(),
    loadForm() {vm.runInContext(readRepo('music_app/static/js/runtime/browser-dialog-helpers.js'), context);},
  };
}

module.exports = {createNotificationDrawerHarness};
