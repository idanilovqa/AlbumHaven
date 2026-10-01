import React, { useState, useEffect, useLayoutEffect, useRef, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { people, artists, albums, albumSeeds, periods, byAlbum, byArtist, image } from './fixture-data.mjs';

const native = () => window.MockRealLayout;
const node = id => native().portals[id] || document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const kinds = ['albums', 'tracks', 'artists'];
function Button({ children, onClick, primary = false, disabled = false }) {
  const html = window.ButtonComponent.renderButton({ label: children, variant: primary ? 'primary' : 'secondary', size: 'small', disabled });
  return <span className="mock-native-button" onClick={event => { if (!disabled && event.target.closest('button')) onClick?.(event); }} dangerouslySetInnerHTML={{ __html: html }} />;
}
function Action({ label, icon, onClick, disabled = false, bare = false }) {
  const ref = useRef(),renderedHtml=useRef(null);
  const shared = { edit:'edit', back:'back', close:'close', compare:'copy', page:'cover' }[icon];
  const html = window.ButtonComponent.renderActionButton({ ariaLabel: label, title: label, icon: shared, disabled, presentation: bare ? 'bare' : 'outlined', className: 'mock-bar-action' });
  useLayoutEffect(() => {
    if(renderedHtml.current!==html){ref.current.innerHTML=html;renderedHtml.current=html;}
    if (shared) return;
    const target = ref.current?.querySelector('.action-button__icon'); if (!target) return;
    const owner = icon === 'friends' ? document.querySelector('[data-gallery-bar-action="artist-family"] svg') : icon === 'settings' ? document.querySelector('#account-menu-button svg, [aria-label="Settings"] svg') : null;
    if (owner) { target.innerHTML = owner.outerHTML; return; }
    const paths = {
      expand:'M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5M3 3l6 6M21 3l-6 6M3 21l6-6M21 21l-6-6',
      collapse:'M3 9h6V3M21 9h-6V3M9 21v-6H3M15 21v-6h6M3 3l6 6M21 3l-6 6M3 21l6-6M21 21l-6-6',
      settings:'M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M6 14v6',
    };
    if (paths[icon]) target.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[icon]}"/></svg>`;
  });
  return <span ref={ref} className="mock-native-button" onClick={event => { if (!disabled && event.target.closest('button')) onClick?.(event); }} />;
}
function NativeHtml({ html, className = '' }) {
  const ref = useRef();
  useLayoutEffect(() => { ref.current.innerHTML=html; native().activate(ref.current); }, [html]);
  return <div ref={ref} className={className} />;
}
function Tabs({ value, onChange, id }) {
  const ref = useRef();
  const html = useRef(native().tabs({ id, label:'Listening views', selectedKey:value, tabs:kinds.map(key => ({ key, label:key[0].toUpperCase()+key.slice(1) })) })).current;
  useLayoutEffect(() => {
    if(!ref.current.firstElementChild)ref.current.innerHTML=html;
    const list = ref.current.firstElementChild; native().mountTabs(list);
    if(list.querySelector('[aria-selected="true"]')?.dataset.inPageTab!==value)list.querySelector(`[data-in-page-tab="${value}"]`)?.click();
    const changed = () => { const next = list.querySelector('[aria-selected="true"]')?.dataset.inPageTab; if (next && next !== value) onChange(next); };
    list.addEventListener('click', changed); list.addEventListener('keydown', changed);
    return () => { list.removeEventListener('click', changed); list.removeEventListener('keydown', changed); };
  }, [html, value, onChange]);
  return <div ref={ref} />;
}
function Select({ label, value, onChange, children }) { return <label className="mock-select"><span>{label}</span><select aria-label={label} value={value} onChange={e => onChange(e.target.value)}>{children}</select></label>; }
function Avatar({ person }) { return <img className="mock-avatar" src={person.avatarUrl || image(person.avatar)} alt="" />; }
function useWidth() {
  const ref = useRef(), [width, setWidth] = useState(0);
  useLayoutEffect(() => { const measure = () => { const next=ref.current?.clientWidth||0; if(next>0)setWidth(next); }; measure(); const observer = new ResizeObserver(measure); observer.observe(ref.current); return () => observer.disconnect(); }, []);
  return [ref, width];
}
function activity(who, kind, factor) {
  if (kind === 'albums') return albums.filter(a => a.mock.counts[who] > 0).map(a => ({ id:a.id, title:a.name, artist:a.album_artist, album:a, count:a.mock.counts[who]*factor }));
  if (kind === 'artists') return artists.map(a => ({ id:a.id, title:a.name, artist:a.genre, album:albums.find(album => album.mock.artist_id === a.id), count:albumSeeds.filter(seed => seed.artist === a.id).reduce((sum, seed) => sum+(seed.counts[who]||0), 0)*factor })).filter(row => row.count > 0);
  return albums.flatMap(album => album.tracks.map((track, index) => { const total=album.mock.counts[who]||0; return { id:track.path, title:track.title, artist:album.album_artist, album, track, count:(Math.floor(total/album.tracks.length)+(index<total%album.tracks.length?1:0))*factor }; })).filter(row => row.count > 0);
}
function RecentBody({ person, kind, factor, readable, scenario, selectedArtist, onRetry, galleryConfig }) {
  const [ref, width] = useWidth();
  const allowed=useMemo(()=>new Set(galleryConfig.keys),[galleryConfig.keys]);
  const view=galleryConfig.view==='covers'?'cards':galleryConfig.view;
  const rows = useMemo(() => activity(person.id, kind, factor).filter(row=>kind==='artists'?albums.some(album=>album.mock.artist_id===row.id&&allowed.has(album.key)):allowed.has(row.album.key)), [person.id, kind, factor,allowed]);
  const albumRows = useMemo(() => activity(person.id, 'albums', factor).filter(row=>allowed.has(row.album.key)).sort((a,b)=>a.album.mock.recent-b.album.mock.recent).slice(0,4), [person.id, factor,allowed]);
  const galleryHtml = useMemo(() => native().flatGallery({ records:albumRows.map(row=>row.album), width:900, fluid:true, compact:kind !== 'albums', view, person:person.id, factor }), [albumRows,kind,view,person.id,factor]);
  let content;
  if (!readable) content = <div className="mock-empty"><h2>Listening is shared with friends</h2><p>Profile basics are visible. Accepted friendship is required for listening activity.</p></div>;
  else if (scenario === 'error') content = <div className="mock-empty"><h2>Listening activity is unavailable</h2><Button onClick={onRetry}>Try again</Button></div>;
  else if (scenario === 'empty') content = <div className="mock-empty">No listening activity in this period</div>;
  else content = <>
    {kind === 'tracks' && <NativeHtml html={native().playTable({ id:'mock-recent-tracks', label:`${person.name} recent tracks`, rows })} />}
    {kind === 'artists' && <NativeHtml html={native().artistTree({ rows, selected:selectedArtist })} />}
    {<NativeHtml className={'mock-flat-gallery '+(kind === 'albums' ? '' : 'mock-small-gallery')} html={galleryHtml} />}
  </>;
  return <div ref={ref} className="mock-recent-composition" data-recent-kind={kind}>{content}</div>;
}
function MobileHomeContent({person,readable,selectedArtist,scenario,factor,galleryConfig}) {
  const [ref,width]=useWidth();
  const top=kind=>activity(person.id,kind,factor).sort((a,b)=>b.count-a.count||a.title.localeCompare(b.title));
  const records=useMemo(()=>top('albums').slice(0,4).map(row=>row.album),[person.id,factor]);
  const gallery=useMemo(()=>native().flatGallery({records,width:360,person:person.id,factor,view:galleryConfig.view==='covers'?'cards':galleryConfig.view,homeGrid:true}),[records,person.id,factor,galleryConfig.view]);
  const content=kind=>!readable?<div className="mock-empty">Listening is shared with friends</div>:scenario==='empty'?<div className="mock-empty">No listening activity in this period</div>:scenario==='error'?<div className="mock-empty">Listening activity is unavailable</div>:<>
    {kind==='tracks'&&<NativeHtml html={native().playTable({id:'mock-phone-home-tracks',label:`${person.name} top tracks`,rows:top('tracks')})}/>}
    {kind==='artists'&&<NativeHtml html={native().artistTree({rows:top('artists'),selected:selectedArtist})}/>}
    {kind==='albums'&&<NativeHtml html={gallery}/>}
  </>;
  return <>{createPortal(<div ref={ref} className="mock-native-home-content">{content('tracks')}</div>,node('mobile-home-tracks'))}{createPortal(<div className="mock-native-home-content">{content('albums')}</div>,node('mobile-home-albums'))}{createPortal(<div className="mock-native-home-content">{content('artists')}</div>,node('mobile-home-artists'))}</>;
}
function ComparisonColumn({ side, person, pairs, kind, factor, view, onView }) {
  const [ref, width] = useWidth();
  const rows = pairs.map(pair => ({ ...(pair[side] || pair.left || pair.right), count:pair[side]?.count ?? 0, missing:!pair[side] }));
  return <section className="mock-comparison-column" ref={ref} aria-label={`${person.name} ${kind}`}>
    <header className="mock-comparison-column-header"><strong>{side === 'left' ? 'Yours' : person.name}</strong>{kind==='albums'&&<Select label={`${side==='left'?'Your':person.name+"'s"} album view`} value={view} onChange={onView}><option value="list">Rows</option><option value="cards">Small covers</option></Select>}</header>
    {kind==='tracks'?<NativeHtml html={native().playTable({ id:'mock-compare-'+side, label:`${person.name} tracks`, rows })}/>:kind==='artists'?<NativeHtml html={native().artistTable({ id:'mock-compare-'+side, label:`${person.name} artists`, rows })}/>:width>0&&<div className="mock-comparison-albums" data-view={view}>{rows.map(row=><NativeHtml key={row.id} className="mock-comparison-album" html={native().flatGallery({ records:[row.album], width:view==='list'?width:(width-12*(Math.max(1,Math.floor((width+12)/150))-1))/Math.max(1,Math.floor((width+12)/150)), compact:true, view, person:person.id, factor, missing:row.missing })}/>)}</div>}
  </section>;
}
function Comparison({ person, kind, factor, sort, ascending, onSort, onDirection }) {
  const [leftView,setLeftView]=useState('list'),[rightView,setRightView]=useState('list');
  const left=activity('me',kind,factor),right=activity(person.id,kind,factor);
  const pairs=[...new Set([...left,...right].map(row=>row.id))].map(id=>({id,left:left.find(row=>row.id===id),right:right.find(row=>row.id===id)}));
  const score=pair=>sort==='yours'?(pair.left?.count||0):sort==='friend'?(pair.right?.count||0):(pair.left?.count||0)+(pair.right?.count||0);
  pairs.sort((a,b)=>(ascending?1:-1)*(score(a)-score(b))||(a.left||a.right).title.localeCompare((b.left||b.right).title));
  return <div className="mock-comparison"><div className="mock-comparison-options"><Select label="Sort by" value={sort} onChange={onSort}><option value="combined">Combined count</option><option value="yours">Your count</option><option value="friend">Friend's count</option></Select><Button onClick={onDirection}>{ascending?'Lowest first':'Highest first'}</Button></div><div className="mock-comparison-columns"><ComparisonColumn side="left" person={people[0]} {...{pairs,kind,factor}} view={leftView} onView={setLeftView}/><ComparisonColumn side="right" {...{person,pairs,kind,factor}} view={rightView} onView={setRightView}/></div></div>;
}
function ProfileEditor({ draft, onChange }) {
  const file = useRef(), pendingRead=useRef(null), [error,setError]=useState('');
  useEffect(()=>()=>{pendingRead.current?.abort();pendingRead.current=null;},[]);
  const cancelRead=()=>{pendingRead.current?.abort();pendingRead.current=null;};
  return <div className="mock-profile-editor"><div className="mock-avatar-editor"><Avatar person={draft}/><Button onClick={()=>file.current.click()}>Choose image</Button><input ref={file} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={event=>{const value=event.target.files?.[0];if(!value)return;if(!['image/png','image/jpeg','image/webp'].includes(value.type)||value.size>5242880){setError('Choose a PNG, JPEG or WebP under 5 MB');return;}cancelRead();const reader=new FileReader();pendingRead.current=reader;reader.onload=()=>{if(pendingRead.current!==reader)return;onChange(previous=>({...previous,avatarUrl:reader.result}));pendingRead.current=null;};reader.readAsDataURL(value);setError('');}}/></div><label>Display name<input value={draft.name} maxLength={50} onChange={event=>onChange({...draft,name:event.target.value})}/></label><label>About you<textarea value={draft.bio} rows={3} maxLength={240} onChange={event=>onChange({...draft,bio:event.target.value})}/></label><div className="mock-avatar-presets">{['mountain','ocean','desert','forest'].map(name=><button type="button" key={name} aria-label={`Use ${name} avatar`} className="mock-avatar-choice" onClick={()=>{cancelRead();onChange(previous=>({...previous,avatar:name,avatarUrl:''}));}}><img src={image(name)} alt=""/></button>)}</div><small className="mock-muted">Local preview only. No image is uploaded.</small>{error&&<p role="alert">{error}</p>}</div>;
}
function App() {
  const first = new URL(location.href), requested = first.searchParams.get('mobile_page')==='album'?'album':first.searchParams.get('mock') || (first.searchParams.get('surface')==='albums'||first.searchParams.has('artist')?'gallery':'home');
  const [mode,setMode]=useState(requested==='activity'?'recent':requested),[personId,setPersonId]=useState(first.searchParams.get('mock_person')||'me'),[kind,setKind]=useState(kinds.includes(first.searchParams.get('mock_kind'))?first.searchParams.get('mock_kind'):'albums'),[period,setPeriod]=useState(periods.some(p=>p.id===first.searchParams.get('mock_period'))?first.searchParams.get('mock_period'):'week');
  const [profile,setProfile]=useState({...people[0]}),[relations,setRelations]=useState(Object.fromEntries(people.map(p=>[p.id,p.relationship]))),[auto,setAuto]=useState(false),[exceptions,setExceptions]=useState([]);
  const [albumId,setAlbumId]=useState(byAlbum(first.searchParams.get('album')||first.searchParams.get('mobile_album'))?.id||null),[selectedArtist,setSelectedArtist]=useState(byArtist(first.searchParams.get('artist_info'))?.id||null),[albumExpanded,setAlbumExpanded]=useState(first.searchParams.get('mock_expanded')==='album');
  const [counts,setCounts]=useState(false),[countFriend,setCountFriend]=useState(''),[scenario,setScenario]=useState('normal'),[galleryConfig,setGalleryConfig]=useState(native().galleryConfig());
  const [dialog,setDialog]=useState(null),[dialogTarget,setDialogTarget]=useState(null),[draft,setDraft]=useState(profile),[sort,setSort]=useState('combined'),[ascending,setAscending]=useState(false),[viewport,setViewport]=useState(innerWidth);
  const draftRef=useRef(draft);draftRef.current=draft;
  const effective=id=>id==='me'?'self':relations[id]==='blocked'?'blocked':auto&&!exceptions.includes(id)?'accepted':relations[id];
  const person=personId==='me'?profile:people.find(p=>p.id===personId)||profile,readable=['self','accepted'].includes(effective(personId));
  const windowPeriod=periods.find(p=>p.id===period),factor=windowPeriod.factor,selectedAlbum=byAlbum(albumId),eligible=people.filter(p=>p.id!=='me'&&effective(p.id)==='accepted'&&(selectedAlbum?.mock.counts[p.id]||0)>0);
  const stateRef=useRef();stateRef.current={mode,personId,kind,period,profile,relations,readable,counts,countFriend,factor,albumId,selectedArtist};
  const pageOrigin=useRef({mode:'home',personId:'me',kind:'albums',period:'week',url:'/?mock=home',scroll:0}),pageEntry=useRef(false),returning=useRef(false),pendingScroll=useRef(null),pendingFocus=useRef(null),pageParents=useRef({}),pageEntries=useRef({});
  function applyScrollReturn(){const focus=pendingFocus.current;if(focus?.isConnected&&focus.getClientRects().length){focus.focus({preventScroll:true});pendingFocus.current=null;}const saved=pendingScroll.current;if(!saved)return;const element=document.getElementById(saved.id);if(element?.clientHeight>0){element.scrollTop=saved.amount;pendingScroll.current=null;}}
  useLayoutEffect(()=>{
    // Native popstate may finish showing the preserved surface after React's
    // layout effect. Restore when its actual geometry becomes visible, rather
    // than racing an arbitrary animation-frame callback.
    const observer=new ResizeObserver(applyScrollReturn);
    for(const id of ['albums-scroll','mock-recent-body','mobile-home-recent']){const element=document.getElementById(id);if(element)observer.observe(element);}
    return()=>observer.disconnect();
  },[]);
  function route(nextMode,nextPerson=personId,extra={},replace=false) {
    const url=new URL(location.href);url.search='';url.searchParams.set('surface','albums');url.searchParams.set('mock',nextMode);
    if(nextPerson!=='me')url.searchParams.set('mock_person',nextPerson);
    if(nextMode!=='gallery'){url.searchParams.set('mock_kind',stateRef.current.kind);url.searchParams.set('mock_period',stateRef.current.period);}
    Object.entries(extra).forEach(([key,value])=>value&&url.searchParams.set(key,value));
    const snapshot={...(history.state||{}),mockMode:nextMode};
    if(replace)history.replaceState(snapshot,'',url);else if(window.AlbumHavenSettingsNavigation?.instance?.pushLibraryHistory)window.AlbumHavenSettingsNavigation.instance.pushLibraryHistory(url.href,snapshot);else history.pushState(snapshot,'',url);
  }
  function home(id='me',push=true){if(window.MockViewContext?.source!=='library'||native().readView().selected_artist||native().readView().query)native().loadGallery('?surface=albums',{source:'library'});setPersonId(id);setMode(id==='me'?'home':'profile');setCountFriend('');setAlbumId(null);setSelectedArtist(null);if(push)route(id==='me'?'home':'profile',id);}
  function gallery(artist='',push=true){const previousUrl=location.href,previousState=history.state,retain=push&&stateRef.current.mode==='album'&&new URL(previousUrl).searchParams.get('mobile_page')==='album';setPersonId('me');setCountFriend('');setMode('gallery');native().layout('gallery');if(retain)history.replaceState(previousState,'',previousUrl);if(push)route('gallery','me',{artist});native().loadGallery(new URLSearchParams({surface:'albums',...(artist?{artist}:{})}).toString(),{source:'library'});}
  function select(album){const value=byAlbum(album.id||album.key);if(!value)return;setAlbumId(value.id);setSelectedArtist(value.mock.artist_id);setCountFriend('');if(innerWidth>900&&['home','profile'].includes(stateRef.current.mode)){native().openAlbum(value,'embedded');native().showArtist(byArtist(value.mock.artist_id));}}
  function rememberOrigin(target){const m=stateRef.current;const scrollId=m.mode==='gallery'?'albums-scroll':innerWidth<=900&&['home','profile'].includes(m.mode)?'mobile-home-recent':'mock-recent-body';pageOrigin.current={...m,url:location.href,navigationPosition:history.state?.albumHavenNavigationPosition,focus:innerWidth>900?document.activeElement:null,scrollId,scroll:document.getElementById(scrollId)?.scrollTop||0};pageParents.current[target]=pageOrigin.current;}
  function page(album,options={}){const value=byAlbum(album.id||album.key);if(!value)return;if(stateRef.current.mode!=='album')rememberOrigin('album');pageEntries.current.album=true;const expanded=options.expandedModule===true;setAlbumExpanded(expanded);setAlbumId(value.id);setMode('album');pageEntry.current=true;if(innerWidth>900&&(stateRef.current.mode!=='album'||stateRef.current.albumId!==value.id))route('album',personId,{album:value.id,mock_expanded:expanded?'album':''});native().openAlbum(value,'full',options);}
  function expandArtist(){rememberOrigin('artist');pageEntries.current.artist=true;setMode('artist');pageEntry.current=true;route('artist',personId,{artist_info:selectedArtist,mock_expanded:'artist'});}

  function back(){if(returning.current)return;returning.current=true;const parent=pageParents.current[stateRef.current.mode]||{mode:'home',personId:'me',kind:'albums',period:'week',url:'/?mock=home',scroll:0};if(pageEntries.current[stateRef.current.mode]){pendingScroll.current={id:parent.scrollId||'mock-recent-body',amount:parent.scroll||0};history.back();}else{const old=parent;setPersonId(old.personId);setKind(old.kind);setPeriod(old.period);setMode(old.mode);history.replaceState(history.state,'',old.url);native().layout(old.mode,old.kind);}requestAnimationFrame(()=>returning.current=false);}
  function nativeAlbumReturned(){
    const old=pageParents.current.album||{mode:'home',personId:'me',kind:'albums',period:'week',url:'/?mock=home',scroll:0};pageEntry.current=false;pageEntries.current.album=false;
    pendingScroll.current={id:old.scrollId||'mobile-home-recent',amount:old.scroll||0};
    setPersonId(old.personId);setKind(old.kind);setPeriod(old.period);setAlbumId(old.albumId||null);setSelectedArtist(old.selectedArtist||null);setCountFriend('');setMode(old.mode);
    history.replaceState({...history.state,mockMode:old.mode},'',old.url);native().layout(old.mode,old.kind);
  }
  function switchKind(value){setKind(value);if(['home','profile','recent','compare'].includes(mode))route(mode,personId,{mock_kind:value},true);}
  function switchPeriod(value){setPeriod(value);if(['home','profile','recent','compare'].includes(mode))route(mode,personId,{mock_period:value},true);}
  function expandRecent(){setMode('recent');route('recent');}
  function relation(id,action){setRelations(previous=>({...previous,[id]:({request:'outgoing',accept:'accepted',decline:'none',cancel:'none',unfriend:'none',unblock:'none'})[action]}));if(action==='unfriend')setExceptions(previous=>[...new Set([...previous,id])]);if(action==='accept')setExceptions(previous=>previous.filter(value=>value!==id));setCountFriend('');native().toast(({request:'Request sent in this preview',accept:'You are now friends in this preview',decline:'Request declined',cancel:'Request cancelled',unfriend:'Unfriended in this preview',unblock:'Person unblocked'})[action]);}
  async function unfriend(id){if(await native().confirm({title:'Unfriend',message:'Their shared listening activity will no longer be visible to you.',acceptLabel:'Unfriend',danger:true}))relation(id,'unfriend');}
  function closeDialog(){native().closeDialog();}
  function showDialog(type,who=null,anchor=null){
    if(type==='profile')setDraft({...profile});setDialog({type,who});
    const modal=document.getElementById('app-form-modal');modal.dataset.mockDialog=type;
    native().dialog({title:({friends:'Friends',people:'People on your server',request:'Friend request',profile:'Edit profile',albumSettings:'Album settings'})[type],mode:type==='profile'?undefined:'reading',anchor:null,submitLabel:'Save profile',cancelLabel:'Cancel',contentHtml:'<div data-mock-dialog-content></div>',
      onSubmit:()=>{const value=draftRef.current;if(!value.name.trim())throw new Error('Enter a display name');setProfile({...value,name:value.name.trim()});native().toast('Profile changed in this preview only');},
      onMount:content=>setDialogTarget(content.querySelector('[data-mock-dialog-content]')),onClose:()=>{setDialogTarget(null);setDialog(null);delete modal.dataset.mockDialog;}});
  }
  function relationship(p){const status=effective(p.id);if(status==='accepted')return <Button onClick={()=>unfriend(p.id)}>Unfriend</Button>;if(status==='incoming')return <><Button primary onClick={()=>relation(p.id,'accept')}>Accept</Button><Button onClick={()=>relation(p.id,'decline')}>Decline</Button></>;if(status==='outgoing')return <Button onClick={()=>relation(p.id,'cancel')}>Cancel request</Button>;if(status==='blocked')return <span className="mock-muted">Blocked</span>;return <Button primary onClick={()=>relation(p.id,'request')}>Add friend</Button>;}
  useLayoutEffect(()=>{native().setCallbacks({
    albumOriginPosition:()=>pageParents.current.album?.navigationPosition,home:()=>home(),artist:name=>gallery(name),albumPage:(album,options)=>page(album,options),
    album:(album,context)=>context.recent&&innerWidth>900?select(album):page(album),
    beforeNativeGallery:()=>{window.MockViewContext={source:'library'};setPersonId('me');setMode('gallery');setCountFriend('');native().layout('gallery');},
    albumClosed:back,albumReturned:nativeAlbumReturned,modalClosed:()=>{native().layout(stateRef.current.mode,stateRef.current.kind);if(innerWidth>900&&['home','profile'].includes(stateRef.current.mode)&&stateRef.current.albumId)select(byAlbum(stateRef.current.albumId));},
    albumRendered:album=>{if(stateRef.current.albumId&&album.id&&album.id!==stateRef.current.albumId)setAlbumId(album.id);decorateCounts();},galleryRendered:()=>{const next=native().galleryConfig();setGalleryConfig(previous=>JSON.stringify(previous)===JSON.stringify(next)?previous:next);},viewportChanged:()=>setViewport(innerWidth),
  });});
  useLayoutEffect(()=>{
    if(!readable&&['recent','compare','album','artist'].includes(mode)){setMode('profile');setCountFriend('');return;}
    native().layout(mode,kind);native().setRecentContext({person:person.name,period:windowPeriod.label,kind});
    native().setSelection(readable&&!!(albumId||selectedArtist));
    document.getElementById('mock-album-panel').hidden=!readable||!albumId;document.getElementById('mock-artist-panel').hidden=!readable||!selectedArtist;
    if(viewport>900&&['home','profile'].includes(mode)&&readable){if(selectedAlbum&&(native().getAlbum()?.id!==albumId||document.getElementById('track-modal').hidden||native().getPlacement()!=='embedded'))native().openAlbum(selectedAlbum,'embedded');if(selectedArtist)native().showArtist(byArtist(selectedArtist));}
    if(mode==='album'&&(native().getAlbum()?.id!==albumId||document.getElementById('track-modal').hidden))native().openAlbum(selectedAlbum,'full');
    if(mode==='artist')native().showArtist(byArtist(selectedArtist));
    applyScrollReturn();
  },[mode,personId,readable,viewport,selectedArtist,albumId]);
  useLayoutEffect(()=>{native().setRecentContext({person:person.name,period:windowPeriod.label,kind});document.getElementById('shell-main-surface').dataset.mockKind=kind;},[person.name,period,kind,mode]);
  useEffect(()=>{if(countFriend&&!eligible.some(p=>p.id===countFriend))setCountFriend('');decorateCounts();},[counts,countFriend,albumId,relations,auto,exceptions]);
  function decorateCounts(){
    const m=stateRef.current,album=byAlbum(native().getAlbum()?.id)||byAlbum(m.albumId);
    if(!album)return;
    for(const table of document.querySelectorAll('#track-modal .compact-data-table')){
      if(!table.dataset.mockOriginalColumns)table.dataset.mockOriginalColumns=table.style.getPropertyValue('--cdt-columns');
      const signature=[album.id,m.counts,m.countFriend].join('|');if(table.dataset.mockCountSignature===signature)continue;table.dataset.mockCountSignature=signature;
      table.querySelectorAll('[data-mock-count]').forEach(cell=>cell.remove());
      const selected = m.counts && m.countFriend;table.dataset.mockFriendStatistics=String(!!selected);
      table.dataset.cdtOverflow='local';
      let notice=table.previousElementSibling?.matches('.mock-stats-scroll-note')?table.previousElementSibling:null;
      if(!notice){notice=document.createElement('small');notice.className='mock-stats-scroll-note';table.before(notice);}notice.textContent=selected?'Scroll table to see all statistics':'';
      table.style.setProperty('--cdt-columns',table.dataset.mockOriginalColumns.replace(/(minmax\(54px,\s*auto\))$/,`minmax(70px,auto) ${selected?'minmax(92px,auto) ':''}$1`));
      for(const row of table.querySelectorAll('[role="row"]')){
        const duration=row.querySelector('[data-cdt-column="duration"]');if(!duration)continue;
        const header=!!row.querySelector('[role="columnheader"]'),index=Math.max(0,Number((row.dataset.trackRowPath||'').split(':').at(-1))-1);
        for(const who of ['me',...(selected?[selected]:[])]){
          const total=album.mock.counts[who]||0,cell=document.createElement('div');cell.dataset.mockCount=who;cell.className='mock-count-cell';cell.setAttribute('role',header?'columnheader':'cell');
          const name=people.find(p=>p.id===who)?.name.split(' ')[0]||'Friend';
          cell.textContent=header?(who==='me'?'Your count':name+' · Count'):String(Math.floor(total/album.tracks.length)+(index<total%album.tracks.length?1:0));
          cell.title=(who==='me'?'Your':name+"'s")+' listens · fictional aggregate, independent of Recent period';
          const headerId=table.id+'-mock-count-'+who;if(header)cell.id=headerId;else cell.setAttribute('aria-labelledby',headerId);duration.before(cell);
        }
      }
    }
  }
  useEffect(()=>{
    const pop=()=>{const wasAlbum=['album','artist'].includes(stateRef.current.mode),parent=pageParents.current[stateRef.current.mode]||pageOrigin.current;if(wasAlbum&&innerWidth>900)pendingFocus.current=parent.focus;if(wasAlbum)pendingScroll.current={id:parent.scrollId||'mock-recent-body',amount:parent.scroll||0};const restoreScroll=applyScrollReturn;const url=new URL(location.href);if(wasAlbum&&innerWidth<=900&&!pageEntry.current&&url.searchParams.get('mock')==='album'&&!url.searchParams.has('mobile_page')){url.search='?mock=home';history.replaceState(history.state,'',url);}const next=url.searchParams.get('mobile_page')==='album'?'album':url.searchParams.get('mock')||(url.searchParams.get('surface')==='albums'||url.searchParams.has('artist')?'gallery':'home');setPersonId(url.searchParams.get('mock_person')||'me');setCountFriend('');if(kinds.includes(url.searchParams.get('mock_kind')))setKind(url.searchParams.get('mock_kind'));if(periods.some(p=>p.id===url.searchParams.get('mock_period')))setPeriod(url.searchParams.get('mock_period'));setMode(next==='activity'?'recent':next);if(next==='artist'){setSelectedArtist(byArtist(url.searchParams.get('artist_info'))?.id||'north');}if(next==='album'){setAlbumExpanded(url.searchParams.get('mock_expanded')==='album');const album=byAlbum(url.searchParams.get('album')||url.searchParams.get('mobile_album'));if(album){setAlbumId(album.id);native().openAlbum(album,'full');}}else if(next==='gallery')native().loadGallery(new URLSearchParams({surface:'albums',artist:url.searchParams.get('artist')||''}).toString(),{source:'library'}).then(()=>requestAnimationFrame(restoreScroll));else requestAnimationFrame(restoreScroll);};
    window.addEventListener('popstate',pop);return()=>window.removeEventListener('popstate',pop);
  },[]);
  useEffect(()=>{
    const click=event=>{const artist=event.target.closest('[data-mock-artist-select]');if(artist){const value=byArtist(artist.dataset.mockArtistSelect);if(artist.closest('#mobile-home'))gallery(value.name);else{const album=albums.find(item=>item.mock.artist_id===value.id);select(album);}return;}const go=event.target.closest('[data-mock-go-artist]');if(go){gallery(go.dataset.mockGoArtist);return;}const row=event.target.closest('#mock-recent-body [data-mock-track-album]');if(row&&!event.target.closest('button,a,input'))select(byAlbum(row.dataset.mockTrackAlbum));};
    document.addEventListener('click',click);return()=>document.removeEventListener('click',click);
  });
  useEffect(()=>{window.MockReviewHarness={setScenario,setAuto,navigation:()=>({mode:stateRef.current.mode,origin:{focus:pageOrigin.current.focus?.outerHTML,focusConnected:pageOrigin.current.focus?.isConnected,navigationPosition:pageOrigin.current.navigationPosition,mode:pageOrigin.current.mode,url:pageOrigin.current.url,scrollId:pageOrigin.current.scrollId,scroll:pageOrigin.current.scroll},pendingFocus:pendingFocus.current?.outerHTML,pending:pendingScroll.current,entry:pageEntry.current}),reset:()=>{setRelations(Object.fromEntries(people.map(p=>[p.id,p.relationship])));setExceptions([]);setScenario('normal');setAuto(false);setCounts(false);setCountFriend('');home();}};return()=>delete window.MockReviewHarness;},[]);
  const periodControl=<Select label="Period" value={period} onChange={switchPeriod}>{periods.map(p=><option key={p.id} value={p.id}>{p.label}</option>)}</Select>;
  const friendPicker=eligible.length>0?<Select label="Friend's listen count" value={countFriend} onChange={value=>{setCountFriend(value);setCounts(!!value);}}><option value="">Your statistics only</option>{eligible.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</Select>:null;
  const title=mode==='compare'?`You & ${person.name}`:personId==='me'?`${profile.name.split(' ')[0]}'s Home`:person.name;
  let dialogBody=null;
  const friendsBody=<div className="mock-friends-menu">{viewport<=900&&<Button onClick={()=>{closeDialog();showDialog('profile');}}>Edit profile</Button>}<Button onClick={()=>{closeDialog();showDialog('people');}}>People on your server</Button><label className="mock-switch"><span>Friends' listen counts</span><input type="checkbox" role="switch" checked={counts} onChange={event=>{setCounts(event.target.checked);setCountFriend('');}}/></label></div>;
  if(dialog?.type==='friends')dialogBody=friendsBody;
  if(dialog?.type==='albumSettings')dialogBody=<div className="mock-settings"><h3>Listening statistics</h3>{friendPicker||<p>No eligible friend has listens for this album.</p>}<p>Your count is always shown. Select a friend to add their named count beside Length. These are fictional lifetime aggregates.</p><Button onClick={()=>{closeDialog();native().openAlbumAppearance();}}>Album page layout</Button><p>Layout changes apply in this preview only and reset on refresh.</p></div>;
  if(dialog?.type==='profile')dialogBody=<ProfileEditor draft={draft} onChange={setDraft}/>;
  if(dialog?.type==='people')dialogBody=<div className="mock-people">{people.filter(p=>p.id!=='me').map(p=><div className="mock-person" key={p.id}><button className="mock-person-name" onClick={()=>{closeDialog();home(p.id);}}><Avatar person={p}/><span><strong>{p.name}</strong><small>{effective(p.id)==='accepted'?'Friend':effective(p.id)}</small></span></button><div className="mock-person-actions">{relationship(p)}</div></div>)}</div>;
  if(dialog?.type==='request')dialogBody=<div className="mock-request"><Avatar person={dialog.who}/><h3>{dialog.who.name}</h3><p>{dialog.who.bio}</p><p>Share listening activity and compare tastes as friends.</p><div className="mock-dialog-actions"><Button onClick={()=>{const id=dialog.who.id;closeDialog();home(id);}}>View profile</Button><Button primary onClick={()=>{relation(dialog.who.id,'accept');closeDialog();}}>Accept request</Button><Button onClick={()=>{relation(dialog.who.id,'decline');closeDialog();}}>Decline</Button></div></div>;
  return <>
    <MobileHomeContent {...{person,readable,selectedArtist,scenario,factor,galleryConfig}}/>
    {createPortal(periodControl,node('mock-mobile-period'))}
    {createPortal(mode==='friends'?<><div className="mock-full-header"><Action label="Back" icon="back" onClick={back}/><h1>Friends</h1></div>{friendsBody}<div className="mock-people">{people.filter(p=>p.id!=='me').map(p=><div className="mock-person" key={p.id}><button className="mock-person-name" onClick={()=>home(p.id)}><Avatar person={p}/><span><strong>{p.name}</strong><small>{effective(p.id)==='accepted'?'Friend':effective(p.id)}</small></span></button><div className="mock-person-actions">{relationship(p)}</div></div>)}</div></>:null,node('mock-friends-page'))}
    {createPortal(personId==='me'?null:effective(personId)==='accepted'?<><span className="mock-friend-label">Friend</span><Action label="Compare" icon="compare" onClick={()=>{setMode('compare');route('compare');}}/></>:null,node('mock-mobile-profile-actions'))}
    {createPortal(<Action label="Friends" icon="friends" onClick={()=>{if(viewport<=900){rememberOrigin('friends');pageEntries.current.friends=true;pageEntry.current=true;setMode('friends');route('friends');}else showDialog('friends');}}/>,node('mock-feature-actions'))}
    {createPortal(<><header className="mock-profile-header"><Avatar person={person}/><div className="mock-profile-copy"><div className="mock-profile-name"><h1>{title}</h1>{personId==='me'&&<Action label="Edit profile" icon="edit" bare onClick={()=>showDialog('profile')}/>} {personId!=='me'&&effective(personId)==='accepted'&&<span className="mock-friend-label">Friend</span>}</div><p>{mode==='compare'?'Taste comparison':person.bio}</p></div><div className="mock-header-actions">{personId!=='me'&&readable&&<Action label={mode==='compare'?'View profile':'Compare'} icon={mode==='compare'?'back':'compare'} onClick={()=>mode==='compare'?home(personId):(setMode('compare'),route('compare'))}/>}</div></header>{mode==='compare'&&<div className="mock-comparison-filters"><Tabs id="mock-comparison-tabs" value={kind} onChange={switchKind}/>{periodControl}</div>}</>,node('mock-heading'))}
    {createPortal(<Tabs id="mock-recent-tabs-list" value={kind} onChange={switchKind}/>,node('mock-recent-tabs'))}
    {createPortal(periodControl,node('mock-recent-period'))}
    {createPortal(<Action label={mode==='recent'?'Collapse':'Expand'} icon={mode==='recent'?'collapse':'expand'} disabled={!readable||scenario!=='normal'} onClick={()=>mode==='recent'?home(personId):expandRecent()}/>,node('mock-recent-expand'))}
    {createPortal(<RecentBody {...{person,kind,factor,readable,scenario,selectedArtist}} onRetry={()=>setScenario('normal')} galleryConfig={galleryConfig}/>,node('mock-recent-content'))}
    {createPortal(<Action label="Expand Album details" icon="expand" disabled={!readable||!selectedAlbum} onClick={()=>page(selectedAlbum,{expandedModule:true})}/>,node('mock-album-expand'))}
    {createPortal(<Action label="Expand Artist info" icon="expand" disabled={!readable||!selectedArtist} onClick={expandArtist}/>,node('mock-artist-expand'))}
    {createPortal(counts?friendPicker:null,node('mock-album-preferences'))}
    {createPortal(mode==='compare'&&readable?<Comparison {...{person,kind,factor,sort,ascending}} onSort={setSort} onDirection={()=>setAscending(!ascending)}/>:null,node('mock-single-custom'))}
    {createPortal(<Action label="Album settings" icon="settings" onClick={()=>showDialog('albumSettings')}/>,node('mock-album-settings-action'))}
    {createPortal(<div className="mock-full-header"><span>Artist info</span><div className="mock-header-actions"><Action label="Collapse Artist info" icon="collapse" onClick={back}/></div></div>,node('mock-full-artist-tools'))}

    {createPortal(<section className="mock-notifications"><h4>Friend requests</h4>{people.filter(p=>effective(p.id)==='incoming').map(p=><button key={p.id} className="mock-person-name" onClick={()=>showDialog('request',p)}><Avatar person={p}/><span><strong>{p.name}</strong><small>Sent you a friend request</small></span></button>)}{!people.some(p=>effective(p.id)==='incoming')&&<p>No pending friend requests</p>}</section>,node('mock-request-notices'))}
    {dialogTarget&&createPortal(dialogBody,dialogTarget)}
  </>;
}
function mount(){const host=document.createElement('div');host.id='mock-react-root';document.body.append(host);createRoot(host).render(<App/>);}
if(window.MockRealLayout)mount();else addEventListener('mock-real-ui-ready',mount,{once:true});
