import json

from fastapi.testclient import TestClient

from backend.app.catalog import Catalog
from backend.app.config import DATA_DIR, Settings
from backend.app.main import create_app


def test_endpoints_archive_and_disabled_live():
    with TestClient(create_app(Settings(_env_file=None))) as c:
        assert c.get('/api/health').json()['status'] == 'ok'
        assert c.get('/api/status').json()['state'] == 'disabled'
        assert c.get('/api/trains').json()['trains'] == []
        archive = c.get('/api/trains?source=archive').json()
        assert archive['count'] == 148 and archive['status']['freshness'] == 'historical'
        assert archive['status']['last_received_at'].startswith('2026-10-26T05:15:36')
        assert c.get('/api/trains?source=archive&archive=141445').json()['count'] == 145
        assert c.get('/api/trains?source=bogus').status_code == 422
        assert c.get('/api/trains?line_id=missing').status_code == 404
        assert c.get('/api/trains?station_id=missing').status_code == 404


def test_ulsan_alias_maps_line_but_does_not_fake_geometry():
    with TestClient(create_app(Settings(_env_file=None))) as c:
        for alias in ['ulsan', '울산', '울산역', '울산(통도사)역', '울산 통도사', 'Ulsan']:
            response = c.get('/api/trains', params={'station_id': alias, 'source': 'archive'}).json()
            assert response['filter']['line_id'] == 'gyeongbu-hsr'
            assert response['filter']['state'] == 'unavailable'
            assert response['count'] == 0 and response['total_received'] == 148
        assert len(c.get('/api/stations?q=통도사').json()['stations']) == 1
        assert c.get('/api/trains?station_id=ulsan&line_id=honam-hsr').status_code == 400
        assert c.get('/api/lines').json()['lines'][0]['coverage'] == 'unavailable'


def test_unknown_mapping_and_multiline_require_choice(tmp_path):
    raw = json.loads((DATA_DIR / 'catalog.json').read_text())
    raw['stations'].append({'id': 'synthetic-unmapped', 'name': '테스트역', 'aliases': []})
    raw['station_line_mappings'].append({'station_id': 'ulsan', 'line_id': 'honam-hsr', 'verified': True, 'source': 'test-only, NOT real station membership'})
    (tmp_path / 'catalog.json').write_text(json.dumps(raw))
    catalog = Catalog(tmp_path)
    assert catalog.resolve('synthetic-unmapped', None).state == 'unmapped'
    assert catalog.resolve('ulsan', None).state == 'select_line'
    assert len(catalog.resolve('ulsan', None).available_line_ids) == 2
