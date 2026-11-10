"""HTTP/policy integration for duplicate review, without a database or real login.

Uses the actual API router, production private-route middleware, request actor
resolution, and PolicyEvaluator. Only session storage and repository returns are
fixtures. This is not PostgreSQL integration, DB-backed session authentication,
or browser coverage. Dependency provisioning belongs to the test environment.
"""
from __future__ import annotations

import asyncio
from copy import deepcopy
import json
import os
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit


DETAIL_URLS = (
    "/album-details?album_key=artist%3A%3Arelease",
    "/utilities/problematic-files/detail?album_key=artist%3A%3Arelease",
    "/utilities/problematic-files/artist::release",
)
SUMMARY_URL = "/utilities/problematic-files"


def source_fixture():
    return [
        {"folder_path": "/PRIVATE_CANARY/first", "tracks": [
            {"path": "/PRIVATE_CANARY/first/01.flac", "title": "First song", "duration_seconds": 61,
             "track_ref": "first-semantic-ref", "track_number": 1}]},
        {"folder_path": "/PRIVATE_CANARY/second", "tracks": [
            {"path": "/PRIVATE_CANARY/second/01.mp3", "title": "Second song", "duration_seconds": 62,
             "track_ref": "second-semantic-ref", "track_number": 1}]},
    ]


class CookieActorResolver:
    """Fixture session store only; never injects request.state or policy results."""
    def __init__(self, actors, anonymous):
        self.actors = actors
        self.anonymous = anonymous
        self.calls = []

    def resolve(self, token):
        self.calls.append(token)
        return self.actors.get(token, self.anonymous)


async def http_get(app, url, token=None):
    target = urlsplit(url)
    headers = [(b"host", b"music.test")]
    if token is not None:
        headers.append((b"cookie", f"__Host-album_haven_session={token}".encode("ascii")))
    messages = []
    sent = False
    response_complete = asyncio.Event()

    async def receive():
        nonlocal sent
        if not sent:
            sent = True
            return {"type": "http.request", "body": b"", "more_body": False}
        # A real client remains connected until the streaming middleware finishes.
        await response_complete.wait()
        return {"type": "http.disconnect"}

    async def send(message):
        messages.append(message)
        if message["type"] == "http.response.body" and not message.get("more_body", False):
            response_complete.set()

    await app({
        "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
        "method": "GET", "scheme": "https", "path": target.path,
        "raw_path": target.path.encode("ascii"), "query_string": target.query.encode("ascii"),
        "headers": headers, "client": ("203.0.113.8", 50000), "server": ("music.test", 443),
    }, receive, send)
    start = next(message for message in messages if message["type"] == "http.response.start")
    body = b"".join(message.get("body", b"") for message in messages if message["type"] == "http.response.body")
    return start["status"], json.loads(body)


class DuplicateCopyReviewHttpPolicyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Imports can load runtime configuration; isolate its writable data first.
        temporary = TemporaryDirectory(prefix="albumhaven-duplicate-api-")
        cls.addClassCleanup(temporary.cleanup)
        environment = patch.dict(os.environ, {"MUSIC_APP_DATA_DIR": temporary.name})
        environment.start()
        cls.addClassCleanup(environment.stop)
        from fastapi import FastAPI
        from music_app.routes import api_read_asgi_routes
        from music_app.services import current_actor, private_route_boundary, policy_evaluator
        cls.fastapi_type = FastAPI
        cls.routes = api_read_asgi_routes
        cls.actors = current_actor
        cls.boundary = private_route_boundary
        cls.policy = policy_evaluator

    def actor(self, *, path_library=None, route_grants=True):
        actions = ["library.browse.read", "library.problems.read"] if route_grants else []
        grants = [self.actors.CapabilityGrant(action, "library", 23) for action in actions]
        if path_library is not None:
            grants.append(self.actors.CapabilityGrant("library.paths.read", "library", path_library))
        return self.actors.CurrentActor(
            state=self.actors.ActorState.ACTIVE, account_id=7, session_id=11,
            username_display="duplicate-reader", current_library_id=23,
            library_relationships=(self.actors.LibraryRelationship(23, "member", False),),
            capability_grants=tuple(grants),
        )

    def setUp(self):
        import psycopg
        deny_database = patch.object(psycopg, "connect", side_effect=AssertionError("HTTP fixture must not open a database"))
        deny_database.start()
        self.addCleanup(deny_database.stop)
        self.sources = source_fixture()
        self.before = deepcopy(self.sources)
        self.repository_calls = []
        self.after_repository_read = lambda: None
        owner = self

        class RepositoryReturns:
            def __init__(self, config):
                owner.assertEqual(config["PERSISTENCE_BACKENDS"]["library_browse"], "postgres")

            def album(self):
                # Share source objects deliberately, exposing request leakage.
                return {"key": "artist::release", "album_artist": "Artist", "album_id": 42,
                        "name": "Release", "suggested_edits": [], "duplicate_sources": owner.sources,
                        "tracks": [{"title": "Ordinary", "track_ref": "ordinary-semantic-ref"}]}

            def build_album_detail_payload(self, album_key, *, client_surface_class):
                owner.assertEqual(album_key, "artist::release")
                owner.assertEqual(client_surface_class, "private_web")
                owner.repository_calls.append("album")
                payload = self.album()
                owner.after_repository_read()
                return payload

            def build_problematic_file_detail_payload(self, album_key):
                owner.assertEqual(album_key, "artist::release")
                owner.repository_calls.append("problem-detail")
                return self.album()

            def build_problematic_files_payload(self):
                owner.repository_calls.append("problem-summary")
                return {"ok": True, "albums": [self.album()]}

        repository_patch = patch.object(self.routes, "PostgresLibraryBrowseRepository", RepositoryReturns)
        repository_patch.start()
        self.addCleanup(repository_patch.stop)
        self.tokens = {"redacted": "r" * 43, "visible": "v" * 43, "wrong-library": "w" * 43, "denied": "d" * 43}
        self.resolver = CookieActorResolver({
            self.tokens["redacted"]: self.actor(),
            self.tokens["visible"]: self.actor(path_library=23),
            self.tokens["wrong-library"]: self.actor(path_library=99),
            self.tokens["denied"]: self.actor(path_library=23, route_grants=False),
        }, self.actors.CurrentActor.anonymous())
        self.app = self.fastapi_type()
        self.app.state.current_actor_resolver = self.resolver
        self.app.state.config = {
            "ALBUM_HAVEN_DEPLOYMENT_MODE": "self_hosted",
            "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://fixture.invalid/never_connect",
            "PERSISTENCE_BACKENDS": {"library_browse": "postgres"},
        }
        self.app.state.auth_policy_config = {"hmac": {"secret": "test-only-policy-origin-key-32-bytes-minimum", "key_version": 1}}
        self.app.state.library_state = {}
        self.boundary.install_private_route_boundary(self.app)
        self.app.include_router(self.routes.router)

    def request(self, url, actor_name, *, expected_resolutions=1):
        before = len(self.resolver.calls)
        token = self.tokens.get(actor_name, actor_name)
        result = asyncio.run(http_get(self.app, url, token))
        self.assertEqual(
            self.resolver.calls[before:], [token] * expected_resolutions,
            "Only entered album detail refreshes authority before response projection",
        )
        self.assertIsInstance(self.app.state.policy_evaluator, self.policy.PolicyEvaluator)
        return result

    def test_detail_routes_evaluate_real_path_grants_without_delete_and_preserve_request_order(self):
        for url in DETAIL_URLS:
            # Both directions reveal request-dependent mutation/cache leakage.
            for actor_name in ("redacted", "visible", "redacted", "visible"):
                with self.subTest(url=url, actor=actor_name):
                    status, body = self.request(
                        url, actor_name, expected_resolutions=2 if url.startswith("/album-details") else 1,
                    )
                    self.assertEqual(status, 200)
                    album = body["album"] if url.startswith("/album-details") else body
                    visible = actor_name == "visible"
                    if visible:
                        self.assertIs(album["allowed_actions"]["library.paths.read"], True)
                    else:
                        self.assertNotIn("library.paths.read", album["allowed_actions"])
                    self.assertNotIn("library.inventory.manage", album["allowed_actions"])
                    self.assertEqual(album["tracks"][0]["track_ref"], "ordinary-semantic-ref")
                    self.assertEqual(album["duplicate_source_count"], 2)
                    self.assertEqual([copy["folder_name"] for copy in album["duplicate_copy_review"]], ["first", "second"])
                    self.assertEqual([copy["copy_number"] for copy in album["duplicate_copy_review"]], [1, 2])
                    if visible:
                        self.assertEqual(album["duplicate_sources"], self.before)
                        self.assertEqual(album["duplicate_copy_review"][0]["tracks"][0]["path"], self.before[0]["tracks"][0]["path"])
                    else:
                        self.assertEqual(album["duplicate_sources"], [])
                        self.assertNotIn("PRIVATE_CANARY", json.dumps(album["duplicate_copy_review"]))
                        self.assertNotIn("semantic-ref", json.dumps(album["duplicate_copy_review"]))
                    self.assertEqual(self.sources, self.before)

    def test_wrong_library_path_grant_does_not_authorize_path_disclosure(self):
        for url in DETAIL_URLS:
            with self.subTest(url=url):
                status, body = self.request(
                    url, "wrong-library", expected_resolutions=2 if url.startswith("/album-details") else 1,
                )
                self.assertEqual(status, 200)
                album = body["album"] if url.startswith("/album-details") else body
                self.assertNotIn("library.paths.read", album["allowed_actions"])
                self.assertEqual(album["duplicate_sources"], [])
                self.assertEqual(len(album["duplicate_copy_review"]), 2)
                self.assertNotIn("PRIVATE_CANARY", json.dumps(album["duplicate_copy_review"]))

    def test_actual_private_boundary_denies_anonymous_and_missing_route_grants_before_repository(self):
        for url in (*DETAIL_URLS, SUMMARY_URL):
            for actor_name, expected in ((None, 401), ("unknown-session", 401), ("denied", 403)):
                with self.subTest(url=url, actor=actor_name):
                    self.repository_calls.clear()
                    status, body = self.request(url, actor_name)
                    self.assertEqual(status, expected)
                    self.assertEqual(body["detail"], "Authentication required." if expected == 401 else "Action not permitted.")
                    self.assertEqual(self.repository_calls, [])

    def test_album_detail_rechecks_revoked_authority_after_repository_and_cover_work(self):
        for phase in ("repository", "cover"):
            for revocation, expected in (("browse", 403), ("session", 401)):
                with self.subTest(phase=phase, revocation=revocation):
                    token = self.tokens["visible"]
                    self.resolver.actors[token] = self.actor(path_library=23)
                    self.repository_calls.clear()

                    def revoke():
                        if revocation == "session":
                            self.resolver.actors.pop(token)
                        else:
                            self.resolver.actors[token] = self.actor(path_library=23, route_grants=False)

                    self.after_repository_read = revoke if phase == "repository" else lambda: None
                    with patch.object(self.routes, "_repair_album_detail_cover_identity",
                                      side_effect=lambda *_: revoke() if phase == "cover" else None) as repair:
                        status, body = self.request(DETAIL_URLS[0], "visible", expected_resolutions=2)
                    self.assertEqual(self.repository_calls, ["album"])
                    repair.assert_called_once()
                    self.assertEqual(status, expected)
                    self.assertEqual(body, {"detail": "Authentication required." if expected == 401 else "Action not permitted."})
                    self.assertNotIn("PRIVATE_CANARY", json.dumps(body))
                    self.assertNotIn("semantic-ref", json.dumps(body))
                    self.assertEqual(self.sources, self.before)

    def test_album_detail_projects_refreshed_path_grants_after_repository_and_cover_work(self):
        for phase in ("repository", "cover"):
            for paths_allowed in (False, True):
                with self.subTest(phase=phase, paths_allowed=paths_allowed):
                    token = self.tokens["visible"]
                    self.resolver.actors[token] = self.actor(path_library=None if paths_allowed else 23)
                    self.repository_calls.clear()

                    def change_path_grant():
                        self.resolver.actors[token] = self.actor(path_library=23 if paths_allowed else None)

                    self.after_repository_read = change_path_grant if phase == "repository" else lambda: None
                    with patch.object(self.routes, "_repair_album_detail_cover_identity",
                                      side_effect=lambda *_: change_path_grant() if phase == "cover" else None) as repair:
                        status, body = self.request(DETAIL_URLS[0], "visible", expected_resolutions=2)
                    self.assertEqual(self.repository_calls, ["album"])
                    repair.assert_called_once()
                    self.assertEqual(status, 200)
                    album = body["album"]
                    self.assertEqual(album["duplicate_source_count"], 2)
                    self.assertEqual(len(album["duplicate_copy_review"]), 2)
                    self.assertNotIn("library.inventory.manage", album["allowed_actions"])
                    self.assertEqual(album["tracks"][0]["track_ref"], "ordinary-semantic-ref")
                    if paths_allowed:
                        self.assertIs(album["allowed_actions"]["library.paths.read"], True)
                        self.assertEqual(album["duplicate_sources"], self.before)
                        for index, source in enumerate(self.before):
                            self.assertEqual(album["duplicate_copy_review"][index]["folder_path"], source["folder_path"])
                            self.assertEqual(album["duplicate_copy_review"][index]["tracks"][0]["path"], source["tracks"][0]["path"])
                    else:
                        self.assertNotIn("library.paths.read", album["allowed_actions"])
                        self.assertEqual(album["duplicate_sources"], [])
                        self.assertNotIn("PRIVATE_CANARY", json.dumps(body))
                    self.assertNotIn("semantic-ref", json.dumps(album["duplicate_copy_review"]))
                    self.assertEqual(self.sources, self.before)

    def test_summary_uses_real_policy_but_never_builds_review_dto(self):
        for actor_name in ("visible", "redacted", "wrong-library"):
            with self.subTest(actor=actor_name):
                status, body = self.request(SUMMARY_URL, actor_name)
                self.assertEqual(status, 200)
                self.assertNotIn("duplicate_copy_review", json.dumps(body))
                album = body["albums"][0]
                self.assertEqual(album["duplicate_source_count"], 2)
                self.assertEqual(album["duplicate_sources"], self.before if actor_name == "visible" else [])
                self.assertEqual(self.sources, self.before)


if __name__ == "__main__":
    unittest.main()
