'use strict';
// Reusable test inputs and real-owner setup only. No policy or owner substitutes.
const assert=require('node:assert/strict');
const base=require('./advanced-runtime.cjs');
const state=h=>h.owner('advancedSearchState');
const panel=h=>h.document.getElementById('search-advanced-panel');
function prepare(h){h.input.value='';h.dispatch(h.input,'input');h.click(h.document.getElementById('search-advanced-toggle'));assert.equal(h.c.editAdvancedSearchControls({type:'setFamily',family:'love'}),true);assert.equal(h.c.editAdvancedSearchControls({type:'setLove',side:'include',orderedSet:['loved']}),true);return state(h).session;}
function apply(h){let operation;const capture=()=>{operation=state(h).pending;};h.form.addEventListener('submit',capture,true);h.click(panel(h).querySelector('[data-advanced-apply]'));h.form.removeEventListener('submit',capture,true);assert.ok(operation,'actual submit captured operation');return operation;}
function editor(h,options={}){let closes=0,controls,beforeCalls=0;const promise=h.c.showAppFormDialog({title:'Fixture consumer',pageId:'advanced-editor',...options,beforeDismiss:options.beforeDismiss?reason=>{beforeCalls++;return options.beforeDismiss(reason);}:undefined,onMount(node,value){controls=value;options.onMount?.(node,value);},onClose(...args){closes++;return options.onClose?.(...args);}});const owner=h.c.getActiveAppFormPage();assert.ok(owner);return {promise,owner,controls,get closes(){return closes;},get beforeCalls(){return beforeCalls;}};}
function mobileShell(h){h.c.innerWidth=390;for(const [tag,id]of [['header','mobile-page-header'],['div','mobile-page-outlet'],['button','mobile-back-button'],['button','mobile-library-button'],['h2','mobile-page-title'],['p','mobile-page-summary'],['div','mobile-settings-actions'],['button','mobile-settings-button']]){const node=h.document.createElement(tag);node.id=id;h.main.append(node);}h.c.setMobileSearchOpen(true);}
function dismissalOptions(op,onDismissOutcome){return {dismissalOperation:{identity:op,nonce:op.nonce,sessionId:op.sessionId},isCurrent:op.isCurrent,onDismissOutcome,searchReplacement:{operation:op,nonce:op.nonce,scope:op.scope,intentRevision:op.intentRevision,isCurrent:op.isCurrent},restoreFocus:false};}
function clickConfirm(h,accept){const node=h.document.getElementById(accept?'app-confirm-accept':'app-confirm-cancel');assert.equal(h.document.getElementById('app-confirm-modal').hidden,false);h.click(node);}
module.exports={...base,state,panel,prepare,apply,editor,mobileShell,dismissalOptions,clickConfirm};
