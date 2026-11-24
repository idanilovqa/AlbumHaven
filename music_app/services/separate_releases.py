from __future__ import annotations

from music_app.services.persistence_selection import select_runtime_persistence_adapter
from music_app.services.rule_state_postgres import RuleStatePostgresAdapter


def load_separate_release_keys(config: dict) -> set[str]:
    select_runtime_persistence_adapter("separate_releases", config)
    return RuleStatePostgresAdapter(config).load_separate_release_keys()


def save_separate_release_keys(config: dict, separate_release_keys: set[str]) -> None:
    select_runtime_persistence_adapter("separate_releases", config)
    # Changed releases mark their albums for the Problematic Files index (0188).
    RuleStatePostgresAdapter(config).save_separate_release_keys(separate_release_keys)
