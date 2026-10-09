"""Launch production ASGI after one isolated Home fixture setup; no control API."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from isolatedLibraryApp import configure_isolated_environment
from isolatedPostgres import (
    IsolatedDatabaseOwnershipLock,
    configure_performance_auth_environment,
    prepare_isolated_database,
    provision_performance_auth_owner,
    resolve_isolated_database_urls,
)
from homeFeedbackData import prepare_home_media, persist_home_inventory, seed_home_feedback


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--manifest", required=True, type=Path)
    args = parser.parse_args()
    if not 1 <= args.port <= 65534:
        parser.error("--port must be between 1 and 65534")
    configured_root = os.environ.get("ALBUM_HAVEN_E2E_TEMP_ROOT", "").strip()
    if os.environ.get("PLAYWRIGHT_MANAGED_APP") != "1" or not configured_root:
        parser.error("Home feedback must be launched by the Playwright wrapper with an owned temporary root")
    temp_root = Path(configured_root).resolve(strict=True)
    if not temp_root.is_dir():
        parser.error("The wrapper-owned temporary root must exist")
    manifest = args.manifest.resolve()
    if manifest != temp_root / "home-feedback-manifest.json":
        parser.error("--manifest must be the exact wrapper-owned Home manifest")
    setup_url, runtime_url = resolve_isolated_database_urls()
    # A previous launch must not leave a readable stale source oracle on failure.
    manifest.unlink(missing_ok=True)
    lock = IsolatedDatabaseOwnershipLock(database_url=setup_url)
    owned = False
    try:
        lock.acquire()
        owned = True
        library_root = configure_isolated_environment(temp_root, runtime_url, args.port + 1)
        # The canonical public URL stays HTTPS. Production auth_asgi explicitly
        # admits exact-origin direct HTTP loopback with Secure cookies; this is
        # the same transport as phase7AuthApp and isolatedLibraryApp, with no
        # trusted proxy, insecure-cookie override, or browser TLS bypass.
        configure_performance_auth_environment(args.port)
        # Every cover is local. No external account or live provider participates.
        os.environ.update({"MUSICBRAINZ_ENABLED": "0", "ALBUM_HAVEN_COVER_PROVIDER_GROUPS": "offline",
                           "LASTFM_API_KEY": "", "LASTFM_API_SECRET": "",
                           "ALBUM_HAVEN_DEPLOYMENT_MODE": "self_hosted"})
        prepare_isolated_database(setup_url, runtime_url)
        provision_performance_auth_owner(runtime_url)
        inventory = prepare_home_media(library_root)
        persist_home_inventory(setup_url, library_root, inventory)
        fixture = seed_home_feedback(setup_url)
        manifest.parent.mkdir(parents=True, exist_ok=True)
        manifest.write_text(json.dumps(fixture, indent=2) + "\n", encoding="utf-8")
        # The manifest is exclusively a browser-harness oracle. No production
        # configuration, route, repository or startup path receives it.
        from music_app import create_asgi_app
        import uvicorn

        app = create_asgi_app()
        uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")
    finally:
        # A forced Windows process stop need not execute this block. The runner
        # proves process exit before database reset and deletion of its leased
        # temporary root, so cleanup never relies on Python finally running.
        if owned:
            lock.release()


if __name__ == "__main__":
    main()
