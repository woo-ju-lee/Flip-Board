from datetime import timedelta

import pytest

from backend.app.normalizer import normalize
from .conftest import AT, TO_WGS84, synthetic_segment


def at_position(single, x, y, seconds=0):
    t = normalize(single, AT).trains[0]
    return t.model_copy(update={'coordinates': TO_WGS84.transform(x, y), 'kind': 'KTX', 'received_at': AT + timedelta(seconds=seconds), 'source_timestamp': AT + timedelta(seconds=seconds)})


def test_meter_distance_and_only_physical_track(single, matcher_factory):
    matcher = matcher_factory([
        synthetic_segment('hsr', 'gyeongbu-hsr', [(1_000_000, 1_900_000), (1_005_000, 1_900_000)]),
        synthetic_segment('normal', 'ordinary', [(1_000_000, 1_900_300), (1_005_000, 1_900_300)]),
    ])
    match = matcher.match(at_position(single, 1_001_000, 1_900_010))
    assert match.line_id == 'gyeongbu-hsr' and match.status == 'matched'
    assert match.distance_m == pytest.approx(10, abs=.1)
    normal = matcher.match(at_position(single, 1_001_000, 1_900_300, 60))
    assert normal.status == 'ambiguous' and normal.reason == 'line_change_pending'
    normal = matcher.match(at_position(single, 1_001_000, 1_900_300, 120))
    assert normal.line_id == 'ordinary'  # KTX label does not force a high-speed track.


def test_leave_and_enter_line_without_sticky_match(single, matcher_factory):
    matcher = matcher_factory([synthetic_segment('hsr', 'gyeongbu-hsr', [(1e6, 1.9e6), (1.005e6, 1.9e6)])])
    assert matcher.match(at_position(single, 1001000, 1900000)).status == 'matched'
    assert matcher.match(at_position(single, 1001000, 1900500, 60)).status == 'unknown'
    assert matcher.match(at_position(single, 1001000, 1900010, 120)).status == 'matched'


def test_parallel_or_crossing_tracks_ambiguous(single, matcher_factory):
    matcher = matcher_factory([
        synthetic_segment('a', 'gyeongbu-hsr', [(1e6, 1.9e6), (1.005e6, 1.9e6)]),
        synthetic_segment('b', 'ordinary', [(1e6, 1900040), (1.005e6, 1900040)]),
    ])
    result = matcher.match(at_position(single, 1001000, 1900020))
    assert result.status == 'ambiguous' and result.line_id is None
    assert len(result.candidates) == 2


def test_unverified_competing_track_prevents_positive(single, matcher_factory):
    matcher = matcher_factory([
        synthetic_segment('a', 'gyeongbu-hsr', [(1e6, 1.9e6), (1.005e6, 1.9e6)]),
        synthetic_segment('b', None, [(1e6, 1900020), (1.005e6, 1900020)], False),
    ])
    assert matcher.match(at_position(single, 1001000, 1900010)).status == 'ambiguous'


def test_unverified_geometry_cannot_match(single, matcher_factory):
    matcher = matcher_factory([synthetic_segment('a', 'gyeongbu-hsr', [(1e6, 1.9e6), (1.005e6, 1.9e6)], False)])
    assert matcher.match(at_position(single, 1001000, 1900000)).status == 'unknown'


def test_missing_review_rejected(matcher_factory):
    f = synthetic_segment('a', 'gyeongbu-hsr', [(1e6, 1.9e6), (1.005e6, 1.9e6)])
    f['properties'].pop('source')
    with pytest.raises(ValueError, match='provenance'):
        matcher_factory([f])


def test_jump_and_confidence_guard(single, matcher_factory):
    matcher = matcher_factory([synthetic_segment('a', 'gyeongbu-hsr', [(1e6, 1.9e6), (1.02e6, 1.9e6)])])
    assert matcher.match(at_position(single, 1001000, 1900000)).status == 'matched'
    assert matcher.match(at_position(single, 1010000, 1900000, 1)).reason == 'implausible_position_jump'
    assert matcher.match(at_position(single, 1001000, 1900065, 60)).reason == 'insufficient_distance_confidence'


def test_no_geometry_no_match(single, matcher_factory):
    assert matcher_factory().match(at_position(single, 1001000, 1900000)).reason == 'no_verified_geometry'


def test_identical_timestamp_cannot_confirm_switch(single, matcher_factory):
    matcher = matcher_factory([
        synthetic_segment('a', 'gyeongbu-hsr', [(1e6, 1.9e6), (1.005e6, 1.9e6)]),
        synthetic_segment('b', 'ordinary', [(1e6, 1900300), (1.005e6, 1900300)]),
    ])
    matcher.match(at_position(single, 1001000, 1900000))
    for _ in range(4):
        assert matcher.match(at_position(single, 1001000, 1900300, 60)).status == 'ambiguous'
    assert matcher.match(at_position(single, 1001000, 1900300, 120)).line_id == 'ordinary'


def test_snapshot_prunes_history(single, matcher_factory):
    matcher = matcher_factory([synthetic_segment('a', 'gyeongbu-hsr', [(1e6, 1.9e6), (1.005e6, 1.9e6)])])
    matcher.match_snapshot([at_position(single, 1001000, 1900000)])
    matcher.match_snapshot([])
    assert not matcher.history
