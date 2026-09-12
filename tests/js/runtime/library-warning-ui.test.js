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
