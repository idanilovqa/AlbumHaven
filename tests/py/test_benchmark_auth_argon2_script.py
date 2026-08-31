from __future__ import annotations

import io
import json

from scripts import benchmark_auth_argon2


def test_command_reports_the_phase_7_floor_without_secret_material():
    stdout = io.StringIO()

    exit_code = benchmark_auth_argon2.main(
        ["--iterations", "3"],
        stdout=stdout,
        benchmark=lambda iterations: {
            "iterations": iterations,
            "hash_ms": [101.25, 99.5, 100.0],
            "verify_ms": [95.0, 96.5, 94.75],
        },
    )

    assert exit_code == 0
    report = json.loads(stdout.getvalue())
    assert report["argon2id"] == {
        "memory_cost_kib": 65_536,
        "time_cost": 3,
        "parallelism": 1,
        "salt_len_bytes": 16,
        "hash_len_bytes": 32,
    }
    assert report["iterations"] == 3
    assert report["hash_ms"] == {"minimum": 99.5, "median": 100.0, "maximum": 101.25}
    assert report["verify_ms"] == {"minimum": 94.75, "median": 95.0, "maximum": 96.5}
    assert "password" not in stdout.getvalue().lower()


def test_command_rejects_unbounded_iteration_counts():
    stderr = io.StringIO()

    exit_code = benchmark_auth_argon2.main(
        ["--iterations", "101"], stdout=io.StringIO(), stderr=stderr
    )

    assert exit_code == 2
    assert "between 1 and 100" in stderr.getvalue()
