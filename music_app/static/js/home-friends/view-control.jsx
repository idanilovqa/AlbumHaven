import React, {useLayoutEffect, useRef} from 'react';
import {buildRecentViewIcon} from './recent-view-icons.mjs';
import {HOME_PHONE_QUERY} from './presentation.mjs';

const choices = {
  albums: [['list', 'Rows'], ['cards', 'Cards'], ['covers', 'No info']],
  tracks: [['grouped', 'Grouped tracks'], ['history', 'Listening history']],
  artists: [['list', 'Rows'], ['cards', 'Circles']],
};
const comparisonChoices = [['rows', 'Rows'], ['covers', 'Small covers']];
export function ViewControl({runtime, kind = 'albums', context = 'activity', value, onChange}) {
  const root = useRef(null), owner = useRef(null), latest = useRef(onChange); latest.current = onChange;
  const comparison = kind === 'albums' && context === 'comparison';
  const items = comparison ? comparisonChoices : Object.hasOwn(choices, kind) ? choices[kind] : choices.albums;
  const html = runtime.viewChooserHtml({value, actions: items.map(([value, label]) => ({value, ariaLabel: label, title: label, presentation: 'bare'}))});
  const initial = useRef(html);
  useLayoutEffect(() => {
    let active = true;
    const host = root.current; host.innerHTML = html;
    const element = host.firstElementChild;
    for (const button of element.querySelectorAll('[data-action-value]')) {
      const mode = button.dataset.actionValue, icon = button.querySelector('.action-button__icon');
      if (icon) icon.innerHTML = kind === 'tracks' ? buildRecentViewIcon(mode)
        : runtime.viewIconHtml(comparison ? mode === 'rows' ? 'list' : 'cards' : kind === 'artists' && mode === 'cards' ? 'covers' : mode);
    }
    const media = typeof window.matchMedia === 'function' ? window.matchMedia(comparison ? HOME_PHONE_QUERY : '(max-width: 600px)') : null;
    const options = () => ({label: comparison ? 'Comparison album view' : kind === 'tracks' ? 'Track grouping' : 'View', direction: media?.matches ? 'down' : 'left',
      onSelect: next => {if (active && items.some(([key]) => key === next)) latest.current?.(next);}});
    const mounted = runtime.mountViewChooser(element, options()); owner.current = mounted;
    const resize = () => {if (active) mounted?.configure(options());}; media?.addEventListener?.('change', resize);
    return () => {active = false; media?.removeEventListener?.('change', resize); mounted?.destroy(); if (owner.current === mounted) owner.current = null;};
  }, [runtime, kind, comparison]);
  useLayoutEffect(() => {owner.current?.select(value);}, [value, runtime, kind, comparison]);
  return <span ref={root} className="home-friends__view-control" dangerouslySetInnerHTML={{__html: initial.current}}/>;
}
