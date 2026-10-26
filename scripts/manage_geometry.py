"""Offline preparation and validation; this tool never downloads or auto-verifies data."""
import argparse
import hashlib
import json
from pathlib import Path

from backend.app.catalog import Catalog
from backend.app.config import Settings
from backend.app.matcher import RailwayMatcher


def prepare(input_path: Path, output_path: Path, source: str, license_reference: str):
    payload = json.loads(input_path.read_text())
    if payload.get('type') != 'FeatureCollection' or not isinstance(payload.get('features'), list):
        raise ValueError('Expected GeoJSON FeatureCollection')
    crs = payload.get('crs', {}).get('properties', {}).get('name', 'EPSG:4326')
    if crs not in ('EPSG:4326', 'urn:ogc:def:crs:EPSG::4326', 'urn:ogc:def:crs:OGC:1.3:CRS84'):
        raise ValueError('Transform original data to EPSG:4326 before preparation')
    features, seen = [], set()
    for item in payload['features']:
        geometry = item.get('geometry', {})
        if geometry.get('type') not in ('LineString', 'MultiLineString'):
            raise ValueError('Only real line geometries are supported')
        digest = hashlib.sha256(json.dumps(geometry, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        if digest in seen:
            continue
        seen.add(digest)
        features.append({'type': 'Feature', 'geometry': geometry, 'properties': {
            'segment_id': f'segment-{digest[:16]}', 'geometry_sha256': digest,
            'line_id': None, 'verified': False, 'neighboring_tracks_reviewed': False,
            'source': source, 'license': license_reference, 'original_feature_id': item.get('id'),
            'reviewed_by': None, 'reviewed_at': None, 'evidence': None,
        }})
    result = {'type': 'FeatureCollection', 'schema_version': 1, 'features': features}
    # Exclusive creation avoids accidentally overwriting an existing reviewed mapping.
    with output_path.open('x') as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2)
    print(f'Prepared {len(features)} UNVERIFIED segments in {output_path}')


def validate(data_dir: Path):
    catalog = Catalog(data_dir)
    matcher = RailwayMatcher(data_dir / 'segments.geojson', set(catalog.lines), Settings(_env_file=None))
    print(json.dumps({'stations': len(catalog.stations), 'lines': len(catalog.lines),
                      'segments': len(matcher.segments), 'eligible_segments': sum(s.eligible for s in matcher.segments),
                      'eligible_line_ids': sorted(matcher.verified_line_ids),
                      'note': 'Schema validation is not independent geospatial accuracy verification.'}, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    p = commands.add_parser('prepare')
    p.add_argument('input', type=Path)
    p.add_argument('output', type=Path)
    p.add_argument('--source', required=True)
    p.add_argument('--license', required=True)
    v = commands.add_parser('validate')
    v.add_argument('data_dir', type=Path)
    args = parser.parse_args()
    if args.command == 'prepare':
        prepare(args.input, args.output, args.source, args.license)
    else:
        validate(args.data_dir)


if __name__ == '__main__':
    main()
