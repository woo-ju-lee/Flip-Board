import copy
import json
from datetime import datetime, timezone

import pytest
from pyproj import Transformer

from backend.app.config import DATA_DIR, Settings
from backend.app.matcher import RailwayMatcher

AT = datetime(2026, 10, 26, 5, 16, tzinfo=timezone.utc)
TO_WGS84 = Transformer.from_crs(5179, 4326, always_xy=True)


@pytest.fixture
def capture():
    return json.loads((DATA_DIR / 'snapshots/trains_20261026_141536_KST.json').read_text(encoding='utf-8'))


@pytest.fixture
def single(capture):
    result = copy.deepcopy(capture)
    result['features'] = result['features'][:1]
    return result


def synthetic_segment(sid, line, points, verified=True):
    """Artificial geometry ONLY for tests; never copied into application data."""
    return {'type': 'Feature', 'properties': {
        'segment_id': sid, 'line_id': line, 'verified': verified,
        'neighboring_tracks_reviewed': verified, 'source': 'synthetic-test',
        'license': 'test-only', 'reviewed_by': 'automated-fixture',
        'reviewed_at': '2026-10-26', 'evidence': 'Synthetic geometry, not a real track',
    }, 'geometry': {'type': 'LineString', 'coordinates': [TO_WGS84.transform(*p) for p in points]}}


@pytest.fixture
def matcher_factory(tmp_path):
    def factory(features=None, **kwargs):
        data = {'type': 'FeatureCollection', 'features': features or []}
        path = tmp_path / 'test-segments.geojson'
        path.write_text(json.dumps(data))
        return RailwayMatcher(path, {'gyeongbu-hsr', 'ordinary', 'honam-hsr'}, Settings(_env_file=None, **kwargs))
    return factory
