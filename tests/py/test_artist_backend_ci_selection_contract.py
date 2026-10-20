"""Exact additive Artist CI selection and platform policy contract.

Source-only assertions; no service import, database or provider is used.
The baseline digest covers the complete existing workflow after reversing only
this contract's declared additive edits. Fixtures and seed owners stay exact.
"""
from pathlib import Path
import hashlib
import json
import re

import pytest

ROOT = Path(__file__).resolve().parents[2]
EXPECTED = {
    "artist_scope_commands": tuple("""tests/py/test_album_top_artist_scope_artwork_postgres.py
tests/py/test_album_top_artist_scope_commands.py
tests/py/test_album_top_artist_scope_postgres.py
tests/py/test_album_top_artist_scope_preview_postgres.py
tests/py/test_album_top_artist_scope_routes.py
tests/py/test_album_top_artwork_preparation_postgres.py
tests/py/test_album_top_browse.py
tests/py/test_album_top_browse_postgres.py
tests/py/test_album_top_catalog.py
tests/py/test_album_top_catalog_versions.py
tests/py/test_album_top_collaboration_commands.py
tests/py/test_album_top_collaboration_postgres.py
tests/py/test_album_top_collaboration_routes.py
tests/py/test_album_top_copy_postgres.py
tests/py/test_album_top_membership.py
tests/py/test_album_top_membership_evidence_postgres.py
tests/py/test_album_top_membership_postgres.py
tests/py/test_album_top_membership_routes.py
tests/py/test_album_top_owner_publication_postgres.py
tests/py/test_album_top_owner_publication_routes.py
tests/py/test_album_top_publication_sources.py
tests/py/test_album_top_publication_sources_postgres.py
tests/py/test_album_top_requests_postgres.py
tests/py/test_album_top_source_finalization.py
tests/py/test_album_top_source_finalization_postgres.py
tests/py/test_album_top_source_finalization_remote_postgres.py
tests/py/test_album_top_source_finalization_routes.py
tests/py/test_album_top_source_lock_publication_postgres.py
tests/py/test_isolated_postgres_migration_ledger.py
tests/py/test_owned_album_top_route_boundary.py
tests/py/test_owned_album_tops.py
tests/py/test_owned_album_tops_postgres.py
tests/py/test_top_artwork_draft_preparation_postgres.py
tests/py/test_top_artwork_owner_http.py
tests/py/test_top_artwork_owner_publication_postgres.py
tests/py/test_top_artwork_owner_sources_postgres.py
tests/py/test_top_artwork_publication.py
tests/py/test_top_artwork_publication_closure_postgres.py
tests/py/test_top_artwork_publication_postgres.py
tests/py/test_top_artwork_publication_retention_postgres.py
tests/py/test_top_artwork_publication_seals_postgres.py
tests/py/test_top_artwork_saved_phases_postgres.py
tests/py/test_artist_backend_ci_selection_contract.py""".splitlines()),
    "artist_remote_evidence": tuple("""tests/py/test_album_top_private_remote_context_routes.py
tests/py/test_album_top_remote_acquisition_lock_order.py
tests/py/test_album_top_remote_acquisition_postgres.py
tests/py/test_album_top_remote_acquisition_routes.py
tests/py/test_album_top_remote_artist_scope_authority_postgres.py
tests/py/test_album_top_remote_artist_scope_bounds_postgres.py
tests/py/test_album_top_remote_artist_scope_fences_postgres.py
tests/py/test_album_top_remote_artist_scope_hook.py
tests/py/test_album_top_remote_artist_scope_postgres.py
tests/py/test_album_top_remote_artist_scope_publication_postgres.py
tests/py/test_album_top_remote_artist_scope_retained_postgres.py
tests/py/test_album_top_remote_consumption_postgres.py
tests/py/test_album_top_remote_identity_lock_postgres.py
tests/py/test_album_top_remote_membership_digest_vectors.py
tests/py/test_album_top_remote_membership_postgres.py
tests/py/test_album_top_remote_membership_wire.py
tests/py/test_album_top_remote_preparation_routes.py
tests/py/test_album_top_remote_preparation_sources.py
tests/py/test_album_top_remote_preparations_postgres.py
tests/py/test_album_top_remote_retention_postgres.py
tests/py/test_album_top_remote_sources.py
tests/py/test_album_top_remote_storage_postgres.py
tests/py/test_remote_album_catalog_mapper.py
tests/py/test_remote_album_credited_admission_shape_postgres.py
tests/py/test_remote_album_credited_consumption_postgres.py
tests/py/test_remote_album_credited_evidence.py
tests/py/test_remote_album_credited_limits_postgres.py
tests/py/test_remote_album_credited_parameter_postgres.py
tests/py/test_remote_album_credited_retention_postgres.py
tests/py/test_remote_album_credited_rows.py
tests/py/test_remote_album_credited_storage_postgres.py
tests/py/test_remote_album_provider_evidence.py
tests/py/test_remote_album_search.py
tests/py/test_remote_preparation_cutoff_postgres.py
tests/py/test_remote_preparation_storage_postgres.py""".splitlines()),
    "artist_scoped_reads": tuple("""tests/py/test_album_top_acquired_artist_preview_display_replay.py
tests/py/test_album_top_acquired_artist_preview_fallback.py
tests/py/test_album_top_acquired_artist_preview_fences.py
tests/py/test_album_top_acquired_artist_preview_postgres.py
tests/py/test_album_top_acquired_artist_preview_routes.py
tests/py/test_album_top_scoped_remote_search_fences_postgres.py
tests/py/test_album_top_scoped_remote_search_final_boundaries_postgres.py
tests/py/test_album_top_scoped_remote_search_postgres.py
tests/py/test_album_top_scoped_remote_search_routes.py""".splitlines()),
    "favorites_backend": tuple("""tests/py/test_album_preferences_postgres.py
tests/py/test_album_preferences_asgi.py
tests/py/test_album_preference_subject_projection.py
tests/py/test_album_top_native_queue.py
tests/py/test_album_top_native_queue_postgres.py
tests/py/test_album_top_native_queue_routes.py
tests/py/test_album_top_native_remote_queue_postgres.py
tests/py/test_album_top_native_remote_targets_postgres.py
tests/py/test_album_top_native_target_routes.py
tests/py/test_album_top_native_targets.py
tests/py/test_album_top_native_targets_postgres.py
tests/py/test_album_top_queue_popularity.py
tests/py/test_album_top_queue_popularity_postgres.py
tests/py/test_album_top_scoped_creation_metadata_boundaries.py
tests/py/test_album_top_scoped_creation_metadata_postgres.py
tests/py/test_artist_listen_launch_final_context.py
tests/py/test_artist_listen_launch_finalizer.py
tests/py/test_artist_listen_launch_postgres.py
tests/py/test_artist_listen_launch_projection.py
tests/py/test_artist_loved_browse_projection.py
tests/py/test_artist_loved_persistence_live.py
tests/py/test_artist_loved_recipe.py
tests/py/test_artist_loved_routes.py
tests/py/test_initialize_loved_browse_postgres.py""".splitlines()),
}
NEW_LIMITS = {"artist_scope_commands": 45, "artist_remote_evidence": 45, "artist_scoped_reads": 30}
BASELINE_WORKFLOW_SHA256 = "c75c9e245ae83d461635029265cab6225b864c799242d1df03c09000d02a9d61"
BASELINE_FAVORITES_ARM = "            favorites_backend)\n              printf '%s\\n' \\\n                'tests/py/test_album_preferences_postgres.py' \\\n                'tests/py/test_album_preferences_asgi.py' \\\n                'tests/py/test_album_preference_subject_projection.py' > \"$evidence/tests.txt\"\n              ;;\n"
OLD_EVIDENCE_NAMES = ["new_top_targets","new_playlist_preview","new_top_queue","new_playlist_preferences","new_source_import","new_url_html"]
OLD_POLICY = json.loads("[{\"nodeIdPattern\":\"^tests\\\\.py\\\\.test_cover_lookup_live_provider_smoke::test_live_music_service_cover_lookup_smoke_logs_duration_and_returns_candidates\\\\[(?:apple-Apple Music|deezer-Deezer|youtube_music-YouTube Music|spotify-Spotify)\\\\]$\",\"reasonPattern\":\"^Set ALBUM_HAVEN_RUN_LIVE_PROVIDER_TESTS=1 to run live provider smoke tests\\\\.$\"}]")
UNCHANGED_OWNERS = {
    "scripts/ci/initialize-loved-browse-postgres.py": "f9d3a8550f1b014293499f5281f072946a3121c86d3ec8cc1bc60cc79023d695",
    "tests/py/album_favorites_postgres_support.py": "13b051c764d22e8796b0e169b1d8e5027c583dad77dcb295eeba99c53a6453f0",
}
PLATFORM_MODULES = ["tests/py/test_top_artwork_draft_capture_postgres.py","tests/py/test_top_artwork_review_postgres.py"]
WINDOWS_CASES = (
    "tests.py.test_album_top_artist_scope_artwork_postgres::test_artwork_a2_rechecks_scope_after_the_actual_outside_observation_gap",
    "tests.py.test_album_top_artist_scope_artwork_postgres::test_artwork_finishes_each_actual_transaction_and_preserves_exact_explicit_members",
)
WINDOWS_REASON = "Requires genuine existing POSIX artwork acquisition"


def workflow():
    return (ROOT / ".github/workflows/pr-gates.yml").read_text(encoding="utf-8")


def arm(text, name):
    matches = list(re.finditer(r"^            " + re.escape(name) + r"\)\n[\s\S]*?^              ;;\n", text, re.M))
    assert len(matches) == 1, (name, len(matches))
    return matches[0].group()


def selectors(text, name):
    body = arm(text, name)
    assert body.count('> "$evidence/tests.txt"') == 1
    return tuple(re.findall(r"'(tests/py/[^']+)'", body))


@pytest.mark.parametrize("name", tuple(EXPECTED))
def test_exact_whole_module_selection_and_order(name):
    actual = selectors(workflow(), name)
    assert actual == EXPECTED[name]
    assert len(actual) == len(set(actual))
    lines = [f"            {name})", "              printf '%s\\n' " + chr(92)]
    for index, item in enumerate(actual):
        suffix = " " + chr(92) if index < len(actual) - 1 else ' > "$evidence/tests.txt"'
        lines.append(f"                '{item}'" + suffix)
    lines.append("              ;;")
    assert arm(workflow(), name) == "\n".join(lines) + "\n"
    for item in actual:
        assert re.fullmatch(r"tests/py/test_[a-z0-9_]+\.py", item), item
        assert (ROOT / item).is_file(), item


def test_complete_union_and_existing_platform_allocation():
    selected = [item for name in EXPECTED for item in selectors(workflow(), name)]
    assert len(selected) == 111
    assert len(set(selected)) == 111
    assert len(PLATFORM_MODULES) == 2
    assert len(set(selected + PLATFORM_MODULES)) == 113
    assert not set(selected).intersection(PLATFORM_MODULES)
    for item in PLATFORM_MODULES:
        assert (ROOT / item).is_file()
    assert "tests/py/test_album_top_artist_scope_artwork_postgres.py" in EXPECTED["artist_scope_commands"]
    assert all(not item.endswith("_support.py") for item in selected)


@pytest.mark.parametrize("name,limit", tuple(NEW_LIMITS.items()))
def test_new_matrix_rows_are_single_bounded_whole_lanes(name, limit):
    rows = re.findall(r"^          - batch: " + re.escape(name) + r"\n(.*?)(?=^          - batch:|^    runs-on:|^          #)", workflow(), re.M | re.S)
    assert rows == [f"            timeout_minutes: {limit}\n"]


def test_only_declared_additions_change_the_complete_workflow():
    text = workflow()
    for name, limit in NEW_LIMITS.items():
        row = f"          - batch: {name}\n            timeout_minutes: {limit}\n"
        assert text.count(row) == 1
        text = text.replace(row, "", 1)
        text = text.replace(arm(text, name), "", 1)
    text = text.replace(arm(text, "favorites_backend"), BASELINE_FAVORITES_ARM, 1)
    pattern = r"contains\(fromJSON\('(\[\"new_top_targets\"[^']+)'\), matrix.batch\)"
    matches = list(re.finditer(pattern, text))
    assert len(matches) == 1
    match = matches[0]
    names = json.loads(match.group(1))
    assert len(names) == len(set(names))
    assert [name for name in names if name in OLD_EVIDENCE_NAMES] == OLD_EVIDENCE_NAMES
    assert set(names) == set(OLD_EVIDENCE_NAMES) | set(EXPECTED)
    old_json = json.dumps(OLD_EVIDENCE_NAMES, separators=(",", ":"))
    text = text[:match.start(1)] + old_json + text[match.end(1):]
    assert hashlib.sha256(text.encode("utf-8")).hexdigest() == BASELINE_WORKFLOW_SHA256


@pytest.mark.parametrize("relative,expected", tuple(UNCHANGED_OWNERS.items()))
def test_seed_and_favorites_admission_owners_remain_byte_identical(relative, expected):
    assert hashlib.sha256((ROOT / relative).read_text(encoding="utf-8").encode("utf-8")).hexdigest() == expected


def policy():
    return json.loads((ROOT / "tests/ci/pytest-allowed-skips.json").read_text(encoding="utf-8"))


def test_windows_policy_only_appends_two_exact_new_cases():
    entries = policy()
    assert entries[:len(OLD_POLICY)] == OLD_POLICY
    additions = entries[len(OLD_POLICY):]
    expected = [{"nodeIdPattern": "^" + re.escape(case) + r"$(?![\s\S])", "reasonPattern": "^" + re.escape(WINDOWS_REASON) + r"$(?![\s\S])"} for case in WINDOWS_CASES]
    # Whitespace is not regex punctuation: accept either literal spaces or
    # re.escape's escaped spaces, with all other bytes pinned exactly.
    canonical = lambda entry: {key: value.replace(r"\ ", " ") for key, value in entry.items()}
    assert [canonical(item) for item in additions] == [canonical(item) for item in expected]


@pytest.mark.parametrize("case", WINDOWS_CASES)
def test_exact_new_windows_case_matches_and_neighbors_do_not(case):
    additions = policy()[len(OLD_POLICY):]
    def allowed(node, reason):
        return any(re.search(entry["nodeIdPattern"], node) and re.search(entry["reasonPattern"], reason) for entry in additions)
    assert allowed(case, WINDOWS_REASON)
    for neighbor in ("prefix" + case, case + "suffix", case + "[parameter]", case.replace("tests.py.", "testsXpyX"), case + "_other", case + "\n", case + "\r\n"):
        assert not allowed(neighbor, WINDOWS_REASON), neighbor
    for reason in ("prefix" + WINDOWS_REASON, WINDOWS_REASON + "suffix", "Requires genuine POSIX acquisition", "", "database unavailable", WINDOWS_REASON + "\n", WINDOWS_REASON + "\r\n"):
        assert not allowed(case, reason), reason
    assert not allowed("tests.py.test_top_artwork_review_postgres::test_unrelated", WINDOWS_REASON)
