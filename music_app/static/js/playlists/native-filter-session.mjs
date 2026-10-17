export function createPlaylistFilterSession(controller,sourceIdentity,providers,onChange=()=>{}){
 let context={controller,sourceIdentity,providers},active=null,sequence=0,disposed=false;
 const sourceCurrent=owner=>{if(disposed||!owner||owner.id!==sequence||owner.context!==context||owner.version!==context.controller.getLifecycleVersion?.())return false;const identity=context.sourceIdentity(context.controller.getSnapshot());return Boolean(identity&&identity.length===owner.identity.length&&identity.every((value,index)=>Object.is(value,owner.identity[index])));};
 const current=owner=>active===owner&&sourceCurrent(owner);
 const close=owner=>{if(disposed||active!==owner)return;active=null;onChange();};
 const retire=()=>{if(active&&!current(active))close(active);};let unsubscribe=controller.subscribe(retire);
 return {get opening(){return current(active)?active:null;},current,sourceCurrent,close,toggle(){if(disposed)return;if(current(active)){close(active);return;}const identity=context.sourceIdentity(context.controller.getSnapshot());if(!identity)return;active={context,identity,version:context.controller.getLifecycleVersion?.(),id:++sequence};onChange();},update(nextController,nextIdentity,nextProviders){if(disposed)return;if(context.controller===nextController&&context.sourceIdentity===nextIdentity&&context.providers===nextProviders)return;unsubscribe();context={controller:nextController,sourceIdentity:nextIdentity,providers:nextProviders};unsubscribe=nextController.subscribe(retire);retire();},dispose(){disposed=true;active=null;unsubscribe();}};
}
