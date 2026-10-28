import copy
from datetime import timedelta

import pytest

from backend.app.config import DATA_DIR
from backend.app.normalizer import InvalidPayload, normalize
from .conftest import AT


def test_actual_captures_and_nullable_delay(capture):
    result = normalize(capture, AT)
    assert len(result.trains) == 148
    assert result.quality.rejected_count == 0
    by_number = {t.number: t for t in result.trains}
    for feature in capture['features']:
        p = feature['properties']
        train = by_number[p['trn_no']]
        assert list(train.coordinates) == feature['geometry']['coordinates']
        assert train.position_label == (p['now_stn'] + p['next_stn']).strip()
        assert train.delay_minutes == p['delay']
    assert any(t.delay_status == 'unknown' for t in result.trains)
    assert any(t.delay_status == 'on_time' for t in result.trains)


def test_id_stability_across_real_captures(capture):
    import json
    old = json.loads((DATA_DIR / 'snapshots/trains_20261026_141445_KST.json').read_text(encoding='utf-8'))
    before = {t.number: t.id for t in normalize(old, AT).trains}
    after = {t.number: t.id for t in normalize(capture, AT).trains}
    assert len(before) == 145
    assert all(after[n] == tid for n, tid in before.items())


def test_order_and_feature_id_do_not_matter(capture):
    before = normalize(capture, AT)
    capture['features'].reverse()
    for i, f in enumerate(capture['features']):
        f['id'] = f'random-{i}'
    assert normalize(capture, AT).trains == before.trains


def test_different_operating_day_and_leading_zero(single):
    p = single['features'][0]['properties']
    p['trn_no'] = '0031'
    before = normalize(single, AT).trains[0]
    p['dpt_pln_dttm'] = '20261027102300'
    after = normalize(single, AT).trains[0]
    assert before.id != after.id
    assert before.number == '0031'
    assert before.planned_departure.utcoffset() == timedelta(hours=9)


@pytest.mark.parametrize('field', ['trn_no', 'dpt_pln_dttm'])
def test_missing_identity_rejects_record(single, field):
    single['features'][0]['properties'].pop(field)
    with pytest.raises(InvalidPayload):
        normalize(single, AT)


def test_optional_fields_missing(single):
    p = single['features'][0]['properties']
    for key in ['delay', 'now_stn', 'next_stn', 'arv_pln_dttm', 'trn_case']:
        p.pop(key)
    train = normalize(single, AT).trains[0]
    assert train.delay_minutes is None and train.delay_status == 'unknown'
    assert train.position_label == '위치 문구 없음'
    assert train.planned_arrival is None


@pytest.mark.parametrize('coords', [[None, 35], [float('nan'), 35], [200, 35], [True, 35], [35, 129], []])
def test_bad_coordinates(single, coords):
    single['features'][0]['geometry']['coordinates'] = coords
    with pytest.raises(InvalidPayload):
        normalize(single, AT)


def test_exact_duplicate_collapses(single):
    single['features'].append(copy.deepcopy(single['features'][0]))
    result = normalize(single, AT)
    assert len(result.trains) == 1 and result.quality.duplicate_count == 1


def test_conflicting_duplicates_quarantined(capture):
    conflicting = copy.deepcopy(capture['features'][0])
    conflicting['geometry']['coordinates'][0] += 0.1
    capture['features'].append(conflicting)
    result = normalize(capture, AT)
    assert len(result.trains) == 147 and result.quality.conflicting_ids == 1
    assert result.quality.rejected_count == 2


def test_same_number_departure_different_endpoints(single):
    another = copy.deepcopy(single['features'][0])
    another['properties']['arv_stn_nm'] = '다른 종착역'
    single['features'].append(another)
    assert len(normalize(single, AT).trains) == 2


@pytest.mark.parametrize('payload', [None, [], {}, {'type': 'FeatureCollection', 'features': None}, {'type': 'Feature', 'features': []}])
def test_invalid_envelope(payload):
    with pytest.raises(InvalidPayload):
        normalize(payload, AT)


def test_empty_collection_is_valid():
    assert normalize({'type': 'FeatureCollection', 'features': []}, AT).trains == []


def test_missing_time_never_becomes_current(single):
    single.pop('timeStamp')
    assert normalize(single, AT).source_timestamp is None


def test_future_timestamp_rejected(single):
    single['timeStamp'] = '2099-01-01T00:00:00Z'
    with pytest.raises(InvalidPayload):
        normalize(single, AT)


def test_partial_malformed_records_counted(capture):
    capture['features'][0]['geometry'] = None
    result = normalize(capture, AT)
    assert len(result.trains) == 147 and result.quality.rejected_count == 1
