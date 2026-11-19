import pytest

from tests.py import pytest_shards


def test_every_file_lands_in_exactly_one_shard_and_heavy_files_spread_out():
    weights = {"a.py": 10.0, "b.py": 9.0, "c.py": 8.0, "d.py": 1.0, "e.py": 1.0}

    owners = pytest_shards.shard_owners([*weights, "new.py", "a.py"], weights, 3)

    assert sorted(owners) == ["a.py", "b.py", "c.py", "d.py", "e.py", "new.py"]
    assert {owners["a.py"], owners["b.py"], owners["c.py"]} == {1, 2, 3}
    assert set(owners.values()) <= {1, 2, 3}


def test_the_assignment_does_not_depend_on_collection_order():
    weights = pytest_shards.load_weights()
    files = sorted(weights)

    assert pytest_shards.shard_owners(files, weights, 3) == pytest_shards.shard_owners(reversed(files), weights, 3)


def test_the_checked_in_weights_split_the_suite_evenly():
    weights = pytest_shards.load_weights()
    loads = [0.0, 0.0, 0.0]
    for file, shard in pytest_shards.shard_owners(weights, weights, 3).items():
        loads[shard - 1] += weights[file]

    assert max(loads) <= 1.05 * sum(loads) / 3


@pytest.mark.parametrize("selection", ["", "3", "0/3", "4/3", "a/b"])
def test_a_malformed_shard_selection_is_refused(selection):
    with pytest.raises(ValueError, match="ALBUM_HAVEN_PYTEST_SHARD"):
        pytest_shards.parse_shard(selection)


def test_shard_selection_parses_index_and_count():
    assert pytest_shards.parse_shard("2/3") == (2, 3)
