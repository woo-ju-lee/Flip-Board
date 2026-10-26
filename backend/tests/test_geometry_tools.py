import json
from scripts.manage_geometry import prepare


def test_preparation_never_auto_labels_or_verifies(tmp_path):
    raw = {'type': 'FeatureCollection', 'features': [{
        'type': 'Feature', 'id': 'volatile-id', 'properties': {},
        'geometry': {'type': 'LineString', 'coordinates': [[127, 37], [127.001, 37.001]]},
    }]}
    input_path, output_path = tmp_path / 'input.json', tmp_path / 'output.json'
    input_path.write_text(json.dumps(raw))
    prepare(input_path, output_path, 'synthetic fixture', 'test-only')
    p = json.loads(output_path.read_text())['features'][0]['properties']
    assert p['verified'] is False and p['line_id'] is None
    assert p['segment_id'].startswith('segment-')
