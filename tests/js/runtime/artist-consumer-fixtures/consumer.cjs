'use strict';
const assert=require('node:assert/strict');
const A=require('../artist-host-fixtures/actual-artist-runtime.cjs');
const H=require('../artist-creation-fixtures/facade.cjs');
const B=require('../artist-scoped-builder-fixtures/builder.cjs');
const tick=B.tick;
async function setup(t,options={}){
 const h=A.fixture(t,options);const root=h.document.createElement('section');root.id='album-tops-root';h.main.append(root);
 // The delivered entry mounts the real Top index and its single automatic
 // Artist consumer. There is no direct second consumer or suppressed request.
 await h.entry();await h.admit(H.payload());await tick();
 const namespace=h.context.AlbumHavenAlbumTopsRuntime.artistCreation,origin=namespace.snapshot();assert.ok(origin);
 const original=[...origin.headerRoot.childNodes];
 const pending=path=>h.requests.filter(r=>!r.settled&&new URL(r.url,'http://localhost').pathname===path);
 const envelope=data=>({status:'ready',context_ref:H.STAMP,data});
 const directories=()=>pending('/album-tops');
 const grant=async(allowed=true)=>{const requests=directories();assert.equal(requests.length,1,'one child directory request while main Top surface is inactive');requests[0].resolve(envelope({tops:[],next_cursor:null,allowed_actions:{'library.browse.read':true,'library.album_tops.create':allowed,can_create:allowed}}));await tick();};
 const create=()=>[...origin.headerRoot.querySelectorAll('button')].find(n=>(n.getAttribute('aria-label')||n.textContent.trim())==='Create Listen-through'&&!n.closest('[hidden]'));
 const form=()=>h.document.querySelector('form[aria-label="Create Album Top"]');
 const population=async()=>{const requests=pending('/album-top-catalog/search');assert.equal(requests.length,1);const url=new URL(requests[0].url,'http://localhost');assert.equal(url.searchParams.get('root_artist_id'),'3');assert.equal(url.searchParams.get('scope_mode'),'artist');assert.equal(url.searchParams.get('q'),'');requests[0].resolve(envelope({albums:[B.album(11)],next_cursor:null}));await tick();};
 t.after(()=>{h.change('context');namespace.snapshot();});
 return {...h,root,namespace,origin,original,pending,envelope,directories,grant,create,form,population};
}
module.exports={setup,H,B,tick};
