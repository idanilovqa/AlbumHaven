"""Measure the Phase 7 Argon2id password-policy floor on self-hosted hardware."""

from __future__ import annotations

import argparse
from collections.abc import Callable, Sequence
import json
import secrets
import statistics
import sys
import time
from typing import Any, TextIO

from argon2 import PasswordHasher
from argon2.low_level import Type


ARGON2_FLOOR = {
    "memory_cost_kib": 65_536,
    "time_cost": 3,
    "parallelism": 1,
    "salt_len_bytes": 16,
    "hash_len_bytes": 32,
}


def run_benchmark(iterations: int) -> dict[str, Any]:
    hasher = PasswordHasher(
        memory_cost=ARGON2_FLOOR["memory_cost_kib"],
        time_cost=ARGON2_FLOOR["time_cost"],
        parallelism=ARGON2_FLOOR["parallelism"],
        salt_len=ARGON2_FLOOR["salt_len_bytes"],
        hash_len=ARGON2_FLOOR["hash_len_bytes"],
        type=Type.ID,
    )
    hash_ms: list[float] = []
    verify_ms: list[float] = []
    for _ in range(iterations):
        candidate = secrets.token_urlsafe(32)
        started = time.perf_counter_ns()
        encoded = hasher.hash(candidate)
        hash_ms.append((time.perf_counter_ns() - started) / 1_000_000)

        started = time.perf_counter_ns()
        if not hasher.verify(encoded, candidate):
            raise RuntimeError("Argon2id benchmark verification failed")
        verify_ms.append((time.perf_counter_ns() - started) / 1_000_000)
    return {"iterations": iterations, "hash_ms": hash_ms, "verify_ms": verify_ms}


def _summary(values: Sequence[float]) -> dict[str, float]:
    return {
        "minimum": round(min(values), 3),
        "median": round(statistics.median(values), 3),
        "maximum": round(max(values), 3),
    }


def main(
    argv: Sequence[str] | None = None,
    *,
    stdout: TextIO = sys.stdout,
    stderr: TextIO = sys.stderr,
    benchmark: Callable[[int], dict[str, Any]] = run_benchmark,
) -> int:
    parser = argparse.ArgumentParser(
        description="Benchmark Album Haven's fixed Phase 7 Argon2id floor."
    )
    parser.add_argument("--iterations", type=int, default=5)
    args = parser.parse_args(argv)
    if not 1 <= args.iterations <= 100:
        stderr.write("--iterations must be between 1 and 100.\n")
        return 2

    measurements = benchmark(args.iterations)
    report = {
        "argon2id": ARGON2_FLOOR,
        "iterations": measurements["iterations"],
        "hash_ms": _summary(measurements["hash_ms"]),
        "verify_ms": _summary(measurements["verify_ms"]),
    }
    json.dump(report, stdout, indent=2, sort_keys=True)
    stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
