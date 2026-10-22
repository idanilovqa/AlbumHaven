// Utilities owns navigation; the standalone module owns the account draft/editor.
function getBackgroundAppearanceEditor() {
  return typeof window !== 'undefined' ? window.AlbumHavenAppearance?.instance : null;
}
let pendingBackgroundAppearanceLeave = null;
function confirmBackgroundAppearanceLeave(onDiscard = null, leaveContext = null) {
  const editor = getBackgroundAppearanceEditor();
  if (!leaveContext) {
    if (!editor || editor.allowLeave(() => false) !== false) return true;
    if (!pendingBackgroundAppearanceLeave && typeof showAppConfirmDialog === 'function') {
      const pending = showAppConfirmDialog({title:'Discard appearance changes?',message:'Your unsaved Appearance changes will be lost.',cancelLabel:'Keep editing',acceptLabel:'Discard changes',danger:true})
        .then(accepted => {if(accepted && editor.allowLeave(() => true) !== false)onDiscard?.();})
        .finally(()=>{if(pendingBackgroundAppearanceLeave===pending)pendingBackgroundAppearanceLeave=null;});
      pendingBackgroundAppearanceLeave=pending;
    }
    return false;
  }
  let done=false;
  const current=()=>leaveContext.isCurrent()&&editor===getBackgroundAppearanceEditor();
  const outcome=(status,reason)=>{if(done)return;done=true;leaveContext.onOutcome?.({status,reason});};
  if(!current()){outcome('superseded','appearance-owner');return false;}
  if(pendingBackgroundAppearanceLeave){outcome('cancelled','busy');return false;}
  try {if(!editor||editor.allowLeave(()=>false)!==false)return true;}
  catch(_error){outcome('failed','appearance-error');return false;}
  if(typeof showAppConfirmDialog!=='function'){outcome('failed','appearance-unavailable');return false;}
  const departure={};pendingBackgroundAppearanceLeave=departure;
  Promise.resolve().then(()=>{
    if(!current())throw {stale:true};
    return showAppConfirmDialog({title:'Discard appearance changes?',message:'Your unsaved Appearance changes will be lost.',cancelLabel:'Keep editing',acceptLabel:'Discard changes',danger:true});
  }).then(accepted=>{
    if(pendingBackgroundAppearanceLeave!==departure||!current()){outcome('superseded','appearance-owner');return;}
    pendingBackgroundAppearanceLeave=null;
    if(accepted!==true){outcome('cancelled','blocked');return;}
    if(!current()){outcome('superseded','stale-intent');return;}
    if(editor.allowLeave(()=>true)===false){outcome('cancelled','blocked');return;}
    if(!current()){outcome('superseded','stale-intent');return;}
    onDiscard?.();done=true;
  }).catch(()=>outcome(current()?'failed':'superseded','appearance-error'))
    .finally(()=>{if(pendingBackgroundAppearanceLeave===departure)pendingBackgroundAppearanceLeave=null;});
  return false;
}
function unmountAppearanceEditors() {
  getBackgroundAppearanceEditor()?.unmount();
  if (typeof window !== 'undefined') window.AlbumHavenSelectionAccent?.unmount?.();
}
function mountBackgroundAppearanceEditor(detail) {
  const editor = getBackgroundAppearanceEditor();
  if (editor) editor.mount(detail);
  else detail.innerHTML = buildOnPageAlertHtml({ severity: 'error', title: 'Appearance unavailable', message: 'Backgrounds could not be loaded. Reload this page to try again.' });
}

// Live canvases consume only the account's applied state, never the editor draft.
function getSavedAppearancePlayerColors() {
  return typeof window !== 'undefined' ? window.AlbumHavenAppearance?.getSavedPlayerColors?.() || null : null;
}
function getSavedAppearanceLoopControlStyle() {
  return getBackgroundAppearanceEditor()?.getSavedLoopControlStyle?.() === 'companion' ? 'companion' : 'capsule';
}
function syncSavedAppearanceLoopControlStyle() {
  const style = getSavedAppearanceLoopControlStyle();
  document.querySelectorAll?.('[data-playback-control-cluster][data-loop-control-style]').forEach(node => {
    node.setAttribute('data-loop-control-style', style);
  });
}
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('album-haven-appearance-change', () => {
    if (typeof updateWaveformAppearance === 'function') updateWaveformAppearance();
    syncSavedAppearanceLoopControlStyle();
    if (typeof syncMobileAlbumComposition === 'function' && typeof getCurrentTrackModalAlbum === 'function') {
      syncMobileAlbumComposition(getCurrentTrackModalAlbum());
    }
  });
}

// Read the existing browser preference only when the owner asks to recover it.
// Normalized runtime defaults are not evidence that earlier colors were stored.
function getPreviousBrowserWaveformColors() {
  if (typeof getLocalStorageItem !== 'function' || typeof PLAYER_APPEARANCE_STORAGE_KEY === 'undefined') return null;
  try {
    const raw = getLocalStorageItem(PLAYER_APPEARANCE_STORAGE_KEY);
    if (!raw) return null;
    const previous = JSON.parse(raw);
    if (!previous || typeof previous !== 'object' || Array.isArray(previous)) return null;
    const colors = [previous.waveformFillColor, previous.waveformEdgeColor];
    if (!colors.every(color => typeof color === 'string' && color.length === 7 && /^#[0-9a-f]{6}$/i.test(color))) return null;
    return { fill: colors[0].toUpperCase(), edge: colors[1].toUpperCase() };
  } catch (_failure) { return null; }
}
function mountSeekbarAppearanceEditor(detail) {
  const host = detail.querySelector('[data-appearance-seekbar-editor]');
  if (!host) return;
  const editor = getBackgroundAppearanceEditor();
  if (editor?.mountSeekbar) editor.mountSeekbar(host, {
    getLegacyColors: getPreviousBrowserWaveformColors,
    getSeekbarMode: profile => window.AlbumHavenDevicePreferences?.enabled
      ? window.AlbumHavenDevicePreferences.read('playerAppearance', {}, profile).seekbarMode || 'default'
      : state.player.appearance?.seekbarMode || 'default',
    applySeekbarMode: async (seekbarMode, profile, isCurrentSave = () => true) => {
      const preferences = window.AlbumHavenDevicePreferences;
      if (preferences?.enabled) {
        const appearance = normalizePlayerAppearance({ ...preferences.read('playerAppearance', {}, profile), seekbarMode });
        if (!preferences.write('playerAppearance', appearance, profile) || !await preferences.flush()) {
          throw new Error('Seekbar mode could not be saved.');
        }
        if (!isCurrentSave() || editor !== getBackgroundAppearanceEditor()
          || preferences !== window.AlbumHavenDevicePreferences) return;
        const current = normalizePlayerAppearance(preferences.read('playerAppearance', {}, profile));
        if (profile === preferences.profile() && JSON.stringify(current) === JSON.stringify(appearance)) {
          state.player.appearance = appearance;
          updateWaveformAppearance(true);
        }
        return;
      }
      state.player.appearance = normalizePlayerAppearance({ ...state.player.appearance, seekbarMode });
      persistPlayerAppearance();
      updateWaveformAppearance(true);
    },
  });
  else host.innerHTML = buildOnPageAlertHtml({ severity: 'error', title: 'Appearance unavailable', message: 'Waveform colors could not be loaded. Reload this page to try again.' });
}

function mountAlbumPageAppearanceEditor(detail) {
  const editor = getBackgroundAppearanceEditor();
  if (editor?.mountAlbumPage) editor.mountAlbumPage(detail);
  else detail.innerHTML = buildOnPageAlertHtml({ severity: 'error', title: 'Appearance unavailable', message: 'Album page appearance could not be loaded. Reload this page to try again.' });
}

function mountAlertsAppearanceEditor(detail) {
  const editor = getBackgroundAppearanceEditor();
  if (editor?.mountAlerts) editor.mountAlerts(detail);
  else detail.innerHTML = buildOnPageAlertHtml({ severity: 'error', title: 'Appearance unavailable', message: 'Alert appearance could not be loaded. Reload this page to try again.' });
}
