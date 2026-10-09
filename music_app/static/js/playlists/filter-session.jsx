import {useLayoutEffect, useRef, useState} from 'react';

// Opening presentation is owned by an exact readable source lifetime. Filter
// values stay in the caller's controller and survive closing this presentation.
export function usePlaylistFilterSession(controller, sourceIdentity, providers) {
  const [opening, setOpening] = useState(null);
  const active = useRef(null), mounted = useRef(false), sequence = useRef(0), latest = useRef(null);
  if (!latest.current || latest.current.controller !== controller || latest.current.sourceIdentity !== sourceIdentity
    || latest.current.providers !== providers) latest.current = {controller, sourceIdentity, providers};
  const renderContext = latest.current;
  const current = owner => {
    const context = latest.current;
    if (!mounted.current || !owner || active.current !== owner || owner.controller !== context.controller
      || owner.providers !== context.providers || owner.version !== context.controller.getLifecycleVersion?.()) return false;
    const identity = context.sourceIdentity(context.controller.getSnapshot());
    return Boolean(identity && identity.length === owner.identity.length
      && identity.every((value, index) => Object.is(value, owner.identity[index])));
  };
  const close = owner => {
    if (!mounted.current || active.current !== owner) return;
    active.current = null; setOpening(value => value === owner ? null : value);
  };
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {mounted.current = false; active.current = null;};
  }, []);
  useLayoutEffect(() => {
    const retire = () => {const owner = active.current; if (owner && !current(owner)) close(owner);};
    retire();
    return controller.subscribe(retire);
  }, [controller, sourceIdentity, providers]);
  return {opening: current(opening) ? opening : null, current, close,
    toggle() {
      if (!mounted.current || latest.current !== renderContext) return;
      if (current(active.current)) {close(active.current); return;}
      const context = latest.current, identity = context.sourceIdentity(context.controller.getSnapshot());
      if (!identity) return;
      const owner = {controller: context.controller, providers: context.providers, identity,
        version: context.controller.getLifecycleVersion?.(), id: ++sequence.current};
      active.current = owner; setOpening(owner);
    }};
}
