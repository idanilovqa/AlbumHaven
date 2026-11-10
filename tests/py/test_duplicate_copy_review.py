"""Pure request-projection contracts; no app/database or filesystem fixtures."""
from copy import deepcopy
import json
import unittest

from music_app.services.duplicate_copy_review import project_duplicate_copy_review


def copies():
    return [
        {"folder_path": "/private/root/雪 release", "folder_name": "unsafe/raw/root",
         "total_duration_seconds": 999, "root_id": 7, "cover_path": "/private/cover",
         "tracks": [{"path": "/private/root/雪 release/01 song.FLAC", "title": "雪 song",
                     "artist": "Artist", "year": 2024, "track_number": 1, "disc_number": 2,
                     "duration_seconds": 0, "track_ref": "secret-ref", "id": 78,
                     "cover": {"url": "secret-cover"}}]},
        {"folder_path": "C:\\private\\second copy\\", "tracks": [
            {"path": "C:\\private\\second copy\\01 song.mp3", "title": "Other song",
             "duration_seconds": 61.5, "codec": "mp3", "bitrate": 320000,
             "sample_rate": 44100, "bit_depth": 16},
            {"path": "C:\\private\\second copy\\02 song.mp3", "title": "Second song",
             "duration_seconds": None}]},
    ]


class DuplicateCopyReviewTests(unittest.TestCase):
    def test_redacted_projection_allowlists_fields_and_preserves_source_order(self):
        result = project_duplicate_copy_review(copies(), include_paths=False)
        self.assertEqual([r["copy_number"] for r in result], [1, 2])
        self.assertEqual([r["folder_name"] for r in result], ["雪 release", "second copy"])
        self.assertEqual([r["track_count"] for r in result], [1, 2])
        for copy in result:
            self.assertEqual(set(copy), {"copy_number", "folder_name", "track_count", "total_duration_seconds", "tracks"})
            for track in copy["tracks"]:
                self.assertEqual(set(track), {"title", "file_name", "track_number", "disc_number", "artist", "year", "duration_seconds", "format", "codec", "bitrate", "sample_rate", "bit_depth"})
        track = result[0]["tracks"][0]
        self.assertEqual(track["file_name"], "01 song.FLAC")
        self.assertEqual(track["format"], "FLAC")
        self.assertEqual(track["title"], "雪 song")
        self.assertEqual(track["artist"], "Artist")
        self.assertEqual((track["track_number"], track["disc_number"], track["year"]), (1, 2, 2024))
        for secret in ("private", "secret-ref", "secret-cover", "root_id", "cover_path"):
            self.assertNotIn(secret, json.dumps(result))

    def test_paths_are_opt_in_and_original_copy_playback_references_untouched(self):
        sources = copies()
        before = deepcopy(sources)
        redacted = project_duplicate_copy_review(sources, include_paths=False)
        visible = project_duplicate_copy_review(sources, include_paths=True)
        for index, source in enumerate(sources):
            self.assertEqual(visible[index]["folder_path"], source["folder_path"])
            self.assertEqual([t["path"] for t in visible[index]["tracks"]], [t["path"] for t in source["tracks"]])
        self.assertEqual(sources, before)
        visible[0]["tracks"][0]["title"] = "changed response"
        self.assertEqual(sources, before)
        self.assertEqual(project_duplicate_copy_review(sources, include_paths=False), redacted)

    def test_unknown_quality_is_not_inferred_from_extension_or_file_size(self):
        sources = copies()
        sources[0]["tracks"][0]["file_size"] = 999999
        result = project_duplicate_copy_review(sources, include_paths=False)
        self.assertEqual([result[0]["tracks"][0][key] for key in ("codec", "bitrate", "sample_rate", "bit_depth")], [None] * 4)
        actual = result[1]["tracks"][0]
        self.assertEqual([actual[key] for key in ("codec", "bitrate", "sample_rate", "bit_depth")], ["mp3", 320000, 44100, 16])

    def test_zero_duration_is_known_but_one_missing_duration_makes_total_unknown(self):
        result = project_duplicate_copy_review(copies(), include_paths=False)
        self.assertEqual(result[0]["total_duration_seconds"], 0)
        self.assertIsNone(result[1]["total_duration_seconds"])
        sources = copies()
        sources[1]["tracks"][1]["duration_seconds"] = 2.25
        self.assertEqual(project_duplicate_copy_review(sources, include_paths=False)[1]["total_duration_seconds"], 63.75)

    def test_malformed_inputs_do_not_create_phantom_duplicate_copies(self):
        for invalid in (None, "path", {}, 1, [], [None, {}, {"tracks": "wrong"}], copies()[:1]):
            with self.subTest(invalid=invalid):
                self.assertEqual(project_duplicate_copy_review(invalid, include_paths=False), [])
        sources = copies()
        sources.insert(1, None)
        sources[0]["tracks"].extend([None, "wrong", {}, {"path": {"secret": "private"}}])
        result = project_duplicate_copy_review(sources, include_paths=False)
        self.assertEqual([r["copy_number"] for r in result], [1, 2])
        self.assertEqual([r["track_count"] for r in result], [1, 2])

    def test_invalid_scalars_never_leak_nested_objects_or_nan(self):
        for bad in ({"private": "secret"}, ["secret"], True, float("nan"), float("inf"), -1):
            with self.subTest(bad=bad):
                sources = copies()
                track = sources[0]["tracks"][0]
                for key in ("title", "artist", "codec", "year", "track_number", "disc_number", "duration_seconds", "bitrate", "sample_rate", "bit_depth"):
                    track[key] = bad
                result = project_duplicate_copy_review(sources, include_paths=False)
                json.dumps(result, allow_nan=False)
                self.assertNotIn("secret", json.dumps(result))
                for key in ("year", "track_number", "disc_number", "duration_seconds", "bitrate", "sample_rate", "bit_depth"):
                    self.assertIsNone(result[0]["tracks"][0][key])
                self.assertIsNone(result[0]["total_duration_seconds"])


    def test_projection_needs_no_file_or_network_access(self):
        from unittest.mock import patch
        with patch("builtins.open", side_effect=AssertionError("File access forbidden")), \
             patch("os.scandir", side_effect=AssertionError("Scan forbidden")), \
             patch("socket.create_connection", side_effect=AssertionError("Network forbidden")):
            self.assertEqual(len(project_duplicate_copy_review(copies(), include_paths=False)), 2)


class RequestBoundaryHelperTests(unittest.TestCase):
    """Execute the actual AST helper, NOT ASGI/API integration.

    The partial checkout lacks its directly imported services/album_details.py.
    Extracting just this helper keeps its real recursive implementation under
    test, with policy evaluation supplied as an explicit test double. Full route
    imports, authentication and real policy evaluation remain integration gates.
    """

    @staticmethod
    def route_tree():
        import ast
        from pathlib import Path
        source = Path(__file__).resolve().parents[2] / "music_app/routes/api_read_asgi_routes.py"
        return ast.parse(source.read_text(encoding="utf-8"), filename=str(source))

    def helper(self, *, paths_allowed, projection=None):
        import ast
        from types import SimpleNamespace
        from unittest.mock import Mock
        tree = self.route_tree()
        node = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
                    and node.name == "_project_missing_album_actions_for_request")
        allowed = Mock(return_value=SimpleNamespace(as_payload=lambda: {"library.paths.read": paths_allowed}))
        namespace = {
            "Request": object,
            "allowed_actions_for_request": allowed,
            "project_duplicate_copy_review": projection or project_duplicate_copy_review,
            "project_missing_album_actions": Mock(return_value={}),
        }
        exec(compile(ast.Module(body=[node], type_ignores=[]), "<actual request helper AST>", "exec"), namespace)
        return namespace[node.name], allowed

    def test_actual_helper_queries_path_capability_and_projects_before_redaction(self):
        for paths_allowed in (False, True):
            with self.subTest(paths_allowed=paths_allowed):
                sources = copies()
                before = deepcopy(sources)
                payload = {"albums": [{"key": "release", "duplicate_sources": sources,
                                       "tracks": [{"track_ref": "album-playback-ref"}]}]}
                request = object()
                calls = []

                def inspect_projection(raw, *, include_paths):
                    self.assertIs(payload["albums"][0]["duplicate_sources"], sources)
                    self.assertIs(raw, sources)
                    calls.append(include_paths)
                    return project_duplicate_copy_review(raw, include_paths=include_paths)

                helper, allowed = self.helper(paths_allowed=paths_allowed, projection=inspect_projection)
                self.assertIs(helper(request, payload, include_duplicate_copy_review=True), payload)
                allowed.assert_called_once()
                self.assertIs(allowed.call_args.args[0], request)
                self.assertIn("library.paths.read", allowed.call_args.args[1])
                self.assertEqual(calls, [paths_allowed])
                result = payload["albums"][0]
                self.assertEqual(result["duplicate_source_count"], 2)
                self.assertEqual(len(result["duplicate_copy_review"]), 2)
                self.assertEqual(result["tracks"], [{"track_ref": "album-playback-ref"}])
                self.assertEqual(sources, before)
                if paths_allowed:
                    self.assertIs(result["duplicate_sources"], sources)
                    self.assertEqual(result["duplicate_sources"][0]["tracks"][0]["track_ref"], "secret-ref")
                    self.assertEqual(result["duplicate_copy_review"][0]["folder_path"], sources[0]["folder_path"])
                else:
                    self.assertEqual(result["duplicate_sources"], [])
                    self.assertNotIn("private", json.dumps(result["duplicate_copy_review"]))

    def test_actual_helper_defaults_to_no_review_on_summary_payloads(self):
        import inspect
        from unittest.mock import Mock
        for paths_allowed in (False, True):
            with self.subTest(paths_allowed=paths_allowed):
                projector = Mock(side_effect=AssertionError("Summary must not build review"))
                helper, _ = self.helper(paths_allowed=paths_allowed, projection=projector)
                self.assertIs(inspect.signature(helper).parameters["include_duplicate_copy_review"].default, False)
                payload = {"albums": [{"duplicate_sources": copies()}]}
                helper(object(), payload)
                self.assertNotIn("duplicate_copy_review", payload["albums"][0])
                projector.assert_not_called()
                self.assertEqual(payload["albums"][0]["duplicate_source_count"], 2)

    def test_static_call_graph_only_three_detail_owners_opt_in_six_times(self):
        """AST ownership guard, not an HTTP route execution or policy test."""
        import ast
        from collections import Counter
        tree = self.route_tree()
        helper_name = "_project_missing_album_actions_for_request"
        wrapper_name = "_project_album_payload_for_request"
        flag_name = "include_duplicate_copy_review"
        owners = {
            node.name: node for node in tree.body
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        }
        for name in (helper_name, wrapper_name):
            defaults = dict(zip(
                (argument.arg for argument in owners[name].args.kwonlyargs),
                owners[name].args.kw_defaults,
            ))
            self.assertIsInstance(defaults[flag_name], ast.Constant)
            self.assertIs(defaults[flag_name].value, False)

        # Only this wrapper may forward a variable, and it must forward the
        # same request, payload and flag unchanged to the security projector.
        forwarding_call = ast.parse(
            f"{helper_name}(request, payload, {flag_name}={flag_name})",
            mode="eval",
        ).body
        opted_in = Counter()
        forwarded = 0
        for owner in owners.values():
            for call in ast.walk(owner):
                if not isinstance(call, ast.Call):
                    continue
                if not isinstance(call.func, ast.Name) or call.func.id not in (helper_name, wrapper_name):
                    continue
                if owner.name == wrapper_name:
                    self.assertEqual(ast.dump(call), ast.dump(forwarding_call))
                    self.assertIsInstance(owner.body[-1], ast.Return)
                    self.assertIs(owner.body[-1].value, call)
                    forwarded += 1
                    continue
                self.assertEqual(len(call.args), 2, "No positional opt-in or argument unpacking")
                self.assertFalse(any(isinstance(arg, ast.Starred) for arg in call.args))
                self.assertTrue(all(kw.arg == flag_name for kw in call.keywords),
                                "No hidden opt-in through keyword unpacking")
                flags = [kw.value for kw in call.keywords if kw.arg == flag_name]
                self.assertLessEqual(len(flags), 1)
                for value in flags:
                    self.assertIsInstance(value, ast.Constant, "Projection opt-in must be explicit at route owner")
                    self.assertIsInstance(value.value, bool)
                    if value.value:
                        opted_in[owner.name] += 1
        self.assertEqual(forwarded, 1)
        self.assertEqual(opted_in, {
            "album_details": 2,
            "utilities_problematic_file_detail_query": 2,
            "utilities_problematic_file_detail": 2,
        })


if __name__ == "__main__":
    unittest.main()
