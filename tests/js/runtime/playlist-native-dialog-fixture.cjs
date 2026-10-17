const vm=require('node:vm');
const {readRepo}=require('./native-home-harness.cjs');
const {fixture}=require('./playlist-native-review-fixture.cjs');
function nativeDialogFixture({delayed = false} = {}) {
  const env = fixture(), {document, context} = env, events = [];
  const modal = document.createElement('div'); modal.id = 'app-form-modal'; modal.hidden = true;
  const panel = document.createElement('div'); panel.className = 'confirm-modal-dialog'; modal.append(panel);
  for (const name of ['title', 'content', 'error', 'close']) {
    const node = document.createElement(name === 'close' ? 'button' : 'div'); node.id = `app-form-${name}`; panel.append(node);
  }
  const footer = document.createElement('div'); footer.className = 'confirm-modal-actions'; panel.append(footer);
  for (const name of ['cancel', 'submit']) {const node = document.createElement('button'); node.id = `app-form-${name}`; footer.append(node);}
  document.body.append(modal);
  let settle, retirements = 0, closeAttempts = 0;
  const navigation = new Promise(resolve => {settle = resolve;});
  if (delayed) {
    context.presentMobileAppFormPage = () => {};
    context.retireMobileAppFormPage = () => {retirements++; return navigation;};
  }
  vm.runInContext(readRepo('music_app/static/js/runtime/browser-dialog-helpers.js'), context);
  const openForm = env.owner('openReactFormDialog');
  env.runtime.openForm = options => openForm({...options,
    onMount(host, close) {options.onMount(host, (value, next) => {closeAttempts++; return close(value, next);});},
    onClose(host, next) {events.push('native-after-close'); options.onClose(host, next);},
  });
  return {...env, modal, events, get closeAttempts() {return closeAttempts;}, get retirements() {return retirements;},
    async settle() {settle(true); await navigation; await Promise.resolve(); await Promise.resolve();}};
}

module.exports={nativeDialogFixture};
