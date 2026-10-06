import React,{useState,useEffect,useLayoutEffect,useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {createPortal} from 'react-dom';
import {people,artists,albums,albumSeeds,periods,byAlbum,byArtist,image} from './fixture-data.mjs';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// Native drawers may replace their bodies between React render and the
// reattachment observer. Keep the same owned DOM targets through that gap.
const rootNode=id=>window.MockRealLayout?.portals?.[id]||document.getElementById(id);
const native=()=>window.MockRealLayout;
function NativeButton({children,onClick,disabled=false,primary=false,label,className=''}){
  const html=window.ButtonComponent.renderButton({label:String(children||label||''),size:'small',variant:primary?'primary':'secondary',disabled,quiet:!primary,className});
  return <span className="mock-native-button" onClick={e=>{if(e.target.closest('button')&&!disabled)onClick?.(e)}} dangerouslySetInnerHTML={{__html:html}}/>;
}
function NativeAction({label,kind,onClick,disabled=false}){
  const ref=useRef();
  const sharedIcon=({remove:'delete',block:'close',profile:'edit',view:'cover',demo:'more',compare:'copy',request:'next',accept:'next',decline:'close',cancel:'close',unblock:'next'})[kind];
  const html=window.ButtonComponent.renderActionButton({ariaLabel:label,title:label,disabled,icon:sharedIcon,iconClass:`mock-icon-${kind}`,className:'mock-bar-action'});
  useLayoutEffect(()=>{
    if(sharedIcon)return;
    const icon=ref.current?.querySelector('.action-button__icon');if(!icon)return;
    if(kind==='friends')icon.innerHTML=document.querySelector('[data-gallery-bar-action="artist-family"] svg')?.outerHTML||'';
    if(kind==='gallery')icon.innerHTML=document.querySelector('[data-gallery-view-choice="cards"] svg')?.outerHTML||'';
    const paths={home:'m3 11 9-8 9 8M5 10v11h5v-7h4v7h5V10',expand:'M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5M3 3l6 6M21 3l-6 6M3 21l6-6M21 21l-6-6',collapse:'M3 9h6V3M21 9h-6V3M9 21v-6H3M15 21v-6h6M3 3l6 6M21 3l-6 6M3 21l6-6M21 21l-6-6'};
    if(paths[kind])icon.innerHTML=`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[kind]}"/></svg>`;
  });
  return <span ref={ref} className="mock-native-button" onClick={e=>{if(e.target.closest('button')&&!disabled)onClick?.(e)}} dangerouslySetInnerHTML={{__html:html}}/>;
}
function NativeHtml({html,className=''}){const ref=useRef();useLayoutEffect(()=>native().activateCovers(ref.current),[html]);return <div ref={ref} className={className} dangerouslySetInnerHTML={{__html:html}}/>;}
function FilterSelect({label,value,onChange,children}){return <label className="mock-select"><span>{label}</span><select value={value} onChange={e=>onChange(e.target.value)} aria-label={label}>{children}</select></label>;}
function Avatar({person}){return <img className="mock-avatar" src={person.avatarUrl||image(person.avatar)} alt=""/>;}
function App(){
  const initialUrl=new URL(location.href);
  const requestedMode=initialUrl.searchParams.get('mobile_page')==='album'?'album':initialUrl.searchParams.get('mock')|| (initialUrl.searchParams.get('surface')==='albums'||initialUrl.searchParams.has('artist')?'gallery':'home');
  const initialKind=initialUrl.searchParams.get('mock_kind'),initialPeriod=initialUrl.searchParams.get('mock_period');
  const [mode,setMode]=useState(['home','profile','gallery','recent','album','compare','activity'].includes(requestedMode)?requestedMode:'home'),[personId,setPersonId]=useState(initialUrl.searchParams.get('mock_person')||'me'),[kind,setKind]=useState(['albums','tracks','artists'].includes(initialKind)?initialKind:'albums'),[period,setPeriod]=useState(periods.some(p=>p.id===initialPeriod)?initialPeriod:'week');
  const [narrow,setNarrow]=useState(innerWidth<=900);
  const [relations,setRelations]=useState(Object.fromEntries(people.map(p=>[p.id,p.relationship]))),[auto,setAuto]=useState(false),[exceptions,setExceptions]=useState([]);
  const [profile,setProfile]=useState({...people[0]}),[albumId,setAlbumId]=useState(byAlbum(initialUrl.searchParams.get('album')||initialUrl.searchParams.get('mobile_album'))?.id||'a1'),[sort,setSort]=useState('combined'),[ascending,setAscending]=useState(false);
  const [counts,setCounts]=useState(false),[countFriend,setCountFriend]=useState(''),[scenario,setScenario]=useState('normal');
  const [dialog,setDialog]=useState(null),[dialogTarget,setDialogTarget]=useState(null);
  const person=personId==='me'?profile:people.find(p=>p.id===personId)||profile;
  const effective=id=>id==='me'?'self':relations[id]==='blocked'?'blocked':auto&&!exceptions.includes(id)?'accepted':relations[id];
  const canRead=effective(personId)==='self'||effective(personId)==='accepted';
  const accepted=people.filter(p=>p.id!=='me'&&effective(p.id)==='accepted');
  const seed=albumSeeds.find(a=>a.id===albumId)||albumSeeds[0];
  const eligible=accepted.filter(p=>(seed.counts[p.id]||0)>0);
  const factor=periods.find(w=>w.id===period).factor,periodLabel=periods.find(w=>w.id===period).label;
  const model=useRef();model.current={mode,personId,kind,period,counts,countFriend,seed,factor,effective};
  const restoreScroll=useRef({});
  const albumOrigin=useRef({mode:'home',artist:'',personId:'me',kind:'albums',period:'week'});
  function saveUrl(nextMode,nextPerson=personId,extra={},replace=false){
    const url=new URL(location.href);url.search='';url.searchParams.set('surface','albums');url.searchParams.set('mock',nextMode);
    if(nextPerson!=='me')url.searchParams.set('mock_person',nextPerson);
    if(nextMode!=='gallery'){url.searchParams.set('mock_kind',model.current.kind);url.searchParams.set('mock_period',model.current.period);}
    Object.entries(extra).forEach(([key,value])=>value&&url.searchParams.set(key,value));
    const snapshot={...(history.state||{}),mockMode:nextMode};
    if(replace)history.replaceState(snapshot,'',url);
    else if(window.AlbumHavenSettingsNavigation?.instance?.pushLibraryHistory)window.AlbumHavenSettingsNavigation.instance.pushLibraryHistory(url.href,snapshot);
    else history.pushState(snapshot,'',url);
  }
  function openHome(id='me',push=true){setPersonId(id);setMode(id==='me'?'home':'profile');setCountFriend('');if(push)saveUrl(id==='me'?'home':'profile',id);}
  function openGallery(artist='',recent=false,push=true,listener=personId){
    if(recent&&!['self','accepted'].includes(model.current.effective(listener))){native().toast('Listening activity is shared with accepted friends.','info');return;}
    if(!recent)setPersonId('me');
    const previousUrl=location.href,previousHistory=history.state;
    const retainAlbumHistory=push&&model.current.mode==='album'&&new URL(previousUrl).searchParams.get('mobile_page')==='album';
    setMode(recent?'recent':'gallery');setCountFriend('');native().layout(recent?'recent':'gallery');
    if(retainAlbumHistory)history.replaceState(previousHistory,'',previousUrl);
    if(push)saveUrl(recent?'recent':'gallery',recent?listener:'me',{artist});
    native().loadGallery(new URLSearchParams({surface:'albums',...(artist?{artist}:{})}).toString(),recent?{source:'recent',person:listener}:{source:'library'});
  }
  function selectAlbum(album,full=false){
    const found=byAlbum(album.key||album.id);if(!found)return;
    setAlbumId(found.id);setCountFriend('');
    const multi=['home','profile'].includes(model.current.mode)&&!full&&innerWidth>900;
    if(!multi){albumOrigin.current={mode:model.current.mode,artist:native().readView().selected_artist||'',personId,kind,period};restoreScroll.current[model.current.mode]=rootNode('albums-scroll')?.scrollTop||0;setMode('album');if(innerWidth>900)saveUrl('album',personId,{album:found.id});}
    native().openAlbum(found,multi?'embedded':'full');
    if(multi)native().showArtist(byArtist(found.mock.artist_id));
  }
  function openCompare(){setMode('compare');saveUrl('compare',personId);}
  function returnFromAlbum(){
    const origin=albumOrigin.current;setPersonId(origin.personId);setKind(origin.kind);setPeriod(origin.period);
    if(['gallery','recent'].includes(origin.mode))openGallery(origin.artist,origin.mode==='recent',false,origin.personId);
    else if(['compare','activity'].includes(origin.mode))setMode(origin.mode);
    else openHome(origin.personId,false);
    const replace=()=>saveUrl(origin.mode,origin.personId,{artist:origin.artist,mock_kind:origin.kind,mock_period:origin.period},true);
    if(innerWidth>900)replace();
    else requestAnimationFrame(()=>{const url=new URL(location.href);if(!url.searchParams.has('mobile_page')&&url.searchParams.get('mock')==='album')replace();});
  }
  function chooseKind(value){
    setKind(value);
    if(mode==='activity'&&value==='albums'){openGallery('',true);saveUrl('recent',personId,{mock_kind:value},true);}
    else if(['activity','compare'].includes(mode))saveUrl(mode,personId,{mock_kind:value},true);
  }
  function choosePeriod(value){setPeriod(value);if(['activity','compare','recent'].includes(mode))saveUrl(mode,personId,{mock_period:value},true);}
  function showDialog(type,who=null){
    setDialog({type,who});
    native().dialog({title:({people:'People on your server',request:'Friend request',view:'View',profile:'Your profile',demo:'Preview scenarios'})[type],mode:'reading',contentHtml:'<div data-mock-dialog-content></div>',
      onMount:node=>setDialogTarget(node.querySelector('[data-mock-dialog-content]')),onClose:()=>{setDialogTarget(null);setDialog(null);}});
  }
  function closeDialog(){native().closeDialog();}
  function relationAction(id,action){
    setRelations(old=>({...old,[id]:({request:'outgoing',accept:'accepted',decline:'none',cancel:'none',remove:'none',block:'blocked',unblock:'none'})[action]}));
    if(['remove','block'].includes(action))setExceptions(old=>[...new Set([...old,id])]);
    if(action==='accept')setExceptions(old=>old.filter(x=>x!==id));
    if(['remove','block'].includes(action))setCountFriend('');
    native().toast(({request:'Friend request sent in this preview',accept:'You are now friends in this preview',decline:'Request declined',cancel:'Request cancelled',remove:'Friend removed',block:'Person blocked',unblock:'Person unblocked'})[action]);
  }
  async function manage(id,action){
    const yes=await native().confirm({title:action==='block'?'Block person':'Remove friend',message:'Friend-scoped listening access will end. The fictional listening history is retained.',acceptLabel:action==='block'?'Block':'Remove',danger:true});
    if(yes)relationAction(id,action);
  }
  function Relation({p,compact=false}){const status=effective(p.id);const Action=({children,onClick,primary})=>compact?<NativeAction label={children} kind={({"Edit profile":'profile',Remove:'remove',Block:'block',Accept:'accept',Decline:'decline',"Cancel request":'cancel',Unblock:'unblock',"Add friend":'request'})[children]} onClick={onClick}/>:<NativeButton primary={primary} onClick={onClick}>{children}</NativeButton>;return status==='self'?<Action onClick={()=>showDialog('profile')}>Edit profile</Action>:status==='accepted'?<><span className="mock-status">Friends</span><Action onClick={()=>manage(p.id,'remove')}>Remove</Action><Action onClick={()=>manage(p.id,'block')}>Block</Action></>:status==='incoming'?<><Action primary onClick={()=>relationAction(p.id,'accept')}>Accept</Action><Action onClick={()=>relationAction(p.id,'decline')}>Decline</Action></>:status==='outgoing'?<Action onClick={()=>relationAction(p.id,'cancel')}>Cancel request</Action>:status==='blocked'?<Action onClick={()=>relationAction(p.id,'unblock')}>Unblock</Action>:<Action primary onClick={()=>relationAction(p.id,'request')}>Add friend</Action>;}

  useEffect(()=>{
    native().setCallbacks({
      album:album=>selectAlbum(album),artist:name=>openGallery(name),library:()=>openGallery(),
      albumClosed:returnFromAlbum,
      beforeNativeGallery:()=>{window.MockViewContext={source:'library'};setPersonId('me');setMode('gallery');native().layout('gallery');setCountFriend('');},
      albumRendered:album=>{if(album.id&&album.id!==model.current.seed.id)setAlbumId(album.id);decorateCounts();},
      galleryRendered:()=>decorateGalleryCounts(),
      viewportChanged:setNarrow,
    });
  });
  useEffect(()=>{
    let active=true;
    if(!canRead&&['recent','activity','compare','album'].includes(mode)){setMode('profile');setCountFriend('');return;}
    native().layout(mode,kind);
    rootNode('shell-main-surface').dataset.mockReadable=String(canRead);
    rootNode('mock-album-panel').hidden=!canRead;
    rootNode('mock-artist-panel').hidden=!canRead;
    if(mode==='album'&&(native().getAlbum()?.id!==albumId||rootNode('track-modal').hidden))native().openAlbum(byAlbum(albumId),'full');
    if(mode==='recent')native().loadGallery('?surface=albums',{source:'recent',person:personId});
    if(['home','profile'].includes(mode)){
      if(canRead&&scenario==='normal'){
        native().loadGallery('?surface=albums',{source:'recent',person:personId}).then(()=>{
          if(!active)return;
          native().layout(mode,kind);
          rootNode('albums-scroll').scrollTop=restoreScroll.current[mode]||0;
          if(innerWidth>900){native().openAlbum(byAlbum(albumId),'embedded');native().showArtist(byArtist(seed.artist));}
        });
      }else native().loadGallery('?surface=albums',{albumIds:[]}).then(()=>{if(active)native().layout(mode,kind)});
    }
    return()=>{active=false};
  },[mode,personId,kind,canRead,scenario,narrow]);
  useEffect(()=>{
    if(countFriend&&!eligible.some(p=>p.id===countFriend))setCountFriend('');
    decorateCounts();
    decorateGalleryCounts();
  },[counts,countFriend,period,albumId,relations,auto,exceptions]);
  useEffect(()=>{native().setRecentContext(person.name,periodLabel);},[person.name,periodLabel,mode]);
  function decorateGalleryCounts(){
    const m=model.current,visible=['home','profile','recent'].includes(m.mode);
    for(const card of document.querySelectorAll('#artist-groups .album-card')){
      const body=card.querySelector('.gallery-card-info'),existing=card.querySelector('[data-mock-listen-metrics]');
      if(!visible){existing?.remove();continue;}
      if(!body)continue;
      const key=card.querySelector('[data-album-key]')?.dataset.albumKey;
      const album=byAlbum(key);if(!album)continue;
      const signature=[album.id,m.personId,m.factor].join('|');
      if(existing?.dataset.mockListenMetrics===signature)continue;
      const metrics=existing||document.createElement('div');metrics.className='mock-card-listen-metrics';metrics.dataset.mockListenMetrics=signature;
      const full=album.mock.full[m.personId];metrics.textContent=`${full==null?'—':(full||0)*m.factor} full listens · ${(album.mock.counts[m.personId]||0)*m.factor} track listens`;
      if(!existing)body.append(metrics);
    }
  }
  useEffect(()=>{
    const pop=()=>{const url=new URL(location.href),next=url.searchParams.get('mobile_page')==='album'?'album':url.searchParams.get('mock')||'gallery',id=url.searchParams.get('mock_person')||'me';setPersonId(id);setCountFriend('');
      const routeKind=url.searchParams.get('mock_kind'),routePeriod=url.searchParams.get('mock_period');
      if(['albums','tracks','artists'].includes(routeKind))setKind(routeKind);
      if(periods.some(p=>p.id===routePeriod))setPeriod(routePeriod);
      if(next==='album'){setMode('album');const a=byAlbum(url.searchParams.get('album')||url.searchParams.get('mobile_album'));if(a){setAlbumId(a.id);native().openAlbum(a,'full');}}
      else if(['gallery','recent'].includes(next))openGallery(url.searchParams.get('artist')||'',next==='recent',false,id);
      else setMode(['profile','compare','activity'].includes(next)?next:'home');};
    window.addEventListener('popstate',pop);return()=>window.removeEventListener('popstate',pop);
  },[]);
  function decorateCounts(){
    const m=model.current,album=albumSeeds.find(a=>a.id===native().getAlbum()?.id)||m.seed;
    for(const table of document.querySelectorAll('#track-modal .compact-data-table')){
      const signature=[album.id,m.personId,m.factor,m.counts,m.countFriend].join('|');
      if(table.dataset.mockCountSignature===signature&&table.querySelector('[data-mock-count]'))continue;
      table.dataset.mockCountSignature=signature;
      table.querySelectorAll('[data-mock-count]').forEach(node=>node.remove());
      const countColumns=m.counts&&m.countFriend?2:1;
      table.style.setProperty('--cdt-columns',`36px minmax(0,1fr) 20px ${countColumns===2?'42px 48px':'42px'} minmax(54px,auto)`);
      for(const row of table.querySelectorAll('[role="row"]')){
        const duration=row.querySelector('[data-cdt-column="duration"]');if(!duration)continue;
        const isHeader=!!row.querySelector('[role="columnheader"]');
        const path=row.getAttribute('data-track-row-path')||'';const index=Math.max(0,Number(path.split(':').at(-1))-1);
        const makeCell=(who,label)=>{const cell=document.createElement('div');cell.dataset.mockCount=who;cell.setAttribute('role',isHeader?'columnheader':'cell');cell.className='mock-count-cell';cell.title=label;
          const total=album.counts[who]||0;cell.textContent=isHeader?label:String((Math.floor(total/album.tracks.length)+(index<total%album.tracks.length?1:0))*m.factor);duration.before(cell);};
        makeCell(m.personId,'Count');if(countColumns===2)makeCell(m.countFriend,(people.find(p=>p.id===m.countFriend)?.name.split(' ')[0]||'Friend')+' · Count');
      }
    }
  }
  function activityRows(who,which=kind){
    if(who!=='me'&&effective(who)!=='accepted')return [];
    if(scenario==='empty')return [];
    if(which==='albums')return albums.filter(a=>(a.mock.counts[who]||0)>0).map(a=>({id:a.id,album:a,title:a.name,artist:a.album_artist,count:(a.mock.counts[who]||0)*factor}));
    if(which==='artists')return artists.map(a=>({id:a.id,title:a.name,artist:a.genre,count:albumSeeds.filter(x=>x.artist===a.id).reduce((n,x)=>n+(x.counts[who]||0),0)*factor,album:albums.find(x=>x.mock.artist_id===a.id)})).filter(x=>x.count>0);
    return albums.flatMap(a=>a.tracks.map((track,index)=>{const total=a.mock.counts[who]||0;return{id:track.path,title:track.title,artist:a.album_artist,count:(Math.floor(total/a.tracks.length)+(index<total%a.tracks.length?1:0))*factor,album:a,track}})).filter(x=>x.count>0);
  }
  function activityItemHtml(item,side=item){
    return `<span class="${side?'':'mock-missing'}"><button class="mock-native-link" data-mock-item="${esc(item.album.id)}"${kind==='artists'?` data-mock-go-artist="${esc(item.title)}"`:''}>${esc(item.title)}</button><small>${esc(side?item.artist:'No listens in this period')}</small></span>`;
  }
  function ActivityRows(){
    const rows=activityRows(personId),tracks=kind==='tracks';
    const html=native().table({id:mode==='activity'?'mock-expanded-activity-table':'mock-activity-table',ariaLabel:`${person.name} ${kind}`,columns:tracks?'36px minmax(0,1fr) 48px':'minmax(0,1fr) 48px',columnsConfig:[...(tracks?[{key:'play',label:'Play',header:'absent',action:true}]:[]),{key:'item',label:kind==='artists'?'Artist':'Track'},{key:'count',label:'Count',action:true}],rows:rows.map(r=>({key:r.id,cells:{play:{content:tracks?native().trackPlay(r.track):''},item:{content:activityItemHtml(r)},count:{content:esc(r.count)}}}))});
    return <NativeHtml html={html}/>;
  }
  function Comparison(){
    const yours=activityRows('me'),friend=activityRows(personId),ids=[...new Set([...yours,...friend].map(r=>r.id))];
    const pairs=ids.map(id=>({id,left:yours.find(r=>r.id===id),right:friend.find(r=>r.id===id)}));
    const score=p=>sort==='yours'?p.left?.count||0:sort==='friend'?p.right?.count||0:(p.left?.count||0)+(p.right?.count||0);
    pairs.sort((a,b)=>(ascending?1:-1)*(score(a)-score(b))||(a.left||a.right).title.localeCompare((b.left||b.right).title));
    const tracks=kind==='tracks',columnsConfig=['left','right'].flatMap(side=>[...(tracks?[{key:side+'Play',label:'Play',header:'absent',action:true}]:[]),{key:side+'Item',label:kind==='artists'?'Artist':'Track'},{key:side+'Count',label:'Count',action:true}]);
    const table=kind==='albums'?'':native().table({id:'mock-comparison-table',ariaLabel:`Your ${kind} compared with ${person.name}`,columns:tracks?'30px minmax(0,1fr) 38px 30px minmax(0,1fr) 38px':'minmax(0,1fr) 44px minmax(0,1fr) 44px',columnsConfig,rows:pairs.map(p=>{const item=p.left||p.right;return {key:p.id,cells:Object.fromEntries(['left','right'].flatMap(side=>[[side+'Play',{content:tracks?native().trackPlay(item.track):''}],[side+'Item',{content:activityItemHtml(item,p[side]||null)}],[side+'Count',{content:esc(p[side]?.count??'—')}]]))}})});
    return <div className="mock-comparison"><div className="mock-comparison-options"><FilterSelect label="Sort by" value={sort} onChange={setSort}><option value="combined">Combined count</option><option value="yours">Your count</option><option value="friend">Friend's count</option></FilterSelect><NativeButton onClick={()=>setAscending(!ascending)}>{ascending?'Lowest first':'Highest first'}</NativeButton></div><div className="mock-pair-labels"><strong>Yours</strong><strong>{person.name}</strong></div>{pairs.length?(kind==='albums'?pairs.map(p=>{const item=p.left||p.right;return <div className="mock-pair" key={p.id}>{[p.left,p.right].map((side,index)=><div key={index} className={side?'':'mock-missing'}><NativeHtml html={native().card(item.album)}/><p>{side?side.count+' track listens':'No listens in this period'}</p></div>)}</div>}):<NativeHtml html={table}/>):<p className="mock-empty">Nothing to compare in this period</p>}</div>;
  }
  const controls=<div className="mock-filter-row"><div role="group" aria-label="Listening views">{['albums','tracks','artists'].map(value=><NativeButton key={value} primary={kind===value} onClick={()=>chooseKind(value)}>{value[0].toUpperCase()+value.slice(1)}</NativeButton>)}</div><FilterSelect label="Period" value={period} onChange={choosePeriod}>{periods.map(p=><option key={p.id} value={p.id}>{p.label}</option>)}</FilterSelect></div>;
  const heading=<><div className="gallery-bar mock-page-heading"><div className="mock-page-avatar"><Avatar person={person}/></div><div className="gallery-bar__context"><h1 className="gallery-bar__title">{mode==='activity'?`${person.name}'s recent ${kind} (${periodLabel})`:mode==='compare'?`You & ${person.name}`:personId==='me'?`${profile.name.split(' ')[0]}'s Home`:person.name}</h1><span className="gallery-bar__summary">{mode==='compare'?'Taste comparison':person.bio}</span></div><div className="gallery-bar__actions"><Relation p={person} compact/>{personId!=='me'&&canRead&&<NativeAction label={mode==='compare'?'View profile':'Compare'} kind={mode==='compare'?'profile':'compare'} onClick={()=>mode==='compare'?openHome(personId):openCompare()}/>}</div></div>{mode==='compare'&&controls}</>;
  const albumTools=<><div className="mock-panel-title"><strong>Album Details</strong><NativeAction label="Expand" kind="expand" onClick={()=>selectAlbum(byAlbum(albumId),true)}/></div><div className="mock-listen-summary"><b>{seed.full[personId]==null?'—':(seed.full[personId]||0)*factor}</b> full listens · <b>{(seed.counts[personId]||0)*factor}</b> track listens</div>{counts&&eligible.length>0&&<FilterSelect label="Friend's listen count" value={countFriend} onChange={setCountFriend}><option value="">Choose a friend</option>{eligible.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</FilterSelect>}{counts&&<small className="mock-muted">{eligible.length?'View only · selection is not saved':'No eligible friends have listened to this album'}</small>}</>;
  function profileEditor(){return <ProfileForm profile={profile} onSave={value=>{setProfile(value);closeDialog();native().toast('Profile changed in this preview only')}}/>;}
  function DialogBody(){
    if(!dialog)return null;
    if(dialog.type==='profile')return profileEditor();
    if(dialog.type==='people')return <div className="mock-people">{people.filter(p=>p.id!=='me').map(p=><div className="mock-person" key={p.id}><button className="mock-person-name" onClick={()=>{closeDialog();openHome(p.id)}}><Avatar person={p}/><span><strong>{p.name}</strong><small>{effective(p.id)}</small></span></button><div className="mock-person-actions"><Relation p={p}/></div></div>)}</div>;
    if(dialog.type==='request')return <div className="mock-request"><Avatar person={dialog.who}/><h3>{dialog.who.name}</h3><p>{dialog.who.bio}</p><p>Share listening activity and compare tastes as friends.</p><NativeButton onClick={()=>{const id=dialog.who.id;closeDialog();openHome(id)}}>View profile</NativeButton><NativeButton primary onClick={()=>{relationAction(dialog.who.id,'accept');closeDialog()}}>Accept request</NativeButton><NativeButton onClick={()=>{relationAction(dialog.who.id,'decline');closeDialog()}}>Decline</NativeButton></div>;
    if(dialog.type==='view')return <div className="mock-settings"><label className="mock-switch"><span>Friends' listen counts</span><input type="checkbox" role="switch" checked={counts} onChange={e=>{setCounts(e.target.checked);setCountFriend('')}}/></label><p>Choose one eligible friend inside Album Details. This view selection is temporary.</p></div>;
    return <div className="mock-settings"><p>All people and listening counts are fictional. Existing app controls remain visible; real media, provider and native actions are unavailable.</p><FilterSelect label="Activity state" value={scenario} onChange={setScenario}><option value="normal">Populated</option><option value="empty">Empty</option><option value="error">Unavailable</option></FilterSelect><label className="mock-switch"><span>Automatic friends</span><input type="checkbox" role="switch" checked={auto} onChange={e=>setAuto(e.target.checked)}/></label><p>Requests by default; removed or blocked people stay excluded.</p><NativeButton onClick={()=>{setRelations(Object.fromEntries(people.map(p=>[p.id,p.relationship])));setExceptions([]);setAuto(false);setScenario('normal');setCounts(false);setCountFriend('');setPeriod('week');setKind('albums');setProfile({...people[0]});closeDialog();openHome()}}>Reset preview</NativeButton></div>;
  }
  useEffect(()=>{
    const handler=event=>{const artist=event.target.closest('[data-mock-go-artist]');if(artist){event.preventDefault();openGallery(artist.dataset.mockGoArtist);return;}const item=event.target.closest('[data-mock-item]');if(item){event.preventDefault();selectAlbum(byAlbum(item.dataset.mockItem),true);}};
    document.addEventListener('click',handler);return()=>document.removeEventListener('click',handler);
  });
  const denied=!canRead?<div className="mock-empty"><h2>{effective(personId)==='blocked'?'This person is blocked':'Listening is shared with friends'}</h2><p>Profile basics are visible. Accepted friendship is required for history and comparison.</p><Relation p={person}/></div>:scenario==='error'?<div className="mock-empty"><h2>Listening activity is unavailable</h2><NativeButton onClick={()=>setScenario('normal')}>Try again</NativeButton></div>:scenario==='empty'?<div className="mock-empty">No listening activity in this period</div>:null;
  return <>
    {createPortal(<><NativeAction label="Home" kind="home" onClick={()=>openHome()}/><NativeAction label="Gallery" kind="gallery" onClick={()=>openGallery()}/><NativeAction label="Friends" kind="friends" onClick={()=>showDialog('people')}/></>,rootNode('mock-feature-actions'))}
    {createPortal(heading,rootNode('mock-heading'))}
    {createPortal(<>{controls}<div className="mock-panel-title"><small>Recent {kind} · {periodLabel}</small><NativeAction label="Expand" kind="expand" disabled={!canRead||scenario!=='normal'} onClick={()=>kind==='albums'?openGallery('',true):(setMode('activity'),saveUrl('activity'))}/></div>{denied}</>,rootNode('mock-activity-tools'))}
    {createPortal(['home','profile'].includes(mode)&&!denied&&kind!=='albums'?<ActivityRows/>:null,rootNode('mock-activity-custom'))}
    {createPortal(canRead?albumTools:null,rootNode('mock-album-tools'))}
    {createPortal(<div className="mock-panel-title"><strong>Artist Info</strong><NativeAction label="Open Gallery" kind="gallery" onClick={()=>openGallery(byArtist(seed.artist).name)}/></div>,rootNode('mock-artist-tools'))}
    {createPortal(mode==='compare'?(denied||<Comparison/>):mode==='activity'?<>{controls}{denied||<ActivityRows/>}</>:null,rootNode('mock-single-custom'))}
    {createPortal(mode==='recent'?<NativeAction label="Collapse" kind="collapse" onClick={()=>openHome(personId)}/>:null,rootNode('mock-gallery-collapse'))}
    {createPortal(mode==='recent'?`${person.name} · ${periodLabel}`:null,rootNode('mock-gallery-context-label'))}
    {createPortal(<><div className="mock-single-toolbar"><span>{person.name} · {periodLabel}</span><NativeAction label="Collapse" kind="collapse" onClick={()=>native().closeAlbum()}/><NativeAction label="View" kind="view" onClick={()=>showDialog('view')}/></div>{counts&&eligible.length>0&&<FilterSelect label="Friend's listen count" value={countFriend} onChange={setCountFriend}><option value="">Choose a friend</option>{eligible.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</FilterSelect>}{counts&&<small className="mock-muted">{eligible.length?'View only · selection is not saved':'No eligible friends have listened to this album'}</small>}</>,rootNode('mock-full-album-tools'))}
    {createPortal(<section className="mock-notifications"><h4>Friend requests</h4>{people.filter(p=>effective(p.id)==='incoming').map(p=><button key={p.id} className="mock-person-name" onClick={()=>showDialog('request',p)}><Avatar person={p}/><span><strong>{p.name}</strong><small>Sent you a friend request</small></span></button>)}{!people.some(p=>effective(p.id)==='incoming')&&<p>No pending friend requests</p>}</section>,rootNode('mock-request-notices'))}
    {dialogTarget&&createPortal(<DialogBody/>,dialogTarget)}
    {createPortal(<div className="mock-preview-tools"><NativeAction label="View" kind="view" onClick={()=>showDialog('view')}/><NativeAction label="Preview scenarios" kind="demo" onClick={()=>showDialog('demo')}/></div>,rootNode('mock-heading'))}
  </>;
}
function ProfileForm({profile,onSave}){
  const[name,setName]=useState(profile.name),[bio,setBio]=useState(profile.bio),[avatar,setAvatar]=useState(profile.avatarUrl||image(profile.avatar)),[error,setError]=useState('');
  return <form className="mock-profile-form" onSubmit={event=>{event.preventDefault();if(!name.trim()){setError('Enter a display name');return}onSave({...profile,name:name.trim(),bio,avatarUrl:avatar})}}><img className="mock-avatar mock-avatar-large" src={avatar} alt="Avatar preview"/><label>Display name<input value={name} maxLength={50} onChange={e=>setName(e.target.value)}/></label><label>About you<textarea value={bio} maxLength={240} onChange={e=>setBio(e.target.value)}/></label><label>Local avatar preview<input type="file" accept="image/png,image/jpeg,image/webp" onChange={e=>{const file=e.target.files?.[0];if(!file)return;if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>5242880){setError('Choose a PNG, JPEG or WebP under 5 MB');return}const reader=new FileReader();reader.onload=()=>setAvatar(reader.result);reader.readAsDataURL(file);setError('')}}/></label><div>{['mountain','ocean','desert','forest'].map(a=><button type="button" className="mock-avatar-choice" key={a} aria-label={`Use ${a} avatar`} onClick={()=>setAvatar(image(a))}><img src={image(a)} alt=""/></button>)}</div><p className="mock-muted">Local preview only. Nothing is uploaded or saved to a server.</p>{error&&<p role="alert">{error}</p>}<button className="ui-button ui-button--primary ui-button--medium" type="submit">Save profile</button></form>;
}
function mount(){const node=document.createElement('div');node.id='mock-react-root';document.body.append(node);createRoot(node).render(<App/>);}
if(window.MockRealLayout)mount();else window.addEventListener('mock-real-ui-ready',mount,{once:true});
