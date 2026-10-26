import copy
import json
from datetime import timedelta

import httpx
from fastapi.testclient import TestClient

from backend.app.config import DATA_DIR, Settings
from backend.app.main import create_app
from backend.app.normalizer import normalize
from .conftest import AT, TO_WGS84, synthetic_segment


def test_normalize_match_station_filter_pipeline(single, tmp_path):
    catalog = json.loads((DATA_DIR / 'catalog.json').read_text())
    catalog['lines'].append({'id': 'ordinary', 'name': '합성 테스트 일반선', 'coverage': 'partial'})
    (tmp_path / 'catalog.json').write_text(json.dumps(catalog))
    geometry = {'type': 'FeatureCollection', 'features': [
        synthetic_segment('a', 'gyeongbu-hsr', [(1e6, 1.9e6), (1.005e6, 1.9e6)]),
        synthetic_segment('b', 'ordinary', [(1e6, 1900300), (1.005e6, 1900300)]),
    ]}
    (tmp_path / 'segments.geojson').write_text(json.dumps(geometry))
    raw = copy.deepcopy(single)
    raw['features'] = []
    for number, y in [('synthetic-on-hsr', 1900000), ('synthetic-ktx-on-normal', 1900300), ('synthetic-outside', 1900900)]:
        feature = copy.deepcopy(single['features'][0])
        feature['properties']['trn_no'] = number
        feature['properties']['trn_case'] = 'KTX'
        feature['geometry']['coordinates'] = list(TO_WGS84.transform(1001000, y))
        raw['features'].append(feature)
    app = create_app(Settings(_env_file=None, data_dir=tmp_path))
    with TestClient(app) as client:
        collector = app.state.collector
        collector.trains = collector.matcher.match_snapshot(normalize(raw, AT).trains)
        result = client.get('/api/trains?station_id=울산').json()
        assert result['count'] == 1
        assert result['trains'][0]['number'] == 'synthetic-on-hsr'
        assert result['filter']['state'] == 'partial'
        assert client.get('/api/trains').json()['count'] == 3
        assert client.get('/api/trains?line_id=ordinary').json()['trains'][0]['number'] == 'synthetic-ktx-on-normal'


def test_api_readers_never_trigger_upstream_requests(single):
    calls = []
    def handler(request):
        calls.append(request)
        assert request.url.host == 'gis.korail.com'
        assert request.headers['referer'].startswith('https://gis.korail.com/')
        return httpx.Response(200, json=single)
    app = create_app(Settings(_env_file=None, live_enabled=True), httpx.MockTransport(handler))
    with TestClient(app) as client:
        for _ in range(20):
            result = client.get('/api/trains')
            assert result.status_code == 200 and result.json()['count'] == 1
            assert client.get('/api/status').json()['collection_enabled'] is True
        assert len(calls) == 1


def test_midnight_reception_does_not_change_service_identity(single):
    before = normalize(single, AT).trains[0]
    after = normalize(single, AT + timedelta(days=1)).trains[0]
    assert before.id == after.id
