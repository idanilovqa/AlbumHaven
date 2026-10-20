import {getAlbumTopPlaybackSession} from './playback-session.mjs';
const labels = Object.freeze({in_order: 'Play Top in order', random_albums: 'Random albums', random_songs: 'Random songs', popular_songs: 'Most popular songs'});
const badges = Object.freeze({in_order: '1', random_albums: 'A', random_songs: 'S', popular_songs: 'P'});
let serial = 0;
export function mountAlbumTopPlaybackControls(host, statusHost, runtime, initial) {
  let props = initial, disposed = false, request = null, menu = null, engagement = null, elements = null, key = null;
  let mode = 'in_order', stopAfterAlbum = false, rendering = false, rerender = false;
  const session = getAlbumTopPlaybackSession(runtime), id = `top-playback-${++serial}`;
  const current = () => !disposed && props.resourceKind === 'album_top' && props.isCurrent() === true;
  const readable = () => current() && props.state.detail.status === 'ready'
    && props.state.detail.data?.top_ref === props.state.selectedTopRef
    && props.state.directory.status !== 'denied' && props.state.detail.data.allowed_actions?.can_read === true;
  const populated = () => readable() && props.state.detail.data.items.length > 0;
  function closeMenu() {const old = menu; menu = null; old?.close({restoreFocus: false});}
  function cancel() {const old = request; request = null; old?.abort();}
  function message(value = '') {statusHost.replaceChildren(); if (value) statusHost.innerHTML = runtime.alertHtml({severity: 'info', role: 'status', message: value});}
  function openMenu() {
    if (!populated() || request || !elements?.optionsTrigger) return;
    const captured = props.state, selected = mode;
    const valid = () => !disposed && props.state.scopeKey === captured.scopeKey
      && props.state.detail.data === captured.detail.data && populated() && !request;
    let owner = null;
    owner = runtime.openChoice(elements.optionsTrigger, {label: 'Top playback options', selected,
      updateTriggerLabel: false, menuWidth: 'content', density: 'compact',
      formats: [...Object.entries(labels).map(([value, label]) => ({value, label})),
        {value: 'stop', label: 'Stop after current album', kind: 'checkbox', checked: stopAfterAlbum}],
      onSelect(value) {
        if (!valid()) return false;
        const next = value === 'stop' ? {mode, stopAfterAlbum: !stopAfterAlbum}
          : Object.hasOwn(labels, value) ? {mode: value, stopAfterAlbum} : null;
        if (!next) return false;
        const active = session.snapshot(props.state.selectedTopRef, props.state.scopeKey);
        if (active && !session.configure(props.state.selectedTopRef, props.state.scopeKey, next)) {
          message('Playback is changing tracks. Try changing the mode again.'); return false;
        }
        mode = next.mode; stopAfterAlbum = next.stopAfterAlbum; render(); return true;
      }, onClose() {if (menu === owner) menu = null;},
    });
    if (!valid()) owner?.close({restoreFocus: false}); else menu = owner;
  }
  async function play() {
    if (!populated() || request) return;
    const captured = props, detail = captured.state.detail.data, controller = new AbortController();
    request = controller; closeMenu(); message(); render();
    const admitted = () => !disposed && request === controller && props.state.scopeKey === captured.state.scopeKey
      && props.state.detail.data === detail && populated();
    try {
      const result = await session.start({top_ref: detail.top_ref, revision: detail.revision},
        {scopeKey: captured.state.scopeKey, mode, stopAfterAlbum, signal: controller.signal, isCurrent: admitted});
      if (admitted()) message(result.started ? result.unavailable ? 'Playback started. Some albums or tracks were unavailable.' : '' : 'No playable tracks are available in this Top.');
    } catch (error) {
      if (admitted() && error?.name !== 'AbortError') message('This Top could not be played. Your current playback permissions and library availability are checked when you play.');
    } finally {if (request === controller) {request = null; render();}}
  }
  function paint() {
    if (disposed) return;
    const nextKey = current() ? JSON.stringify([props.state.scopeKey, props.state.selectedTopRef]) : null;
    if (key !== nextKey) {
      closeMenu(); cancel(); engagement?.destroy(); elements?.play?.removeEventListener('click', play);
      engagement = null; elements = null; host.replaceChildren(); key = nextKey;
      mode = 'in_order'; stopAfterAlbum = false; message();
    }
    if (!nextKey) return;
    const active = session.snapshot(props.state.selectedTopRef, props.state.scopeKey);
    if (disposed) return;
    if (active) {mode = active.mode; stopAfterAlbum = active.stopAfterAlbum;}
    if (!elements) {
      host.innerHTML = runtime.playbackControlHtml({variant: 'collection-play', resourceKind: 'album_top', ownerId: id, modeBadge: badges[mode], modeLabel: labels[mode]});
      elements = runtime.playbackControlElements(host);
      elements.play.addEventListener('click', play);
      engagement = runtime.mountPlaybackOptions({root: elements.actionRoot, interactionRoot: host.firstElementChild,
        contextKey: nextKey, active: false, onEnter: openMenu});
    }
    const enabled = populated() && !request;
    elements.play.disabled = !enabled; elements.play.setAttribute('aria-disabled', String(!enabled));
    elements.play.setAttribute('aria-label', `${request ? 'Starting Top playback' : 'Play Top from the beginning'}: ${labels[mode]}${stopAfterAlbum ? ', stop after current album' : ''}`);
    elements.modeBadge.textContent = badges[mode];
    elements.loopActions.hidden = !populated();
    engagement?.update({contextKey: nextKey, enabled, canCreate: populated(), active: false, busy: Boolean(request)});
    if (!enabled) closeMenu();
  }
  function render() {
    if (disposed) return;
    if (rendering) {rerender = true; return;}
    rendering = true;
    try {do {rerender = false; paint();} while (rerender && !disposed);}
    finally {rendering = false;}
  }
  function update(next) {
    if (disposed) return;
    if (props.state.detail.data !== next.state.detail.data || props.state.scopeKey !== next.state.scopeKey
      || props.state.selectedTopRef !== next.state.selectedTopRef || next.state.detail.status !== 'ready') {cancel(); closeMenu();}
    props = next; if (!readable()) cancel(); render();
  }
  function dispose() {
    if (disposed) return; disposed = true; cancel(); closeMenu(); engagement?.destroy();
    elements?.play?.removeEventListener('click', play); host.replaceChildren(); statusHost.replaceChildren();
  }
  try {render();} catch (error) {dispose(); throw error;}
  return Object.freeze({update, dispose});
}
