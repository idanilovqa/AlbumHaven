import {mountSharedHeader, mountListensBadge} from '/music_app/static/js/home-friends/shared-header.mjs';
import {mountButton, mountChoice} from '/music_app/static/js/home-friends/native-controls.mjs';
import {mountPeriod} from '/music_app/static/js/home-friends/period.mjs';
import {mountProfileIdentity} from '/music_app/static/js/home-friends/profile.mjs';
const runtime = {buttonHtml:x=>window.ButtonComponent.renderButton(x),actionHtml:x=>window.ButtonComponent.renderActionButton(x),
  iconHtml:x=>window.ButtonComponent.renderIconSvg(x),openChoice:(...args)=>window.openUtilityChoiceDropdown(...args),
  artboxHtml:x=>window.buildAlbumArtboxHtml(x),alertHtml:x=>window.buildOnPageAlertHtml(x),openAvatar(){}};
window.fixtureCalls=[];
let revision=0, permitted=true, period='week', disposed=false, header, reset, missing, periodOwner, badge;
const owners=[], own=owner=>{owners.push(owner);return owner;};
function host(parent, tag='span') {const child=document.createElement(tag);parent.append(child);return child;}
const resetProps=()=>({label:'Reset',onClick:()=>window.fixtureCalls.push('reset:'+revision)});
const missingProps=()=>({label:'Missing',disabled:!permitted,onClick:()=>window.fixtureCalls.push('missing')});
const periodProps=()=>({value:period,onChange:value=>{period=value;render();}});
const badgeProps=()=>({total:period==='week'?7:28,range:'Selected period'});
function render() {if(disposed)return;reset.update(resetProps());missing.update(missingProps());periodOwner.update(periodProps());badge.update(badgeProps());header.refresh();}
window.fixtureUpdate=patch=>{if(disposed)return;if('permitted' in patch)permitted=patch.permitted;if('period' in patch)period=patch.period;revision++;render();};
window.fixtureUnmount=()=>{if(disposed)return;disposed=true;let failure;for(const owner of owners.splice(0).reverse()){try{owner.dispose();}catch(error){failure??=error;}}if(failure)throw failure;};
try {
  header=own(mountSharedHeader(document.getElementById('fixture'),runtime,{id:'fixture',className:'gallery-bar home-friends__page-header'}));
  own(mountProfileIdentity(host(header.slots.identity,'div'),runtime,{profile:{display_name:'Fixture Person',handle:'fixture',avatar_url:null}}));
  badge=own(mountListensBadge(host(header.slots.identity),runtime,badgeProps()));
  own(mountButton(host(header.slots.leading),runtime,{label:'Full size',icon:'expand',onClick:()=>window.fixtureCalls.push('expand')}));
  reset=own(mountButton(host(header.slots.actions),runtime,resetProps()));
  periodOwner=own(mountPeriod(host(header.slots.actions),runtime,periodProps()));
  own(mountChoice(host(header.slots.actions),runtime,{label:'Rows',showLabel:false,value:'all',options:[['all','All rows'],['few','Few rows']],onChange:x=>window.fixtureCalls.push('rows:'+x)}));
  missing=own(mountButton(host(header.slots.actions),runtime,missingProps()));
  own(mountButton(host(header.slots.outsideActions),runtime,{label:'View',icon:'cover',onClick:()=>window.fixtureCalls.push('view')}));
  for(const icon of window.fixtureFinalOrder||['collapse'])own(mountButton(host(header.slots.finalAction),runtime,{icon,label:({collapse:'Collapse',more:'More actions',close:'Close'})[icon],onClick:()=>window.fixtureCalls.push(icon)}));
  header.refresh();
} catch(error) {window.fixtureUnmount();throw error;}
