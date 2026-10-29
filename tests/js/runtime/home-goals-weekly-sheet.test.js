'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,load}=require('./home-friends-native-app-fixture.cjs');
async function mounted(t){
 const h=fixture(t),{mountWeeklyGoalsSheet}=await load('goals-weekly-sheet.mjs');
 const host=h.form.querySelector('#app-form-content'),mounts=[],closes=[];let current=true;
 h.form.hidden=false;
 h.c.AlbumHavenBottomSheet={mount(options){const row={options,disposed:0,suspended:[]};mounts.push(row);return {dispose(){row.disposed++;},suspend(value){row.suspended.push(value);}};}};
 const media=h.c.matchMedia('(max-width: 720px)');media.matches=true;
 const owner=h.own(mountWeeklyGoalsSheet(host,h.runtime,{isCurrent:()=>current,onClose:next=>{closes.push(next);return false;}}));
 return {...h,host,media,mounts,closes,owner,resize(value){media.matches=value;for(const fn of media.listeners)fn();},retire(){current=false;}};
}
test('Goals mounts shared mobile owner with native focus/dismissal retained and semantic labels',async t=>{
 const h=await mounted(t),o=h.mounts[0].options;
 assert.equal(o.ownDismissal,false);assert.equal(o.ownFocus,false);assert.equal(o.expandLabel,'Expand Weekly Goals settings');assert.equal(o.collapseLabel,'Collapse Weekly Goals settings');
 assert.equal(o.overlay,h.form);assert.equal(o.scroller,h.host);assert.equal(o.requestClose('drag'),false);assert.deepEqual(h.closes,[{reason:'drag'}]);
 assert.equal(h.form.querySelectorAll('.album-sheet-handle').length,1);assert.equal(h.host.contains(o.handle),false);
});
test('mobile to desktop to mobile disposes before remount; close removes listeners and nodes',async t=>{
 const h=await mounted(t);h.resize(false);assert.equal(h.mounts[0].disposed,1);assert.equal(h.form.classList.contains('is-native-bottom-sheet'),false);
 h.resize(true);assert.equal(h.mounts.length,2);h.owner.dispose();h.resize(false);h.resize(true);assert.equal(h.mounts.length,2);assert.equal(h.mounts[1].disposed,1);assert.equal(h.media.listeners.size,0);assert.equal(h.form.querySelector('.album-sheet-handle'),null);
});
test('retired context cannot request dismissal or remain current',async t=>{
 const h=await mounted(t),o=h.mounts[0].options;h.retire();assert.equal(o.isCurrent(),false);assert.equal(o.requestClose('drag'),false);assert.deepEqual(h.closes,[]);h.resize(true);assert.equal(h.mounts[0].disposed,1);
});
