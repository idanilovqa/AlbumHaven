"""Reachable pure geometry working-margin boundaries, never SQL proof."""
from copy import deepcopy
import hashlib
import json
from types import SimpleNamespace

import pytest

from music_app.services import local_album_full_fold as fold

BUDGET = 3 * 1024 * 1024
EXTENT = 15_000_000_000_000
TRACKS = tuple((2**63 - 1) - i for i in range(512))
VERSIONS = {track: hashlib.sha256(str(track).encode()).hexdigest() for track in TRACKS}


def rows(owner, starts):
    ordinal = 0
    result = []
    for index, start in enumerate(starts):
        frames = EXTENT - 24000 - start
        assert 0 < frames <= fold.MAX_VALUE and ordinal + frames <= fold.MAX_VALUE
        result.append(dict(id=(owner - 1) * 512 + index + 1, owner_id=owner,
            parent_id=(owner - 1) * 512 + index + 1, binding_serial=index + 1,
            generation=1, stream_id=index + 1, epoch=1, continuity_serial=1,
            ordinal_start=ordinal, output_start=ordinal, source_base48=0,
            source_start48=start, frames=frames, track_id=TRACKS[index],
            local_version=VERSIONS[TRACKS[index]], extent_frames48=EXTENT, has_loss=False))
        ordinal += frames
    return result


def feed(original, values, *, finished=False):
    current = original
    for start in range(0, len(values), fold.PAGE_RUNS):
        current = fold.advance_geometry(current, values[start:start + fold.PAGE_RUNS],
            owner_finished=finished and start + fold.PAGE_RUNS >= len(values))
    return current


@pytest.fixture(scope='module')
def full_groups():
    anchors = {str(track): dict(run_id=i + 1, version=VERSIONS[track], extent_frames48=EXTENT)
        for i, track in enumerate(TRACKS)}
    current = fold.new_geometry(list(TRACKS), anchors)
    for owner in range(1, fold.MAX_GROUPS + 1):
        # Each independent session misses the final member. Five-digit starts
        # within the genuine boundary tolerance keep every middle join valid.
        values = rows(owner, [10000 + owner] + [24000] * 510)
        current = feed(current, values, finished=True)
        assert len(current['groups']) == owner and current['pruned_segments'] == 0
    assert current['pending'] is None and current['uninterrupted'] == 0
    assert current['seen_runs'] == 128 * 511
    assert all(group['count'] == 1 and len(group['actual']) == 511 for group in current['groups'])
    assert len(json.dumps(current).encode()) < BUDGET
    return current


def observed_feed(monkeypatch, original, starts):
    sizes = []
    dumps = json.dumps
    def observe(value, *args, **kwargs):
        encoded = dumps(value, *args, **kwargs)
        # Observe the actual owner's normal serializer without changing a byte.
        sizes.append(len(encoded.encode()))
        return encoded
    values = rows(129, starts)
    before = deepcopy(values)
    with monkeypatch.context() as observation:
        observation.setattr(fold, 'json', SimpleNamespace(dumps=observe))
        result = feed(original, values)
    assert values == before
    return result, sizes


@pytest.mark.parametrize('extra', [0, 1])
def test_exact_geometry_working_margin_retains_cap_and_prunes_cap_plus_one(full_groups, monkeypatch, request, extra):
    assert BUDGET == fold.MAX_STATE_BYTES - 1024 * 1024
    before = deepcopy(full_groups)
    low, high = 0, 512
    while low + 1 < high:
        count = (low + high) // 2
        result, _ = observed_feed(monkeypatch, full_groups, [0] * count)
        if result['pruned_segments']:
            high = count
        else:
            low = count
    result, _ = observed_feed(monkeypatch, full_groups, [0] * low)
    gap = BUDGET + extra - len(json.dumps(result).encode())
    assert 0 <= gap < 4 * low
    starts = [0] * low
    for index in range(low):
        addition = min(4, gap)
        # 0 -> 10/100/1000/10000 adds exactly 1/2/3/4 JSON digits. Every
        # start remains within the real 24,000-frame endpoint tolerance.
        starts[index] = 10 ** addition if addition else 0
        gap -= addition
    assert gap == 0 and all(0 <= value <= 24000 for value in starts)
    actual, sizes = observed_feed(monkeypatch, full_groups, starts)
    assert max(sizes) == BUDGET + extra
    assert full_groups == before
    assert actual['seen_runs'] == 128 * 511 + low
    assert actual['uninterrupted'] == 0
    assert len(actual['pending']['spans']) == low
    assert actual['pending']['last']['ordinal_end'] <= fold.MAX_VALUE
    if extra == 0:
        assert len(json.dumps(actual).encode()) == BUDGET
        assert actual['groups'] == full_groups['groups']
        assert actual['pruned_segments'] == 0
    else:
        # Actual owner prunes only the newest unallocated group. It preserves
        # the valid pending contiguous traversal rather than throwing it away.
        assert actual['groups'] == full_groups['groups'][:-1]
        assert actual['pruned_segments'] == 1
        assert len(json.dumps(actual).encode()) < BUDGET
    request.node.user_properties.extend([
        ('base_bytes', len(json.dumps(full_groups).encode())),
        ('pending_spans', low), ('maximum_observed_bytes', max(sizes)),
        ('retained_bytes', len(json.dumps(actual).encode())),
        ('retained_groups', len(actual['groups'])),
        ('final_ordinal', actual['pending']['last']['ordinal_end'])])
