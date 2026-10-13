import React, {useCallback, useLayoutEffect, useRef, useState} from 'react';
import {Button} from './components.jsx';
import {metric} from './model.mjs';
import {headerActionsFit} from './header-layout.mjs';

export function ListensBadge({runtime, total, range}) {
  return <span className="home-header__listens" title={range || 'Listens'} aria-label={`Listens: ${metric(total)}`}>
    <span dangerouslySetInnerHTML={{__html: runtime.iconHtml('megaphone')}}/><span>{metric(total)}</span>
  </span>;
}

// React owns placement and disclosure. Native children retain their original
// nodes, callbacks, menus and permission state at every measured width.
export function SharedHeader({runtime, id, className = '', identity, children, leading, actions, outsideActions, finalAction, hidden, headerRef, tabIndex, ariaLabel}) {
  const root = useRef(null), identityHost = useRef(null), leadingHost = useRef(null), content = useRef(null);
  const attachRoot = useCallback(node => {
    root.current = node;
    if (typeof headerRef === 'function') {
      const cleanup = headerRef(node);
      if (typeof cleanup === 'function') return () => {root.current = null; cleanup();};
    } else if (headerRef) headerRef.current = node;
  }, [headerRef]);
  const actionsHost = useRef(null), outsideHost = useRef(null), triggerHost = useRef(null), lastFocus = useRef(null), inlineFocus = useRef(false), compactFocus = useRef(null);
  const [layout, setLayout] = useState({compact: false, outside: false}), [open, setOpen] = useState(false);
  const [position, setPosition] = useState({}), latest = useRef(null);
  const hasActions = Boolean(actions || outsideActions || finalAction), panelId = `${id}-tools`;
  latest.current = {open};
  const trigger = () => triggerHost.current?.querySelector('button');
  const focusable = node => node?.isConnected && !node.disabled && node.getAttribute('aria-disabled') !== 'true'
    && !node.closest('[hidden],[inert],[aria-hidden="true"]') && node.getClientRects().length > 0;
  const close = restore => {setOpen(false); if (restore && focusable(trigger())) trigger().focus({preventScroll: true});};
  useLayoutEffect(() => {
    const host = root.current, doc = host.ownerDocument, win = doc.defaultView;
    let frame = 0, disposed = false;
    if (hidden) {compactFocus.current = null; setOpen(false);}
    const childMenu = target => Boolean(host.querySelector('[aria-expanded="true"]:not([data-header-tools])')
      && target?.closest?.('[role="menu"], [role="dialog"]'));
    const width = node => node ? Math.max(node.scrollWidth, node.getBoundingClientRect().width) : 0;
    const naturalWidth = node => {
      const items = [...node.children].filter(child => !child.hidden && win.getComputedStyle(child).display !== 'none');
      return items.reduce((sum, child) => sum + width(child), 0) + Math.max(0, items.length - 1) * (parseFloat(win.getComputedStyle(node).columnGap) || 0);
    };
    const measure = () => {
      frame = 0; if (disposed || host.hidden) return;
      const available = host.getBoundingClientRect().width; if (!available) return;
      const gap = parseFloat(win.getComputedStyle(host).columnGap) || 8;
      const leadingWidth = width(leadingHost.current), bodyWidth = width(content.current);
      const identityWidth = width(identityHost.current) + (leadingWidth ? leadingWidth + gap : 0) + (bodyWidth ? bodyWidth + gap : 0);
      const actionsWidth = naturalWidth(actionsHost.current), outsideWidth = naturalWidth(outsideHost.current);
      const compact = (actionsWidth > 0 || outsideWidth > 0) && !headerActionsFit({availableWidth: available, identityWidth, actionsWidth, outsideWidth, gap});
      const outside = compact && outsideWidth > 0 && headerActionsFit({availableWidth: available, identityWidth,
        actionsWidth: width(triggerHost.current) || 34, outsideWidth, gap});
      const active = doc.activeElement;
      if (compact && !latest.current.open && (childMenu(active) || actionsHost.current.contains(active) || !outside && outsideHost.current.contains(active))) {
        // The Tools control is still hidden until React commits compact layout.
        // Keep the actual focus source, including native body-mounted menus.
        compactFocus.current = active;
      }
      if (!compact) compactFocus.current = null;
      if (!compact && active === trigger()) inlineFocus.current = true;
      setLayout(previous => previous.compact === compact && previous.outside === outside ? previous : {compact, outside});
      if (!compact) setOpen(false);
      const rect = host.getBoundingClientRect(), viewport = win.visualViewport;
      const viewportTop = (viewport?.offsetTop || 0) + 8;
      const viewportBottom = (viewport?.offsetTop || 0) + (viewport?.height || win.innerHeight) - 8;
      const layoutWidth = doc.documentElement.clientWidth || win.innerWidth;
      const viewportLeft = (viewport?.offsetLeft || 0) + 8;
      const viewportRight = Math.min(layoutWidth, (viewport?.offsetLeft || 0) + (viewport?.width || layoutWidth)) - 8;
      const player = doc.querySelector('.global-player')?.getBoundingClientRect();
      const bottom = player?.height > 0 && player.top > viewportTop && player.top < viewportBottom ? player.top - 8 : viewportBottom;
      const below = Math.max(0, bottom - rect.bottom - 4), above = Math.max(0, Math.min(rect.top, bottom) - viewportTop - 4);
      const panel = host.querySelector('.home-header__floating-panel');
      const height = panel ? panel.scrollHeight + panel.offsetHeight - panel.clientHeight
        : Math.max(actionsHost.current.scrollHeight, outsideHost.current.scrollHeight);
      const flip = below < Math.min(80, height) && above > below;
      const maxWidth = Math.max(0, Math.min(available, viewportRight - viewportLeft));
      const panelWidth = Math.min(maxWidth, panel?.getBoundingClientRect().width || maxWidth);
      const next = {top: `${flip ? Math.max(viewportTop, Math.min(rect.top, bottom) - 4 - Math.min(height, above)) : Math.max(viewportTop, Math.min(rect.bottom + 4, bottom))}px`,
        left: `${Math.max(viewportLeft, Math.min(rect.right - panelWidth, viewportRight - panelWidth))}px`,
        maxWidth: `${maxWidth}px`, maxHeight: `${flip ? above : below}px`};
      setPosition(previous => Object.keys(next).every(key => previous[key] === next[key]) ? previous : next);
      const previous = lastFocus.current;
      if (previous && (!previous.isConnected || previous.disabled) && (active === doc.body || active === previous)) {
        const replacement = [...host.querySelectorAll('button')].find(node => (node.getAttribute('aria-label') || node.textContent) === (previous.getAttribute('aria-label') || previous.textContent) && focusable(node));
        const target = replacement || (compact ? trigger() : [...host.querySelectorAll('button')].find(focusable));
        if (focusable(target)) {target.focus({preventScroll: true}); lastFocus.current = target;}
      }
    };
    const schedule = () => {if (!frame && !disposed) frame = win.requestAnimationFrame(measure);};
    const pointer = event => {
      compactFocus.current = null; // An explicit pointer gesture owns its next focus target.
      if (latest.current.open && !host.contains(event.target) && !childMenu(event.target)) close(false);
    };
    const key = event => {
      if (event.key === 'Escape' && latest.current.open && !event.defaultPrevented && !childMenu(event.target)) {
        event.preventDefault(); event.stopPropagation(); close(true);
      }
    };
    const resize = win.ResizeObserver ? new win.ResizeObserver(schedule) : null;
    [host, identityHost.current, content.current, actionsHost.current, outsideHost.current, doc.querySelector('.global-player')].filter(Boolean).forEach(node => resize?.observe(node));
    const mutation = new win.MutationObserver(schedule);
    mutation.observe(host, {subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['disabled','aria-disabled','hidden']});
    doc.addEventListener('pointerdown', pointer); doc.addEventListener('keydown', key);
    win.addEventListener('resize', schedule); win.addEventListener('scroll', schedule, true);
    win.visualViewport?.addEventListener('resize', schedule); win.visualViewport?.addEventListener('scroll', schedule); measure();
    return () => {disposed = true; if (frame) win.cancelAnimationFrame(frame); resize?.disconnect(); mutation.disconnect();
      doc.removeEventListener('pointerdown', pointer); doc.removeEventListener('keydown', key);
      win.removeEventListener('resize', schedule); win.removeEventListener('scroll', schedule, true);
      win.visualViewport?.removeEventListener('resize', schedule); win.visualViewport?.removeEventListener('scroll', schedule);};
  }, [hasActions, hidden, open]);
  useLayoutEffect(() => {
    const doc = root.current.ownerDocument, active = doc.activeElement;
    const compactSource = compactFocus.current;
    compactFocus.current = null;
    if (layout.compact && !open && compactSource && (active === compactSource || active === doc.body) && focusable(trigger())) {
      trigger().focus({preventScroll: true});
    }
    if (!layout.compact && inlineFocus.current) {
      inlineFocus.current = false;
      const target = [...actionsHost.current.querySelectorAll('button'), ...outsideHost.current.querySelectorAll('button'), ...root.current.querySelectorAll('button')].find(focusable);
      target?.focus({preventScroll: true});
    }
    if (layout.compact && !open && active?.closest?.('[inert]') && root.current.contains(active)) trigger()?.focus({preventScroll: true});
  }, [layout.compact, layout.outside, open]);
  const concealed = layout.compact && !open;
  const floating = layout.compact && open ? ' gallery-anchored-menu home-header__floating-panel' : '';

  return <header ref={attachRoot} hidden={hidden} tabIndex={tabIndex} aria-label={ariaLabel} className={`gallery-bar home-header ${className}`} data-shared-header={id}
    data-header-compact={String(layout.compact)} data-header-outside={String(layout.outside)} data-header-open={String(open)}
    onFocusCapture={event => {lastFocus.current = event.target;}}>
    <span ref={leadingHost} className="home-header__leading">{leading}</span>
    <div ref={identityHost} className="home-header__identity">{identity}</div>
    <div ref={content} className="home-header__content">{children}</div>
    <div className="home-header__controls">
      <span ref={triggerHost} className="home-header__tools" hidden={!hasActions || !layout.compact}>
        <Button runtime={runtime} icon="tools" attributes={{'data-header-tools': 'true', 'aria-expanded': String(open), 'aria-controls': panelId}}
          onClick={() => open ? close(true) : setOpen(true)}>Tools</Button>
      </span>
      <div id={panelId} data-header-action-capsule="true" className={`home-header__capsule${!layout.outside ? floating : ''}`} style={!layout.outside && floating ? position : undefined}>
        <span ref={outsideHost} className="home-header__outside" inert={concealed && !layout.outside ? true : undefined}
          aria-hidden={concealed && !layout.outside || undefined}>{outsideActions}</span>
        <span ref={actionsHost} className={`home-header__actions${layout.outside ? floating : ''}`} style={layout.outside && floating ? position : undefined} inert={concealed ? true : undefined}
          aria-hidden={concealed || undefined}>{actions}{finalAction}</span>
      </div>
    </div>
  </header>;
}
