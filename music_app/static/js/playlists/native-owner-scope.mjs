// Construction-time ownership: a failed factory cannot return its disposer.
// Record each successful acquisition before another renderer can throw.
export function createNativeOwnerScope(){
 let retired=false;const releases=[];
 const defer=release=>{if(retired){release();return;}releases.push(release);};
 return {own(owner){if(owner?.dispose)defer(()=>owner.dispose());return owner;},defer,
  listen(target,type,listener,options){target.addEventListener(type,listener,options);defer(()=>target.removeEventListener(type,listener,options));},
  dispose(){if(retired)return;retired=true;for(const release of releases.splice(0).reverse()){try{release();}catch{/* Finish releasing the remaining owners. */}}}};
}
