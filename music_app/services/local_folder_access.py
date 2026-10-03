"""Presentation and route ceiling for the existing server-side folder launcher.

A remote server's filesystem visibility is not evidence of a client mount.
Network-client/native path mappings require a client-side launcher; this route
must never open Explorer on somebody else's server desktop.
"""
from __future__ import annotations

import ipaddress
import os
import sys


def _loopback(value: object) -> bool:
    text = str(value or "").strip().strip("[]").casefold()
    if text == "localhost":
        return True
    try:
        address = ipaddress.ip_address(text)
        return (getattr(address, "ipv4_mapped", None) or address).is_loopback
    except ValueError:
        return False


def can_open_client_folder(request, *, platform: str | None = None, environ=None) -> bool:
    peer = getattr(getattr(request, "client", None), "host", None)
    host = getattr(getattr(request, "url", None), "hostname", None)
    if not _loopback(peer) or not _loopback(host):
        return False
    # Do not mistake a local reverse proxy for a same-machine browser.
    if any(request.headers.get(key) for key in ("forwarded", "x-forwarded-for", "x-forwarded-host")):
        return False
    os_name = sys.platform if platform is None else platform
    env = os.environ if environ is None else environ
    return os_name.startswith("win") or os_name == "darwin" or bool(env.get("DISPLAY") or env.get("WAYLAND_DISPLAY"))
