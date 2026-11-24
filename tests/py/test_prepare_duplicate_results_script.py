import io

import pytest

from music_app.services import problematic_index
from scripts import prepare_duplicate_results

READY = {"problematic_index": "ready", "duplicate_results": "ready", "changed_albums_waiting": 0,
         "changed_loose_groups_waiting": 0}


def _run(*arguments):
    output, errors = io.StringIO(), io.StringIO()
    code = prepare_duplicate_results.main(
        arguments, stdout=output, stderr=errors, repository_factory=lambda: "repository",
    )
    return code, output.getvalue(), errors.getvalue()


@pytest.mark.parametrize("arguments, rebuild", [((), False), (("--rebuild",), True)])
def test_the_step_reports_progress_and_exits_zero_only_once_ready(monkeypatch, arguments, rebuild):
    asked = []

    def prepare(repository, *, rebuild_duplicates, report):
        asked.append((repository, rebuild_duplicates))
        report("Duplicate results", 500, 14866)

    monkeypatch.setattr(problematic_index, "prepare_for_serving", prepare)
    monkeypatch.setattr(problematic_index, "serving_readiness", lambda _repository: dict(READY))

    code, output, errors = _run(*arguments)

    assert (code, errors, asked) == (0, "", [("repository", rebuild)])
    assert "Duplicate results: 500/14866" in output
    assert "READY" in output


@pytest.mark.parametrize("field, value", [
    ("problematic_index", None),
    ("duplicate_results", "building"),
    ("changed_albums_waiting", 3),
    ("changed_loose_groups_waiting", 2),
])
def test_the_check_changes_nothing_and_fails_while_not_ready(monkeypatch, field, value):
    monkeypatch.setattr(problematic_index, "prepare_for_serving", lambda *_a, **_k: pytest.fail("--check must not write"))
    monkeypatch.setattr(problematic_index, "serving_readiness", lambda _repository: {**READY, field: value})

    code, output, errors = _run("--check")

    assert (code, output) == (1, "")
    assert "do not start serving" in errors


@pytest.mark.parametrize("error, shown", [
    (problematic_index.PreparationError("stop every writer first"), "stop every writer first"),
    (RuntimeError("postgresql://user:secret@host/db"), "RuntimeError"),
])
def test_a_failure_exits_non_zero_without_quoting_the_connection(monkeypatch, error, shown):
    def fail(*_arguments, **_options):
        raise error

    monkeypatch.setattr(problematic_index, "prepare_for_serving", fail)

    code, _output, errors = _run()

    assert code == 1
    assert shown in errors
    assert "secret" not in errors
