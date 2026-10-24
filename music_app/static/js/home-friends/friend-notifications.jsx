import React, {useSyncExternalStore} from 'react';
import {FriendRequestDialog} from './friend-request.jsx';

// This sibling remains mounted when Home is hidden; NativeDialog owns its only
// portal host, focus trap and drawer parent. It creates no extra drawer or root.
export function FriendNotifications({producer}) {
  const {dialog} = useSyncExternalStore(producer.subscribe, producer.getSnapshot, producer.getSnapshot);
  return dialog ? <FriendRequestDialog key={dialog.key} runtime={dialog.runtime} controller={dialog.controller}
    requestRef={dialog.requestRef} parentSurface={dialog.parentSurface} returnFocus={dialog.returnFocus}
    onClose={dialog.onClose} onProfile={dialog.onProfile}/> : null;
}
