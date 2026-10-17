import {buildRecentViewIcon} from './recent-view-icons.mjs';
import {HOME_PHONE_QUERY} from './presentation.mjs';
const choices = {albums: [['list', 'Rows'], ['cards', 'Cards'], ['covers', 'No info']],
  tracks: [['grouped', 'Grouped tracks'], ['history', 'Listening history']], artists: [['list', 'Rows'], ['cards', 'Circles']]};
const comparisonChoices = [['rows', 'Rows'], ['covers', 'Small covers']];
export function mountViewControl(host, runtime, initial) {
  let props, owner, media, resize, signature, activeLease = null, disposed = false, revision = 0;
  host.classList.add('home-friends__view-control');
  function release() {
    const previous = owner, previousMedia = media, previousResize = resize;
    activeLease = null; owner = media = resize = null;
    try {previousMedia?.removeEventListener?.('change', previousResize);} finally {previous?.destroy();}
  }
  function dispose() {if (!disposed) {disposed = true; revision++; try {release();} finally {host.replaceChildren();}}}
  function update(next) {
    if (disposed) return;
    const token = ++revision, current = () => !disposed && revision === token && props.isCurrent?.() !== false; props = next;
    try {
    const kind = props.kind || 'albums', comparison = kind === 'albums' && props.context === 'comparison';
    const key = `${kind}:${comparison}`;
    if (signature !== key) {
      release(); if (!current()) return; signature = key;
      const items = comparison ? comparisonChoices : choices[kind] || choices.albums;
      const html = runtime.viewChooserHtml({value: props.value, actions: items.map(([value, label]) => ({value, ariaLabel: label, title: label, presentation: 'bare'}))});
      if (!current()) return; host.innerHTML = html; const element = host.firstElementChild;
      for (const button of element.querySelectorAll('[data-action-value]')) {
        const mode = button.dataset.actionValue, icon = button.querySelector('.action-button__icon');
        if (icon) {const html = kind === 'tracks' ? buildRecentViewIcon(mode)
          : runtime.viewIconHtml(comparison ? mode === 'rows' ? 'list' : 'cards' : kind === 'artists' && mode === 'cards' ? 'covers' : mode); if (!current()) return; icon.innerHTML = html;}
      }
      media = host.ownerDocument.defaultView?.matchMedia?.(comparison ? HOME_PHONE_QUERY : '(max-width: 600px)');
      const lease = {owner: null, media}; activeLease = lease;
      const ownsLease = () => {
        if (disposed || activeLease !== lease || lease.owner === null || owner !== lease.owner) return false;
        const allowed = props.isCurrent?.() !== false;
        return allowed && !disposed && activeLease === lease && owner === lease.owner;
      };
      const options = () => ({label: comparison ? 'Comparison album view' : kind === 'tracks' ? 'Track grouping' : 'View', direction: lease.media?.matches ? 'down' : 'left',
        onSelect: value => {if (ownsLease() && items.some(([choice]) => choice === value)) props.onChange?.(value);}});
      const nextOwner = runtime.mountViewChooser(element, options());
      if (!current() || activeLease !== lease) {nextOwner?.destroy(); return;} owner = nextOwner; lease.owner = nextOwner;
      resize = () => {if (ownsLease()) lease.owner.configure(options());}; lease.media?.addEventListener?.('change', resize);
    }
    if (current()) owner?.select(props.value);
    } catch (error) {try {dispose();} catch {} throw error;}
  }
  update(initial);
  return {element: host, update, dispose};
}
