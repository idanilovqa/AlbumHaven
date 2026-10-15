const test=require('node:test');
const assert=require('node:assert/strict');
const {fixture,driver}=require('./playlist-header-migration-fixture.cjs');
let savedHeader,draftHeader;
test.before(async()=>{
  ({mountPlaylistHeader:savedHeader,mountMissingPlaylistDraftHeader:draftHeader}=
    await import('../../../music_app/static/js/playlists/native-headers.mjs'));
});
for(const kind of ['saved','draft']) {
  const props=title=>kind==='saved'
    ? {detail:{title},draft:null,actions:{},onAction(){}}
    : {title,filtersId:'title-currentness-filters',actions:{},onAction(){}};
  function titleGetter(get){const value=props('placeholder');
    if(kind==='saved')Object.defineProperty(value.detail,'title',{get});
    else Object.defineProperty(value,'title',{get});
    return value;
  }
  function setup(t){const h=fixture(t),view=driver(t,h,kind==='saved'?savedHeader:draftHeader,props('Original title'));
    return {...h,view,heading:h.host.querySelector('.gallery-bar__title')};}
  test(`${kind} native header refuses stale title evaluation and leaves its mounted title unchanged`,t=>{
    const h=setup(t);let reads=0;
    const stale=titleGetter(()=>{reads++;return 'Stale title';});stale.isCurrent=()=>false;
    h.view.render(stale);
    assert.equal(reads,0,'a stale update cannot even evaluate its title getter');
    assert.equal(h.heading.textContent,'Original title');
    assert.equal(h.host.querySelector('.gallery-bar__title'),h.heading);
  });
  test(`${kind} native header reentrant title getter cannot overwrite replacement title`,t=>{
    const h=setup(t);let reads=0;
    h.view.render(titleGetter(()=>{reads++;h.view.render(props('Replacement title'));return 'Retired title';}));
    assert.equal(reads,1);
    assert.equal(h.heading.textContent,'Replacement title');
    assert.equal(h.host.querySelector('.gallery-bar__title'),h.heading);
    assert.equal(h.heading.isConnected,true);
  });
  test(`${kind} native header disposal inside title getter prevents detached title writes`,t=>{
    const h=setup(t);let reads=0;
    h.view.render(titleGetter(()=>{reads++;h.view.dispose();return 'Retired title';}));
    assert.equal(reads,1);
    assert.equal(h.heading.textContent,'Original title','retirement precedes any title assignment');
    assert.equal(h.heading.isConnected,false);
    assert.equal(h.host.childNodes.length,0);
  });
  test(`${kind} native header reentrant currentness callback cannot write over replacement`,t=>{
    const h=setup(t);let reads=0,checks=0;
    const stale=titleGetter(()=>{reads++;return 'Retired title';});
    stale.isCurrent=()=>{checks++;h.view.render(props('Replacement title'));return true;};
    h.view.render(stale);
    assert.equal(checks,1);
    assert.equal(reads,0);
    assert.equal(h.heading.textContent,'Replacement title');
    assert.equal(h.host.querySelector('.gallery-bar__title'),h.heading);
  });
}
