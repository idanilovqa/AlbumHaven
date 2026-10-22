import {mountButton, mountChoice} from '../home-friends/native-controls.mjs';
import {mountCreationSearch} from '../playlists/native-creation.mjs';
import {createCollectionFilterSession} from '../collections/native-filter-session.mjs';
import {mountCollectionFilterSurface} from '../collections/native-filter-surface.mjs';
import {DEFAULT_TOP_READ_VIEW, normalizeTopReadView, topReadViewDirty} from './read-view.mjs';

let serial = 0;
const node = (host, tag = 'span', className = '') => {const element = host.ownerDocument.createElement(tag); element.className = className; host.append(element); return element;};
export function mountAlbumTopReadControls(toolsHost, panelHost, runtime, initial) {
  let props = initial, disposed = false, surface = null, opening = null, session = null;
  const id = `album-top-filter-${++serial}`, toolbar = node(toolsHost, 'span', 'collection-filter-toolbar');
  const resetHost = node(toolbar), triggerHost = node(toolbar);
  const readable = () => !disposed && props.isCurrent() && props.state.detail.status === 'ready'
    && props.state.detail.refreshing !== true && props.state.directory.status !== 'denied'
    && props.state.detail.data?.allowed_actions?.can_read === true
    && props.state.detail.data.allowed_actions['library.browse.read'] === true;
  const sourceIdentity = state => readable() && state.scopeKey === props.state.scopeKey
    && state.detail.data === props.state.detail.data ? [state.scopeKey, state.selectedTopRef, state.detail.data] : null;
  let reset = null, trigger = null;
  try {
    reset = mountButton(resetHost, runtime, {label: 'Reset filters', icon: 'undo', onClick() {
      if (readable() && topReadViewDirty(props.view)) props.onChange(DEFAULT_TOP_READ_VIEW);
    }});
    trigger = mountButton(triggerHost, runtime, {label: 'Filter', icon: 'filters', onClick() {
      if (readable() && props.state.detail.data.items.length) session.toggle();
    }});
  } catch (error) {dispose(); throw error;}
  function fields(host, captured) {
    const searchHost = node(host, 'div', 'collection-filter-search'), choicesHost = node(host, 'div', 'collection-filter-fields');
    const current = () => readable() && session.current(captured);
    const change = patch => {if (current() && props.state.detail.data.items.length) props.onChange({...normalizeTopReadView(props.view), ...patch});};
    const search = mountCreationSearch(searchHost, runtime, {id: `${id}-search`, label: 'Search albums or artists',
      placeholder: 'Album or artist', className: 'collection-filter-search', value: props.view.query, onChange: query => change({query})});
    const choices = [
      ['sort', 'Sort', [['curator', 'Curator order'], ['original', 'Original rank'], ['year', 'Year'], ['artist', 'Artist'], ['album', 'Album']]],
      ['direction', 'Direction', [['asc', 'Ascending'], ['desc', 'Descending']]],
      ['completion', 'Manual completion', [['all', 'Any completion'], ['complete', 'Manually completed'], ['incomplete', 'Not manually completed']]],
    ].map(([key, label, options]) => ({key, label, options, host: node(choicesHost), owner: null}));
    function update() {
      const value = normalizeTopReadView(props.view), disabled = !current() || !props.state.detail.data.items.length;
      search.update({id: `${id}-search`, label: 'Search albums or artists', placeholder: 'Album or artist',
        className: 'collection-filter-search', value: value.query, maxLength: 200, disabled, onChange: query => change({query})});
      for (const item of choices) {
        const next = {label: item.label, value: value[item.key], options: item.options, disabled,
          onChange: value => change({[item.key]: value})};
        if (item.owner) item.owner.update(next); else item.owner = mountChoice(item.host, runtime, next);
      }
    }
    update();
    return {update, dispose() {search.dispose(); for (const item of choices) item.owner?.dispose(); host.replaceChildren();}};
  }
  function render() {
    if (disposed || !session) return;
    const allowed = readable(), populated = allowed && props.state.detail.data.items.length > 0;
    const dirty = topReadViewDirty(props.view);
    resetHost.hidden = !allowed || !dirty;
    reset.update({label: 'Reset filters', icon: 'undo', disabled: !allowed || !dirty,
      onClick() {if (readable() && topReadViewDirty(props.view)) props.onChange(DEFAULT_TOP_READ_VIEW);}});
    trigger.update({label: 'Filter', icon: 'filters', disabled: !populated, selected: Boolean(session.opening),
      attributes: {'aria-expanded': String(Boolean(session.opening)), 'aria-controls': id},
      onClick() {if (readable() && props.state.detail.data.items.length) session.toggle();}});
    const next = allowed ? session.opening : null;
    if (opening !== next) {
      surface?.dispose(); surface = null; opening = next;
      if (opening) {
        const captured = opening;
        surface = mountCollectionFilterSurface(panelHost, runtime, {title: 'Top filters', pageId: 'album-top-filters'}, {
          id, returnFocus: () => session.sourceCurrent(captured) ? triggerHost.querySelector('button') : null,
          onClose: () => session.close(captured), mount: host => fields(host, captured),
        });
      }
    } else if (surface) {
      const captured = opening;
      surface.update({id, returnFocus: () => session.sourceCurrent(captured) ? triggerHost.querySelector('button') : null,
        onClose: () => session.close(captured), mount: host => fields(host, captured)});
    }
    panelHost.hidden = !opening;
  }
  function dispose() {
    if (disposed) return; disposed = true;
    session?.dispose(); surface?.dispose(); reset?.dispose(); trigger?.dispose(); toolbar.remove(); panelHost.hidden = true;
  }
  try {
    session = createCollectionFilterSession({resourceNamespace: 'album-top'}, props.controller, sourceIdentity, props.providers, render);
    render();
  } catch (error) {dispose(); throw error;}
  return {update(next) {if (disposed) return; props = next; session.update(next.controller, sourceIdentity, next.providers); render();},
    dispose};
}
