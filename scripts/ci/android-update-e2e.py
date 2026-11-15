#!/usr/bin/env python3
"""In-app update end to end on an emulator: the owner's 2026-11-09 phone reports.

One press of Update downloads, verifies and installs the newer APK (Android's own confirmation is
the only other tap); once Android has replaced the package, the new version reopens itself on the
page Update was pressed on when "Appear on top" is allowed, without showing the old version's
picture of that page; without it, and with notifications allowed, it posts "Album Haven updated".

A local server, reached by the device through `adb reverse`, is the debug build's origin
(-PalbumHavenDevOrigin=http://127.0.0.1:18765): it serves the page, which drives the bridge as the
web's Update button does, the update manifest and the newer APK. Usage:

  android-update-e2e.py --serial emulator-5554 --old app-v1.apk --new app-v2.apk
"""

import argparse
import base64
import hashlib
import json
import os
import re
import subprocess
import sys
import threading
import time
import uuid
import xml.etree.ElementTree as ElementTree
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

PACKAGE = "org.albumhaven.app"
ACTIVITY = f"{PACKAGE}/org.albumhaven.shell.ShellActivity"
DEV_PORT = 18765
ORIGIN = f"http://127.0.0.1:{DEV_PORT}"
UPDATE_PAGE = "/library?artist=Update%20Target"
APK_NAME = "album-haven-update.apk"
# The short-lived link the signed APK exchange hands out (ArtifactHttp.DOWNLOAD_PATH).
DOWNLOAD_PATH = "/artifacts/android/download/album-haven-update." + "d" * 43
INSTALLER_PACKAGES = ("com.google.android.packageinstaller", "com.android.packageinstaller")
# The reopened page is held back this long, so what covers it before it draws can be seen.
REOPEN_HOLD_SECONDS = 5

PAGE = """<!doctype html><title>Update Target</title><body style="background:#2a6">Update Target
<script>
if (location.pathname === '/') location.replace('UPDATE_PAGE');
const report = (event, value) => fetch('/report?' + new URLSearchParams({ event, value }));
const send = (name) => AlbumHavenBridge.postMessage(JSON.stringify({
  protocol: 1, id: crypto.randomUUID(), type: 'command', name, payload: name === 'bridge.handshake'
    ? { protocolMin: 1, protocolMax: 1 } : {},
}));
let pressed = false;
const follow = (state) => {
  report('state', state.state + (state.reason ? ':' + state.reason : ''));
  if (state.state === 'idle' || state.state === 'upToDate') send('updates.check');
  // The web's Update button, pressed once.
  if (state.state === 'available' && !pressed) {
    pressed = true;
    report('pressed', 'updates.download');
    send('updates.download');
  }
};
AlbumHavenBridge.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.name === 'bridge.handshake') {
    report('handshake', location.pathname + location.search);
    if (message.payload.updates && location.pathname !== '/') follow(message.payload.updates);
  } else if (message.name === 'updates.state') {
    follow(message.payload);
  }
};
send('bridge.handshake');
</script>""".replace("UPDATE_PAGE", UPDATE_PAGE)


class Origin(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, manifest: dict, apk: bytes):
        super().__init__(("127.0.0.1", 0), Handler)
        self.manifest = json.dumps(manifest).encode()
        self.apk = apk
        self.lock = threading.Lock()
        self.reports: list[tuple[float, str, str]] = []
        self.pages: list[tuple[float, str]] = []
        self.hold_after = None  # Pages asked for after this time are held back.
        self.held = threading.Event()

    def reported(self, event: str, after: float = 0) -> list[str]:
        with self.lock:
            return [value for at, name, value in self.reports if name == event and at > after]

    def pages_after(self, after: float) -> list[str]:
        with self.lock:
            return [path for at, path in self.pages if at > after]


class Handler(BaseHTTPRequestHandler):
    server: Origin

    def log_message(self, *args):
        pass

    def respond(self, status: int, body: bytes, content_type: str):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parts = urlsplit(self.path)
        server = self.server
        if parts.path == "/report":
            query = parse_qs(parts.query)
            with server.lock:
                server.reports.append((time.time(), query["event"][0], query["value"][0]))
            return self.respond(204, b"", "text/plain")
        if parts.path == "/artifacts/android/stable/manifest.json":
            return self.respond(200, server.manifest, "application/json")
        if parts.path == DOWNLOAD_PATH:
            return self.respond(200, server.apk, "application/vnd.android.package-archive")
        if parts.path in ("/", "/library"):
            now = time.time()
            with server.lock:
                server.pages.append((now, self.path))
            if server.hold_after is not None and now > server.hold_after:
                server.held.set()
                time.sleep(REOPEN_HOLD_SECONDS)
            return self.respond(200, PAGE.encode(), "text/html")
        return self.respond(404, b"{}", "application/json")

    def do_HEAD(self):
        if urlsplit(self.path).path != DOWNLOAD_PATH:
            return self.respond(404, b"", "text/plain")
        self.send_response(200)
        self.send_header("Content-Length", str(len(self.server.apk)))
        self.end_headers()

    def do_POST(self):
        """The signed-artifact steps (music_app/services/android_artifact_access.py) with every key and signature accepted."""
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        path = urlsplit(self.path).path
        if path == "/artifacts/android/challenge":
            body = {"challenge": base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip("=")}
        elif path == "/artifacts/android/attest":
            body = {"deviceKey": str(uuid.uuid4())}
        elif path == f"/artifacts/android/stable/{APK_NAME}":
            body = {"path": DOWNLOAD_PATH}
        else:
            body = {"protocol": 1, "claimToken": "update-e2e"}
        self.respond(200, json.dumps(body).encode(), "application/json")

    do_PUT = do_POST
    do_DELETE = do_POST


class Device:
    def __init__(self, adb: str, serial: str):
        self.adb = [adb, "-s", serial]

    def run(self, *args: str, check: bool = True) -> str:
        result = subprocess.run(self.adb + list(args), capture_output=True, text=True, timeout=180)
        if check and result.returncode != 0:
            raise RuntimeError(f"adb {' '.join(args)} failed: {result.stdout}{result.stderr}")
        return result.stdout

    def shell(self, command: str, check: bool = True) -> str:
        return self.run("shell", command, check=check)

    def nodes(self) -> list[ElementTree.Element]:
        for _ in range(3):
            if "dumped" in self.shell("uiautomator dump /sdcard/e2e-ui.xml", check=False):
                return list(ElementTree.fromstring(self.shell("cat /sdcard/e2e-ui.xml")).iter("node"))
            time.sleep(1)
        return []

    def tap(self, bounds: str):
        left, top, right, bottom = map(int, re.findall(r"\d+", bounds))
        self.shell(f"input tap {(left + right) // 2} {(top + bottom) // 2}")

    def version_code(self) -> int | None:
        found = re.search(r"versionCode=(\d+)", self.shell(f"dumpsys package {PACKAGE}", check=False))
        return int(found.group(1)) if found else None

    def resumed(self) -> bool:
        activities = self.shell("dumpsys activity activities")
        short = ACTIVITY.replace("org.albumhaven.shell.", ".")
        return any(ACTIVITY in line or short in line for line in activities.splitlines() if "ResumedActivity" in line)

    def install_fresh(self, apk: Path, overlay: bool):
        # A confirmation an earlier case left open would cover this one's.
        for installer in INSTALLER_PACKAGES:
            self.shell(f"am force-stop {installer}", check=False)
        self.shell("input keyevent KEYCODE_HOME")
        self.run("uninstall", PACKAGE, check=False)
        self.run("install", "-g", str(apk))
        self.shell(f"appops set {PACKAGE} REQUEST_INSTALL_PACKAGES allow")
        self.shell(f"appops set {PACKAGE} SYSTEM_ALERT_WINDOW {'allow' if overlay else 'deny'}")


def wait(what: str, condition, seconds: float = 90):
    deadline = time.time() + seconds
    while time.time() < deadline:
        value = condition()
        if value:
            return value
        time.sleep(0.5)
    raise AssertionError(f"Timed out waiting for {what}")


def expect(condition: bool, message: str):
    if not condition:
        raise AssertionError(message)


def installer_button(device: Device):
    """The bounds of the button on Android's confirmation for this update that installs it."""
    for node in device.nodes():
        if node.get("package") in INSTALLER_PACKAGES and node.get("text", "").strip().upper() in ("UPDATE", "INSTALL"):
            return node.get("bounds")
    return None


def press_update_once(device: Device, origin: Origin, decline_overlay: bool):
    device.shell(f"am start -W -n {ACTIVITY}")
    if decline_overlay:
        # The first Update asks once for "Appear on top"; the user comes back without allowing it.
        wait("the Appear on top setting", lambda: "com.android.settings" in device.shell("dumpsys window | grep mCurrentFocus"))
        device.shell("input keyevent KEYCODE_BACK")
    button = wait("Android's install confirmation", lambda: installer_button(device), 180)
    expect(origin.reported("pressed") == ["updates.download"], f"Update pressed {origin.reported('pressed')}")
    states = origin.reported("state")
    for state in ("available", "downloading", "verifying", "installing"):
        expect(state in states, f"no {state} state in {states}")
    expect("failed" not in states, f"the update failed: {states}")
    return button


def install_confirmed(device: Device, origin: Origin, button: str, new_version: int) -> float:
    origin.hold_after = time.time()
    device.tap(button)
    wait("the package replaced", lambda: device.version_code() == new_version, 180)
    return origin.hold_after


def reopens_on_the_update_page(device: Device, origin: Origin, old: Path, new_version: int):
    device.install_fresh(old, overlay=True)
    button = press_update_once(device, origin, decline_overlay=False)
    # Leaving for Android's confirmation pictured the page; the old version's picture must not show.
    about = device.shell(f"run-as {PACKAGE} cat cache/last-screen.properties", check=False)
    unescaped = re.sub(r"\\(.)", r"\1", about)  # Java properties escape ':' and '='.
    expect(f"url={ORIGIN}{UPDATE_PAGE}" in unescaped, f"no picture of the update page: {about!r}")
    installed_at = install_confirmed(device, origin, button, new_version)
    wait("the updated app's page request", origin.held.is_set, 60)
    # While the reopened page is held back, nothing shows the old version's picture of it.
    covering = [node.get("resource-id") for node in device.nodes()]
    expect(f"{PACKAGE}:id/last_screen" not in covering, "the old version's picture shows after the update")
    wait("the updated app on screen", device.resumed, 60)
    reopened = origin.pages_after(installed_at)
    expect(reopened[:1] == [UPDATE_PAGE], f"reopened on {reopened}, not {UPDATE_PAGE}")
    wait("the reopened page", lambda: UPDATE_PAGE in origin.reported("handshake", after=installed_at), 60)


def notifies_without_appear_on_top(device: Device, origin: Origin, old: Path, new_version: int):
    # Installed with -g, so notifications are allowed.
    device.install_fresh(old, overlay=False)
    button = press_update_once(device, origin, decline_overlay=True)
    installed_at = install_confirmed(device, origin, button, new_version)
    wait(
        "the Album Haven updated notification",
        lambda: "Album Haven updated" in device.shell("dumpsys notification --noredact", check=False),
        60,
    )
    time.sleep(5)
    expect(not origin.pages_after(installed_at), "the app opened itself without Appear on top")
    expect(not device.resumed(), "the app is on screen without Appear on top")


def signing_certificate(apk: Path) -> str:
    sdk = Path(os.environ.get("ANDROID_HOME") or os.environ["ANDROID_SDK_ROOT"])
    apksigner = sorted((sdk / "build-tools").glob("*/apksigner*"))[-1]
    printed = subprocess.run([str(apksigner), "verify", "--print-certs", str(apk)], capture_output=True, text=True, check=True).stdout
    return re.search(r"certificate SHA-256 digest: ([0-9a-f]{64})", printed).group(1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--adb", default="adb")
    parser.add_argument("--serial", required=True)
    parser.add_argument("--old", type=Path, required=True, help="the debug APK installed first")
    parser.add_argument("--new", type=Path, required=True, help="the same build with a higher version code")
    parser.add_argument("--new-version-code", type=int, default=2)
    parser.add_argument("--new-version-name", default="0.10.1")
    args = parser.parse_args()

    apk = args.new.read_bytes()
    manifest = {
        "schemaVersion": 1, "channel": "stable", "applicationId": PACKAGE,
        "versionCode": args.new_version_code, "versionName": args.new_version_name,
        "sourceCommit": "0" * 40, "apkUrl": f"{ORIGIN}/artifacts/android/stable/{APK_NAME}",
        "apkSize": len(apk), "sha256": hashlib.sha256(apk).hexdigest(),
        "signingCertificateSha256": signing_certificate(args.new), "minAndroidApi": 29,
        "bridgeProtocolMin": 1, "bridgeProtocolMax": 1, "publishedAt": "2026-11-09T00:00:00Z",
        "releaseNotesUrl": "https://albumhaven.org/releases",
    }
    device = Device(args.adb, args.serial)
    cases = [
        ("one press installs; the update reopens on its page without the old picture", reopens_on_the_update_page),
        ("one press installs; without Appear on top a notification offers the update", notifies_without_appear_on_top),
    ]
    failures = 0
    for name, case in cases:
        origin = Origin(manifest, apk)
        threading.Thread(target=origin.serve_forever, daemon=True).start()
        device.run("reverse", f"tcp:{DEV_PORT}", f"tcp:{origin.server_address[1]}")
        try:
            case(device, origin, args.old, args.new_version_code)
            print(f"PASS {name}")
        except Exception as failure:  # Every case runs; each failure is reported.
            failures += 1
            screen = [(node.get("package"), node.get("text")) for node in device.nodes() if node.get("text")]
            print(f"FAIL {name}: {failure}\n  reports: {origin.reports}\n  pages: {origin.pages}\n  screen: {screen}")
        finally:
            device.run("reverse", "--remove", f"tcp:{DEV_PORT}", check=False)
            origin.shutdown()
            device.run("uninstall", PACKAGE, check=False)
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
