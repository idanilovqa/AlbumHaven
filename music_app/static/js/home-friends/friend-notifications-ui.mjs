import {mountFriendRequestDialog} from './friend-request.mjs';

// This view stays subscribed while Home is hidden. NativeDialog owns the only
// form host and its optional drawer parent; notifications add no DOM root.
export function mountFriendNotifications(initial) {
  let props = initial, disposed = false, unsubscribe = null, owner = null, key = null, runtime = null, rendering = false, pending = false;
  function render() {
    if (disposed) return;
    if (rendering) {pending = true; return;}
    rendering = true;
    try {
      do {
        pending = false;
        const {dialog} = props.producer.getSnapshot();
        if (!dialog) {owner?.dispose(); owner = null; key = null; runtime = null; continue;}
        if (!owner || key !== dialog.key || runtime !== dialog.runtime) {
          owner?.dispose(); owner = null; key = dialog.key; runtime = dialog.runtime;
          const next = mountFriendRequestDialog(null, runtime, dialog);
          if (disposed) next.dispose(); else owner = next;
        } else owner.update(dialog);
      } while (!disposed && pending);
    } finally {rendering = false;}
  }
  function subscribe() {unsubscribe = props.producer.subscribe(render);}
  function update(next) {if (disposed) return; const replaced = next.producer !== props.producer; if (replaced) {unsubscribe?.(); owner?.dispose(); owner = null; key = null; runtime = null;} props = next; if (replaced) subscribe(); render();}
  subscribe(); render(); return {update, dispose() {if (!disposed) {disposed = true; unsubscribe?.(); owner?.dispose(); owner = null;}}};
}
