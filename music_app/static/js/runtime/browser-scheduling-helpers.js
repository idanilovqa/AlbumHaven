function scheduleBrowserTimeout(callback, delay = 0) {
  if (typeof window?.setTimeout === 'function') {
    return window.setTimeout(callback, delay);
  }
  if (typeof callback === 'function') callback();
  return 0;
}

function clearBrowserTimeout(timeoutId) {
  if (typeof window?.clearTimeout !== 'function') return false;
  window.clearTimeout(timeoutId);
  return true;
}

function scheduleBrowserAnimationFrame(callback) {
  if (typeof window?.requestAnimationFrame === 'function') {
    return window.requestAnimationFrame(callback);
  }
  if (typeof callback === 'function') callback();
  return 0;
}

function cancelBrowserAnimationFrame(frameId) {
  if (typeof window?.cancelAnimationFrame !== 'function') return false;
  window.cancelAnimationFrame(frameId);
  return true;
}

function waitForBrowserTimeout(delay = 0) {
  return new Promise((resolve) => {
    scheduleBrowserTimeout(resolve, delay);
  });
}
