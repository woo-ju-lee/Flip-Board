"""Conservative physical-track matching in Korea 2000 / Unified CS (EPSG:5179)."""
import json
import math
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from pyproj import Transformer
from shapely import transform
from shapely.geometry import Point, shape
from shapely.strtree import STRtree

from .config import Settings
from .models import MatchCandidate, TrainLineMatch, TrainPosition

PROJECT = Transformer.from_crs('EPSG:4326', 'EPSG:5179', always_xy=True)


@dataclass
class Segment:
    id: str
    line_id: str | None
    geometry: object
    eligible: bool


@dataclass
class History:
    point: Point
    at: datetime
    line_id: str | None
    pending: str | None = None
    confirmations: int = 0


class RailwayMatcher:
    def __init__(self, path: Path, line_ids: set[str], settings: Settings):
        self.settings = settings
        self.history: dict[str, History] = {}
        raw = json.loads(path.read_text(encoding='utf-8'))
        if raw.get('type') != 'FeatureCollection' or not isinstance(raw.get('features'), list):
            raise ValueError('Expected segments FeatureCollection')
        if raw.get('crs', {}).get('properties', {}).get('name', 'EPSG:4326') not in ('EPSG:4326', 'urn:ogc:def:crs:EPSG::4326'):
            raise ValueError('Segments must use EPSG:4326')
        self.segments = []
        seen = set()
        for f in raw['features']:
            p = f['properties']
            sid, line_id = p['segment_id'], p.get('line_id')
            if sid in seen or (line_id is not None and line_id not in line_ids):
                raise ValueError('Duplicate segment ID or unknown line ID')
            seen.add(sid)
            geo = shape(f['geometry'])
            if geo.geom_type not in ('LineString', 'MultiLineString') or geo.is_empty or not geo.is_valid:
                raise ValueError(f'Invalid segment geometry: {sid}')
            x1, y1, x2, y2 = geo.bounds
            if not all(math.isfinite(v) for v in geo.bounds) or not (120 <= x1 <= x2 <= 135 and 30 <= y1 <= y2 <= 45):
                raise ValueError(f'Segment outside service bounds: {sid}')
            eligible = (p.get('verified') is True and p.get('neighboring_tracks_reviewed') is True
                        and bool(line_id) and all(p.get(key) for key in ('source', 'license', 'reviewed_by', 'reviewed_at', 'evidence')))
            if p.get('verified') is True and not eligible:
                raise ValueError(f'Verified segment lacks provenance or competing-track review: {sid}')
            self.segments.append(Segment(sid, line_id, transform(geo, PROJECT.transform, interleaved=False), eligible))
        self.tree = STRtree([s.geometry for s in self.segments]) if self.segments else None
        self.verified_line_ids = {s.line_id for s in self.segments if s.eligible}

    def match_snapshot(self, trains: list[TrainPosition]) -> list[TrainPosition]:
        result = [train.model_copy(update={'match': self.match(train)}) for train in trains]
        active_ids = {t.id for t in trains}
        self.history = {key: value for key, value in self.history.items() if key in active_ids}
        return result

    def match(self, train: TrainPosition) -> TrainLineMatch:
        if self.tree is None:
            return TrainLineMatch()
        cfg = self.settings
        point = Point(*PROJECT.transform(*train.coordinates))
        at = train.source_timestamp or train.received_at
        previous = self.history.get(train.id)
        if previous:
            elapsed = (at - previous.at).total_seconds()
            if 0 < elapsed <= 300 and point.distance(previous.point) > cfg.max_speed_meters_per_second * elapsed + 150:
                # Do not allow one impossible observation to poison the trusted history.
                return TrainLineMatch(reason='implausible_position_jump')
        by_line: dict[str, MatchCandidate] = {}
        for index in self.tree.query(point.buffer(cfg.match_distance_meters)):
            segment = self.segments[int(index)]
            distance = point.distance(segment.geometry)
            if distance <= cfg.match_distance_meters:
                candidate = MatchCandidate(line_id=segment.line_id, segment_id=segment.id,
                    distance_m=round(distance, 2), verified=segment.eligible)
                key = segment.line_id or f'unlabeled:{segment.id}'
                # An unreviewed nearby segment must still remain a competing candidate.
                if not segment.eligible:
                    key = f'unreviewed:{segment.id}'
                if key not in by_line or distance < by_line[key].distance_m:
                    by_line[key] = candidate
        candidates = sorted(by_line.values(), key=lambda x: (x.distance_m, x.segment_id))
        if not candidates:
            self.history[train.id] = History(point, at, None)
            return TrainLineMatch(reason='outside_verified_tracks')
        best = candidates[0]
        base = dict(distance_m=best.distance_m, candidates=candidates[:8])
        if len(candidates) > 1 and candidates[1].distance_m - best.distance_m <= cfg.ambiguity_meters:
            self.history[train.id] = History(point, at, previous.line_id if previous else None)
            return TrainLineMatch(status='ambiguous', reason='parallel_tracks_or_junction', **base)
        if not best.verified:
            self.history[train.id] = History(point, at, None)
            return TrainLineMatch(reason='unverified_nearest_segment', **base)
        confidence = round(1 - best.distance_m / (2 * cfg.match_distance_meters), 3)
        if confidence < cfg.min_confidence:
            self.history[train.id] = History(point, at, None)
            return TrainLineMatch(reason='insufficient_distance_confidence', confidence=confidence, **base)
        if previous and previous.line_id and previous.line_id != best.line_id:
            count = previous.confirmations if previous.pending == best.line_id else 0
            if at > previous.at:
                count += 1
            if count < cfg.switch_confirmations:
                self.history[train.id] = History(point, at, previous.line_id, best.line_id, count)
                return TrainLineMatch(status='ambiguous', reason='line_change_pending', confidence=confidence, **base)
        self.history[train.id] = History(point, at, best.line_id)
        return TrainLineMatch(status='matched', line_id=best.line_id, segment_id=best.segment_id,
            confidence=confidence, reason='reviewed_geometry_distance_and_continuity', **base)
