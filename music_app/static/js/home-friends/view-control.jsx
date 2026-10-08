import React, {useLayoutEffect, useRef} from 'react';
import {buildRecentViewIcon} from './recent-view-icons.mjs';

const choices = {
  albums: [['list', 'Rows'], ['cards', 'Cards'], ['covers', 'No info']],
  tracks: [['grouped', 'Grouped tracks'], ['history', 'Listening history']],
  artists: [['list', 'Rows'], ['cards', 'Circles']],
};
export function ViewControl({runtime, kind = 'albums', value, onChange}) {
  const root = useRef(null), owner = useRef(null), latest = useRef(onChange); latest.current = onChange;
  const items = choices[kind] || choices.albums;
  const html = runtime.viewChooserHtml({value, actions: items.map(([value, label]) => ({value, ariaLabel: label, title: label, presentation: 'bare'}))});
  const initial = useRef(html);
  useLayoutEffect(() => {
    const host = root.current; host.innerHTML = html;
    const element = host.firstElementChild;
    for (const button of element.querySelectorAll('[data-action-value]')) {
      const mode = button.dataset.actionValue, icon = button.querySelector('.action-button__icon');
      if (icon) icon.innerHTML = kind === 'tracks' ? buildRecentViewIcon(mode) : runtime.viewIconHtml(kind === 'artists' && mode === 'cards' ? 'covers' : mode);
    }
    const media = typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 600px)') : null;
    const options = () => ({label: kind === 'tracks' ? 'Track grouping' : 'View', direction: media?.matches ? 'down' : 'left',
      onSelect: next => {if (items.some(([key]) => key === next)) latest.current?.(next);}});
    owner.current = runtime.mountViewChooser(element, options());
    const resize = () => owner.current?.configure(options()); media?.addEventListener?.('change', resize);
    return () => {media?.removeEventListener?.('change', resize); owner.current?.destroy(); owner.current = null;};
  }, [runtime, kind]);
  useLayoutEffect(() => {owner.current?.select(value);}, [value, runtime, kind]);
  return <span ref={root} className="home-friends__view-control" dangerouslySetInnerHTML={{__html: initial.current}}/>;
}
