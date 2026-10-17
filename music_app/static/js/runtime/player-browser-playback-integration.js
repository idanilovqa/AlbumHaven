function isUnexpectedBrowserPlaybackSuspension(engine, context) {
  return engine?.context === context
    && (context.state === 'suspended' || context.state === 'interrupted')
    && Boolean(engine.roles?.current)
    && engine.snapshot?.paused === false
    && engine.snapshot?.ended !== true
    && engine.mode !== 'error';
}

function observeBrowserPlaybackAudioContext(context) {
  if (!context) return;
  const previousStateChange = context.onstatechange;
  context.onstatechange = (event) => {
    if (typeof previousStateChange === 'function') previousStateChange.call(context, event);
    const engine = state?.player?.streaming;
    if (engine?.context !== context) return;
    publishStreamingDiagnostics();
    if (!isUnexpectedBrowserPlaybackSuspension(engine, context)) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    void reconcileInterruptedStreamingPlayback(context).catch((error) => {
      console.warn('[AlbumHaven][Playback] Failed to reconcile interrupted audio.', error);
    });
  };
}

function reconcileBrowserPlaybackOnForeground() {
  return reconcileInterruptedStreamingPlayback();
}
