import {useLayoutEffect, useRef, useState} from 'react';
import {createTrackPreferenceController} from './track-preference.mjs';

export function useTrackPreferences({runtime, source, rows, context, isCurrent, onError}) {
  const latest = useRef(null), owner = useRef(null), [version, setVersion] = useState(0);
  latest.current = {runtime, source, rows, context, isCurrent, onError};
  if (!owner.current) owner.current = createTrackPreferenceController({getView: () => latest.current,
    onChange: () => setVersion(value => value + 1), onError: message => latest.current?.onError?.(message)});
  const editor = owner.current;
  useLayoutEffect(() => {editor.sync();});
  useLayoutEffect(() => {
    const unsubscribe = runtime.subscribeTrackPreferences?.(() => {editor.sync(); setVersion(value => value + 1);});
    return () => {unsubscribe?.(); editor.cancel();};
  }, [runtime, editor]);
  return {get: editor.get, cycle: editor.cycle, version};
}
