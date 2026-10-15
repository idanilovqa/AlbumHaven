'use strict';
const assert=require('node:assert/strict');
const {fixture,load,deferred,settle}=require('./home-friends-native-app-fixture.cjs');
const target=kind=>({kind,ref:`${kind}:one`,identity_ref:`${kind}:one`,allowed_actions:{can_view_details:true}});
const track=()=>({id:'track:one',kind:'track',title:'Track',artist:'Artist',source_readable:true,availability:'local',allowed_actions:{can_view_details:true},album_target:target('album'),artist_target:target('artist')});
const visible=node=>Boolean(node&&!node.closest('[hidden], [inert]'));
async function appFixture(t,{section='recent',presentation={},friend=null,status='ready',total=73,controller:provided}={}) {
  const h=fixture(t),{createHomeFriendsController}=await load('model.mjs'),{mountHomeFriendsView}=await load('app.mjs');
  let friends={profile:{display_name:'Owner',handle:'owner',allowed_actions:{can_edit:true}},friends:friend?[friend]:[],requests:[]};
  let activity={status,data:{rows:[track()],total_listens:total,range_label:'Chosen period range',snapshot_ref:'snapshot:one'}};
  let recent={status,data:{total_listens:total,recent_local_albums:[],recent_not_local_albums:[]}};
  const reads=[],saved=[],navigations=[];
  const controller=provided||createHomeFriendsController({providers:{readFriends:()=>friends,readActivity:()=>activity},readRecent:()=>recent});
  if(!provided){controller.setScope('actor/library');await controller.loadFriends();if(friend)controller.selectFriend(friend.account_ref);}
  Object.assign(h.runtime,{savePresentation:next=>saved.push(next),navigate:next=>navigations.push(next),snapshot:()=>({scopeKey:controller.getSnapshot().scopeKey}),
    readActivityMissingEligibility:async()=>({can_inspect_missing:true}),inspectActivityMissing:async()=>true});
  const readDetail=args=>{const pending=deferred();reads.push({args,...pending});return pending.promise;};
  let shell={section,friendRef:friend?.account_ref||'',profileRef:'',accountName:'Owner',presentation:{kind:'tracks',kindExplicit:true,...presentation}},owner;
  const props=()=>({runtime:h.runtime,controller,state:controller.getSnapshot(),shell,readDetail});
  const unsubscribe=controller.subscribe(()=>owner?.update(props()));
  owner=h.own(mountHomeFriendsView(h.host,props()));owner.update(props());await settle();h.drain();await settle();
  t.after(()=>{unsubscribe();if(!provided)controller.dispose();});
  return {...h,controller,owner,reads,saved,navigations,
    update(){owner.update(props());},
    route(next){shell={...shell,...next};owner.update(props());},
    async replaceActivity(next){activity=next;await controller.loadActivity(controller.getSnapshot().activityNavigation.query||{kind:'tracks',period:'week'});await settle();h.drain();},
    async replaceFriends(next){friends=next;await controller.loadFriends();await settle();h.drain();},
    clickRow(){const row=h.host.querySelector('[data-home-activity-row="track:one"]');assert.ok(row);const event=new h.c.Event('click',{bubbles:true});event.detail=1;row.dispatchEvent(event);},
    choosePeriod(label,root=h.host){const trigger=[...root.querySelectorAll('button')].find(n=>visible(n)&&/^Period:/.test(n.getAttribute('aria-label')||''));assert.ok(trigger);h.click(trigger);h.drain();const option=[...h.document.querySelectorAll('[role="menuitemradio"]')].find(n=>n.textContent.trim()===label);assert.ok(option);h.click(option);},
  };
}
module.exports={appFixture,visible,track,settle};
