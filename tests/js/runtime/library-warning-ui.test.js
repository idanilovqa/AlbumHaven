const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function load() {
  const context = {state:{ui:{},status:{}},document:{getElementById:()=>null}};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../../../music_app/static/js/runtime/library-warning-ui.js'),'utf8'),context);
  return context;
}

function renderScanWarning(problem) {
  const context = load();
  const elements = new Map(['library-warning-button', 'library-warning-panel', 'library-scan-warning']
    .map(id => [id, { innerHTML: '', hidden: true, dataset: {} }]));
  context.document.getElementById = id => elements.get(id) || null;
  context.escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  context.ButtonComponent = require('../../../music_app/static/js/button-component.js');
  vm.runInContext(fs.readFileSync(path.join(__dirname,
    '../../../music_app/static/js/runtime/alert-components.js'), 'utf8'), context);
  context.renderLibraryWarning({ watcher_health: {
    state: 'warning', warning_token: 'owned-warning', problems: [problem],
  } });
  const notice = elements.get('library-scan-warning');
  assert.equal(notice.hidden, false);
  return notice.innerHTML;
}

test('watcher health renders a path-free Library notice with the authorized full scan action', () => {
  const html = renderScanWarning({
    state: 'overflow', root_key: 'root_1234567890abcdef',
    message: 'Private Music C:\\Private Music\\song.flac',
    allowed_actions: { 'library.refresh': true },
  });
  assert.match(html, /role="alert"/);
  assert.match(html, /Some library changes may have been missed\./);
  assert.match(html, /class="[^"]*button[^"]*"/);
  assert.match(html, /data-status-action="full-rescan"/);
  assert.match(html, />Full Rescan</);
  assert.doesNotMatch(html, /Private Music|[A-Z]:\\|root_1234567890abcdef/);
});

test('watcher health keeps the Library notice but omits the action for a read-only reviewer', () => {
  for (const allowed_actions of [{}, { 'library.refresh': false }, { 'library.refresh': 'true' }]) {
    const html = renderScanWarning({
      state: 'root_unavailable', root_key: 'root_fedcba0987654321',
      message: 'Private Music C:\\Private Music', allowed_actions,
    });
    assert.match(html, /role="alert"/);
    assert.match(html, /Some library changes may have been missed\./);
    assert.doesNotMatch(html, /data-status-action|Full Rescan|root_fedcba0987654321|Private Music|[A-Z]:\\/);
  }
});
test('dismissal hides only the matching warning, not its Scan page notice',()=>{
  const context=load();
  const health={state:'warning',warning_token:'first'};
  assert.equal(context.libraryWarningPresentation(health,'').showIcon,true);
  assert.equal(context.libraryWarningPresentation(health,'first').showIcon,false);
  assert.equal(context.libraryWarningPresentation(health,'first').warning,true);
  assert.equal(context.libraryWarningPresentation({...health,dismissed:true},'').showIcon,false);
  assert.equal(context.libraryWarningPresentation({...health,warning_token:'second'},'first').showIcon,true);
  assert.equal(context.libraryWarningPresentation({state:'healthy'},'first').showIcon,false);
});
test('failed dismissal is reported without acknowledging or closing the warning',async()=>{
  const context=load();
  const panel={dataset:{warningToken:'first'}};
  context.document.getElementById=()=>panel;
  context.fetch=async()=>({ok:false,status:503});
  let message='';context.showRepairAlert=value=>{message=value;};
  const button={disabled:false};
  await context.dismissLibraryWarning(button);
  assert.equal(button.disabled,false);
  assert.equal(context.state.ui.dismissedLibraryWarningToken,undefined);
  assert.match(message,/Unable to dismiss/);
});
