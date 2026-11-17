"""The edge that turns cover paths into opaque references and back (no database)."""

from html import escape
import json
from urllib.parse import quote

from music_app.services.cover_reference_boundary import (
    UNAVAILABLE_COVER_URL,
    carries_cover_paths,
    publish_cover_references,
    resolve_cover_references,
)

COVER = r"C:\Music\Broadcast\Tender Buttons\cover.jpg"
CANDIDATE = r"C:\Music\Broadcast\Tender Buttons\Art\back.jpg"
REFERENCES = {COVER: "CoverReference00000000", CANDIDATE: "CandidateReference0000"}


class Namer:
    def __init__(self, known=REFERENCES):
        self.known = dict(known)
        self.calls = []

    def __call__(self, library_id, wanted):
        self.calls.append((library_id, dict(wanted)))
        return {path: self.known[path] for path in wanted if path in self.known}


def publish(text, library_id=7, namer=None):
    namer = namer or Namer()
    return publish_cover_references(text, library_id, namer), namer


def test_json_cover_fields_become_reference_fields_with_one_naming_call():
    body = json.dumps({
        "albums": [
            {"cover_path": COVER, "tracks": [{"path": "C:/Music/x.flac", "cover_path": COVER}]},
            {"cover_path": None},
            {"cover_path": ""},
        ],
        "active_cover_path": COVER,
        "selected_cover_path": COVER,
        "track": {"coverPath": COVER},
        "optimistic_cover_path": COVER,
    })

    published, namer = publish(body)

    payload = json.loads(published)
    assert payload["albums"][0]["cover_ref"] == REFERENCES[COVER]
    assert payload["albums"][0]["tracks"][0]["cover_ref"] == REFERENCES[COVER]
    assert payload["albums"][1]["cover_ref"] is None and payload["albums"][2]["cover_ref"] == ""
    assert payload["active_cover_ref"] == payload["selected_cover_ref"] == REFERENCES[COVER]
    assert payload["track"]["coverRef"] == payload["optimistic_cover_ref"] == REFERENCES[COVER]
    assert "cover_path" not in published and "coverPath" not in published and "Broadcast" not in published
    # Track paths are not covers and are left alone (opaque track references come later).
    assert payload["albums"][0]["tracks"][0]["path"] == "C:/Music/x.flac"
    assert namer.calls == [(7, {COVER: "cover"})]


def test_lookup_candidates_are_named_as_candidates_unless_they_are_also_the_cover():
    body = json.dumps({
        "active_cover_path": COVER,
        "selected_source_cover_path": CANDIDATE,
        "local_covers": [
            {"candidate_cover_path": COVER, "is_active": True},
            {"candidate_cover_path": CANDIDATE, "duplicate_of_cover_path": COVER},
        ],
    })

    published, namer = publish(body)

    assert namer.calls == [(7, {COVER: "cover", CANDIDATE: "candidate"})]
    payload = json.loads(published)
    assert payload["selected_source_cover_ref"] == REFERENCES[CANDIDATE]
    assert [item["candidate_cover_ref"] for item in payload["local_covers"]] == [REFERENCES[COVER], REFERENCES[CANDIDATE]]
    assert payload["local_covers"][1]["duplicate_of_cover_ref"] == REFERENCES[COVER]


def test_html_attributes_and_legacy_urls_in_every_encoding_become_references():
    encoded = quote(COVER)
    html = (
        f'<img src="/cover?path={encoded}&amp;size=480&amp;v=r1" data-cover-path="{escape(COVER)}">'
        f'<script>window.x = {{"cover_preview_url": "/cover?path={encoded}\\u0026size=480"}};</script>'
        f'<a href="/cover?path={encoded}">full</a>'
        f'{{"cover_preview_url":"/cover?path={encoded}&v=r2"}}'
    )

    published, _namer = publish(html)

    reference = REFERENCES[COVER]
    assert f'src="/cover/{reference}?size=480&amp;v=r1"' in published
    assert f'data-cover-ref="{reference}"' in published
    assert f'"/cover/{reference}?size=480"' in published
    assert f'href="/cover/{reference}"' in published
    assert f'"/cover/{reference}?v=r2"' in published
    assert "path=" not in published and "Broadcast" not in published


def test_a_path_that_cannot_be_named_never_leaves_as_itself():
    body = json.dumps({"cover_path": COVER, "cover_preview_url": f"/cover?path={quote(COVER)}&size=480"})
    attribute = f'<img data-cover-path="{escape(COVER)}">'

    for library_id, namer in ((None, Namer()), (7, Namer(known={}))):
        published = publish_cover_references(body + attribute, library_id, namer)
        assert "Broadcast" not in published
        assert '"cover_ref": null' in published
        assert f'"{UNAVAILABLE_COVER_URL}?size=480"' in published
        assert 'data-cover-ref=""' in published
    assert Namer().calls == []


def test_text_without_cover_paths_is_returned_unchanged_without_naming():
    namer = Namer()
    body = json.dumps({"albums": [{"cover_ref": "x", "path": "C:/Music/a.flac"}], "url": "/cover/x?size=1"})

    assert not carries_cover_paths(body)
    assert publish_cover_references(body, 7, namer) is body
    assert namer.calls == []


def test_request_references_become_paths_and_unknown_or_malformed_ones_become_null():
    seen = []

    def resolve(library_id, references):
        seen.append((library_id, set(references)))
        return {REFERENCES[COVER]: COVER}

    body = json.dumps({
        "album": {"cover_ref": REFERENCES[COVER], "tracks": [{"path": "C:/Music/a.flac"}]},
        "source_cover_ref": "UnknownReference000000",
        "selected_cover_ref": "../../etc/passwd",
        "coverRef": None,
    })

    resolved = json.loads(resolve_cover_references(body, 7, resolve))

    assert resolved["album"]["cover_path"] == COVER
    assert resolved["source_path"] is None
    assert resolved["selected_cover_path"] is None
    assert resolved["coverPath"] is None
    assert resolved["album"]["tracks"][0]["path"] == "C:/Music/a.flac"
    assert seen == [(7, {REFERENCES[COVER], "UnknownReference000000"})]


def test_requests_from_an_actor_without_a_library_resolve_nothing():
    body = json.dumps({"cover_ref": REFERENCES[COVER]})

    resolved = json.loads(resolve_cover_references(body, None, lambda *_args: {REFERENCES[COVER]: COVER}))

    assert resolved == {"cover_path": None}
