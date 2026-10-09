const test = require('node:test');
const assert = require('node:assert/strict');
const {createNotificationDrawerHarness} = require('./notification-drawer-harness.cjs');

function setup() {
  const h = createNotificationDrawerHarness(); h.render();
  const forms = h.document.createElement('div'); forms.innerHTML = '<div id="app-shell" data-native-account-id="account" data-native-library-id="library"></div>'
    + '<div id="app-form-modal" hidden><div class="confirm-modal-dialog"><h2 id="app-form-title"></h2><div id="app-form-content"></div>'
    + '<p id="app-form-error"></p><div class="confirm-modal-actions"><button id="app-form-cancel"></button><button id="app-form-submit"></button></div></div></div>';
  h.document.body.appendChild(forms); h.loadForm();
  h.context.overlayClickStartedOnOverlay = (_modal, event) => event.target === h.modal;
  h.context.getComputedStyle = () => ({zIndex: '135'});
  h.modal = h.document.getElementById('app-form-modal'); h.modal.style.zIndex = '125';
  h.source = h.context.AlbumHavenNotifications.registerSource({name: 'friend-requests', scopeKey: 'account:library', isCurrent: () => true, onOpen() {}});
  h.source.replace([{id: 'one', title: 'Person'}]); h.opener = h.bodyElement.querySelector('[data-open-request-notification]'); h.opener.focus();
  h.open = (options = {}) => h.context.openReactFormDialog({title: 'Friend request', parentSurface: '#cover-lookup-drawer',
    returnFocus: () => h.context.notificationDrawerFocusTarget('["friend-requests","account:library","one"]'), ...options});
  return h;
}

for (const selector of ['#track-modal', '#non-album-modal', '[data-resource-selection-content="album"]']) {
  test(`shared playlist form retains ${selector} without touching the notification drawer`, async () => {
    const h = setup(), parent = h.document.createElement('div'), trigger = h.document.createElement('button');
    if (selector.startsWith('#')) parent.id = selector.slice(1); else parent.setAttribute('data-resource-selection-content', 'album');
    parent.hidden = false; parent.inert = false; parent.appendChild(trigger); h.document.body.appendChild(parent); trigger.focus();
    const owner = h.context.openReactFormDialog({title: 'Add to playlist', parentSurface: selector, returnFocus: () => trigger});
    assert.equal(parent.inert, true); assert.equal(h.modal.style.zIndex, '136');
    await owner.close(null, {returnToParent: false, restoreFocus: false});
    assert.equal(parent.inert, false); assert.equal(parent.hidden, false);
    assert.equal(h.drawerElement.hidden, false, 'only the exact native drawer parent may close the drawer');
    assert.equal(h.modal.hidden, true);
  });
}

test('drawer parent stays inert below the native form; Escape returns to the current opener', async () => {
  const h = setup(); let closeOptions;
  const owner = h.open({onClose(_host, options) {closeOptions = options; assert.equal(h.modal.hidden, true); assert.equal(h.drawerElement.inert, false);}});
  assert.equal(h.modal.style.zIndex, '136'); assert.equal(h.drawerElement.inert, true);
  h.modal.dispatchEvent(new h.context.Event('keydown', {key: 'Escape'})); await owner.promise;
  assert.equal(h.modal.hidden, true); assert.equal(h.drawerElement.hidden, false); assert.equal(h.drawerElement.inert, false);
  assert.equal(h.modal.style.zIndex, '125'); assert.equal(h.document.activeElement, h.opener); assert.equal(closeOptions.current, true);
  h.timeouts.splice(0).forEach(callback => callback());
  assert.equal(h.modal.listeners.length, 0);
});

test('form content click cannot close the retained drawer, including a click whose action closes the form', async () => {
  const h = setup(); let outside = 0, close;
  h.document.addEventListener('click', () => {outside++;});
  const owner = h.open({onMount(host, finish) {close = finish; const button = h.document.createElement('button');
    button.addEventListener('click', () => close()); host.appendChild(button);}});
  h.click(h.document.getElementById('app-form-content').querySelector('button')); await owner.promise;
  assert.equal(outside, 0); assert.equal(h.drawerElement.hidden, false);
  h.timeouts.splice(0).forEach(callback => callback());
  assert.equal(h.modal.listeners.length, 0);
});

test('removed request uses connected native fallback and stale account teardown cannot steal focus', async () => {
  const h = setup(), first = h.open(); h.source.replace([]); first.close(); await first.promise;
  assert.equal(h.document.activeElement, h.document.querySelector('[data-close-cover-lookup-drawer]'));
  h.source.replace([{id: 'two', title: 'Other person'}]); const second = h.open();
  h.document.getElementById('app-shell').dataset.nativeAccountId = 'different';
  const currentControl = h.document.createElement('button'); h.document.body.appendChild(currentControl); currentControl.focus();
  second.close(null, {returnToParent: false}); await second.promise; assert.equal(h.document.activeElement, currentControl);
  assert.equal(h.drawerElement.hidden, false, 'old account cleanup cannot retire the current account drawer');
});

test('View profile retires native form and drawer before callback and preserves new route focus', async () => {
  const h = setup(); const profileControl = h.document.createElement('button'); h.document.body.appendChild(profileControl);
  const owner = h.open({onClose() {
    assert.equal(h.modal.hidden, true); assert.equal(h.drawerElement.hidden, true); assert.equal(h.drawerElement.inert, false);
    assert.equal(h.context.getActiveAppFormPage(), null); profileControl.focus();
  }});
  owner.close(null, {returnToParent: false, restoreFocus: false}); await owner.promise;
  assert.equal(h.context.state.coverLookup.drawerOpen, false); assert.equal(h.document.activeElement, profileControl);
});

test('cleanup leaves a newly acquired native form intact and retains an already-inert parent', async () => {
  const h = setup(); h.drawerElement.inert = true; let replacement;
  const old = h.open({onClose() {replacement = h.context.openReactFormDialog({title: 'Next form'});}});
  old.close(); await old.promise;
  assert.equal(h.drawerElement.inert, true); assert.equal(h.modal.hidden, false);
  assert.equal(h.document.getElementById('app-form-title').textContent, 'Next form');
  old.close(); assert.equal(h.modal.hidden, false);
  h.timeouts.splice(0).forEach(callback => callback()); replacement.close(); await replacement.promise;
});

test('a failed form mount restores the drawer and its opener for retry', () => {
  const h = setup();
  assert.throws(() => h.open({onMount() {throw new Error('Mount failed');}}), /Mount failed/);
  assert.equal(h.modal.hidden, true); assert.equal(h.drawerElement.hidden, false); assert.equal(h.drawerElement.inert, false);
  assert.equal(h.document.activeElement, h.opener);
});
