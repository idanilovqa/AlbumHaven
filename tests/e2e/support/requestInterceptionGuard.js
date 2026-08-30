const BLOCKED_INTERCEPTION_METHODS = Object.freeze([
  'route',
  'routeFromHAR',
  'routeWebSocket',
  'unroute',
  'unrouteAll',
]);

export function installRequestInterceptionGuard(target, ownerName) {
  const restorers = [];
  for (const methodName of BLOCKED_INTERCEPTION_METHODS) {
    if (typeof target?.[methodName] !== 'function') continue;
    const ownDescriptor = Object.getOwnPropertyDescriptor(target, methodName);
    Object.defineProperty(target, methodName, {
      configurable: true,
      enumerable: ownDescriptor?.enumerable ?? false,
      writable: true,
      value() {
        throw new Error(
          `E2E production-parity violation: ${ownerName}.${methodName} cannot intercept the real app request path.`,
        );
      },
    });
    restorers.push(() => {
      if (ownDescriptor) Object.defineProperty(target, methodName, ownDescriptor);
      else delete target[methodName];
    });
  }
  return () => {
    for (const restore of restorers.reverse()) restore();
  };
}

export function installContextRequestInterceptionGuard(context) {
  const pageRestorers = new Map();
  const guardPage = (page) => {
    if (!page || pageRestorers.has(page)) return;
    pageRestorers.set(page, installRequestInterceptionGuard(page, 'page'));
  };
  const restoreContext = installRequestInterceptionGuard(context, 'context');
  for (const page of context.pages()) guardPage(page);
  if (typeof context.prependListener === 'function') context.prependListener('page', guardPage);
  else context.on('page', guardPage);

  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    context.off('page', guardPage);
    for (const restorePage of [...pageRestorers.values()].reverse()) restorePage();
    pageRestorers.clear();
    restoreContext();
  };
}

export { BLOCKED_INTERCEPTION_METHODS };
