import {createGoalsOwner} from './goals-owner.mjs';
import {mountGoalsPanel} from './goals.mjs';
import {mountSharedHeader} from './shared-header.mjs';
import {mountProfileIdentity} from './profile.mjs';
import {mountTabs} from './native-controls.mjs';
import {createNativeLifetime} from './native-lifetime.mjs';

// This is the account-safe Home/Goals fallback. It never starts the library shell.
export function mountAccountGoalsEntry(root, runtime, createTransport, {onRestore = () => root.ownerDocument.defaultView.location.reload()} = {}) {
  const life = createNativeLifetime(), doc = root.ownerDocument, win = doc.defaultView;
  const username = root.dataset.accountName || '';
  let retired = false, transport, goalsOwner, panel, visibilityRequest = null, visibilitySequence = 0;
  let focused = typeof doc.hasFocus === 'function' ? doc.hasFocus() : true;
  let visible = doc.visibilityState !== 'hidden' && focused;
  const current = () => !retired && !life.disposed;
  const make = (parent, tag, className) => {const node=doc.createElement(tag);node.className=className;parent.append(node);return node;};
  const privacyNote = make(root.parentNode, 'p', 'home-friends__muted'); privacyNote.hidden=true; privacyNote.setAttribute('role','status');
  life.defer(()=>privacyNote.remove());
  function cancelVisibility() {visibilitySequence++;const previous=visibilityRequest;visibilityRequest=null;previous?.abort();}
  life.defer(cancelVisibility);
  async function visibilityChanged() {
    if (!current()) return;
    cancelVisibility();visible=false;root.hidden=true;panel?.update();
    if (doc.visibilityState === 'hidden' || !focused) {privacyNote.hidden=true;return;}
    const token=visibilitySequence, request=new AbortController();visibilityRequest=request;
    const active=()=>current()&&token===visibilitySequence&&doc.visibilityState!=='hidden'&&focused;
    privacyNote.textContent='Checking this session…';privacyNote.hidden=false;
    try {
      // Validation-only read: retain this panel's exact uncertain intent and
      // never replace its provider/controller or submit a new mutation.
      await transport.request('/account/goals',{signal:request.signal,isCurrent:active});
      if (!active()) return;
      visible=true;privacyNote.hidden=true;root.hidden=false;panel?.update();
    } catch {
      if (active()) {privacyNote.textContent='This session could not be checked. Reload Home to continue.';privacyNote.hidden=false;}
    }
  }
  const blurred = () => {focused=false;void visibilityChanged();};
  const focusedAgain = () => {focused=true;void visibilityChanged();};
  function retire() {
    if (retired) return; retired=true;
    life.dispose(); root.hidden=false;root.replaceChildren(); root.removeAttribute('data-account-name'); root.removeAttribute('data-account-goals-context');
    const status=make(root,'p','home-friends__muted');status.setAttribute('role','status');status.textContent='Reload Home to restore this session.';
    const reload=make(root,'a','button ui-button ui-button--primary ui-button--medium');reload.href='/account/goals/view';reload.textContent='Reload Home';
  }
  const restored = event => {if (event.persisted) {retire();onRestore();}};
  // Keep restoration handling after retirement so BFCache cannot revive controls.
  win.addEventListener('pagehide',retire); win.addEventListener('pageshow',restored);
  try {
    transport=createTransport({root,accountGoals:true});life.own(transport);
    life.defer(transport.subscribe(retire));
    goalsOwner = life.own(createGoalsOwner({transport, isCurrent:current, document:doc}));
    root.replaceChildren();root.classList.add('home-friends');
    const page=life.own(mountSharedHeader(make(root,'div',''),runtime,{id:'home-page',className:'home-friends__page-header'}));
    life.own(mountProfileIdentity(page.slots.identity,runtime,{profile:null,own:true,fallbackName:username || 'My music'}));
    const widget=make(root,'section','home-friends__widget');widget.setAttribute('aria-label','Goals');
    const subsection=life.own(mountSharedHeader(make(widget,'div',''),runtime,{id:'home-recent',className:'home-friends__widget-header'}));
    const content=make(widget,'div','home-friends__widget-content');content.id='account-home-goals';content.setAttribute('role','tabpanel');content.setAttribute('aria-labelledby','home-recent-sections-goals');
    const tabs = life.own(mountTabs(subsection.slots.identity,runtime,{id:'home-recent-sections',label:'Home sections',items:[['goals','Goals',{panelId:content.id}]],value:'goals',onActivate:()=>panel?.update({visitIntent:{}})}));
    life.defer(goalsOwner.controller.subscribe(() => {
      const state = goalsOwner.controller.getSnapshot();
      tabs.setAttention('goals', state.attentionStatus === 'ready' ? state.attention.indicator : 'none');
    }));
    panel=life.own(mountGoalsPanel(content,runtime,{transport,owner:goalsOwner,visitIntent:{},header:{actions:page.slots.actions,content:subsection.slots.content},isCurrent:()=>current()&&visible}));
    doc.addEventListener('visibilitychange',visibilityChanged);life.defer(()=>doc.removeEventListener('visibilitychange',visibilityChanged));
    win.addEventListener('blur',blurred);win.addEventListener('focus',focusedAgain);
    life.defer(()=>{win.removeEventListener('blur',blurred);win.removeEventListener('focus',focusedAgain);});
    root.hidden=!visible;
    page.update({id:'home-page',className:'home-friends__page-header'});subsection.update({id:'home-recent',className:'home-friends__widget-header'});
  } catch(error) {retire();throw error;}
  return {dispose() {retire();win.removeEventListener('pagehide',retire);win.removeEventListener('pageshow',restored);}};
}

export function accountGoalsRuntime(target) {
  return {buttonHtml:value=>target.ButtonComponent.renderButton(value),actionHtml:value=>target.ButtonComponent.renderActionButton(value),
    iconHtml:name=>target.ButtonComponent.renderIconSvg(name),alertHtml:value=>target.buildOnPageAlertHtml(value),
    artboxHtml:value=>target.buildAlbumArtboxHtml(value),galleryCardHtml:value=>target.buildGalleryCardHtml(value),
    switchHtml:value=>target.buildGallerySwitchHtml(value),
    showOwnedToast:(message,variant)=>target.showToast(message,variant,undefined,{placement:'top-center'}),
    tabsHtml:value=>target.buildInPageTabsHtml(value),mountTabs:element=>target.mountInPageTabs(element),
    openChoice:(anchor,options)=>target.openUtilityChoiceDropdown(anchor,options),
    openForm:options=>target.openReactFormDialog(options,()=>Boolean(target.document.getElementById('account-home')?.dataset.accountGoalsContext)),
  };
}

const accountRoot = typeof document === 'object' ? document.getElementById('account-home') : null;
if (accountRoot) {
  try {mountAccountGoalsEntry(accountRoot,accountGoalsRuntime(window),window.createAlbumHavenPrivateUITransport);}
  catch {accountRoot.textContent='Home could not be loaded. Reload to try again.';accountRoot.setAttribute('role','alert');}
}
