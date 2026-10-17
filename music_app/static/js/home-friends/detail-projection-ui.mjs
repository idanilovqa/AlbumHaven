import {mountButton} from './native-controls.mjs';
import {metric} from './model.mjs';
import {detailSelection, detailSelectionKey, matchingDetail} from './detail-projection.mjs';
import {mountListenedAlbums, resourceArtwork as artwork} from './artist-selection.mjs';
let sequence = 0;
export function detailDuration(value) {if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 'Unknown'; const seconds = Math.floor(value); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;}
const knownText = value => typeof value === 'string' && value.trim() ? value : 'Unknown';
const metadataLabel = value => value === 'last_known' ? 'Last-known metadata' : value === 'current' ? 'Current metadata' : 'Metadata freshness unknown';
export function mountDetailProjectionPanel(host, runtime, initial) {
  let props, disposed = false, owners = [], external, rendered;
  const retired=Symbol('retired detail projection');
  const own=owner=>{if(disposed){owner?.dispose();throw retired;}owners.push(owner);return owner;};
  const id = `home-detail-native-${++sequence}`;
  const element = (parent, tag, className, text) => {if(disposed)throw retired;const node = host.ownerDocument.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; parent.append(node); return node;};
  const html = (parent, markup, className) => {const node = element(parent, 'div', className); node.innerHTML = markup; return node;};
  const button = (parent, options) => {const node = element(parent, 'span'); own(mountButton(node, runtime, options));};
  function clear() {const previous=owners;owners=[];for(const owner of previous){try{owner.dispose();}catch(_cleanupError){}}external?.remove();external=null;host.replaceChildren();}
  function dispose(){if(!disposed){disposed=true;clear();}}
  function tracks(parent, data) {
    if (data.tracks === null) {element(parent, 'p', 'home-friends__muted', 'Track information is unknown.'); return;}
    const escape = runtime.escapeHtml, hasDiscs = data.tracks.some(track => track.disc_number !== null);
    html(parent, runtime.tableHtml({id: `${id}-tracks`, ariaLabel: 'Album tracks', columns: `${hasDiscs ? 'minmax(40px,auto) ' : ''}minmax(32px,auto) minmax(0,1fr) minmax(60px,auto)`,
      columnsConfig: [...(hasDiscs ? [{key: 'disc', label: 'Disc'}] : []), {key: 'number', label: '#'}, {key: 'title', label: 'Track'}, {key: 'duration', label: 'Length'}],
      density: 'compact', frame: 'outline', mobile: 'preserve', overflow: 'local', emptyHtml: '<p>No tracks were returned.</p>', rows: data.tracks.map(track => ({key: track.id, cells: {
        disc: escape(track.disc_number === null ? 'Unknown' : metric(track.disc_number)), number: escape(track.track_number === null ? 'Unknown' : metric(track.track_number)),
        title: `${escape(knownText(track.title))}${track.artist ? `<br><small class="home-friends__muted">${escape(track.artist)}</small>` : ''}`, duration: escape(detailDuration(track.duration_seconds)),
      }}))}));
  }
  function discography(parent, data) {
    if (data.discography === null) {element(parent, 'p', 'home-friends__muted', 'Discography information is unknown.'); return;}
    const escape = runtime.escapeHtml;
    html(parent, runtime.tableHtml({id: `${id}-discography`, ariaLabel: 'Artist discography', columns: 'minmax(0,1fr) minmax(48px,auto) minmax(80px,auto)', density: 'compact', frame: 'outline', mobile: 'preserve', overflow: 'local',
      columnsConfig: [{key: 'release', label: 'Release'}, {key: 'year', label: 'Year'}, {key: 'type', label: 'Type'}], emptyHtml: '<p>No releases were returned.</p>', rows: data.discography.map(release => ({key: release.id, cells: {
        release: `<span class="home-detail__release">${artwork(runtime, release, `${knownText(release.title)} artwork`)}<span>${escape(knownText(release.title))}<br><small class="home-friends__muted">${escape(metadataLabel(release.metadata_state))}</small></span></span>`, year: escape(knownText(release.year)), type: escape(knownText(release.release_type)),
      }}))}));
  }
  function render(next) {
    if (disposed) return; props = next;
    const active = host.contains(host.ownerDocument.activeElement) ? host.ownerDocument.activeElement?.getAttribute('data-detail-intent') : null;
    const target = detailSelection(props.selection), kind = target?.kind === 'artist' ? 'artist' : 'album', granted = target?.allowed_actions.can_view_details === true;
    const matching = matchingDetail(props.value?.data, target), status = !target ? 'unavailable' : !granted ? 'denied' : props.value?.status === 'ready' && !matching ? 'unavailable' : props.value?.status || 'unavailable';
    const data = status === 'ready' && matching ? props.value.data : null;
    host.classList.add('home-detail'); host.setAttribute('aria-label', kind === 'artist' ? 'Artist information' : 'Album details'); host.dataset.detailKind = kind;
    const actionTarget = data ? detailSelection({...target, native_actions: data.native_actions || target.native_actions}) : target;
    const permitted = intent => !!data && typeof props.onIntent === 'function' && props.canIntent?.(intent, actionTarget) === true;
    const destination = props.listenedAlbumsHost?.nodeType === 1 && props.listenedAlbumsHost.isConnected ? props.listenedAlbumsHost : host;
    const nextRender = {data, status, target: detailSelectionKey(target), destination,
      permissions: JSON.stringify(['artwork','open','page','artist_gallery'].map(permitted)),
      select: typeof props.onSelectAlbum === 'function', retry: typeof props.onRetry === 'function'};
    if (rendered && Object.keys(nextRender).every(key => Object.is(rendered[key], nextRender[key]))) return;
    if(disposed)return;rendered = nextRender; clear();if(disposed)return;
    const invoke = intent => {if (!disposed && permitted(intent)) props.onIntent(intent, actionTarget);};
    const action = (parent, intent, label, icon) => {if (permitted(intent)) button(parent, {label, icon, attributes: {'data-detail-intent': intent}, onClick: () => invoke(intent)});};
    if (!data) {
      const label = kind === 'artist' ? 'Artist information' : 'Album details';
      const message = {loading: `Loading ${label.toLowerCase()}…`, empty: `No ${label.toLowerCase()} ${kind === 'artist' ? 'was' : 'were'} returned.`, denied: `You don't have access to these ${kind === 'artist' ? 'artist details' : 'album details'}.`, unavailable: `${label} ${kind === 'artist' ? 'is' : 'are'} unavailable from this provider.`, error: `${label} could not be loaded.`}[status] || `${label} ${kind === 'artist' ? 'is' : 'are'} unavailable.`;
      const statusHost = element(host, 'div'); statusHost.setAttribute('aria-busy', String(status === 'loading'));
      html(statusHost, runtime.alertHtml({severity: status === 'error' ? 'error' : 'info', role: status === 'error' ? 'alert' : 'status', message}));
      if (status === 'error' && props.onRetry) button(statusHost, {label: 'Retry details', onClick: () => props.onRetry?.()}); return;
    }
    if (kind === 'artist' && typeof runtime.artistInfoHtml === 'function') {
      html(host, runtime.artistInfoHtml({presentation: 'embedded', artist: data.title, imageUrl: data.artwork_url, summary: data.summary,
        metadata: [metadataLabel(data.metadata_state), data.release_count === null ? '' : `${metric(data.release_count)} releases`].filter(Boolean).join(' · '), sourceLabel: data.source_label}));
      action(host, 'artist_gallery', 'View Artist Gallery');
    } else {
      const overview = element(host, 'div', 'home-detail__overview'), art = element(overview, 'div', 'home-detail__artwork');
      if (permitted('artwork')) {
        const trigger = element(art, 'button', 'utility-artbox-trigger'); trigger.type = 'button'; trigger.setAttribute('aria-label', `Enlarge ${knownText(data.title)} artwork`); trigger.dataset.detailIntent = 'artwork';
        trigger.onclick = () => invoke('artwork'); owners.push({dispose() {trigger.onclick = null;}}); html(trigger, artwork(runtime, data, `${knownText(data.title)} artwork`));
      } else html(art, artwork(runtime, data, `${knownText(data.title)} artwork`));
      const identity = element(overview, 'div', 'home-detail__identity');
      html(identity, runtime.detailHeaderHtml({variant: 'copy', titleId: `${id}-title`, subtitleId: `${id}-subtitle`, title: knownText(data.title), eyebrow: kind === 'album' ? data.artist : '', subtitle: metadataLabel(data.metadata_state)}));
      action(identity, 'open', data.title || 'Open album'); action(identity, 'page', 'Full size', 'expand'); action(identity, 'artist_gallery', 'View Artist Gallery');
      const facts = element(identity, 'dl', 'home-detail__facts');
      const rows = kind === 'album' ? [['Year', knownText(data.year)], ['Release type', knownText(data.release_type)], ['Tracks', data.track_count === null ? 'Unknown' : metric(data.track_count)], ['Length', detailDuration(data.duration_seconds)]] : [['Releases', data.release_count === null ? 'Unknown' : metric(data.release_count)]];
      for (const [label, value] of rows) {element(facts, 'dt', '', label); element(facts, 'dd', '', value);}
      const information = element(host, 'div', 'home-detail__information'); element(information, 'h4', '', 'Information'); element(information, 'p', 'home-detail__summary', data.summary || 'No information was supplied.');
      if (data.source_label) element(information, 'p', 'home-friends__muted', `Source: ${data.source_label}`);
    }
    if (kind === 'artist') {
      const destination = props.listenedAlbumsHost?.nodeType === 1 && props.listenedAlbumsHost.isConnected ? props.listenedAlbumsHost : host;
      const listened = element(destination, 'section', 'home-detail__collection'); if (destination !== host) external = listened;
      listened.setAttribute('aria-label', 'Listened albums'); element(listened, 'h4', '', "Albums from the artist you've listened to");
      own(mountListenedAlbums(element(listened, 'div'), runtime, {albums: data.listened_albums, onSelect: typeof props.onSelectAlbum === 'function' ? selected => props.onSelectAlbum?.(selected) : undefined}));
    }
    const collection = element(host, 'div', 'home-detail__collection'); element(collection, 'h4', '', kind === 'album' ? 'Tracks' : 'Discography');
    if (kind === 'album') tracks(collection, data); else discography(collection, data);
    if (active) [...host.querySelectorAll('[data-detail-intent]')].find(node => node.dataset.detailIntent === active)?.focus({preventScroll: true});
  }
  function update(next){if(disposed)return;try{render(next);}catch(error){dispose();if(error!==retired)throw error;}}
  try{update(initial);return {element:host,update,dispose};}catch(error){dispose();throw error;}
}
