from __future__ import annotations

import hashlib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_login_ui_assets_are_present_and_use_the_exact_approved_brand_mark():
    template = ROOT / "music_app" / "templates" / "login.html"
    stylesheet = ROOT / "music_app" / "static" / "css" / "login.css"
    script = ROOT / "music_app" / "static" / "js" / "login.js"
    mark = ROOT / "music_app" / "static" / "images" / "album-haven-cloud-vinyl.png"

    assert template.is_file()
    assert stylesheet.is_file()
    assert script.is_file()
    assert mark.is_file()
    assert hashlib.sha256(mark.read_bytes()).hexdigest() == (
        "febbc15f861cc64c87b4f1161feb5c9876832cc8ab4f516ac7b31c84cc6a69d1"
    )
