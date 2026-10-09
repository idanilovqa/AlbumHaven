import React, {useLayoutEffect, useRef, useState} from 'react';
import {NativeDialog} from '../home-friends/native-dialog.jsx';
import {HOME_PHONE_QUERY} from '../home-friends/presentation.mjs';

// Values stay with the Playlist controller. The native form owns phone history,
// dismissal and focus; this adapter owns only inline versus form presentation.
export function PlaylistFilterSurface({runtime, id, onClose, returnFocus, children}) {
  const inline = useRef(null), closeForm = useRef(null), latest = useRef(null), resizing = useRef(false);
  const alive = useRef(false), focusInline = useRef(false);
  const phoneNow = () => typeof window !== 'undefined'
    && (window.matchMedia?.(HOME_PHONE_QUERY).matches ?? window.innerWidth <= 900);
  const [phone, setPhone] = useState(phoneNow);
  latest.current = {phone, onClose, returnFocus};
  const focusTrigger = () => {
    const target = latest.current.returnFocus?.();
    if (target?.isConnected && !target.disabled && !target.closest('[hidden], [inert]')) target.focus({preventScroll: true});
  };
  useLayoutEffect(() => {
    alive.current = true;
    if (typeof window === 'undefined') return () => {alive.current = false;};
    const media = window.matchMedia?.(HOME_PHONE_QUERY);
    const resize = () => {
      const next = media?.matches ?? window.innerWidth <= 900;
      if (!alive.current || next === latest.current.phone) return;
      if (!latest.current.phone) {
        // Narrowing an inline row does not unexpectedly open a new page.
        latest.current.onClose?.({restoreFocusRequested: true}); focusTrigger();
      } else if (!resizing.current && closeForm.current) {
        resizing.current = true;
        // The existing owner must finish Back/parent restoration before the
        // inline replacement can mount. Never replace a pending form return.
        Promise.resolve(closeForm.current({restoreFocus: false, reason: 'resize'})).then(closed => {
          if (closed === false) resizing.current = false;
        }, () => {resizing.current = false;});
      }
    };
    if (media?.addEventListener) media.addEventListener('change', resize);
    else window.addEventListener('resize', resize);
    return () => {
      alive.current = false; resizing.current = false; closeForm.current = null;
      media?.removeEventListener?.('change', resize); window.removeEventListener('resize', resize);
    };
  }, []);
  useLayoutEffect(() => {
    if (!phone && focusInline.current) {
      focusInline.current = false;
      inline.current?.querySelector('input:not(:disabled), button:not(:disabled)')?.focus({preventScroll: true});
    }
  }, [phone]);
  if (phone) return <NativeDialog runtime={runtime} title="Playlist filters" pageId="playlist-filters"
    returnFocus={returnFocus} contentOwnsFooter={false} onClose={options => {
      if (!alive.current) return;
      closeForm.current = null;
      if (resizing.current && !phoneNow() && options?.current !== false) {
        resizing.current = false; focusInline.current = true; setPhone(false);
      } else {resizing.current = false; latest.current.onClose?.(options);}
    }}>{close => {
      closeForm.current = close;
      return <section id={id} className="playlists__filter-surface playlists__filter-surface--form" aria-label="Playlist filters">{children}</section>;
    }}</NativeDialog>;
  return <section ref={inline} id={id} className="playlists__filter-surface playlists__filter-surface--inline" aria-label="Playlist filters"
    onKeyDown={event => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.repeat || event.isComposing
        || inline.current?.querySelector('[aria-expanded="true"]')) return;
      event.preventDefault(); event.stopPropagation(); latest.current.onClose?.({restoreFocusRequested: true}); focusTrigger();
    }}>{children}</section>;
}
