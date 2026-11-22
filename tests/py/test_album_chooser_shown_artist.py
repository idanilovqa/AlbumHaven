"""The Cover Look Up split chooser's releases carry the artist as the card shows it."""
from __future__ import annotations

import asyncio

from music_app.routes import api_wave_d_asgi_routes as routes


def test_the_split_choosers_releases_go_through_the_cards_display_projection(monkeypatch):
    projected = []

    def project(_config, payload):
        projected.append(payload)
        payload[0]["display_artist"] = "Shaman"
        return payload

    monkeypatch.setattr(routes, "project_correction_display", project, raising=False)
    choices = [{"album_id": 1, "album_key": "a", "name": "Idja", "album_artist": "Korpiklaani"},
               {"album_id": 2, "album_key": "b", "name": "Idja", "album_artist": "Korpiklaani"}]

    payload, status = asyncio.run(routes._cover_lookup_album_split_response({}, {"one", "two"}, choices))

    first, second = payload["current_releases"]
    assert status == 409 and len(projected) == 1, "one read for the whole chooser"
    assert (first["display_artist"], first["album_artist"]) == ("Shaman", "Korpiklaani")
    assert "display_artist" not in second
