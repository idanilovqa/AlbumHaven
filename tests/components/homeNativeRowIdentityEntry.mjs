import {mountArtistSelectionRows} from '/music_app/static/js/home-friends/artist-selection.mjs';
import {mountPersonNavigation} from '/music_app/static/js/home-friends/friends-directory.mjs';
const runtime = {navigationItemHtml: config => window.NavigationTree.renderItem(config),
  artboxHtml: config => window.buildAlbumArtboxHtml(config), escapeHtml: value => window.escapeHtml(value)};
const root = document.getElementById('fixture'), artistHost = document.createElement('div'), personHost = document.createElement('div');
root.append(artistHost, personHost);
let state = {revision:0, artistSelected:false, readable:true, personSelected:false, personDisabled:false,
  personVisible:true, personHidden:false, personTitle:'Person One', artistTitle:'Artist One', mode:'normal'};
let artistOwner, personOwner, disposed = false;
window.rowCalls = [];
function render() {
  if (disposed) return;
  const artist = {id:'artist:one',title:state.artistTitle,listen_count:3,source_readable:state.readable,allowed_actions:{can_read:state.readable}};
  const artistProps = {rows:[artist],selectedId:state.artistSelected ? artist.id : null,onSelect:row => {
    window.rowCalls.push('artist:'+state.revision+':'+row.title); state = {...state,artistSelected:true}; render();
  }};
  if (artistOwner) artistOwner.update(artistProps); else artistOwner = mountArtistSelectionRows(artistHost,runtime,artistProps);
  personHost.hidden = state.personHidden;
  if (!state.personVisible) {personOwner?.dispose(); personOwner = null; return;}
  const personProps = {person:{account_ref:'member:one',display_name:state.personTitle,handle:'person',avatar_url:null},
    rowKey:'person:one',selected:state.personSelected,disabled:state.personDisabled,
    onSelect:() => {window.rowCalls.push('select'); state = {...state,revision:state.revision+1,personSelected:true,
      ...(state.mode==='revoke'?{personDisabled:true}:{}), ...(state.mode==='unmount'?{personVisible:false}:{}), ...(state.mode==='hide'?{personHidden:true}:{})}; render();},
    onActivate:node => window.rowCalls.push('activate:'+state.revision+':'+String(node===document.querySelector('[data-home-person-row="person:one"]')))};
  if (personOwner) personOwner.update(personProps); else personOwner = mountPersonNavigation(personHost,runtime,personProps);
}
window.rowUpdate = patch => {if (!disposed) {state = {...state,...patch,revision:state.revision+1}; render();}};
window.clickPersonTwice = () => {for (let i=0;i<2;i++) document.querySelector('[data-home-person-row="person:one"]').click();};
window.rowUnmount = () => {if (disposed) return; disposed=true; try {personOwner?.dispose();} finally {try {artistOwner?.dispose();} finally {root.replaceChildren();}}};
try {render();} catch (error) {window.rowUnmount(); throw error;}
