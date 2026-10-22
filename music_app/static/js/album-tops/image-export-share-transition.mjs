// Only a currently registered logical Share owner can hand its native shell
// to the designer. Retired weak keys never silently become standalone hosts.
const owners = new WeakMap();
const fail = code => {throw Object.assign(new Error('Image transition unavailable.'), {code});};
const connected = host => host && typeof host === 'object' && host.isConnected === true;
export function registerAlbumTopImageShareTransition(host, begin) {
  if (!connected(host) || typeof begin !== 'function' || owners.get(host)?.active) fail('share_transition_unavailable');
  const owner = {active:true,begin,issued:false,lease:null}; owners.set(host,owner);
  return () => {
    if (!owner.active) return;
    owner.active=false;owner.begin=null;
    const lease=owner.lease;owner.lease=null;
    if(owners.get(host)===owner)owners.set(host,{active:false});
    lease?.cancel();
  };
}
export function requestAlbumTopImageShareTransition(host) {
  if(!connected(host))fail('share_transition_unavailable');
  const owner=owners.get(host);if(!owner)return null;
  if(!owner.active||owner.issued)fail('share_transition_unavailable');
  owner.issued=true;
  try {
    const lease=owner.begin();
    if(!lease||!Object.isFrozen(lease)||Reflect.ownKeys(lease).length!==2
      ||!Object.hasOwn(lease,'settled')||!Object.hasOwn(lease,'cancel')
      ||!(lease.settled instanceof Promise)||typeof lease.cancel!=='function')throw null;
    owner.lease=lease;
    if(!owner.active){owner.lease=null;lease.cancel();}
    return lease;
  }catch{fail('share_transition_unconfirmed');}
}
