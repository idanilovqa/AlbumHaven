from music_app.routes import api_wave_a_asgi_routes
from music_app.services import edit_workflows


def test_genre_is_an_allowed_media_tag_edit_field():
    assert "genre" in edit_workflows._ALLOWED_TAG_EDIT_FIELDS
    assert "genre" in api_wave_a_asgi_routes._MEDIA_TAG_EDIT_FIELDS
