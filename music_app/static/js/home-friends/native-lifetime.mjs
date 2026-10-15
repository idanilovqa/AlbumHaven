// A bounded cleanup ledger, not a rendering abstraction. Register successful
// acquisitions before the next callback; retired scopes reject late owners.
export function createNativeLifetime() {
  let disposed = false; const releases = [];
  const defer = release => {
    if (disposed) {try {release();} catch (_cleanupError) {}}
    else releases.push(release);
  };
  return {get disposed() {return disposed;}, defer,
    own(owner) {defer(() => owner?.dispose?.()); return owner;},
    dispose() {if (disposed) return; disposed = true; for (const release of releases.splice(0).reverse()) {try {release();} catch (_cleanupError) {}}},
  };
}
