from __future__ import annotations


def test_resolve_client_surface_class_is_framework_neutral():
    import music_app.services.client_surfaces as client_surfaces

    assert not hasattr(client_surfaces, "request")
    assert not hasattr(client_surfaces, "current_app")
    assert not hasattr(client_surfaces, "has_request_context")
    assert client_surfaces.resolve_client_surface_class() == "private_web"
    assert client_surfaces.resolve_client_surface_class("TV") == "tv"
    assert client_surfaces.resolve_client_surface_class(None, default="mobile") == "mobile"
