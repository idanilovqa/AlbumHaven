import React, { useState, useEffect, useLayoutEffect, useRef, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal, flushSync } from 'react-dom';
import { people, artists, albums, periods, byAlbum, byArtist, image } from './fixture-data.mjs';
import {activity} from './listening-model.mjs';
import {buildRecentListening,recentArtistAlbums,formatRecentListenTimestamp,resolveRecentTimeZone} from './recent-history.mjs';
import {renderArtistView,mountArtistView,renderArtistIdentity,artistViewStyles} from './artist-view.mjs';
import {ReviewProposals} from './review-proposals.jsx';
import {bindSidebarInactivity} from './sidebar-inactivity.mjs';
import {Comparison,ComparisonIdentityHeader} from './comparison-panel.jsx';
import {trackPopularity,albumPopularity,artistPopularity,loveControl,refreshLoveControls,bindTrackLoveControls} from './track-social.mjs';
import {PlaylistPanel,PlaylistSidebar} from './playlist-panel.jsx';
import {playlistController,LOVED_PLAYLIST_ID,playlistTrack,createQueue,advanceQueue,setQueueMode,queueOrigin} from './playlist-model.mjs';

const native = () => window.MockRealLayout;
const node = id => native().portals[id] || document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const kinds = ['albums', 'tracks', 'artists'];
let pendingPanelTransition=null,panelTransitionRevision=0,applyingPanelTransition=false;
function invalidatePanelTransition(){
  if(applyingPanelTransition)return;
  ++panelTransitionRevision;pendingPanelTransition?.skipTransition();pendingPanelTransition=null;
}
function panelTransition(change,{atomic=false}={}){
  invalidatePanelTransition();const revision=panelTransitionRevision;
  const commit=()=>{if(revision!==panelTransitionRevision)return;applyingPanelTransition=true;try{flushSync(change);}finally{applyingPanelTransition=false;}};
  if(atomic||!document.startViewTransition||matchMedia('(prefers-reduced-motion: reduce)').matches){commit();return;}
  const transition=document.startViewTransition(commit);pendingPanelTransition=transition;
  transition.finished.catch(()=>{}).then(()=>{if(pendingPanelTransition===transition)pendingPanelTransition=null;});
}
function Button({ children, onClick, primary = false, disabled = false }) {
  const html = window.ButtonComponent.renderButton({ label: children, title:String(children),ariaLabel:String(children), variant: primary ? 'primary' : 'secondary', size: 'small', disabled });
  return <span className="mock-native-button" onClick={event => { if (!disabled && event.target.closest('button')) onClick?.(event); }} dangerouslySetInnerHTML={{ __html: html }} />;
}
function Action({ label, icon, onClick, disabled = false, bare = false, active, visibleLabel, variant = 'icon' }) {
  const ref = useRef(),renderedHtml=useRef(null);
  const shared = { edit:'edit', back:'back', close:'close', compare:'copy', page:'cover' }[icon];
  const html = window.ButtonComponent.renderActionButton({ ariaLabel: label, title: label, icon: shared, disabled, presentation: bare ? 'bare' : 'outlined', className:variant==='sidebar-mode'?'mock-bar-action mock-sidebar-mode-button':'mock-bar-action',attributes:active===undefined?{}:{'aria-pressed':String(active)} });
  useLayoutEffect(() => {
    if(!ref.current.firstElementChild){ref.current.innerHTML=html;renderedHtml.current=html;}
    const button=ref.current.firstElementChild;button.classList.toggle('action-button--bare',bare);window.ButtonComponent.setDisabled(button,disabled);button.setAttribute('aria-label',label);button.title=label;if(active===undefined)button.removeAttribute('aria-pressed');else button.setAttribute('aria-pressed',String(active));
    button.classList.toggle('mock-sidebar-mode-button',variant==='sidebar-mode');
    if(visibleLabel!==undefined){let text=button.querySelector('.mock-action-label');if(!text){text=document.createElement('span');text.className='mock-action-label';button.querySelector('.action-button__content').append(text);}text.textContent=label;text.hidden=!visibleLabel;}
    if (shared) return;
    const target = ref.current?.querySelector('.action-button__icon'); if (!target) return;
    const owner = icon === 'friends' ? document.querySelector('[data-gallery-bar-action="artist-family"] svg') : icon === 'settings' ? document.querySelector('#account-menu-button svg, [aria-label="Settings"] svg') : null;
    if (owner) { target.innerHTML = owner.outerHTML; return; }
    const paths = {
      expand:'M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5M3 3l6 6M21 3l-6 6M3 21l6-6M21 21l-6-6',
      collapse:'M3 9h6V3M21 9h-6V3M9 21v-6H3M15 21v-6h6M3 3l6 6M21 3l-6 6M3 21l6-6M21 21l-6-6',
      filter:'M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M6 14v6',
      settings:'M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M6 14v6',
      playlist:'M4 6h11M4 11h11M4 16h6M18 6v12a2.5 2.5 0 1 1-2.5-2.5H18M18 6l4 1v4l-4-1',
      tree:'M12 21V3M12 7 7 3M12 11l6-5M12 15l-7-5M12 18l7-5',
      repeat:'M17 3l4 4-4 4M3 11V9a2 2 0 0 1 2-2h16M7 21l-4-4 4-4m14 0v2a2 2 0 0 1-2 2H3',
      repeatOne:'M17 3l4 4-4 4M3 11V9a2 2 0 0 1 2-2h16M7 21l-4-4 4-4m14 0v2a2 2 0 0 1-2 2H3M10 10l2-1v6m-2 0h4',
      statistics:'M2.5 21.5 6.5 14.5C5.8 13.4 5.8 12.2 6.3 11.3C5.5 10.4 5.7 9.1 6.3 8.7C5.6 7.9 6 6.5 6.9 6.2C6.4 4.9 7.2 3.9 8.4 4.1L9.5 4.4C9.1 3.7 9.4 2.8 10.2 2.7L11.8 3.3 13.1 2.5C14.4 1.8 15.9 2.5 15.9 4C17.2 4.6 17.6 5.8 17.3 7C18.4 8.4 18.1 9.7 18.1 10.6C18.1 12.1 17.1 13.6 16.2 14.4L21.5 21.5M7 21.5 12 17 17 21.5M6.5 14.5l4.1 3.7M16.2 14.4 13.6 16.5M6.9 6.2l2.9.7c1.4.3 1.3 2.2-.1 2.4l-3.4-.6M6.3 11.3l2.1.4M9.5 4.4l1.5.5',
    };
    if (paths[icon]) target.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[icon]}"/></svg>`;
  });
  return <span ref={ref} className="mock-native-button" onClick={event => { if (!disabled && event.target.closest('button')) onClick?.(event); }} />;
}
function NativeHtml({ html, className = '', onClick }) {
  const ref = useRef();
  useLayoutEffect(() => { const focusKey=ref.current.contains(document.activeElement)?document.activeElement.dataset.mockSort:null;ref.current.innerHTML=html;native().activate(ref.current);if(focusKey)[...ref.current.querySelectorAll('[data-mock-sort]')].find(button=>button.dataset.mockSort===focusKey)?.focus({preventScroll:true}); }, [html]);
  return <div ref={ref} className={className} onClick={onClick} />;
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
function Select({ label, value, onChange, children }) { return <label className="mock-select"><span className={label==='Period'?'sr-only':undefined}>{label}</span><select aria-label={label} value={value} onChange={e => onChange(e.target.value)}>{children}</select></label>; }
function Choice({label,value,options,onChange,density='normal'}) {
  const ref=useRef();const chosen=options.find(option=>option.value===value)?.label||options[0]?.label||label;
  useLayoutEffect(()=>{if(!ref.current.firstElementChild)ref.current.innerHTML=window.ButtonComponent.renderButton({label:chosen,variant:'secondary',size:'small',className:'mock-choice-trigger',ariaLabel:label,attributes:{'aria-haspopup':'menu','aria-expanded':'false'}}).replace('</button>','<svg class="mock-choice-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>');const button=ref.current.firstElementChild;button.querySelector('.ui-button__content').textContent=chosen;button.setAttribute('aria-label',label);button.title=label+': '+chosen;button.classList.toggle('mock-choice-trigger--slim',density==='slim');},[chosen,label,density]);
  return <span ref={ref} className="mock-native-choice" onClick={event=>{const button=event.target.closest('button');if(button)native().choiceDropdown(button,{formats:options,selected:value,label,onSelect:onChange});}}/>;
}
function selectPersonRow(button,navigate){
  const row=button.closest('.mock-person');if(!row)return;const owner=row.parentElement;
  for(const other of owner.querySelectorAll('.mock-person'))other.classList.toggle('is-selected',other===row);
  if(owner.mockPendingPerson?.row!==row)owner.mockPendingPerson=null;
  if(!navigate||owner.mockPendingPerson)return;
  const activation={row};owner.mockPendingPerson=activation;
  const current=()=>owner.mockPendingPerson===activation&&row.isConnected&&!row.closest('[hidden],[inert],[aria-hidden="true"]');
  const cancel=()=>{if(owner.mockPendingPerson===activation)owner.mockPendingPerson=null;};
  // One directory-owned activation permits a paint and coalesces rapid choices.
  requestAnimationFrame(()=>{if(!current()){cancel();return;}requestAnimationFrame(()=>{if(current()){cancel();navigate();}else cancel();});});
}
function Avatar({ person }) { return <img className="mock-avatar" src={person.avatarUrl || image(person.avatar)} alt="" />; }
function useWidth() {
  const ref = useRef(), [width, setWidth] = useState(0);
  useLayoutEffect(() => { const measure = () => { const next=ref.current?.clientWidth||0; if(next>0)setWidth(next); }; measure(); const observer = new ResizeObserver(measure); observer.observe(ref.current); return () => observer.disconnect(); }, []);
  return [ref, width];
}
function RecentViewControl({mode='home',kind,value,onChange,phone=innerWidth<=900,scope=''}) {
  // Coordinate the existing native root; never render a competing view button.
  useLayoutEffect(()=>{
    const context=mode==='gallery'?'gallery':mode==='compare'&&kind==='albums'?'comparison':['home','profile','recent'].includes(mode)&&kind!=='albums'?`recent-${kind}`:'none';
    native().setViewContext({context,scope:`${mode}:${scope}:${kind}`,value,onSelect:onChange,phone,host:context==='comparison'?node('mock-comparison-view-action'):node('mock-recent-view-action')});
  },[mode,kind,value,onChange,phone,scope]);
  return null;
}
function RecentContents({person,kind,factor,period,readable,scenario,selectedAlbumId,selectedArtist,selectedTrack,selectedListen,trackView,artistView,galleryConfig,mobile=false,onRetry}) {
  const allowed=useMemo(()=>new Set(galleryConfig.keys),[galleryConfig.keys]);
  useLayoutEffect(()=>{if(kind==='albums')native().paintRecentAlbumSelection(mobile?'mobile-home-albums':'mock-recent-content',byAlbum(selectedAlbumId)?.key||null);},[selectedAlbumId,kind,person.id,period,galleryConfig,mobile,readable,scenario]);
  useLayoutEffect(()=>native().paintArtistSelection?.(mobile?'mobile-home-artists':'mock-recent-content',selectedArtist),[selectedArtist,artistView,kind,person.id,period,galleryConfig]);
  useLayoutEffect(()=>native().paintRecentSelection(mobile?'mock-phone-home-tracks':'mock-recent-tracks',selectedTrack,selectedListen,trackView),[selectedTrack,selectedListen,trackView,person.id,period,galleryConfig]);
  const listening=useMemo(()=>buildRecentListening(person.id,period,{albumIds:allowed}),[person.id,period,allowed]);
  const artistRows=useMemo(()=>activity(person.id,'artists',factor).filter(row=>albums.some(album=>album.mock.artist_id===row.id&&allowed.has(album.key))),[person.id,factor,allowed]);
  const artistAlbums=useMemo(()=>recentArtistAlbums(selectedArtist,person.id,period,{albumIds:allowed}).rows,[selectedArtist,person.id,period,allowed]);
  const albumRows=useMemo(()=>activity(person.id,'albums',factor).filter(row=>allowed.has(row.album.key)).sort((a,b)=>mobile?b.count-a.count||a.title.localeCompare(b.title):a.album.mock.recent-b.album.mock.recent).slice(0,4),[person.id,factor,allowed,mobile]);
  if(!readable)return <div className="mock-empty">Listening is shared with friends</div>;
  if(scenario==='error')return <div className="mock-empty">Listening activity is unavailable{onRetry&&<Button onClick={onRetry}>Try again</Button>}</div>;
  if(scenario==='empty')return <div className="mock-empty">No listening activity in this period</div>;
  if(kind==='tracks')return <><NativeHtml html={native().playTable({id:mobile?'mock-phone-home-tracks':'mock-recent-tracks',artwork:true,label:`${person.name} recent tracks`,rows:trackView==='history'?listening.history:listening.tracks,timeColumn:true,loveColumn:true,history:trackView==='history'})}/>{trackView==='history'&&listening.truncated&&<p className="mock-history-summary">Latest {listening.shownPlays} of {listening.totalPlays.toLocaleString('en-US')} listens</p>}</>;
  if(kind==='artists')return <><NativeHtml html={native().artistTree({rows:artistRows,view:artistView})}/>{selectedArtist&&<section className="mock-selected-artist-albums"><h3>Albums from the artists you've listened to</h3>{artistAlbums.length?<NativeHtml className="mock-flat-gallery mock-small-gallery" html={native().flatGallery({records:artistAlbums.map(row=>row.album),width:mobile?360:900,fluid:true,compact:true,view:'cards',person:person.id,factor})}/>:<p className="mock-empty">No albums listened to in this period</p>}</section>}</>;
  return <NativeHtml className="mock-flat-gallery" html={native().flatGallery({records:albumRows.map(row=>row.album),width:mobile?360:900,fluid:!mobile,homeGrid:mobile,view:'cards',person:person.id,factor})}/>;
}
function RecentBody(props) {return <div className="mock-recent-composition" data-recent-kind={props.kind}><RecentContents {...props}/></div>;}
function MobileHomeContent(props) {return <>{kinds.map(kind=>createPortal(<div className="mock-native-home-content"><RecentContents {...props} kind={kind} mobile/></div>,node('mobile-home-'+kind),kind))}</>;}
function ArtistPage({artist,selectedAlbumId,onBack,onGallery,onAlbum,onSelectAlbum,onArtist}) {
  const ref=useRef(),callbacks=useRef();callbacks.current={onBack,onGallery,onAlbum,onSelectAlbum,onArtist};
  useLayoutEffect(()=>{let style=document.getElementById('mock-artist-view-styles');if(!style){style=document.createElement('style');style.id='mock-artist-view-styles';style.textContent=artistViewStyles;document.head.append(style);}const config={artist,albums,artists,selectedAlbumId,fictionalDefaults:true};const owners=native().artistViewOwners;ref.current.innerHTML=renderArtistView(config,owners);return mountArtistView(ref.current,config,owners,{onBack:()=>callbacks.current.onBack(),onViewGallery:value=>callbacks.current.onGallery(value),onOpenAlbum:value=>callbacks.current.onAlbum(value),onSelectAlbum:value=>callbacks.current.onSelectAlbum?.(value),onOpenArtist:value=>callbacks.current.onArtist(value)});},[artist?.id]);useLayoutEffect(()=>{native().artistViewOwners.paintSelection?.(ref.current,selectedAlbumId);},[selectedAlbumId,artist?.id]);
  return <div ref={ref} className="mock-artist-page-host"/>;
}
function ProfileEditor({ draft, onChange }) {
  const file = useRef(), pendingRead=useRef(null), [error,setError]=useState(''),[editingName,setEditingName]=useState(false),nameReturn=useRef(false),nameInput=useRef(null),nameBeforeEdit=useRef(draft.name),nameEdit=useRef(null),nameEscapeHeld=useRef(false);
  nameEdit.current={editingName,onChange};
  useEffect(()=>()=>{pendingRead.current?.abort();pendingRead.current=null;},[]);
  const cancelRead=()=>{pendingRead.current?.abort();pendingRead.current=null;};
  useLayoutEffect(()=>{if(!editingName&&nameReturn.current){nameReturn.current=false;document.querySelector('.mock-profile-title-button')?.focus();}},[editingName]);
  useEffect(()=>{
    const escape=event=>{
      if(event.key!=='Escape'||(!nameEdit.current.editingName&&!nameEscapeHeld.current))return;
      const modal=document.getElementById('app-form-modal');
      if(!modal||modal.hidden||window.getTopmostOpenModal?.()!==modal)return;
      if(!nameEscapeHeld.current&&document.activeElement!==nameInput.current)return;
      event.preventDefault();event.stopImmediatePropagation();
      if(event.repeat||event.isComposing||nameEscapeHeld.current)return;
      nameEscapeHeld.current=true;nameEdit.current.onChange(previous=>({...previous,name:nameBeforeEdit.current}));nameReturn.current=true;setEditingName(false);
    };
    const release=event=>{if(event.type==='blur'||event.key==='Escape')nameEscapeHeld.current=false;};
    window.addEventListener('keydown',escape,true);window.addEventListener('keyup',release,true);window.addEventListener('blur',release);
    return()=>{window.removeEventListener('keydown',escape,true);window.removeEventListener('keyup',release,true);window.removeEventListener('blur',release);};
  },[]);
  return <div className="mock-profile-editor">{createPortal(editingName?<><span className="mock-profile-title-label">{draft.name||'Profile'}</span><input ref={nameInput} autoFocus className="mock-profile-title-input" aria-label="Name" value={draft.name} maxLength={50} onChange={event=>onChange({...draft,name:event.target.value})} onBlur={()=>setEditingName(false)} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();event.stopPropagation();nameReturn.current=true;setEditingName(false);}}}/></>:<button type="button" className="mock-profile-title-button" aria-label={`Edit name: ${draft.name}`} onClick={()=>{nameBeforeEdit.current=draft.name;setEditingName(true);}}>{draft.name||'Your name'}</button>,document.getElementById('app-form-title'))}<div className="mock-avatar-editor"><button type="button" className="mock-avatar-open" aria-label={`View ${draft.name}'s avatar`} onClick={()=>native().openAvatar(draft.avatarUrl||image(draft.avatar),draft.name)}><Avatar person={draft}/></button><Button onClick={()=>file.current.click()}>Choose image</Button><input ref={file} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={event=>{const value=event.target.files?.[0];if(!value)return;if(!['image/png','image/jpeg','image/webp'].includes(value.type)||value.size>5242880){setError('Choose a PNG, JPEG or WebP under 5 MB');return;}cancelRead();const reader=new FileReader();pendingRead.current=reader;reader.onload=()=>{if(pendingRead.current!==reader)return;onChange(previous=>({...previous,avatarUrl:reader.result}));pendingRead.current=null;};reader.readAsDataURL(value);setError('');}}/></div><label>About you<textarea value={draft.bio} rows={3} maxLength={240} onChange={event=>onChange({...draft,bio:event.target.value})}/></label><div className="mock-avatar-presets">{['mountain','ocean','desert','forest'].map(name=><button type="button" key={name} aria-label={`Use ${name} avatar`} className="mock-avatar-choice" onClick={()=>{cancelRead();onChange(previous=>({...previous,avatar:name,avatarUrl:''}));}}><img src={image(name)} alt=""/></button>)}</div><small className="mock-muted">Local preview only. No image is uploaded.</small>{error&&<p role="alert">{error}</p>}</div>;
}
function App() {
  const first = new URL(location.href), requested = first.searchParams.get('mobile_page')==='album'?'album':first.searchParams.get('mock') || (first.searchParams.get('surface')==='albums'||first.searchParams.has('artist')?'gallery':'home');
  const [mode,setMode]=useState(requested==='activity'?'recent':requested),[personId,setPersonId]=useState(first.searchParams.get('mock_person')||'me'),[kind,setKind]=useState(kinds.includes(first.searchParams.get('mock_kind'))?first.searchParams.get('mock_kind'):(innerWidth<=900?'tracks':'albums')),[period,setPeriod]=useState(periods.some(p=>p.id===first.searchParams.get('mock_period'))?first.searchParams.get('mock_period'):'week');
  const [profile,setProfile]=useState({...people[0]}),[relations,setRelations]=useState(Object.fromEntries(people.map(p=>[p.id,p.relationship==='blocked'?'none':p.relationship]))),[auto,setAuto]=useState(false),[exceptions,setExceptions]=useState([]);
  const [albumId,setAlbumId]=useState(byAlbum(first.searchParams.get('album')||first.searchParams.get('mobile_album'))?.id||null),[selectedArtist,setSelectedArtist]=useState(byArtist(first.searchParams.get('artist_info'))?.id||null),[expandedModule,setExpandedModule]=useState(first.searchParams.get('mock_expanded')||'');
  const [selectedTrack,setSelectedTrack]=useState(null),[selectedListen,setSelectedListen]=useState(null),[panelsVisible,setPanelsVisible]=useState(false),[trackView,setTrackView]=useState('grouped'),[artistView,setArtistView]=useState('rows');
  const [artistAlbumId,setArtistAlbumId]=useState(null);
  const selectionByKind=useRef({}),recentEntrySelections=useRef(new Map()),artistEntrySelections=useRef(new Map()),artistEntryPosition=useRef(history.state?.albumHavenNavigationPosition);
  const playlistEntryStates=useRef(new Map()),playlistEntryPosition=useRef(history.state?.albumHavenNavigationPosition);
  const [counts,setCounts]=useState(false),[countFriend,setCountFriend]=useState(''),[scenario,setScenario]=useState('normal'),[galleryConfig,setGalleryConfig]=useState(native().galleryConfig());
  const [playlistExpanded,setPlaylistExpanded]=useState(requested==='playlist'&&first.searchParams.get('mock_expanded')==='playlist');
  const [playlistId,setPlaylistId]=useState(first.searchParams.get('mock_playlist')||LOVED_PLAYLIST_ID),[sidebarMode,setSidebarMode]=useState('artists'),[queue,setQueue]=useState(null),[revealTrack,setRevealTrack]=useState(null),[albumRepeat,setAlbumRepeat]=useState({});const queueRef=useRef(null),pendingPlaylistFocus=useRef(false);
  const [artistDestination,setArtistDestination]=useState('gallery'),[openAlbumModals,setOpenAlbumModals]=useState(true);const modalOrigin=useRef(null),modalEntryOrigins=useRef(new Map()),closingAlbumModal=useRef(false);
  const [dialog,setDialog]=useState(null),[dialogTarget,setDialogTarget]=useState(null),[draft,setDraft]=useState(profile),[sort,setSort]=useState('combined'),[ascending,setAscending]=useState(false),[viewport,setViewport]=useState(innerWidth),[comparisonView,setComparisonView]=useState('list'),[commonOnly,setCommonOnly]=useState(true);
  const draftRef=useRef(draft);draftRef.current=draft;
  const effective=id=>id==='me'?'self':auto&&!exceptions.includes(id)?'accepted':relations[id];
  const person=personId==='me'?profile:people.find(p=>p.id===personId)||profile,readable=['self','accepted'].includes(effective(personId));
  const windowPeriod=periods.find(p=>p.id===period),factor=windowPeriod.factor,selectedAlbum=byAlbum(albumId),embeddedAlbum=['home','profile','recent'].includes(mode)&&kind==='albums'&&selectionByKind.current.albums?.albumId!==albumId?null:selectedAlbum,eligible=people.filter(p=>p.id!=='me'&&effective(p.id)==='accepted'&&(selectedAlbum?.mock.counts[p.id]||0)>0);
  const stateRef=useRef();stateRef.current={mode,personId,kind,period,profile,relations,readable,counts,countFriend,factor,albumId,selectedArtist,selectedTrack,selectedListen,panelsVisible,artistAlbumId,artistDestination,playlistId,playlistExpanded,revealTrack,openAlbumModals,sort,ascending,comparisonView,commonOnly,expandedModule};
  const pageOrigin=useRef({mode:'home',personId:'me',kind:'albums',period:'week',url:'/?mock=home',scroll:0}),pageEntry=useRef(false),returning=useRef(false),pendingScroll=useRef(null),pendingFocus=useRef(null),pageParents=useRef({}),pageEntries=useRef({}),entryOrigins=useRef(new Map());
  function findReturnFocus(match){
    if(match.kind==='module-expand')return node('mock-'+match.module+'-expand').querySelector('button');
    if(match.kind==='playlist-expand')return node('mock-playlist-expand').querySelector('button');
    if(match.kind==='playlist-track'){
      const row=[...document.querySelectorAll('#mock-playlist-content [data-track-row-path]')].find(value=>value.dataset.trackRowPath===match.key);
      return match.control==='love'?row?.querySelector('[data-mock-track-love]'):match.control==='play'?row?.querySelector('.play-track-button'):row;
    }
    const selector=match.kind==='compare'?'#shell-main-surface [aria-label=Compare]':match.kind==='discography'?'#mock-artist-page [data-mock-artist-release] button':match.kind==='comparison-artist'?'#mock-single-custom [data-mock-comparison-artist]':match.kind==='artist-family'?'#mock-artist-page [data-mock-connected-artist]':match.kind==='artist-gallery'?'#mock-artist-page [data-mock-artist-gallery]':match.kind==='gallery-title'?'[data-mock-gallery-artist-page]':match.kind==='gallery-info'?'[data-artist-info-trigger][data-artist]':'#mock-single-custom [data-open-tracklist]';
    return [...document.querySelectorAll(selector)].find(element=>{
      if(!element.getClientRects().length)return false;
      if(match.kind==='compare')return true;
      if(match.kind==='comparison-artist')return element.dataset.mockComparisonArtist===match.artist&&(!match.key||(element.dataset.mockComparisonAlbum||element.closest('[data-comparison-album-id]')?.dataset.comparisonAlbumId)===match.key)&&(!match.side||element.closest('[data-side]')?.dataset.side===match.side);
      if(match.kind==='gallery-info')return element.dataset.artist===match.artist;
      if(match.kind==='gallery-title')return element.dataset.mockGalleryArtistPage===match.artist;
      if(match.kind==='artist-family')return element.closest('[data-mock-artist-view]')?.dataset.mockArtistView===match.artist&&element.dataset.mockConnectedArtist===match.target;
      if(['discography','artist-gallery'].includes(match.kind)){
        if(element.closest('[data-mock-artist-view]')?.dataset.mockArtistView!==match.artist)return false;
        return match.kind==='artist-gallery'||element.closest('[data-mock-artist-release]')?.dataset.mockArtistRelease===match.key&&(match.control==='artwork'?element.matches('.mock-discography-select'):element.matches('[data-mock-artist-album-title]'));
      }
      return element.dataset.albumKey===match.key&&(!match.side||element.closest('[data-side]')?.dataset.side===match.side);
    });
  }
  function returnFocusMatch(m,focused,target){
    for(const module of ['recent','album','artist'])if(focused?.closest?.('#mock-'+module+'-expand'))return {kind:'module-expand',module};
    if(m.mode==='playlist'){
      if(focused?.closest?.('#mock-playlist-expand'))return {kind:'playlist-expand'};
      const row=focused?.closest?.('#mock-playlist-content [data-track-row-path]');
      if(row)return {kind:'playlist-track',key:row.dataset.trackRowPath,control:focused.matches?.('[data-mock-track-love]')?'love':focused.matches?.('.play-track-button')?'play':'row'};
    }
    const comparisonArtist=m.mode==='compare'&&focused?.closest?.('[data-mock-comparison-artist]');
    if(comparisonArtist)return {kind:'comparison-artist',artist:comparisonArtist.dataset.mockComparisonArtist,key:comparisonArtist.dataset.mockComparisonAlbum||comparisonArtist.closest('[data-comparison-album-id]')?.dataset.comparisonAlbumId,side:comparisonArtist.closest('[data-side]')?.dataset.side};
    if(m.mode==='gallery'&&focused?.matches?.('[data-mock-gallery-artist-page]'))return {kind:'gallery-title',artist:focused.dataset.mockGalleryArtistPage};
    if(m.mode==='gallery'&&focused?.matches?.('[data-artist-info-trigger][data-artist]'))return {kind:'gallery-info',artist:focused.dataset.artist};
    if(m.mode==='artist-page'){
      const family=focused?.closest?.('[data-mock-connected-artist]');
      if(family)return {kind:'artist-family',artist:m.selectedArtist,target:family.dataset.mockConnectedArtist};
      const release=focused?.closest?.('[data-mock-artist-release]');
      if(release)return {kind:'discography',artist:m.selectedArtist,key:release.dataset.mockArtistRelease,control:focused.matches?.('.mock-discography-select')?'artwork':'title'};
      if(m.artistAlbumId&&focused?.closest?.('[data-mock-artist-album-slot]'))return {kind:'discography',artist:m.selectedArtist,key:m.artistAlbumId,control:'artwork'};
      if(focused?.matches?.('[data-mock-artist-gallery]'))return {kind:'artist-gallery',artist:m.selectedArtist};
    }
    return target==='compare'?{kind:'compare'}:m.mode==='compare'&&focused?.dataset.albumKey?{kind:'album',key:focused.dataset.albumKey,side:focused.closest('[data-side]')?.dataset.side}:null;
  }
  function applyScrollReturn(){
    const pending=pendingFocus.current;let focus=pending?.element||pending;
    if((!focus?.isConnected||!focus.getClientRects().length)&&pending?.match)focus=findReturnFocus(pending.match);
    if(focus?.isConnected&&focus.getClientRects().length){focus.focus({preventScroll:true});pendingFocus.current=null;}
    const saved=pendingScroll.current;if(!saved)return;const element=document.getElementById(saved.id);if(!element?.clientHeight)return;
    if(saved.id==='mock-artist-page-scroll'){element.scrollTop=Math.max(0,Math.min(saved.amount,element.scrollHeight-element.clientHeight));const info=document.querySelector('#mock-artist-page .mock-artist-info-copy');if(info&&Number.isFinite(saved.artistInfoAmount))info.scrollTop=saved.artistInfoAmount;const releases=document.querySelector('#mock-artist-page .mock-artist-view__releases'),family=document.querySelector('#mock-artist-page .mock-artist-view__family');if(releases&&Number.isFinite(saved.artistDiscographyAmount))releases.scrollTop=saved.artistDiscographyAmount;if(family&&Number.isFinite(saved.artistFamilyAmount))family.scrollTop=saved.artistFamilyAmount;}
    else if(saved.id==='mock-playlist-scroll'){if(element.dataset.scrollReady!=='true')return;element.scrollTop=Math.max(0,Math.min(saved.amount,element.scrollHeight-element.clientHeight));}
    else if(saved.id==='mock-single-custom'){
      const comparison=element.querySelector('.mock-comparison'),columns=[...(comparison?.querySelectorAll('.mock-comparison-column')||[])];
      const ready=comparison?.querySelector('.mock-shared-comparison,.mock-empty')||columns.length===2&&columns.every(column=>column.dataset.comparisonReady==='true');
      if(!ready)return;
      element.scrollTop=Math.max(0,Math.min(saved.amount,element.scrollHeight-element.clientHeight));
    }else element.scrollTop=saved.amount;
    pendingScroll.current=null;
  }
  useLayoutEffect(()=>{
    // Native popstate may finish showing the preserved surface after React's
    // layout effect. Restore when its actual geometry becomes visible, rather
    // than racing an arbitrary animation-frame callback.
    const observer=new ResizeObserver(applyScrollReturn);
    for(const id of ['albums-scroll','mock-recent-body','mobile-home-recent','mock-single-custom','mock-artist-page','mock-playlist-content']){const element=document.getElementById(id);if(element)observer.observe(element);}
    let observedPlaylistBody=null;const playlistReady=()=>{const body=document.getElementById('mock-playlist-scroll');if(observedPlaylistBody!==body){if(observedPlaylistBody)observer.unobserve(observedPlaylistBody);observedPlaylistBody=body;if(body)observer.observe(body);}applyScrollReturn();};window.addEventListener('mock-playlist-ready',playlistReady);playlistReady();let observedArtistBody=null;const artistReady=()=>{const body=document.getElementById('mock-artist-page-scroll');if(body!==observedArtistBody){if(observedArtistBody)observer.unobserve(observedArtistBody);observedArtistBody=body;if(body)observer.observe(body);}applyScrollReturn();};window.addEventListener('mock-artist-ready',artistReady);artistReady();
    const comparisonContents=new MutationObserver(applyScrollReturn);comparisonContents.observe(document.getElementById('mock-single-custom'),{childList:true,subtree:true});
    return()=>{observer.disconnect();comparisonContents.disconnect();window.removeEventListener('mock-playlist-ready',playlistReady);window.removeEventListener('mock-artist-ready',artistReady);};
  },[]);
  function route(nextMode,nextPerson=personId,extra={},replace=false) {
    invalidatePanelTransition();savePlaylistEntry();native().closeViewControl();
    const url=new URL(location.href),proposal=url.searchParams.get('mock_proposal'),palette=url.searchParams.get('proposal_palette');url.search='';url.searchParams.set('surface','albums');url.searchParams.set('mock',nextMode);if(proposal==='panel-color'){url.searchParams.set('mock_proposal',proposal);if(palette)url.searchParams.set('proposal_palette',palette);}
    if(nextPerson!=='me')url.searchParams.set('mock_person',nextPerson);
    if(nextMode!=='gallery'){url.searchParams.set('mock_kind',stateRef.current.kind);url.searchParams.set('mock_period',stateRef.current.period);}
    // Replacing Recent kind/period preserves the entry's explicit expansion.
    // New navigation starts a fresh presentation unless its caller flags it.
    const expansion=Object.prototype.hasOwnProperty.call(extra,'mock_expanded')?extra.mock_expanded:replace&&nextMode===stateRef.current.mode?stateRef.current.expandedModule:'';
    if(expansion)url.searchParams.set('mock_expanded',expansion);
    Object.entries(extra).forEach(([key,value])=>value&&url.searchParams.set(key,value));
    setExpandedModule(expansion||'');
    const snapshot={...(history.state||{}),mockMode:nextMode};
    if(replace)history.replaceState(snapshot,'',url);else if(window.AlbumHavenSettingsNavigation?.instance?.pushLibraryHistory)window.AlbumHavenSettingsNavigation.instance.pushLibraryHistory(url.href,snapshot);else history.pushState(snapshot,'',url);
    if(!replace&&pageParents.current[nextMode])entryOrigins.current.set(history.state?.albumHavenNavigationPosition,pageParents.current[nextMode]);
  }
  function home(id='me',push=true){saveRecentSelection();if(window.MockViewContext?.source!=='library'||native().readView().selected_artist||native().readView().query)native().loadGallery('?surface=albums',{source:'library'});setPersonId(id);setMode(id==='me'?'home':'profile');setCountFriend('');setAlbumId(null);setSelectedArtist(null);setSelectedTrack(null);setSelectedListen(null);setPanelsVisible(false);selectionByKind.current={};if(push)route(id==='me'?'home':'profile',id);}
  function gallery(artist='',push=true,expansion=''){if(push&&stateRef.current.mode!=='gallery'){rememberOrigin('gallery');pageEntries.current.gallery=true;}const previousUrl=location.href,previousState=history.state,retain=push&&stateRef.current.mode==='album'&&new URL(previousUrl).searchParams.get('mobile_page')==='album';setPersonId('me');setCountFriend('');setMode('gallery');native().layout('gallery');if(retain)history.replaceState(previousState,'',previousUrl);if(push)route('gallery','me',{artist,mock_expanded:expansion});native().loadGallery(new URLSearchParams({surface:'albums',...(artist?{artist}:{})}).toString(),{source:'library'});}
  function select(album,selection={}){const value=byAlbum(album.id||album.key);if(!value)return;setAlbumId(value.id);setSelectedArtist(value.mock.artist_id);setSelectedTrack(selection.trackId||null);setSelectedListen(selection.listenId||null);setPanelsVisible(true);setCountFriend('');if(['home','profile','recent'].includes(stateRef.current.mode))selectionByKind.current[stateRef.current.kind]={albumId:value.id,selectedArtist:value.mock.artist_id,selectedTrack:selection.trackId||null,selectedListen:selection.listenId||null};if(!(stateRef.current.mode==='playlist'&&stateRef.current.playlistExpanded)&&(innerWidth>900||stateRef.current.mode==='playlist')&&['home','profile','playlist'].includes(stateRef.current.mode)){native().openAlbum(value,'embedded');native().showArtist(byArtist(value.mock.artist_id));}}
  function clearRecentAlbumSelection(){
    const m=stateRef.current;
    if(!['home','profile','recent'].includes(m.mode)||m.kind!=='albums'||!m.albumId||selectionByKind.current.albums?.albumId!==m.albumId||native().getPlacement()==='modal')return;
    const cleared={albumId:null,selectedArtist:null,selectedTrack:null,selectedListen:null};
    selectionByKind.current={...selectionByKind.current,albums:cleared};
    setAlbumId(null);setSelectedArtist(null);setSelectedTrack(null);setSelectedListen(null);setCountFriend('');
    // Keep the opened modules, showing their empty prompts. Save only this
    // entry; older Back/Forward snapshots and other listening kinds stay intact.
    stateRef.current={...m,...cleared,countFriend:''};
    saveRecentSelection();native().clearRecentAlbumDetails();
  }
  function selectArtist(value){setSelectedArtist(value.id);setAlbumId(null);setSelectedTrack(null);setSelectedListen(null);setPanelsVisible(true);setCountFriend('');selectionByKind.current.artists={albumId:null,selectedArtist:value.id,selectedTrack:null,selectedListen:null};}
  function openPlaylist(id=LOVED_PLAYLIST_ID,trackId=null){setCountFriend('');if(stateRef.current.mode!=='playlist'){setPlaylistExpanded(false);rememberOrigin('playlist');pageEntries.current.playlist=true;setAlbumId(null);setSelectedArtist(null);setPanelsVisible(false);route('playlist','me',{mock_playlist:id});}setPersonId('me');setPlaylistId(id);setMode('playlist');setSelectedTrack(trackId);setSelectedListen(null);setRevealTrack(trackId);setSidebarMode('playlists');native().showSidebar('playlists',false);pendingPlaylistFocus.current=native().closeSidebar()===true;}
  function acceptQueue(next,context={}){queueRef.current=next;setQueue(next);if(context.reason==='mode'||!next||next.ended||next.transition==='stop')return;const row=playlistTrack(next.currentTrackId);if(row)native().selectPreviewTrack(row.track,row.album,{queueManaged:true});}
  function queueStep(reason='next',direction=1){const current=queueRef.current;if(!current)return false;acceptQueue(advanceQueue(current,{reason,direction}),{reason});return true;}
  function setAlbumRepeatMode(value){if(!selectedAlbum)return;setAlbumRepeat(previous=>({...previous,[selectedAlbum.id]:value}));const current=queueRef.current;if(current?.source==='album'&&current.albumId===selectedAlbum.id)acceptQueue(setQueueMode(current,{repeat:value}),{reason:'mode'});}
  useEffect(()=>bindTrackLoveControls({root:document,controller:playlistController}),[]);
  useLayoutEffect(()=>native().showSidebar(sidebarMode,false),[sidebarMode]);
  useEffect(()=>{const binding=bindSidebarInactivity({panel:document.getElementById('artist-tree-expanded'),main:document.getElementById('shell-main-surface'),isEnabled:()=>native().canAutoCloseSidebar(),onClose:()=>native().collapseSidebar()});return()=>binding.dispose();},[mode,sidebarMode,personId]);
  function saveRecentSelection(){const m=stateRef.current;if(['home','profile','recent'].includes(m.mode))recentEntrySelections.current.set(history.state?.albumHavenNavigationPosition,{...m,selections:{...selectionByKind.current}});}
  function saveArtistSelection(){const m=stateRef.current;if(m.mode==='artist-page')artistEntrySelections.current.set(artistEntryPosition.current,{artistId:m.selectedArtist,albumId:m.artistAlbumId,scroll:document.getElementById('mock-artist-page-scroll')?.scrollTop||0,artistInfoScroll:document.querySelector('#mock-artist-page .mock-artist-info-copy')?.scrollTop||0,discographyScroll:document.querySelector('#mock-artist-page .mock-artist-view__releases')?.scrollTop||0,familyScroll:document.querySelector('#mock-artist-page .mock-artist-view__family')?.scrollTop||0});}
  useEffect(()=>{const captureArtistScroll=event=>{if(event.target?.closest?.('#mock-artist-page'))saveArtistSelection();};window.addEventListener('scroll',captureArtistScroll,true);return()=>window.removeEventListener('scroll',captureArtistScroll,true);},[]);
  // Presentation snapshots use the native library entry position. They are not
  // a second Back stack: the existing owner performs every history traversal.
  function savePlaylistEntry(){
    const m=stateRef.current;if(m.mode!=='playlist')return;
    const previous=playlistEntryStates.current.get(playlistEntryPosition.current);
    const focused=document.activeElement,focusMatch=returnFocusMatch(m,focused,'playlist');
    playlistEntryStates.current.set(playlistEntryPosition.current,{...m,
      parent:previous?previous.parent:pageParents.current.playlist,owned:previous?previous.owned:!!pageEntries.current.playlist,
      scroll:document.getElementById('mock-playlist-scroll')?.scrollTop||0,
      focus:focusMatch?focused:previous?.focus,focusMatch:focusMatch||previous?.focusMatch});
  }
  function restorePlaylistEntry(url){
    const saved=playlistEntryStates.current.get(history.state?.albumHavenNavigationPosition);
    setPlaylistId(url.searchParams.get('mock_playlist')||LOVED_PLAYLIST_ID);
    setPlaylistExpanded(url.searchParams.get('mock_expanded')==='playlist');
    setRevealTrack(saved?.revealTrack||null);
    if(saved){
      setAlbumId(saved.albumId||null);setSelectedArtist(saved.selectedArtist||null);
      setSelectedTrack(saved.selectedTrack||null);setSelectedListen(saved.selectedListen||null);setPanelsVisible(!!saved.panelsVisible);
      if(saved.parent)pageParents.current.playlist=saved.parent;else delete pageParents.current.playlist;
      pageEntries.current.playlist=!!saved.owned;
      pendingScroll.current={id:'mock-playlist-scroll',amount:saved.scroll||0};
      pendingFocus.current={element:saved.focus,match:saved.focusMatch};
    }else{
      setAlbumId(null);setSelectedArtist(null);setSelectedTrack(null);setSelectedListen(null);setPanelsVisible(false);
      // A direct/reloaded entry cannot borrow ownership from another Playlist.
      delete pageParents.current.playlist;pageEntries.current.playlist=false;
      pendingScroll.current={id:'mock-playlist-scroll',amount:0};pendingFocus.current=null;
    }
  }
  function expandPlaylist(){
    const m=stateRef.current;if(m.mode!=='playlist'||m.playlistExpanded)return;
    rememberOrigin('playlist');pageEntries.current.playlist=true;setPlaylistExpanded(true);
    route('playlist','me',{mock_playlist:m.playlistId,mock_expanded:'playlist'});
    pendingScroll.current={id:'mock-playlist-scroll',amount:pageParents.current.playlist.scroll||0};
  }
  function collapsePlaylist(){
    const m=stateRef.current;if(m.mode!=='playlist'||!m.playlistExpanded)return;
    const parent=pageParents.current.playlist;
    if(pageEntries.current.playlist&&parent?.mode==='playlist'&&!parent.playlistExpanded&&parent.playlistId===m.playlistId){back();return;}
    // An expanded deep link has no unexpanded sibling entry. Collapse replaces
    // only its presentation; its Back keeps the ordinary safe Home fallback.
    savePlaylistEntry();const url=new URL(location.href);url.searchParams.delete('mock_expanded');
    history.replaceState({...history.state,mockMode:'playlist'},'',url);setPlaylistExpanded(false);setExpandedModule('');pendingFocus.current={match:{kind:'playlist-expand'}};
  }
  function rememberOrigin(target){saveRecentSelection();saveArtistSelection();savePlaylistEntry();const m=stateRef.current;const scrollId=m.mode==='playlist'?'mock-playlist-scroll':m.mode==='artist-page'?'mock-artist-page-scroll':m.mode==='compare'?'mock-single-custom':m.mode==='gallery'?'albums-scroll':innerWidth<=900&&['home','profile'].includes(m.mode)?'mobile-home-recent':'mock-recent-body';pageOrigin.current={...m,selections:{...selectionByKind.current},url:location.href,navigationPosition:history.state?.albumHavenNavigationPosition,focus:innerWidth>900||['compare','artist-page','gallery','playlist'].includes(target)?document.activeElement:null,focusMatch:returnFocusMatch(m,document.activeElement,target),scrollId,scroll:document.getElementById(scrollId)?.scrollTop||0};pageParents.current[target]=pageOrigin.current;}
  function showAlbumModal(album,{restore=false}={}){const value=byAlbum(album?.id||album?.key);if(!value)return;if(!stateRef.current.openAlbumModals){if(!restore){page(value);return;}const url=new URL(location.href);url.searchParams.delete('mock_modal_album');const parent=modalEntryOrigins.current.get(history.state?.albumHavenNavigationPosition)||{...stateRef.current,mode:url.searchParams.get('mock')||'gallery',url:url.href,navigationPosition:history.state?.mockModalParentPosition,albumId:null,selectedArtist:null,selectedTrack:null,selectedListen:null,panelsVisible:false,scrollId:'albums-scroll',scroll:0};const owned=!!history.state?.mockModalOwned;url.searchParams.set('mock','album');url.searchParams.set('album',value.id);history.replaceState({...history.state,mockMode:'album',mockModalAlbum:null},'',url);pageParents.current.album=parent;entryOrigins.current.set(history.state?.albumHavenNavigationPosition,parent);pageEntries.current.album=owned;pageEntry.current=owned;setAlbumId(value.id);setMode('album');setCountFriend('');native().openAlbum(value,'full');return;}if(native().getPlacement()!=='modal'){const url=new URL(location.href);url.searchParams.delete('mock_modal_album');if(!restore){rememberOrigin('album-modal');modalOrigin.current=pageParents.current['album-modal'];}else modalOrigin.current=modalEntryOrigins.current.get(history.state?.albumHavenNavigationPosition)||{...stateRef.current,mode:url.searchParams.get('mock')||'gallery',url:url.href,navigationPosition:history.state?.mockModalParentPosition,albumId:null,selectedArtist:null,selectedTrack:null,selectedListen:null,panelsVisible:false};}setAlbumId(value.id);setCountFriend('');closingAlbumModal.current=false;
    if(!restore){const url=new URL(location.href);url.searchParams.set('mock_modal_album',value.id);window.AlbumHavenSettingsNavigation.instance.pushLibraryHistory(url.href,{...history.state,mockModalAlbum:value.id,mockModalOwned:true,mockModalParentPosition:history.state?.albumHavenNavigationPosition});modalEntryOrigins.current.set(history.state?.albumHavenNavigationPosition,modalOrigin.current);}
    native().openAlbum(value,'modal');}
  function modalClosed(){setCountFriend('');const url=new URL(location.href);if(url.searchParams.has('mock_modal_album')&&!closingAlbumModal.current){if(history.state?.mockModalOwned){closingAlbumModal.current=true;history.back();return;}url.searchParams.delete('mock_modal_album');const {mockModalAlbum,mockModalOwned,mockModalParentPosition,...snapshot}=history.state||{};history.replaceState(snapshot,'',url);}const old=modalOrigin.current;modalOrigin.current=null;if(old){if(old.selections)selectionByKind.current={...old.selections};setArtistAlbumId(old.artistAlbumId||null);setAlbumId(old.albumId||null);setSelectedArtist(old.selectedArtist||null);setSelectedTrack(old.selectedTrack||null);setSelectedListen(old.selectedListen||null);setPanelsVisible(!!old.panelsVisible);}native().layout(old?.mode||stateRef.current.mode,old?.kind||stateRef.current.kind);}
  function page(album,options={}){invalidatePanelTransition();const value=byAlbum(album.id||album.key);if(!value)return;if(stateRef.current.mode!=='album')rememberOrigin('album');pageEntries.current.album=true;const expanded=options.expandedModule===true;setExpandedModule(expanded?'album':'');if(value.id!==stateRef.current.albumId)setCountFriend('');setAlbumId(value.id);setMode('album');pageEntry.current=true;if(innerWidth>900){const sameAlbum=stateRef.current.mode==='album'&&stateRef.current.albumId===value.id;if(!sameAlbum||stateRef.current.expandedModule!==(expanded?'album':''))route('album',personId,{album:value.id,mock_expanded:expanded?'album':''},sameAlbum);}native().openAlbum(value,'full',{...options,expandedModule:expanded});entryOrigins.current.set(history.state?.albumHavenNavigationPosition,pageParents.current.album);}
  function selectArtistAlbum(album){setCountFriend('');setArtistAlbumId(album.id);setAlbumId(album.id);native().openAlbum(album,'embedded');}
  function closeArtistAlbum(){
    const m=stateRef.current;if(m.mode!=='artist-page'||!m.artistAlbumId||native().getPlacement()==='modal')return;
    invalidatePanelTransition();
    pendingFocus.current={match:{kind:'discography',artist:m.selectedArtist,key:m.artistAlbumId,control:'artwork'}};
    native().clearArtistAlbumDetails();setArtistAlbumId(null);setAlbumId(null);setCountFriend('');
  }
  function artistPage(artist){if(!artist)return;setCountFriend('');rememberOrigin('artist-page');setArtistAlbumId(null);pageEntries.current['artist-page']=true;setSelectedArtist(artist.id);setMode('artist-page');route('artist-page',personId,{artist_info:artist.id});native().loadGallery(new URLSearchParams({surface:'albums',artist:artist.name}).toString(),{source:'library'});}
  function openArtist(name){const artist=byArtist(name);if(artist)artistPage(artist);else gallery(name);}
  function expandArtist(){setCountFriend('');rememberOrigin('artist');pageEntries.current.artist=true;setMode('artist');pageEntry.current=true;route('artist',personId,{artist_info:selectedArtist,mock_expanded:'artist'});}

  function back(){if(returning.current)return;invalidatePanelTransition();saveArtistSelection();savePlaylistEntry();returning.current=true;const parent=pageParents.current[stateRef.current.mode]||{mode:'home',personId:'me',kind:'albums',period:'week',url:'/?mock=home',scroll:0};if(pageEntries.current[stateRef.current.mode]){pendingScroll.current={id:parent.scrollId||'mock-recent-body',amount:parent.scroll||0};history.back();}else{const old=parent;setPersonId(old.personId);setKind(old.kind);setPeriod(old.period);setMode(old.mode);if(old.mode==='compare'){setSort(old.sort||'combined');setAscending(!!old.ascending);setComparisonView(old.comparisonView||'list');setCommonOnly(old.commonOnly!==false);}if(stateRef.current.mode==='playlist'){setAlbumId(old.albumId||null);setSelectedArtist(old.selectedArtist||null);setSelectedTrack(old.selectedTrack||null);setSelectedListen(old.selectedListen||null);setPanelsVisible(!!old.panelsVisible);setPlaylistExpanded(false);setRevealTrack(null);pendingScroll.current={id:old.scrollId||'mock-recent-body',amount:old.scroll||0};}history.replaceState(history.state,'',old.url);setExpandedModule(old.expandedModule||'');native().layout(old.mode,old.kind);}requestAnimationFrame(()=>returning.current=false);}
  function nativeAlbumReturned(){
    invalidatePanelTransition();const old=pageParents.current.album||{mode:'home',personId:'me',kind:'albums',period:'week',url:'/?mock=home',scroll:0};pageEntry.current=false;pageEntries.current.album=false;
    pendingScroll.current={id:old.scrollId||'mobile-home-recent',amount:old.scroll||0};
    if(old.selections)selectionByKind.current={...old.selections};setPlaylistExpanded(old.mode==='playlist'&&!!old.playlistExpanded);setRevealTrack(old.revealTrack||null);setArtistAlbumId(old.artistAlbumId||null);setPersonId(old.personId);setKind(old.kind);setPeriod(old.period);setAlbumId(old.albumId||null);setSelectedArtist(old.selectedArtist||null);setSelectedTrack(old.selectedTrack||null);setSelectedListen(old.selectedListen||null);setPanelsVisible(!!old.panelsVisible);setCountFriend('');setMode(old.mode);if(old.mode==='compare'){setSort(old.sort||'combined');setAscending(!!old.ascending);setComparisonView(old.comparisonView||'list');setCommonOnly(old.commonOnly!==false);}
    history.replaceState({...history.state,mockMode:old.mode},'',old.url);setExpandedModule(old.expandedModule||'');native().layout(old.mode,old.kind);
  }
  function switchKind(value){if(value!==stateRef.current.kind&&mode!=='compare'){if(stateRef.current.kind!=='albums'||selectionByKind.current.albums?.albumId===albumId)selectionByKind.current[stateRef.current.kind]={albumId,selectedArtist,selectedTrack,selectedListen};const saved=selectionByKind.current[value]||{};setAlbumId(saved.albumId||null);setSelectedArtist(saved.selectedArtist||null);setSelectedTrack(saved.selectedTrack||null);setSelectedListen(saved.selectedListen||null);setCountFriend('');}setKind(value);if(['home','profile','recent','compare'].includes(mode))route(mode,personId,{mock_kind:value},true);}
  function switchPeriod(value){setPeriod(value);if(['home','profile','recent','compare'].includes(mode))route(mode,personId,{mock_period:value},true);}
  function openComparison(){setCountFriend('');rememberOrigin('compare');pageEntries.current.compare=true;setMode('compare');route('compare');}
  function expandRecent(){setCountFriend('');rememberOrigin('recent');pageEntries.current.recent=true;setMode('recent');route('recent',personId,{mock_expanded:'recent'});}
  function relation(id,action){setRelations(previous=>({...previous,[id]:({request:'outgoing',accept:'accepted',decline:'none',cancel:'none',unfriend:'none'})[action]}));if(action==='unfriend')setExceptions(previous=>[...new Set([...previous,id])]);if(action==='accept')setExceptions(previous=>previous.filter(value=>value!==id));setCountFriend('');native().toast(({request:'Request sent in this preview',accept:'You are now friends in this preview',decline:'Request declined',cancel:'Request cancelled',unfriend:'Unfriended in this preview'})[action]);}
  async function unfriend(id){if(await native().confirm({title:'Unfriend',message:'Their shared listening activity will no longer be visible to you.',acceptLabel:'Unfriend',danger:true}))relation(id,'unfriend');}
  function closeDialog(){native().closeDialog();}
  function showDialog(type,who=null,anchor=null){
    if(type==='profile')setDraft({...profile});setDialog({type,who});
    const modal=document.getElementById('app-form-modal');modal.dataset.mockDialog=type;
    native().dialog({parentSurface:type==='request'?'#cover-lookup-drawer':!document.getElementById('utility-modal').hidden&&['artistSettings','albumSettings'].includes(type)?'#utility-modal':null,title:({friends:'Friends',people:'People on your server',request:'Friend request',profile:profile.name,albumSettings:'Play statistics',artistSettings:'Artist navigation'})[type],mode:type==='profile'?undefined:'reading',anchor:null,submitLabel:'Save profile',cancelLabel:'Cancel',contentHtml:'<div data-mock-dialog-content></div>',
      onSubmit:()=>{const value=draftRef.current;if(!value.name.trim())throw new Error('Enter a name');setProfile({...value,name:value.name.trim()});native().toast('Profile changed in this preview only');},
      onMount:content=>{if(type==='profile')document.getElementById('app-form-title').replaceChildren();setDialogTarget(content.querySelector('[data-mock-dialog-content]'));},onClose:()=>{setDialogTarget(null);setDialog(null);delete modal.dataset.mockDialog;}});
  }
  function relationship(p){const status=effective(p.id);if(status==='accepted')return <Button onClick={()=>unfriend(p.id)}>Unfriend</Button>;if(status==='incoming')return <><Button primary onClick={()=>relation(p.id,'accept')}>Accept</Button><Button onClick={()=>relation(p.id,'decline')}>Decline</Button></>;if(status==='outgoing')return <Button onClick={()=>relation(p.id,'cancel')}>Cancel request</Button>;return <Button primary onClick={()=>relation(p.id,'request')}>Add friend</Button>;}
  useLayoutEffect(()=>{native().setCallbacks({
    recentAlbumCleared:clearRecentAlbumSelection,trackSelected:(trackId,albumId,listenId)=>select(byAlbum(albumId),{trackId,listenId}),kindChanged:switchKind,artistSettings:()=>showDialog('artistSettings'),albumStatistics:()=>showDialog('albumSettings'),trackLoveControl:trackId=>loveControl(trackId,playlistController.getLove(trackId)),trackPopularity,albumPopularity,artistPopularity,queueStep,playerArtworkLabel:()=>queueRef.current?.source==='playlist'?'Open current track in Loved and Obsessed':'Open album details',playerArtist:trackId=>{const row=playlistTrack(trackId);if(row)openArtist(row.artist);},playerAlbum:trackId=>{const row=playlistTrack(trackId);if(row)page(row.album);},playerArtwork:()=>{const origin=queueOrigin(queueRef.current);if(origin?.source==='playlist'){openPlaylist(origin.playlistId,origin.trackId);return true;}return false;},queueSource:(trackId,albumId)=>{const album=byAlbum(albumId);if(album){const next=createQueue({albumId:album.id,trackIds:album.tracks.map(track=>track.path),currentTrackId:trackId,repeat:albumRepeat[album.id]||'off'});queueRef.current=next;setQueue(next);}else{const row=playlistTrack(trackId),next=Object.freeze({...createQueue({trackIds:[trackId],currentTrackId:trackId,repeat:'off'}),source:'single',playlistId:null,albumId:row?.album.id||null});queueRef.current=next;setQueue(next);}},sidebarArtists:()=>setSidebarMode('artists'),albumOriginPosition:()=>pageParents.current.album?.navigationPosition,home:()=>home(),artist:name=>openArtist(name),artistPage:name=>artistPage(byArtist(name)),artistTree:name=>{if(stateRef.current.artistDestination==='page'){artistPage(byArtist(name));return true;}return false;},albumTitle:album=>showAlbumModal(album),albumPage:(album,options)=>page(album,options),
    album:(album,context)=>context.recent&&innerWidth>900?select(album):(context.phoneHome?page(album):showAlbumModal(album)),
    beforeNativeGallery:()=>{invalidatePanelTransition();setExpandedModule('');setSidebarMode('artists');window.MockViewContext={source:'library'};setPersonId('me');setMode('gallery');setCountFriend('');native().layout('gallery');},
    albumClosed:back,albumReturned:nativeAlbumReturned,modalClosed,
    albumRendered:album=>{if(!['home','profile','recent'].includes(stateRef.current.mode)&&stateRef.current.albumId&&album.id&&album.id!==stateRef.current.albumId)setAlbumId(album.id);decorateCounts();},galleryRendered:()=>{const next=native().galleryConfig();setGalleryConfig(previous=>JSON.stringify(previous)===JSON.stringify(next)?previous:next);},viewportChanged:()=>setViewport(innerWidth),
  });});
  useLayoutEffect(()=>{
    if(!readable&&['recent','compare','album','artist','artist-page'].includes(mode)){setMode('profile');setCountFriend('');return;}
    native().layout(mode,kind);native().setRecentContext({person:person.name,personId,period:windowPeriod.label,kind});
    const playlistSingle=mode==='playlist'&&playlistExpanded;
    native().setSelection(readable&&panelsVisible&&!playlistSingle);
    document.getElementById('mock-album-panel').hidden=playlistSingle||!readable||(mode==='artist-page'?!artistAlbumId:!panelsVisible);document.getElementById('mock-artist-panel').hidden=playlistSingle||!readable||!panelsVisible;
    document.getElementById('mock-album-placeholder').hidden=!!embeddedAlbum;document.getElementById('mock-artist-placeholder').hidden=!!selectedArtist;document.getElementById('mock-album-native-actions').hidden=!embeddedAlbum;
    if(['home','profile','recent'].includes(mode)&&kind==='albums'&&!embeddedAlbum&&native().getPlacement()!=='modal'&&native().getAlbum())native().clearRecentAlbumDetails();
    if(['home','profile','playlist'].includes(mode)&&(viewport>900||mode==='playlist')){if(!embeddedAlbum&&native().getPlacement()!=='modal')document.getElementById('track-modal').hidden=true;if(!selectedArtist)document.querySelector('[data-artist-info-overlay]').hidden=true;}
    if(!playlistSingle&&(viewport>900||mode==='playlist')&&['home','profile','playlist'].includes(mode)&&readable&&native().getPlacement()!=='modal'){if(embeddedAlbum&&(native().getAlbum()?.id!==albumId||document.getElementById('track-modal').hidden||native().getPlacement()!=='embedded'))native().openAlbum(embeddedAlbum,'embedded');if(selectedArtist)native().showArtist(byArtist(selectedArtist));}
    if(mode==='album'&&(native().getAlbum()?.id!==albumId||document.getElementById('track-modal').hidden))native().openAlbum(selectedAlbum,'full');
    if(mode==='artist')native().showArtist(byArtist(selectedArtist));if(mode==='artist-page'){const slot=document.querySelector('[data-mock-artist-album-slot]');if(slot)slot.hidden=!artistAlbumId;if(artistAlbumId&&native().getPlacement()!=='modal'&&(native().getAlbum()?.id!==artistAlbumId||document.getElementById('track-modal').hidden||native().getPlacement()!=='embedded'))native().openAlbum(byAlbum(artistAlbumId),'embedded');}
    if(mode==='artist-page'){artistEntryPosition.current=history.state?.albumHavenNavigationPosition;window.dispatchEvent(new window.Event('mock-artist-ready'));}saveRecentSelection();saveArtistSelection();if(mode==='playlist')playlistEntryPosition.current=history.state?.albumHavenNavigationPosition;applyScrollReturn();savePlaylistEntry();native().completeNavigationPresentation();if(mode==='playlist'&&pendingPlaylistFocus.current){pendingPlaylistFocus.current=false;(node('mock-gallery-back').querySelector('button')||node('mock-playlist-expand').querySelector('button'))?.focus({preventScroll:true});}else if(mode!=='playlist')pendingPlaylistFocus.current=false;
  },[mode,personId,kind,readable,viewport,selectedArtist,albumId,panelsVisible,artistAlbumId,playlistExpanded,playlistId,selectedTrack,revealTrack]);
  useLayoutEffect(()=>{native().setRecentContext({person:person.name,personId,period:windowPeriod.label,kind});document.getElementById('shell-main-surface').dataset.mockKind=kind;},[person.name,personId,period,kind,mode]);
  useEffect(()=>{if(countFriend&&!eligible.some(p=>p.id===countFriend))setCountFriend('');decorateCounts();},[counts,countFriend,albumId,relations,auto,exceptions]);
  useEffect(()=>{if(first.searchParams.get('mock_proposal')==='panel-color'){native().previewPalette(first.searchParams.get('proposal_palette'));select(albums[0]);}if(requested==='artist-page'){const artist=byArtist(first.searchParams.get('artist_info'));if(artist)native().loadGallery(new URLSearchParams({surface:'albums',artist:artist.name}).toString(),{source:'library'});}if(requested==='playlist')setSidebarMode('playlists');if(first.searchParams.has('mock_modal_album'))showAlbumModal(byAlbum(first.searchParams.get('mock_modal_album')),{restore:true});},[]);
  function decorateCounts(){
    const m=stateRef.current,album=byAlbum(native().getAlbum()?.id)||byAlbum(m.albumId);if(!album)return;
    const selected=m.counts&&m.countFriend&&people.some(p=>p.id===m.countFriend&&effective(p.id)==='accepted'&&(album.mock.counts[p.id]||0)>0)?m.countFriend:'me';
    for(const table of document.querySelectorAll('#track-modal .compact-data-table')){
      if(!table.dataset.mockOriginalColumns)table.dataset.mockOriginalColumns=table.style.getPropertyValue('--cdt-columns');
      const signature=[album.id,selected,m.counts].join('|');if(table.dataset.mockCountSignature===signature)continue;table.dataset.mockCountSignature=signature;
      const restoreFocus=table.contains(document.activeElement)&&document.activeElement?.matches('[data-mock-plays-owner]');
      table.querySelectorAll('[data-mock-count],[data-mock-stat]').forEach(cell=>cell.remove());
      table.dataset.mockFriendStatistics=String(selected!=='me');table.dataset.mockStatisticsV007='true';table.dataset.cdtOverflow='local';
      table.previousElementSibling?.matches('.mock-stats-scroll-note')&&table.previousElementSibling.remove();
      table.style.setProperty('--cdt-columns',table.dataset.mockOriginalColumns.replace(/(minmax\(54px,\s*auto\))$/,`32px minmax(92px,auto) minmax(108px,auto) $1`));
      for(const row of table.querySelectorAll('[role="row"]')){
        const duration=row.querySelector('[data-cdt-column="duration"]');if(!duration)continue;
        const header=!!row.querySelector('[role="columnheader"]'),index=Math.max(0,Number((row.dataset.trackRowPath||'').split(':').at(-1))-1);
        const total=album.mock.counts[selected],cell=document.createElement('div');cell.dataset.mockCount=selected;cell.dataset.mockStat='personal';cell.className='mock-count-cell';cell.setAttribute('role',header?'columnheader':'cell');
        const name=selected==='me'?'Your':people.find(p=>p.id===selected)?.name.split(' ')[0]||'Friend';
        const label=selected==='me'?'Plays':name+' · Plays';
        if(header){cell.id=table.id+'-mock-plays';cell.innerHTML=window.ButtonComponent.renderButton({label,variant:'secondary',size:'small',className:'mock-plays-heading',attributes:{'data-mock-plays-owner':'true','aria-label':`Choose whose plays: ${name}`,title:`${name} plays`}});}
        else{cell.setAttribute('aria-labelledby',table.id+'-mock-plays');cell.textContent=Number.isFinite(total)?String(Math.floor(total/album.tracks.length)+(index<total%album.tracks.length?1:0)):'—';}
        cell.title=`${name} plays · fictional lifetime aggregate`;
        const love=document.createElement('div');love.dataset.mockStat='love';love.className='mock-track-love-cell';love.setAttribute('role',header?'columnheader':'cell');if(header){love.id=table.id+'-love';love.textContent='Love';}else{love.innerHTML=loveControl(row.dataset.trackRowPath,playlistController.getLove(row.dataset.trackRowPath));love.setAttribute('aria-labelledby',table.id+'-love');}duration.before(love,cell);
        const popularity=document.createElement('div');popularity.dataset.mockStat='popularity';popularity.className='mock-count-cell';popularity.setAttribute('role',header?'columnheader':'cell');popularity.title='Fictional Last.fm global plays';if(header){popularity.id=table.id+'-popularity';popularity.textContent='Popularity';}else{const value=trackPopularity(row.dataset.trackRowPath);popularity.textContent=value==null?'—':value.toLocaleString('en-US');popularity.setAttribute('aria-labelledby',table.id+'-popularity');}duration.before(popularity);
      }
      if(restoreFocus)table.querySelector('[data-mock-plays-owner]')?.focus({preventScroll:true});
    }
  }
  useEffect(()=>{
    const pop=()=>{if(native().lightboxHistoryHandled())return;savePlaylistEntry();panelTransition(()=>{const wasAlbum=['album','artist','artist-page'].includes(stateRef.current.mode),wasComparison=stateRef.current.mode==='compare',wasCustom=['artist-page','playlist','gallery'].includes(stateRef.current.mode),parent=pageParents.current[stateRef.current.mode]||pageOrigin.current;if(wasComparison||wasCustom||wasAlbum&&innerWidth>900)pendingFocus.current={element:parent.focus,match:parent.focusMatch};if(stateRef.current.mode==='recent')pendingFocus.current={element:parent.focus,match:parent.focusMatch};if(wasAlbum||wasComparison||wasCustom||stateRef.current.mode==='recent')pendingScroll.current={id:parent.scrollId||'mock-recent-body',amount:parent.scroll||0};const restoreScroll=applyScrollReturn;const url=new URL(location.href);if(wasAlbum&&innerWidth<=900&&!pageEntry.current&&url.searchParams.get('mock')==='album'&&!url.searchParams.has('mobile_page')){url.search='?mock=home';history.replaceState(history.state,'',url);}const returningRecent=stateRef.current.mode==='recent'||url.href===parent.url;if(returningRecent&&parent){if(parent.selections)selectionByKind.current={...parent.selections};setArtistAlbumId(parent.artistAlbumId||null);setAlbumId(parent.albumId||null);setSelectedArtist(parent.selectedArtist||null);setSelectedTrack(parent.selectedTrack||null);setSelectedListen(parent.selectedListen||null);setPanelsVisible(!!parent.panelsVisible);}const next=url.searchParams.get('mobile_page')==='album'?'album':url.searchParams.get('mock')||(url.searchParams.get('surface')==='albums'||url.searchParams.has('artist')?'gallery':'home');setPersonId(url.searchParams.get('mock_person')||'me');if(url.searchParams.has('mock_playlist'))setPlaylistId(url.searchParams.get('mock_playlist'));setCountFriend('');if(kinds.includes(url.searchParams.get('mock_kind')))setKind(url.searchParams.get('mock_kind'));if(periods.some(p=>p.id===url.searchParams.get('mock_period')))setPeriod(url.searchParams.get('mock_period'));const entryOrigin=entryOrigins.current.get(history.state?.albumHavenNavigationPosition);if(entryOrigin){pageParents.current[next]=entryOrigin;pageEntries.current[next]=true;}else if(['recent','activity','artist','album','gallery'].includes(next)){delete pageParents.current[next];pageEntries.current[next]=false;}const recentSaved=recentEntrySelections.current.get(history.state?.albumHavenNavigationPosition);if(['home','profile','recent','activity'].includes(next)&&recentSaved){selectionByKind.current={...recentSaved.selections};setAlbumId(recentSaved.albumId||null);setSelectedArtist(recentSaved.selectedArtist||null);setSelectedTrack(recentSaved.selectedTrack||null);setSelectedListen(recentSaved.selectedListen||null);setPanelsVisible(!!recentSaved.panelsVisible);}setExpandedModule(url.searchParams.get('mock_expanded')||'');setMode(next==='activity'?'recent':next);if(next==='compare'&&parent.mode==='compare'){setSort(parent.sort||'combined');setAscending(!!parent.ascending);setComparisonView(parent.comparisonView||'list');setCommonOnly(parent.commonOnly!==false);}if(next==='playlist'){restorePlaylistEntry(url);setSidebarMode('playlists');}if(next==='artist'||next==='artist-page'){const artistId=byArtist(url.searchParams.get('artist_info'))?.id||'north';setSelectedArtist(artistId);if(next==='artist-page'){const saved=artistEntrySelections.current.get(history.state?.albumHavenNavigationPosition);const selected=saved?.artistId===artistId?saved.albumId:null;setArtistAlbumId(selected||null);setAlbumId(selected||null);if(saved?.artistId===artistId)pendingScroll.current={id:'mock-artist-page-scroll',amount:saved.scroll||0,artistInfoAmount:saved.artistInfoScroll||0,artistDiscographyAmount:saved.discographyScroll||0,artistFamilyAmount:saved.familyScroll||0};}}if(next==='album'){const album=byAlbum(url.searchParams.get('album')||url.searchParams.get('mobile_album'));if(album){setAlbumId(album.id);native().openAlbum(album,'full');}}else if(next==='artist-page'){const artist=byArtist(url.searchParams.get('artist_info'));if(artist)native().loadGallery(new URLSearchParams({surface:'albums',artist:artist.name}).toString(),{source:'library'}).then(()=>requestAnimationFrame(restoreScroll));}else if(next==='gallery')native().loadGallery(url.searchParams,{source:'library'}).then(()=>requestAnimationFrame(restoreScroll));else requestAnimationFrame(restoreScroll);const modalId=url.searchParams.get('mock_modal_album');if(modalId)showAlbumModal(byAlbum(modalId),{restore:true});else if(native().getPlacement()==='modal'){closingAlbumModal.current=true;native().closeAlbum();modalClosed();}else if(closingAlbumModal.current){modalClosed();}closingAlbumModal.current=false;},{atomic:new URL(location.href).searchParams.get('mock')==='playlist'});};
    window.addEventListener('popstate',pop);return()=>window.removeEventListener('popstate',pop);
  },[]);
  useEffect(()=>{
    const click=event=>{const plays=event.target.closest('[data-mock-plays-owner]');if(plays){const m=stateRef.current,album=byAlbum(m.albumId);native().choiceDropdown(plays,{formats:[{value:'',label:'Your plays'},...(m.counts?people.filter(p=>p.id!=='me'&&effective(p.id)==='accepted'&&(album?.mock.counts[p.id]||0)>0).map(p=>({value:p.id,label:p.name+"'s plays"})):[])],selected:m.countFriend,label:'Whose plays',onSelect:value=>setCountFriend(value)});return;}const artist=event.target.closest('[data-mock-artist-select]');if(artist){const value=byArtist(artist.dataset.mockArtistSelect);selectArtist(value);return;}const go=event.target.closest('[data-mock-go-artist]');if(go){openArtist(go.dataset.mockGoArtist);return;}const row=event.target.closest('#mock-recent-body [data-mock-track-album]');if(row&&!event.target.closest('button,a,input'))select(byAlbum(row.dataset.mockTrackAlbum));};
    document.addEventListener('click',click);return()=>document.removeEventListener('click',click);
  });
  useEffect(()=>{window.MockReviewHarness={setScenario,setAuto,navigation:()=>({mode:stateRef.current.mode,origin:{focus:pageOrigin.current.focus?.outerHTML,focusConnected:pageOrigin.current.focus?.isConnected,navigationPosition:pageOrigin.current.navigationPosition,mode:pageOrigin.current.mode,url:pageOrigin.current.url,scrollId:pageOrigin.current.scrollId,scroll:pageOrigin.current.scroll},pendingFocus:pendingFocus.current?.outerHTML,pending:pendingScroll.current,entry:pageEntry.current}),reset:()=>{setRelations(Object.fromEntries(people.map(p=>[p.id,p.relationship==='blocked'?'none':p.relationship])));setExceptions([]);setScenario('normal');setAuto(false);setCounts(false);setCountFriend('');home();}};return()=>delete window.MockReviewHarness;},[]);
  const totalListens=readable?activity(person.id,'albums',factor).reduce((total,row)=>total+row.count,0):null;
  const periodControl=<div className="mock-period-summary">{totalListens!==null&&mode!=='compare'&&<span className="mock-listens-summary">Listens · {totalListens.toLocaleString('en-US')}</span>}<Choice label="Period" density={['home','profile','recent'].includes(mode)?'slim':'normal'} value={period} options={periods.map(p=>({value:p.id,label:p.label}))} onChange={switchPeriod}/></div>;
  const playOwners=[{value:'',label:'Your plays'},...(counts?eligible.map(p=>({value:p.id,label:p.name+"'s plays"})):[])];
  const friendPicker=<Choice label="Whose plays" value={countFriend} options={playOwners} onChange={setCountFriend}/>;
  const title=mode==='compare'?`You & ${person.name}`:personId==='me'?`${profile.name.split(' ')[0]}'s Home`:person.name;
  let dialogBody=null;
  const peopleList=<div className="mock-people">{people.filter(p=>p.id!=='me').map(p=><div className="mock-person" key={p.id}><button className="mock-person-name mock-person-navigation" aria-label={`Open ${p.name}'s profile`} title={`Open ${p.name}'s profile`} onPointerDown={event=>selectPersonRow(event.currentTarget)} onKeyDown={event=>{if(event.key==='Enter'||event.key===' ')selectPersonRow(event.currentTarget);}} onClick={event=>selectPersonRow(event.currentTarget,()=>{closeDialog();home(p.id);})}><Avatar person={p}/><span><strong>{p.name}</strong><small>{effective(p.id)==='accepted'?'Friend':effective(p.id)}</small></span></button><div className="mock-person-actions">{relationship(p)}</div></div>)}</div>;
  const friendsBody=peopleList;
  if(dialog?.type==='friends'||dialog?.type==='people')dialogBody=peopleList;
  if(dialog?.type==='albumSettings')dialogBody=<div className="mock-settings"><label className="selection-accent-toggle mock-statistics-checkbox"><input type="checkbox" checked={counts} onChange={event=>{setCounts(event.target.checked);setCountFriend('');}}/><span>Show friends statistics</span></label>{friendPicker}{counts&&!eligible.length&&<p>No eligible friend has plays for this album.</p>}<p>Selected plays apply to this Album only and return to yours when it closes.</p><Choice label="Opening albums" value={openAlbumModals?'modal':'page'} options={[{value:'modal',label:'Open modal'},{value:'page',label:'Go to full Album page'}]} onChange={value=>setOpenAlbumModals(value==='modal')}/><Button onClick={()=>{closeDialog();native().openAlbumAppearance();}}>Album page layout</Button></div>;
  if(dialog?.type==='artistSettings')dialogBody=<div className="mock-settings"><p>When clicked on an artist</p><Choice label="Artist destination" value={artistDestination} options={[{value:'page',label:"Go to Artist page"},{value:'gallery',label:"Go to Artist's Gallery"}]} onChange={setArtistDestination}/></div>;
  if(dialog?.type==='profile')dialogBody=<ProfileEditor draft={draft} onChange={setDraft}/>;
  if(dialog?.type==='request')dialogBody=<div className="mock-request"><Avatar person={dialog.who}/><h3>{dialog.who.name}</h3><p>{dialog.who.bio}</p><p>Share listening activity and compare tastes as friends.</p><div className="mock-dialog-actions"><Button onClick={()=>{const id=dialog.who.id;closeDialog();native().closeNotifications();home(id);}}>View profile</Button><Button primary onClick={()=>{relation(dialog.who.id,'accept');closeDialog();}}>Accept request</Button><Button onClick={()=>{relation(dialog.who.id,'decline');closeDialog();}}>Decline</Button></div></div>;
  return <>
    {createPortal(mode==='recent'?<Action key={'recent-'+expandedModule} label={expandedModule==='recent'?'Collapse':'Back'} icon={expandedModule==='recent'?'collapse':'back'} bare onClick={back}/>:mode==='playlist'&&(playlistExpanded||!panelsVisible)?<Action key={playlistExpanded?'playlist-collapse':'playlist-back'} label={playlistExpanded?'Collapse Playlist':'Back'} icon={playlistExpanded?'collapse':'back'} bare onClick={playlistExpanded?collapsePlaylist:back}/>:mode==='gallery'?<Action key={'gallery-'+expandedModule} label={expandedModule==='discography'?'Collapse Discography':'Back'} icon={expandedModule==='discography'?'collapse':'back'} bare onClick={back}/>:null,node('mock-gallery-back'))}
    {createPortal(<Action label="Playlists" icon="playlist" active={sidebarMode==='playlists'} onClick={()=>{setSidebarMode('playlists');native().showSidebar('playlists',true);}}/>,node('mock-playlist-rail-action'))}
    {createPortal(<Action label="Playlists" icon="playlist" variant="sidebar-mode" active={sidebarMode==='playlists'} visibleLabel={sidebarMode==='playlists'} onClick={()=>{setSidebarMode('playlists');native().showSidebar('playlists',false);}}/>,node('mock-sidebar-mode-actions'))}
    {createPortal(<PlaylistSidebar controller={playlistController} native={native} selectedPlaylistId={mode==='playlist'?playlistId:null} onOpenPlaylist={openPlaylist}/>,node('mock-playlist-sidebar'))}
    {createPortal(mode==='playlist'&&!playlistExpanded?<Action label="Expand Playlist" icon="expand" onClick={()=>panelTransition(expandPlaylist)}/>:null,node('mock-playlist-expand'))}
    {createPortal(mode==='playlist'?<PlaylistPanel controller={playlistController} native={native} playlistId={playlistId} selectedTrackId={selectedTrack} revealTrackId={revealTrack} queue={queue} actionsHost={node('mock-playlist-header-actions')} onSelectTrack={value=>select(value.album,{trackId:value.trackId})} onQueueChange={acceptQueue}/>:null,node('mock-playlist-content'))}
    {createPortal(selectedAlbum?<><Action label="Repeat album" icon="repeat" bare active={albumRepeat[selectedAlbum.id]==='all'} onClick={()=>setAlbumRepeatMode((albumRepeat[selectedAlbum.id]||'off')==='all'?'off':'all')}/><Action label="Repeat one song" icon="repeatOne" bare active={albumRepeat[selectedAlbum.id]==='one'} onClick={()=>setAlbumRepeatMode((albumRepeat[selectedAlbum.id]||'off')==='one'?'off':'one')}/></>:null,node('mock-album-playback-actions'))}
    <MobileHomeContent {...{person,readable,selectedArtist,selectedTrack,selectedListen,scenario,factor,period,galleryConfig,trackView,artistView}} selectedAlbumId={selectionByKind.current.albums?.albumId||null}/>
    {createPortal(periodControl,node('mock-mobile-period'))}
    {createPortal(mode==='friends'?<><div className="mock-full-header"><Action label="Back" icon="back" onClick={back}/><h1>Friends</h1></div>{friendsBody}</>:null,node('mock-friends-page'))}
    {createPortal(personId==='me'?<Action label="Edit profile" icon="edit" bare onClick={()=>showDialog('profile')}/>:effective(personId)==='accepted'?<span className="mock-friend-label">Friend</span>:null,node('mock-mobile-profile-actions'))}
    {createPortal(personId!=='me'&&readable?<Action label="Compare" icon="compare" onClick={openComparison}/>:null,node('mock-profile-actions'))}
    {createPortal(<Action label="Friends" icon="friends" onClick={()=>{if(viewport<=900){setCountFriend('');rememberOrigin('friends');pageEntries.current.friends=true;pageEntry.current=true;setMode('friends');route('friends');}else showDialog('friends');}}/>,node('mock-feature-actions'))}
    {createPortal(<>{mode==='compare'?<ComparisonIdentityHeader {...{profile,person,title,kind}} isFriend={effective(personId)==='accepted'} view={comparisonView} onView={setComparisonView} phone={viewport<=900} onBack={back} viewControl={<span id="mock-comparison-view-action"/>}/>:<header className="mock-profile-header"><Avatar person={person}/><div className="mock-profile-copy"><div className="mock-profile-name"><h1>{title}</h1>{personId==='me'&&<Action label="Edit profile" icon="edit" bare onClick={()=>showDialog('profile')}/>} {personId!=='me'&&effective(personId)==='accepted'&&<span className="mock-friend-label">Friend</span>}</div><p>{person.bio}</p></div><div id="mock-profile-actions-inline" className="mock-header-actions"/></header>}{mode==='compare'&&<div className="mock-comparison-filters"><Tabs id="mock-comparison-tabs" value={kind} onChange={switchKind}/>{periodControl}</div>}</>,node('mock-heading'))}
    {createPortal(<Tabs id="mock-recent-tabs-list" value={kind} onChange={switchKind}/>,node('mock-recent-tabs'))}
    {createPortal(periodControl,node('mock-recent-period'))}
    <RecentViewControl mode={mode} kind={kind} value={mode==='compare'?comparisonView:kind==='tracks'?trackView:artistView} onChange={mode==='compare'?setComparisonView:kind==='tracks'?setTrackView:setArtistView} phone={viewport<=900} scope={personId}/>
    {createPortal(['home','profile'].includes(mode)&&panelsVisible&&viewport>900?<Action label="Expand" icon="expand" disabled={!readable||scenario!=='normal'} onClick={()=>panelTransition(expandRecent)}/>:null,node('mock-recent-expand'))}
    {createPortal(<RecentBody {...{person,kind,factor,period,readable,scenario,selectedArtist,selectedTrack,selectedListen,trackView,artistView}} selectedAlbumId={selectionByKind.current.albums?.albumId||null} onRetry={()=>setScenario('normal')} galleryConfig={galleryConfig}/>,node('mock-recent-content'))}
    {createPortal(mode==='artist-page'&&artistAlbumId?<button type="button" className="mock-native-link" title={`Open album page: ${byAlbum(artistAlbumId).name}`} aria-label={`Open album page: ${byAlbum(artistAlbumId).name}`} onClick={()=>page(byAlbum(artistAlbumId))}>{byAlbum(artistAlbumId).name} • Album Info</button>:'Album details',node('mock-album-heading'))}
    {createPortal(mode==='artist-page'&&artistAlbumId?<Action label="Close Album info" icon="close" onClick={closeArtistAlbum}/>:null,node('mock-artist-album-close'))}
    {createPortal(<Action label="Expand Album details" icon="expand" disabled={!readable||!embeddedAlbum} onClick={()=>panelTransition(()=>page(embeddedAlbum,{expandedModule:true}))}/>,node('mock-album-expand'))}
    {createPortal(selectedArtist?<div className="mock-artist-name-link"><Button onClick={()=>artistPage(byArtist(selectedArtist))}>{byArtist(selectedArtist).name}</Button><small>{byArtist(selectedArtist).genre} · {byArtist(selectedArtist).formed}–present</small></div>:<strong>Artist info</strong>,node('mock-artist-heading'))}
    {createPortal(<Action label="Expand Artist info" icon="expand" disabled={!readable||!selectedArtist} onClick={()=>panelTransition(expandArtist)}/>,node('mock-artist-expand'))}
    {createPortal(null,node('mock-album-preferences'))}
    {createPortal(mode==='proposals'?<ReviewProposals Action={Action} Choice={Choice}/>:mode==='compare'&&readable?<Comparison Choice={Choice} {...{person,kind,factor,sort,ascending}} view={comparisonView} phone={viewport<=900} commonOnly={commonOnly} onCommonOnly={setCommonOnly} onSort={value=>{setSort(value);setAscending(false);}} onDirection={()=>setAscending(!ascending)}/>:null,node('mock-single-custom'))}
    {createPortal(<Action label="Play statistics" icon="statistics" bare onClick={()=>showDialog('albumSettings')}/>,node('mock-album-config-action'))}
    {createPortal(null,node('mock-album-settings-action'))}
    {createPortal(<div className="mock-full-header"><Action key={'artist-'+expandedModule} label={expandedModule==='artist'?'Collapse Artist info':'Back'} icon={expandedModule==='artist'?'collapse':'back'} bare onClick={back}/><NativeHtml html={selectedArtist?renderArtistIdentity(byArtist(selectedArtist),{fictionalDefaults:true,heading:'strong',suffix:'Artist Info'}):'Artist info'}/></div>,node('mock-full-artist-tools'))}

    {createPortal(mode==='artist-page'&&selectedArtist?<ArtistPage artist={byArtist(selectedArtist)} selectedAlbumId={artistAlbumId} onBack={back} onGallery={value=>gallery(value.name,true,'discography')} onAlbum={page} onSelectAlbum={selectArtistAlbum} onArtist={artistPage}/>:null,node('mock-artist-page'))}
    {createPortal(<section className="mock-notifications"><h4>Friend requests</h4>{people.filter(p=>effective(p.id)==='incoming').map(p=><button key={p.id} className="mock-person-name" onClick={()=>showDialog('request',p)}><Avatar person={p}/><span><strong>{p.name}</strong><small>Sent you a friend request</small></span></button>)}{!people.some(p=>effective(p.id)==='incoming')&&<p>No pending friend requests</p>}</section>,node('mock-request-notices'))}
    {dialogTarget&&createPortal(dialogBody,dialogTarget)}
  </>;
}
function mount(){native().setSocialOwners({trackLoveControl:trackId=>loveControl(trackId,playlistController.getLove(trackId)),trackPopularity,albumPopularity,artistPopularity,formatListenTime:stamp=>formatRecentListenTimestamp(stamp,{timeZone:native().preferredTimeZone()}),listenTimeZone:()=>resolveRecentTimeZone(native().preferredTimeZone())});const host=document.createElement('div');host.id='mock-react-root';document.body.append(host);createRoot(host).render(<App/>);}
if(window.MockRealLayout)mount();else addEventListener('mock-real-ui-ready',mount,{once:true});
