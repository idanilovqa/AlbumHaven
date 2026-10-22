import {openNativeDialog} from '../home-friends/native-dialog.mjs';
import {mountButton} from '../home-friends/native-controls.mjs';
import {projectAlbumTopImage} from './image-export-layout.mjs';
import {createAlbumTopImageRenderer} from './image-export-renderer.mjs';
import {mountAlbumTopImageControls} from './image-export-controls.mjs';
import {requestAlbumTopImageShareTransition} from './image-export-share-transition.mjs';
import {prepareAlbumTopImageFonts, createAlbumTopImageSurface, decodeAlbumTopImageResource,
  encodeAlbumTopImagePng, readAlbumTopImagePngHeader, albumTopImageFilename} from './image-export-browser.mjs';

const DEFAULTS = Object.freeze({columns:4,showTitle:true,showInfo:true,showArtist:true,showAlbum:true,
  showYear:true,showNumber:true,showOwnRating:false,numberPlacement:'on',backgroundColor:'#ffffff',
  textColor:'#111111',frameColor:'#111111',frameWidth:1,roundedCorners:false});
const MAX_BLOB = 67108864, MAX_RETAINED = 201326592;
const deferred = () => {let resolve; const promise = new Promise(done => {resolve=done;}); return {promise,resolve};};

// One runtime-owned coordinator survives Share/view remounts. Every real async
// operation retains its old owner's lane until settlement, never merely abort.
export function createAlbumTopImageCoordinator({runtime,bridge}) {
  let lane=null, shown=null, waiting=null, terminal=false, quarantined=false, captureSequence=0;
  const closed=deferred(), delivery=new Set(), blobs=new Map();
  let phase='idle';
  const cleanup = (owner, callback) => {try {callback(); return true;} catch {quarantined=true; if(owner)owner.quarantined=true; return false;}};
  function retain(blob) {
    const size=blob.size;
    if (!(blob instanceof Blob) || blob.type!=='image/png' || !Number.isSafeInteger(size) || size<=0 || size>MAX_BLOB) return false;
    const old=blobs.get(blob); if(old){old.refs++; return true;}
    let bytes=0; for(const entry of blobs.values())bytes+=entry.size;
    if(bytes+size>MAX_RETAINED)return false;
    blobs.set(blob,{refs:1,size});return true;
  }
  function drop(blob) {const entry=blobs.get(blob); if(!entry)return; if(--entry.refs===0)blobs.delete(blob);}
  function finishTerminal() {
    if(terminal&&!lane&&!waiting&&delivery.size===0&&!quarantined){phase='disposed';closed.resolve();}
  }
  function retireUrl(record, owner) {
    record.retired=true;
    if(record.image){
      cleanup(owner,()=>record.image.removeAttribute('src'));
      cleanup(owner,()=>record.image.remove());
    }
    if(record.url&&!record.urlAttempted){record.urlAttempted=true;
      if(!cleanup(owner,()=>URL.revokeObjectURL(record.url)))record.releaseUnknown=true;
      else record.url=null;
    }
    if(!record.inflight&&!record.releaseUnknown&&record.retained){record.retained=false;drop(record.blob);}
  }
  function releaseRatings(rec, value) {if(value)cleanup(rec,()=>rec.access.releaseOwnRatings(value));}
  function releaseBaseline(rec) {
    const value=rec.ratings; rec.ratings=null;
    const unsubscribe=rec.unwatch;rec.unwatch=null;
    if(unsubscribe)cleanup(rec,unsubscribe);
    releaseRatings(rec,value);
  }
  function valid(rec) {
    try {return Boolean(!quarantined&&!rec.quarantined&&!rec.dead&&!rec.retired&&!terminal&&lane===rec&&rec.capture&&rec.access?.isCurrent(rec.capture)===true);}
    catch {return false;}
  }
  function currentBlob(rec) {
    if(!valid(rec)||rec.dirty||rec.error||rec.downloadPending||!rec.preview||rec.preview.retired)return null;
    const state=rec.renderer?.read();
    if(state?.status!=='ready'||rec.preview.generation!==state.generation)return null;
    const blob=rec.renderer.currentBlob(state.generation);
    return blob===rec.preview.blob?blob:null;
  }
  function presentation(rec) {
    if(rec.dead||!rec.controls)return;
    let ready=false;
    try {ready=Boolean(currentBlob(rec))&&delivery.size<2;} catch {retire(rec);return;}
    rec.controls.update(rec.options,{canDownload:ready,error:rec.error,
      previous:Boolean(rec.preview&&!ready&&(rec.dirty||rec.error)),
      message:rec.message||(ready?'Ready to download.':rec.dirty?'Preparing image…':'Image unavailable. Try again.')});
  }
  function discardCandidate(rec) {
    if(rec.candidate)retireUrl(rec.candidate,rec);
    rec.previewDesired=null;
  }
  function clearPreview(rec) {
    discardCandidate(rec);
    if(rec.preview){retireUrl(rec.preview,rec);rec.preview=null;}
  }
  function invalidate(rec, remove=false) {
    rec.displayEpoch++;
    rec.dirty=true;rec.error=false;rec.message='Preparing image…';
    if(rec.candidate)retireUrl(rec.candidate,rec);
    rec.previewDesired=null;
    if(remove)clearPreview(rec);
    presentation(rec);
  }
  function error(rec, message='Image unavailable. Try again.') {
    if(rec.dead)return;
    rec.error=true;rec.dirty=true;rec.message=message;presentation(rec);
  }
  function retire(rec) {
    if(rec.dead||rec.retired)return;
    rec.retired=true;rec.desired=false;rec.prepEpoch++;
    rec.prepAbort?.abort();rec.downloadAbort?.abort();
    invalidate(rec,true);releaseBaseline(rec);
    invalidateCore(rec,'retired');
    error(rec,'This source changed. Close the image designer and try again.');
  }
  function invalidateCore(rec,font=String(rec.fontGeneration)) {
    rec.ignoreCoreError=true;
    try {rec.renderer?.replace(null,{fontGeneration:font});}
    finally {rec.ignoreCoreError=false;}
  }
  function leased(rec,thunk) {
    rec.pending++;
    let promise;
    try {promise=thunk();}catch(error){promise=Promise.reject(error);}
    return Promise.resolve(promise).finally(()=>{rec.pending--;finishRecord(rec);});
  }
  function finishRecord(rec) {
    if(!rec.dead||rec.pending||!rec.coreClosed||!rec.nativeClosed||rec.quarantined||rec.finished)return;
    rec.finished=true;rec.capture=null;rec.access=null;rec.renderer=null;rec.options=null;
    rec.args=null;rec.closed.resolve();
    if(lane===rec)lane=null;
    if(waiting&&!terminal&&!lane&&!quarantined){const next=waiting;waiting=null;lane=next;if(next.host)start(next);}
    else if(!terminal&&!lane&&!waiting)phase='idle';
    finishTerminal();
  }
  function notifyClosed(rec, outcome) {
    if(rec.notified)return;rec.notified=true;
    try{rec.args?.onClose?.(Object.freeze({current:outcome?.current===true,
      restoreFocusRequested:outcome?.restoreFocusRequested!==false}));}catch{/* observers cannot skip cleanup */}
  }
  function closeRecord(rec, fromNative=false) {
    if(rec.dead)return;
    rec.dead=true;rec.prepEpoch++;rec.desired=false;rec.previewDesired=null;
    if(rec.renderer)rec.coreClosed=false;
    rec.prepAbort?.abort();rec.downloadAbort?.abort();
    if(rec.transitionPending&&rec.transition&&!rec.transitionCancelled){rec.transitionCancelled=true;cleanup(rec,()=>rec.transition.cancel());}
    for(const fn of rec.cleanups.splice(0))cleanup(rec,fn);
    clearPreview(rec);releaseBaseline(rec);
    if(rec.access)cleanup(rec,()=>rec.access.dispose());
    if(rec.controls){cleanup(rec,()=>rec.controls.dispose());rec.controls=null;}
    if(rec.waitingControl){cleanup(rec,()=>rec.waitingControl.dispose());rec.waitingControl=null;}
    if(rec.dialog&&!fromNative)cleanup(rec,()=>{
      const result=rec.dialog.close({force:true,reason:'cancel'});
      if(result&&typeof result.then==='function')result.catch(()=>{quarantined=true;rec.quarantined=true;});
    });
    if(shown===rec)shown=null;
    if(waiting===rec)waiting=null;
    if(rec.nativeClosed&&!rec.transitionPending)notifyClosed(rec,{current:false});
    if(rec.renderer){
      rec.coreClosed=false;
      try {rec.renderer.dispose().then(()=>{rec.coreClosed=true;finishRecord(rec);});}
      catch {rec.quarantined=true;quarantined=true;}
    }
    if(lane===rec&&!terminal)phase=waiting?'waiting':'closing';
    finishRecord(rec);
  }
  function queueModel(rec) {
    if(!valid(rec))return;
    rec.desired=true;rec.error=false;
    if(rec.preparing||rec.downloadPending)return;
    rec.preparing=true;
    const epoch=rec.prepEpoch,abort=new AbortController();rec.prepAbort=abort;
    const live=()=>valid(rec)&&epoch===rec.prepEpoch&&!abort.signal.aborted;
    const task=async()=>{
      try {
        if(!rec.fontReady){
          if(!await prepareAlbumTopImageFonts(rec.doc,live)||!live())return;
          rec.fontReady=true;
        }
        if(rec.options.showOwnRating&&!rec.ratings){
          let value=await rec.access.readOwnRatings(rec.capture,{signal:abort.signal});
          if(!live()||!rec.options.showOwnRating){releaseRatings(rec,value);return;}
          rec.ratings=value;
          try {rec.unwatch=rec.access.watchOwnRatings(rec.capture,value,()=>retire(rec));}
          catch {releaseBaseline(rec);throw 'own_ratings_unavailable';}
          if(!live())return;
        }
        if(!live())return;
        rec.desired=false;
        const projected=projectAlbumTopImage(rec.capture.source,rec.options,rec.options.showOwnRating?rec.ratings:null);
        if(projected.status!=='ready'){error(rec);return;}
        rec.renderer.replace(projected.model,{fontGeneration:String(rec.fontGeneration)});
      } catch {if(live())error(rec);}
      finally {rec.preparing=false;if(rec.prepAbort===abort)rec.prepAbort=null;}
    };
    leased(rec,task).then(()=>{if(valid(rec)&&rec.desired&&!rec.error)queueModel(rec);});
  }
  function settingsChanged(rec,patch) {
    if(rec.dead)return;
    const old=rec.options;rec.options={...old,...patch};
    invalidate(rec);
    if(Object.hasOwn(patch,'showOwnRating')&&old.showOwnRating!==patch.showOwnRating){
      rec.prepEpoch++;rec.prepAbort?.abort();rec.downloadAbort?.abort();
      releaseBaseline(rec);invalidateCore(rec);
    }
    if(valid(rec))queueModel(rec);
  }
  function onState(rec,state) {
    if(rec.dead)return;
    if(state.status==='ready'){
      rec.previewDesired={generation:state.generation,output:state.output};
      rec.dirty=true;rec.error=false;rec.message='Preparing preview…';presentation(rec);runPreview(rec);
    }else if(state.status==='pending'){
      rec.dirty=true;rec.error=false;rec.message='Preparing image…';presentation(rec);
    }else if(state.status==='error'||state.status==='disposed'){
      if(rec.ignoreCoreError)return;
      if(state.error==='source_retired'){retire(rec);return;}
      error(rec);
    }
  }
  function previewCurrent(rec, candidate) {
    return valid(rec)&&!candidate.retired&&rec.renderer.read().generation===candidate.generation
      && rec.renderer.currentBlob(candidate.generation)===candidate.blob;
  }
  function runPreview(rec) {
    if(rec.previewBusy||!rec.previewDesired||!valid(rec))return;
    const desired=rec.previewDesired;rec.previewDesired=null;
    const blob=rec.renderer.currentBlob(desired.generation);if(!blob)return;
    rec.previewBusy=true;
    const candidate={blob,generation:desired.generation,url:null,image:null,retired:false,retained:false,inflight:true};rec.candidate=candidate;
    const task=async()=>{
      try {
        if(!retain(blob))throw 'resource_budget';candidate.retained=true;
        const dimensions=await readAlbumTopImagePngHeader(blob,desired.output.width,desired.output.height);
        if(!previewCurrent(rec,candidate))return;
        const pixels=dimensions.width*dimensions.height;
        if(pixels+(rec.preview?.pixels||0)>64000000)throw 'resource_budget';candidate.pixels=pixels;
        candidate.url=URL.createObjectURL(blob);
        if(!previewCurrent(rec,candidate))return;
        const image=rec.doc.createElement('img');candidate.image=image;image.alt='Album Top image preview';image.src=candidate.url;
        if(typeof image.decode!=='function')throw 'resource_unavailable';
        await image.decode();
        if(!previewCurrent(rec,candidate))return;
        if(image.naturalWidth!==dimensions.width||image.naturalHeight!==dimensions.height)throw 'invalid_png';
        const previous=rec.preview;
        rec.preview=candidate;rec.candidate=null;rec.controls.preview.replaceChildren(image);
        if(previous)retireUrl(previous,rec);
        rec.dirty=false;rec.error=false;rec.message='Ready to download.';presentation(rec);
      } catch {if(valid(rec)&&rec.renderer.read().generation===candidate.generation)error(rec);}
      finally {
        candidate.inflight=false;
        if(rec.preview!==candidate)retireUrl(candidate,rec);
        if(rec.candidate===candidate)rec.candidate=null;
        rec.previewBusy=false;
      }
    };
    leased(rec,task).then(()=>{if(valid(rec)&&rec.previewDesired)runPreview(rec);});
  }
  function deliver(rec,blob,generation,epoch=rec.displayEpoch) {
    const eligible=()=>valid(rec)&&!rec.dirty&&!rec.error&&rec.displayEpoch===epoch
      &&rec.renderer.currentBlob(generation)===blob&&rec.preview?.blob===blob&&!rec.preview.retired;
    if(!eligible()||delivery.size>=2)return;
    const lease={blob,url:null,retained:false,retired:false,timer:null};
    if(!retain(blob)){error(rec,'Download unavailable: resource limit. Try again.');return;}
    lease.retained=true;
    try {
      lease.url=URL.createObjectURL(blob);
      if(!eligible()){retireUrl(lease,rec);return;}
      const anchor=rec.doc.createElement('a');anchor.setAttribute('href',lease.url);anchor.setAttribute('download',albumTopImageFilename(rec.capture.source.title));
      anchor.hidden=true;rec.doc.body.append(anchor);
      delivery.add(lease);
      lease.timer=setTimeout(()=>{
        lease.timer=null;retireUrl(lease,null);delivery.delete(lease);
        if(shown&&!shown.dead)presentation(shown);finishTerminal();
      },60000);
      try {anchor.click();} finally {anchor.remove();}
      rec.message=delivery.size>=2?'Download capacity is full. Wait for the current downloads.':'Download started.';
    } catch {
      if(lease.timer!==null){clearTimeout(lease.timer);lease.timer=null;}
      delivery.delete(lease);retireUrl(lease,rec);error(rec,'Download unavailable. Try again.');
    }
    presentation(rec);
  }
  function download(rec) {
    let blob;try{blob=currentBlob(rec);}catch{retire(rec);return;}
    if(!blob||delivery.size>=2)return;
    const generation=rec.renderer.read().generation;
    if(!rec.options.showOwnRating){deliver(rec,blob,generation);return;}
    rec.downloadPending=true;rec.message='Checking your current ratings…';presentation(rec);
    const abort=new AbortController();rec.downloadAbort=abort;const epoch=rec.prepEpoch,displayEpoch=rec.displayEpoch;
    const live=()=>valid(rec)&&!abort.signal.aborted&&epoch===rec.prepEpoch&&displayEpoch===rec.displayEpoch;
    const task=async()=>{
      let fresh=null;
      try {
        fresh=await rec.access.readOwnRatings(rec.capture,{signal:abort.signal});
        if(!live())return;
        const equal=rec.access.sameOwnRatings(rec.ratings,fresh);
        releaseRatings(rec,fresh);fresh=null;
        if(!live()||rec.quarantined)return;
        if(!equal){retire(rec);return;}
        rec.downloadPending=false;
        if(rec.renderer.currentBlob(generation)===blob)deliver(rec,blob,generation,displayEpoch);
      }catch{if(live())error(rec,'Your ratings could not be checked. Try again.');}
      finally {
        if(fresh)releaseRatings(rec,fresh);
        rec.downloadPending=false;if(rec.downloadAbort===abort)rec.downloadAbort=null;
        presentation(rec);
      }
    };
    leased(rec,task).then(()=>{if(valid(rec)&&rec.desired&&!rec.error)queueModel(rec);});
  }
  function start(rec) {
    if(rec.dead||terminal||quarantined||rec.quarantined)return;
    phase='opening';rec.started=true;
    if(rec.waitingControl){rec.waitingControl.dispose();rec.waitingControl=null;}
    try {
      rec.access=bridge.createAccess({controller:rec.args.controller,providers:rec.args.providers,attribution:rec.args.attribution,
        onRetired:capture=>{if(capture===rec.capture)retire(rec);}});
      if(rec.dead||terminal||quarantined||rec.quarantined){cleanup(rec,()=>rec.access.dispose());return;}
      if(captureSequence===Number.MAX_SAFE_INTEGER)throw 'unavailable';
      rec.capture=rec.access.capture({sourceKey:String(++captureSequence)});
      if(!rec.capture)throw 'unavailable';
      if(!valid(rec))return;
      rec.controls=mountAlbumTopImageControls(rec.host,runtime,{count:rec.capture.source.total,options:rec.options,
        onChange:patch=>settingsChanged(rec,patch),onDownload:()=>download(rec),onCancel:()=>closeRecord(rec),
        onRetry:()=>{if(valid(rec)){rec.error=false;rec.message='Preparing image…';invalidate(rec);queueModel(rec);}}});
      rec.renderer=createAlbumTopImageRenderer({
        isCurrent:(binding,fontGeneration)=>valid(rec)&&fontGeneration===String(rec.fontGeneration)
          && Object.keys(binding).every(key=>binding[key]===rec.capture.source.binding[key]),
        onState:state=>onState(rec,state),scheduleFrame:callback=>requestAnimationFrame(callback),cancelFrame:token=>cancelAnimationFrame(token),
        createSurface:()=>createAlbumTopImageSurface(rec.doc),
        prepareResource:request=>request.kind==='brand'?rec.access.prepareBrand(rec.capture,request):rec.access.prepareCover(rec.capture,request),
        decodeResource:prepared=>decodeAlbumTopImageResource(prepared),encodePng:surface=>encodeAlbumTopImagePng(surface),
      });
      const stateChanged=()=>{if(!valid(rec))retire(rec);};
      const unsubscribe=rec.args.controller.subscribe(stateChanged);rec.cleanups.push(unsubscribe);
      const fonts=rec.doc.fonts;
      const loading=()=>{
        if(rec.dead||rec.retired)return;
        if(rec.fontGeneration===Number.MAX_SAFE_INTEGER){retire(rec);return;}
        rec.fontGeneration++;rec.fontReady=false;rec.prepEpoch++;rec.prepAbort?.abort();
        invalidate(rec,true);invalidateCore(rec);queueModel(rec);
      };
      const loaded=()=>{if(valid(rec)&&!rec.fontReady)queueModel(rec);};
      if(fonts?.addEventListener){fonts.addEventListener('loading',loading);fonts.addEventListener('loadingdone',loaded);fonts.addEventListener('loadingerror',loaded);
        rec.cleanups.push(()=>{fonts.removeEventListener('loading',loading);fonts.removeEventListener('loadingdone',loaded);fonts.removeEventListener('loadingerror',loaded);});}
      phase='active';queueModel(rec);
    }catch{
      phase='unavailable';
      if(rec.controls)error(rec);
      else {
        rec.host.replaceChildren();const note=rec.doc.createElement('p'),slot=rec.doc.createElement('span');note.textContent='Image export is unavailable. Close and try again.';note.setAttribute('role','alert');rec.host.append(note,slot);
        rec.waitingControl=mountButton(slot,runtime,{label:'Cancel',onClick:()=>closeRecord(rec)});
      }
    }
  }
  function openShell(rec) {
    if(rec.dead||terminal||quarantined||rec.quarantined)return;
    const args=rec.args;rec.nativeClosed=false;
    rec.dialog=openNativeDialog(runtime,{title:'Export Album Top image',pageId:'album-top-image',showCloseButton:true,returnFocus:args.returnFocus,dismissDisabled:false,
      beforeDismiss:()=>{closeRecord(rec,true);return true;}},
      {fallbackHost:args.fallbackHost,mount(host){rec.host=host;rec.doc=host.ownerDocument;
        if(lane&&lane!==rec){waiting=rec;phase='waiting';const note=rec.doc.createElement('p'),slot=rec.doc.createElement('span');note.textContent='Waiting for the previous image to finish closing…';host.replaceChildren(note,slot);rec.waitingControl=mountButton(slot,runtime,{label:'Cancel',onClick:()=>closeRecord(rec)});}
        else {lane=rec;start(rec);}
        return {dispose:()=>closeRecord(rec,true)};},onClose:()=>closeRecord(rec,true),
        onNativeSettlement:outcome=>{
          rec.nativeClosed=true;
          notifyClosed(rec,{current:!rec.openingFailed&&outcome.status==='closed'&&outcome.current===true,
            restoreFocusRequested:rec.openingFailed?false:outcome.restoreFocusRequested});
          closeRecord(rec,true);finishRecord(rec);
        },onError:()=>{rec.openingFailed=true;closeRecord(rec,true);finishRecord(rec);}});
    if(rec.dead&&!rec.nativeClosed&&!rec.dialog.failed)cleanup(rec,()=>rec.dialog.close({force:true,reason:'cancel'}));
    if(rec.dead&&rec.dialog.failed)cleanup(rec,()=>rec.dialog.dispose());
  }
  function open(args) {
    const rec={args,closed:deferred(),dead:false,retired:false,finished:false,notified:false,quarantined:false,pending:0,
      coreClosed:true,nativeClosed:true,openingFailed:false,displayEpoch:0,transition:null,transitionCancelled:false,transitionPending:false,
      options:{...DEFAULTS},cleanups:[],capture:null,access:null,renderer:null,controls:null,dialog:null,host:null,
      preview:null,candidate:null,previewDesired:null,previewBusy:false,desired:false,preparing:false,prepEpoch:0,prepAbort:null,
      fontGeneration:1,fontReady:false,ratings:null,unwatch:null,downloadPending:false,downloadAbort:null,dirty:true,error:false,message:''};
    const handle=Object.freeze({update({state}){if(!rec.dead&&rec.started&&(!valid(rec)||state!==rec.args.controller.getSnapshot()))retire(rec);},
      close:()=>closeRecord(rec),dispose:()=>closeRecord(rec),closed:rec.closed.promise});
    if(terminal){rec.dead=true;rec.finished=true;rec.closed.resolve();return handle;}
    if(shown)closeRecord(shown);
    if(waiting)closeRecord(waiting);
    shown=rec;
    if(!lane)lane=rec;else waiting=rec;
    if(quarantined){rec.quarantined=true;phase='unavailable';return handle;}
    rec.transitionPending=true;
    leased(rec,async()=>{
      try {
        rec.transition=requestAlbumTopImageShareTransition(args.fallbackHost);
        if(rec.transition){
          if(rec.dead&&!rec.transitionCancelled){rec.transitionCancelled=true;cleanup(rec,()=>rec.transition.cancel());}
          const admitted=await rec.transition.settled;
          if(typeof admitted!=='boolean')throw Object.assign(new Error(),{code:'share_transition_unconfirmed'});
          rec.transitionPending=false;
          if(!admitted||rec.dead||terminal){closeRecord(rec);notifyClosed(rec,{current:false});return;}
        }else rec.transitionPending=false;
        openShell(rec);
      }catch(error){
        if(error?.code==='share_transition_unavailable'){
          rec.transitionPending=false;closeRecord(rec);notifyClosed(rec,{current:false});
        }else{quarantined=true;rec.quarantined=true;phase='unavailable';await new Promise(()=>{});}
      }
    });
    return handle;
  }
  function dispose() {
    if(terminal)return closed.promise;
    terminal=true;phase='disposed';
    if(shown)closeRecord(shown);if(waiting)closeRecord(waiting);if(lane&&!lane.dead)closeRecord(lane);
    finishTerminal();return closed.promise;
  }
  return Object.freeze({open,read:()=>Object.freeze({phase}),dispose});
}
