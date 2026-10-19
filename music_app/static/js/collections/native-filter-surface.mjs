import {openNativeDialog} from '../home-friends/native-dialog.mjs';
import {HOME_PHONE_QUERY} from '../home-friends/presentation.mjs';

// One disclosure owner for collection resources. Native form presentation keeps
// responsibility for phone stacking, dismissal and return-focus transactions.
export function mountCollectionFilterSurface(host, runtime, config, initial) {
  const {title, pageId, className} = config;
  let props = initial, disposed = false, dialog = null, child = null, section = null;
  let resizing = false, phone = false;
  const window = host.ownerDocument.defaultView, media = window?.matchMedia?.(HOME_PHONE_QUERY);
  const phoneNow = () => media?.matches ?? (window?.innerWidth <= 900);
  function focusTrigger() {
    const target = props.returnFocus?.();
    if (target?.isConnected && !target.disabled && !target.closest('[hidden], [inert]')) target.focus({preventScroll: true});
  }
  function mountSection(parent, form) {
    const mode = form ? 'form' : 'inline';
    section = host.ownerDocument.createElement('section');
    section.id = props.id;
    section.className = `collection-filter-surface collection-filter-surface--${mode}`
      + (className ? ` ${className} ${className}--${mode}` : '');
    section.setAttribute('aria-label', title);
    parent.append(section);
    child = props.mount(section);
    return {dispose() {child?.dispose(); child = null; section?.remove(); section = null;}};
  }
  function mountInline(focus = false) {
    mountSection(host, false);
    if (focus) section?.querySelector('input:not(:disabled),button:not(:disabled)')?.focus({preventScroll: true});
  }
  function close(options) {
    if (disposed) return;
    dialog = null;
    if (resizing && !phoneNow() && options?.current !== false) {
      resizing = false; phone = false; mountInline(true);
    } else {resizing = false; props.onClose?.(options);}
  }
  function resize() {
    const next = phoneNow();
    if (disposed || next === phone) return;
    if (!phone) {props.onClose?.({restoreFocusRequested: true}); focusTrigger();}
    else if (!resizing && dialog) {
      resizing = true;
      Promise.resolve(dialog.close({restoreFocus: false, reason: 'resize'}))
        .then(closed => {if (closed === false) resizing = false;}, () => {resizing = false;});
    }
  }
  function keydown(event) {
    if (phone || event.key !== 'Escape' || event.defaultPrevented || event.repeat || event.isComposing
      || section?.querySelector('[aria-expanded="true"]')) return;
    event.preventDefault(); event.stopPropagation();
    props.onClose?.({restoreFocusRequested: true}); focusTrigger();
  }
  phone = phoneNow();
  if (phone) dialog = openNativeDialog(runtime, {
    title, pageId, returnFocus: () => props.returnFocus?.(), contentOwnsFooter: false,
  }, {fallbackHost: host, mount: body => mountSection(body, true), onClose: close});
  else mountInline();
  host.addEventListener('keydown', keydown);
  if (media?.addEventListener) media.addEventListener('change', resize);
  else window?.addEventListener('resize', resize);
  return {
    element: host,
    update(next) {props = next; child?.update?.(next.childProps);},
    dispose() {
      disposed = true;
      media?.removeEventListener?.('change', resize); window?.removeEventListener('resize', resize);
      host.removeEventListener('keydown', keydown);
      dialog?.dispose(); child?.dispose(); host.replaceChildren();
    },
  };
}
