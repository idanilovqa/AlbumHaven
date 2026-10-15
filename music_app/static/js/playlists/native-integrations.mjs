import {
  createNativeOwnerScope
}
from './native-owner-scope.mjs';
import {
  mountButton,
  mountStatus
}
from '../home-friends/native-controls.mjs';
import {
  mountRetryOriginalRequest
}
from './native-mutation-status.mjs';
const node=(host,tag='div',className='')=> {
  const value=host.ownerDocument.createElement(tag);
  value.className=className;
  host.append(value);
  return value;
};
function mutation(host,runtime,value,matching=false) {
  host.innerHTML=!value||value.status==='idle'?'':runtime.alertHtml({
    severity:['error','denied'].includes(value.status)?'error':'info',
    role:['error','denied'].includes(value.status)?'alert':'status',
    message: {
      loading:matching?'Accepting the selected match…':'Waiting for the native player…',
      ready:matching?'The matching provider confirmed the selection.':'The native player acknowledged the request.',
      error:'The request was not confirmed.',
      denied:'Access changed. Refresh this playlist before trying again.',
      unavailable:'This integration is unavailable.'
    }
    [value.status]
  });
}
export function mountPlaylistPlaybackControls(host,runtime,initial) {
  let props=initial,
  disposed=false;
  const scope=createNativeOwnerScope();
  scope.defer(()=>host.replaceChildren());
  try {
    host.className='playlists__playback';
    host.setAttribute('aria-label','Playlist playback');
    const toolbar=node(host,'div','playlists__actions');
    toolbar.setAttribute('role','toolbar');
    toolbar.setAttribute('aria-label','Playlist playback controls');
    const orderHost=node(toolbar,'span'),
    shuffleHost=node(toolbar,'span'),
    repeatHost=node(toolbar,'span'),
    returnHost=node(toolbar,'span'),
    statusHost=node(host),
    unavailableHost=node(host),
    currentHost=node(host,'p','playlists__note'),
    mutationHost=node(host),
    retryHost=node(host);
    const shuffle=scope.own(mountButton(shuffleHost,runtime, {
      label:'Shuffle unavailable'
    })),
    repeat=scope.own(mountButton(repeatHost,runtime, {
      label:'Repeat unavailable'
    })),
    back=scope.own(mountButton(returnHost,runtime, {
      label:'Return to current'
    })),
    status=scope.own(mountStatus(statusHost,runtime, {
      value: {
        status:'idle'
      },
      label:'Playlist queue controls'
    })),
    retry=scope.own(mountRetryOriginalRequest(retryHost,runtime, {
    }));
    function update(next) {
      if(disposed)return;
      props=next;
      const {
        state,
        controller,
        providers= {
        }
      }
      =props,
      value=state.playback,
      playback=value.status==='ready'?value.data:null,
      row=state.currentItemId&&state.detail?.track_rows.find(item=>item.playlist_item_id===state.currentItemId);
      shuffleHost.hidden=props.hasOrderControl===true;
      shuffle.update({
        label:playback?`Shuffle ${playback.shuffle?'on':'off'}`:'Shuffle unavailable',
        disabled:!state.available.shuffle,
        selected:playback?playback.shuffle:undefined,
        onClick:()=>controller.playbackIntent('shuffle')
      });
      repeat.update({
        label:playback? {
          off:'Repeat off',
          all:'Repeat playlist',
          one:'Repeat one track'
        }
        [playback.repeat]:'Repeat unavailable',
        disabled:!state.available.repeat,
        selected:playback?playback.repeat!=='off':undefined,
        onClick:()=>controller.playbackIntent('repeat')
      });
      back.update({
        label:'Return to current',
        disabled:!state.available.return_to_current,
        onClick:()=>controller.playbackIntent('return_to_current')
      });
      status.update({
        value,
        label:'Playlist queue controls',
        retry:()=>controller.loadPlayback()
      });
      if(value.status==='unavailable')statusHost.hidden=true;
      unavailableHost.innerHTML=value.status==='unavailable'?runtime.alertHtml({
        severity:'info',
        role:'status',
        message:'Playlist queue controls are incomplete: no authorized queue provider is available. Track playback remains owned by the native player.'
      }):'';
      currentHost.textContent=!playback?'':playback.current_playlist_id===null?'The native player has no current playlist track.':playback.current_playlist_id!==state.detail?.playlist_id?'The current track belongs to another playlist.':row?`Current: ${row.title||'Untitled track'}`:'The current queued track is outside this playlist projection.';
      currentHost.setAttribute('role','status');
      mutation(mutationHost,runtime,state.playbackMutation);
      retry.update({
        scopeKey:state.scopeKey,
        available:providers.hasPendingPlaylistOperation?.({
          scopeKey:state.scopeKey,
          action:'playlist_preferences'
        })===true,
        retry:()=>providers.retryPlaylistOperation({
          scopeKey:state.scopeKey,
          action:'playlist_preferences'
        }),
        current:()=>controller.getSnapshot().scopeKey===state.scopeKey&&controller.getSnapshot().detail?.playlist_id===state.detail?.playlist_id,
        onRecovered:()=>controller.loadPlayback()
      });
    }
    update(props);
    return {
      element:host,
      orderHost,
      update,
      dispose() {
        if(disposed)return;
        disposed=true;
        scope.dispose();
      }
    };
  }catch(error) {
    disposed=true;
    scope.dispose();
    throw error;
  }
}
export function mountPlaylistMatchReview(host,runtime,initial) {
  let props=initial,
  disposed=false,
  statusOwner=null,
  context=null,
  contextController=null;
  const candidates=new Map();
  const scope=createNativeOwnerScope();
  scope.defer(()=>host.replaceChildren());
  scope.defer(()=> {
    for(const item of candidates.values()) {
      try {
        item.owner.dispose();
      }catch {
      }
    }
    candidates.clear();
  });
  scope.defer(()=>statusOwner?.dispose());
  try {
    host.className='playlists__match-review';
    host.setAttribute('aria-label','Selected track match review');
    node(host,'h3').textContent='Review local match';
    const title=node(host,'strong'),
    identity=node(host,'p','playlists__note'),
    explanation=node(host,'p'),
    messageHost=node(host),
    statusHost=node(host),
    candidateHost=node(host,'div','playlists__match-candidates'),
    acceptHost=node(host),
    mutationHost=node(host);
    candidateHost.setAttribute('role','group');
    candidateHost.setAttribute('aria-label','Choose a possible local match');
    const accept=scope.own(mountButton(acceptHost,runtime, {
      label:'Accept selected local match',
      disabled:true
    }));
    function clearCandidates() {
      for(const item of candidates.values()) {
        item.owner.dispose();
        item.slot.remove();
      }
      candidates.clear();
    }
    function update(next) {
      if(disposed)return;
      props=next;
      const {
        state,
        controller
      }
      =props;
      const nextContext=JSON.stringify([state.scopeKey,state.detail?.playlist_id,state.selectedItemId]);
      if(context!==nextContext||contextController!==controller) {
        clearCandidates();
        context=nextContext;
        contextController=controller;
      }
      const source=state.detail?.track_rows.find(row=>row.playlist_item_id===state.selectedItemId&&row.source_readable!==false);
      host.hidden=!state.selectedItemId||!source||!['unresolved','missing'].includes(source.availability);
      if(host.hidden) {
        clearCandidates();
        statusOwner?.dispose();
        statusOwner=null;
        return;
      }
      title.textContent=source.title||'Untitled original';
      identity.textContent=[source.artist||source.secondary_artist,source.album_title].filter(Boolean).join(' · ');
      explanation.textContent=`${source.availability==='missing'?'This source track is confirmed missing.':'Local availability is unresolved. This original remains included for review.'} Choosing a candidate does not accept a match.`;
      const value=state.matches,
      data=['ready','empty'].includes(value.status)?value.data:null;
      if(['unavailable','empty'].includes(value.status)) {
        statusOwner?.dispose();
        statusOwner=null;
        messageHost.innerHTML=runtime.alertHtml({
          severity:'info',
          role:'status',
          message:value.status==='unavailable'?'Local matching is incomplete: no authorized match provider is available for this track.':'No possible local matches were supplied. The original track is unchanged.'
        });
      }else {
        messageHost.replaceChildren();
        const statusProps= {
          value,
          label:'Local match candidates',
          retry:()=>props.controller.loadMatches()
        };
        if(statusOwner)statusOwner.update(statusProps);
        else statusOwner=mountStatus(statusHost,runtime,statusProps);
      }
      const rows=data?.candidates||[],
      live=new Set(rows.map(candidate=>candidate.candidate_ref));
      for(const [key,item]of candidates)if(!live.has(key)) {
        item.owner.dispose();
        item.slot.remove();
        candidates.delete(key);
      }
      const focused=host.ownerDocument.activeElement;
      rows.forEach((candidate,index)=> {
        const key=candidate.candidate_ref,
        buttonProps= {
          label:[candidate.title||'Untitled candidate',candidate.artist,candidate.album_title,candidate.version_label].filter(Boolean).join(' · '),
          selected:state.candidateRef===key,
          disabled:state.matchMutation.status==='loading',
          onClick:()=>props.controller.chooseCandidate(key)
        };
        let item=candidates.get(key);
        if(item)item.owner.update(buttonProps);
        else {
          const slot=host.ownerDocument.createElement('span');
          item= {
            slot,
            owner:mountButton(slot,runtime,buttonProps)
          };
          candidates.set(key,item);
        }
        if(candidateHost.children[index]!==item.slot)candidateHost.insertBefore(item.slot,candidateHost.children[index]||null);
      });
      candidateHost.hidden=!rows.length;
      if(focused?.isConnected&&host.contains(focused)&&!focused.disabled&&host.ownerDocument.activeElement!==focused&&(host.ownerDocument.activeElement===host.ownerDocument.body||!host.ownerDocument.activeElement?.isConnected))focused.focus({
        preventScroll:true
      });
      accept.update({
        label:'Accept selected local match',
        disabled:!state.available.acceptMatch,
        attributes: {
          'data-playlists-accept-match':'1'
        },
        onClick:async()=> {
          const owner=props,
          accepted=await owner.controller.acceptMatch();
          if(accepted&&!disposed&&props.controller===owner.controller&&props.state.selectedItemId===owner.state.selectedItemId)props.onAccepted?.();
        }
      });
      mutation(mutationHost,runtime,state.matchMutation,true);
    }
    update(initial);
    return {
      element:host,
      update,
      dispose() {
        if(disposed)return;
        disposed=true;
        scope.dispose();
      }
    };
  }catch(error) {
    disposed=true;
    scope.dispose();
    throw error;
  }
}
