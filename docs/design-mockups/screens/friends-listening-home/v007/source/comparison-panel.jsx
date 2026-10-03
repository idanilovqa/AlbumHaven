import React,{useLayoutEffect,useMemo,useRef,useState} from 'react';
import {image} from './fixture-data.mjs';
import {activity,comparisonPairs} from './listening-model.mjs';
import {
  comparisonAlbumTable,comparisonCard,comparisonContentWidth,comparisonMetrics,
  comparisonRating,isKnownComparisonNumber,comparisonSideTable,sharedComparisonTable,sortHeading,
} from './comparison-view.mjs';

const getNative=()=>window.MockRealLayout;
export const comparisonOrderOptions=Object.freeze([
  {value:'combined',label:'General'},
  {value:'yours',label:'Yours first'},
  {value:'friend',label:"Friend's first"},
]);
function NativeHtml({html,className='',onClick,owners}){
  const ref=useRef();
  useLayoutEffect(()=>{
    const host=ref.current,focusKey=host.contains(document.activeElement)?document.activeElement.dataset.mockSort:null;
    host.innerHTML=html;owners.activate(host);
    if(focusKey)[...host.querySelectorAll('[data-mock-sort]')].find(button=>button.dataset.mockSort===focusKey)?.focus({preventScroll:true});
  },[html,owners]);
  return <div ref={ref} className={className} onClick={onClick}/>;
}
function NativeChoice({label,value,options,onChange,owners}){
  const chosen=options.find(option=>option.value===value)?.label||options[0]?.label||label;
  const html=window.ButtonComponent.renderButton({label:chosen,variant:'secondary',size:'small',ariaLabel:`${label}: ${chosen}`,attributes:{'aria-haspopup':'menu'}});
  return <span className="mock-native-choice" onClick={event=>{
    const button=event.target.closest('button');if(button)owners.choiceDropdown(button,{formats:options,selected:value,label,onSelect:onChange});
  }} dangerouslySetInnerHTML={{__html:html}}/>;
}
function NativeAction({label,icon,onClick,bare=false}){
  const html=window.ButtonComponent.renderActionButton({ariaLabel:label,title:label,icon,presentation:bare?'bare':'outlined',className:'mock-bar-action'});
  return <span className="mock-native-button" dangerouslySetInnerHTML={{__html:html}} onClick={event=>{if(event.target.closest('button'))onClick?.(event);}}/>;
}
function NativeAvatar({person}){return <img className="mock-avatar" src={person.avatarUrl||image(person.avatar)} alt=""/>;}

export function ComparisonView({value,onChange,phone}){
  const ref=useRef(),owner=useRef(),change=useRef(onChange);change.current=onChange;
  useLayoutEffect(()=>{
    ref.current.innerHTML=window.UnfoldingActionButton.render({value,actions:[{value:'list',ariaLabel:'Rows',title:'Rows'},{value:'cards',ariaLabel:'Small covers',title:'Small covers'}]});
    const root=ref.current.firstElementChild;root.id='mock-comparison-view';
    for(const button of root.querySelectorAll('[data-action-value]')){
      const icon=document.querySelector(`#gallery-view-cluster-options [data-gallery-view-choice="${button.dataset.actionValue}"] svg`);
      if(icon)button.querySelector('.action-button__icon').innerHTML=icon.outerHTML;
    }
    owner.current=window.UnfoldingActionButton.mount(root,{label:'Comparison album view',direction:phone?'down':'left',onSelect:view=>change.current(view)});
    return()=>{owner.current?.close();owner.current?.destroy();owner.current=null;};
  },[]);
  useLayoutEffect(()=>{owner.current?.configure({label:'Comparison album view',direction:phone?'down':'left',onSelect:view=>change.current(view)});owner.current?.select(value);},[value,phone]);
  return <span ref={ref} className="mock-comparison-view"/>;
}
export function ComparisonIdentityHeader({profile,person,title,kind,view,onView,phone,onBack,Action=NativeAction,Avatar=NativeAvatar}){
  return <header className="mock-profile-header mock-comparison-identity" data-comparison-header="v007">
    <Action label="Back" icon="back" bare onClick={onBack}/>
    <div className="mock-overlapping-avatars" role="img" aria-label={`${profile.name} and ${person.name}`}><Avatar person={profile}/><Avatar person={person}/></div>
    <div className="mock-profile-copy"><div className="mock-profile-name"><h1>{title||`You & ${person.name}`}</h1></div><p>Taste comparison</p></div>
    <div className="mock-header-actions">{kind==='albums'&&<ComparisonView value={view} onChange={onView} phone={phone}/>}</div>
  </header>;
}
function SortAction({label,sortKey,sort,ascending,onSort,owners}){
  return <NativeHtml className="mock-sort-action" owners={owners} html={sortHeading(label,sortKey,sort,ascending)} onClick={event=>{if(event.target.closest('[data-mock-sort]'))onSort(sortKey);}}/>;
}
function ComparisonHeadings({person,sort,ascending,onSort,owners}){
  return <div className="mock-comparison-column-headings">
    {[['Yours','yours'],[person.name,'friend']].map(([label,key])=><div key={key} data-comparison-heading={key}><SortAction {...{label,sort,ascending,owners,onSort}} sortKey={key}/></div>)}
  </div>;
}
function TableColumn({side,person,pairs,kind,factor,owners}){
  const html=useMemo(()=>comparisonSideTable({side,person,pairs,kind,factor},owners),[side,person,pairs,kind,factor,owners]);
  return <section className="mock-comparison-column" data-side={side} data-comparison-ready="true" aria-label={`${side==='left'?'Your':person.name} ${kind}`}>
    <NativeHtml html={html} owners={owners}/>
  </section>;
}
function CardColumn({side,person,pairs,factor,owners,activeId,onHover,onFocus}){
  const cards=useMemo(()=>pairs.map(pair=>({pair,html:comparisonCard(pair,side,person,factor,owners)})),[pairs,side,person,factor,owners]);
  return <section className="mock-comparison-column" data-side={side} data-comparison-ready="true" aria-label={`${side==='left'?'Your':person.name} albums`}>
    <div className="mock-comparison-albums" data-view="cards">{cards.map(({pair,html})=>
      <div key={pair.id} id={`mock-comparison-${side}-${encodeURIComponent(pair.id)}`} className="mock-comparison-album"
        data-comparison-album-id={pair.id} data-comparison-highlighted={side==='right'&&activeId===pair.id?'true':undefined}
        onMouseEnter={side==='left'?()=>onHover(pair.id):undefined}
        onMouseLeave={side==='left'?()=>onHover(null):undefined}
        onFocusCapture={side==='left'?()=>onFocus(pair.id):undefined}
        onBlurCapture={side==='left'?event=>{if(!event.currentTarget.contains(event.relatedTarget))onFocus(null);}:undefined}>
        <NativeHtml html={html} owners={owners}/>
      </div>
    )}</div>
  </section>;
}
function CardComparison({person,pairs,factor,sort,ascending,onSort,owners}){
  const [hovered,setHovered]=useState(null),[focused,setFocused]=useState(null);
  const activeId=focused||hovered,focusedPair=pairs.find(pair=>pair.id===focused);
  let announcement='';
  if(focusedPair){
    const album=(focusedPair.left||focusedPair.right).album,rating=comparisonRating(album,person.id);
    const metrics=comparisonMetrics(focusedPair,'albums',person.id,factor).map(metric=>`${metric.label}: ${isKnownComparisonNumber(metric.right)?metric.right:'unavailable'}`).join('. ');
    announcement=`Matching album for ${person.name}: ${album.name}. Rating: ${isKnownComparisonNumber(rating)?`${rating} out of 10`:'unavailable'}. ${metrics}`;
  }
  return <div className="mock-desktop-comparison mock-comparison-cards">
    <span id="mock-comparison-match-instructions" className="sr-only">Focus an album in Yours to highlight its matching album and hear the comparison on the other side.</span>
    <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
    <ComparisonHeadings {...{person,sort,ascending,onSort,owners}}/>
    <div className="mock-comparison-columns">{['left','right'].map(side=><CardColumn key={side} {...{side,person,pairs,factor,owners,activeId}} onHover={setHovered} onFocus={setFocused}/>)}</div>
  </div>;
}

// Drop-in replacement for the previous Comparison function. All data/filter,
// browser history, selected period and default Common-only state stay upstream.
export function Comparison({person,kind,factor,sort='combined',ascending=false,onSort,onDirection,view='list',phone=false,commonOnly=true,onCommonOnly,native=getNative,Choice}){
  const owners=typeof native==='function'?native():native;
  const normalizedSort=sort==='general'?'combined':sort;
  const pairs=useMemo(()=>comparisonPairs(activity('me',kind,factor),activity(person.id,kind,factor),{sort:normalizedSort,ascending,commonOnly}),[person.id,kind,factor,normalizedSort,ascending,commonOnly]);
  const chooseSort=key=>normalizedSort===key?onDirection?.():onSort?.(key);
  const chooseOrder=key=>{if(normalizedSort!==key)onSort?.(key);};
  const tableHtml=useMemo(()=>phone?sharedComparisonTable({kind,pairs,person,factor,view,sort:normalizedSort,ascending},owners)
    :kind==='albums'&&view!=='cards'?comparisonAlbumTable({pairs,person,factor,sort:normalizedSort,ascending},owners):'',
    [phone,kind,pairs,person,factor,view,normalizedSort,ascending,owners]);
  const choiceProps={label:'Comparison order',value:normalizedSort,options:comparisonOrderOptions,onChange:chooseOrder};
  return <div className="mock-comparison mock-comparison-v007" data-comparison-kind={kind} data-comparison-view={view} data-comparison-phone={String(phone)} style={{'--mock-comparison-content-width':`${comparisonContentWidth(pairs,kind)}px`}}>
    <div className="mock-comparison-options"><label className="selection-accent-toggle mock-common-only"><input type="checkbox" checked={commonOnly} onChange={event=>onCommonOnly?.(event.target.checked)}/><span>Common only</span></label>
      {Choice?<Choice {...choiceProps}/>:<NativeChoice {...choiceProps} owners={owners}/>}
    </div>
    {!pairs.length?<div className="mock-empty" role="status">{commonOnly?'No shared listens for this view and period':'No listening activity for this view and period'}</div>
      :tableHtml?<NativeHtml className="mock-shared-comparison-host mock-comparison-centered" html={tableHtml} owners={owners} onClick={event=>{const button=event.target.closest('[data-mock-sort]');if(button)chooseSort(button.dataset.mockSort);}}/>
        :kind==='albums'?<CardComparison key={`${person.id}-${factor}`} {...{person,pairs,factor,ascending,owners}} sort={normalizedSort} onSort={chooseSort}/>
          :<div className="mock-desktop-comparison mock-comparison-centered"><ComparisonHeadings {...{person,ascending,owners}} sort={normalizedSort} onSort={chooseSort}/><div className="mock-comparison-columns">{['left','right'].map(side=><TableColumn key={side} {...{side,person,pairs,kind,factor,owners}}/>)}</div></div>}
  </div>;
}
