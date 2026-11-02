// Web side of Android bridge v1. `AlbumHavenBridge` exists only inside the APK,
// injected by the shell for its exact allowed origins.
const ANDROID_BRIDGE_PROTOCOL = 1;
const ANDROID_BRIDGE_TIMEOUT_MS = 15000;

const androidBridge = { info: null, pending: new Map(), connection: null };

function isAndroidShell() {
  return typeof window !== 'undefined' && Boolean(window.AlbumHavenBridge);
}

function hasAndroidCapability(capability) {
  return Boolean(androidBridge.info?.capabilities?.includes(capability));
}

// Fails closed: the APK stays silent until its shell negotiates an audio path,
// either native audio or the interim web player inside the WebView.
function isAndroidPlaybackUnavailable() {
  return isAndroidShell() && !hasAndroidCapability('playback.native.v1')
    && !hasAndroidCapability('playback.webview.v1');
}

function createAndroidBridgeMessageId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  const hex = Array.from(window.crypto.getRandomValues(new Uint8Array(16)),
    byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function handleAndroidBridgeMessage(event) {
  let message;
  try {
    message = JSON.parse(event.data);
  } catch (_error) {
    return;
  }
  if (message?.type !== 'response') return;
  const pending = androidBridge.pending.get(message.id);
  if (!pending) return;
  androidBridge.pending.delete(message.id);
  clearTimeout(pending.timer);
  if (message.payload?.ok) {
    pending.resolve(message.payload);
  } else {
    pending.reject(Object.assign(new Error(message.payload?.error?.message || 'Android bridge request failed.'),
      { code: message.payload?.error?.code || 'unknown' }));
  }
}

function sendAndroidBridgeCommand(name, payload = {}) {
  return new Promise((resolve, reject) => {
    const id = createAndroidBridgeMessageId();
    const timer = setTimeout(() => {
      androidBridge.pending.delete(id);
      reject(Object.assign(new Error('Android bridge timed out.'), { code: 'timeout' }));
    }, ANDROID_BRIDGE_TIMEOUT_MS);
    androidBridge.pending.set(id, { resolve, reject, timer });
    window.AlbumHavenBridge.postMessage(JSON.stringify({
      protocol: ANDROID_BRIDGE_PROTOCOL, id, type: 'command', name, payload,
    }));
  });
}

function connectAndroidBridge() {
  if (!isAndroidShell()) return Promise.resolve(null);
  if (!androidBridge.connection) {
    window.AlbumHavenBridge.onmessage = handleAndroidBridgeMessage;
    androidBridge.connection = sendAndroidBridgeCommand('bridge.handshake', {
      protocolMin: ANDROID_BRIDGE_PROTOCOL, protocolMax: ANDROID_BRIDGE_PROTOCOL,
    }).then((info) => {
      androidBridge.info = info;
      return info;
    }, () => null);
  }
  return androidBridge.connection;
}
