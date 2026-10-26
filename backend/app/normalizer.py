"""Normalize the captured KORAIL schema; never invent position or identity fields."""
import hashlib
import json
import math
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from .models import DataQuality, TrainPosition

KST = ZoneInfo('Asia/Seoul')


class InvalidPayload(ValueError):
    pass


def planned_time(value) -> datetime | None:
    if not isinstance(value, str) or len(value) != 14 or not value.isdigit():
        return None
    try:
        return datetime.strptime(value, '%Y%m%d%H%M%S').replace(tzinfo=KST)
    except ValueError:
        return None


def response_time(value) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        result = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return result.astimezone(timezone.utc) if result.tzinfo else None
    except ValueError:
        return None


def label(value, default='—') -> str:
    return value.strip() if isinstance(value, str) and value.strip() else default


@dataclass(frozen=True)
class ParsedSnapshot:
    trains: list[TrainPosition]
    source_timestamp: datetime | None
    quality: DataQuality


def normalize(payload, received_at: datetime) -> ParsedSnapshot:
    if not isinstance(payload, dict) or payload.get('type') != 'FeatureCollection' or not isinstance(payload.get('features'), list):
        raise InvalidPayload('Expected GeoJSON FeatureCollection')
    crs = payload.get('crs')
    if crs is not None:
        if not isinstance(crs, dict) or not isinstance(crs.get('properties'), dict) or crs['properties'].get('name') not in ('urn:ogc:def:crs:EPSG::4326', 'EPSG:4326', 'urn:ogc:def:crs:OGC:1.3:CRS84'):
            raise InvalidPayload('Unsupported coordinate reference system')
    source_timestamp = response_time(payload.get('timeStamp'))
    if source_timestamp and (source_timestamp - received_at).total_seconds() > 60:
        raise InvalidPayload('Source timestamp is in the future')
    records: dict[str, TrainPosition] = {}
    collisions: set[str] = set()
    reasons: Counter = Counter()
    duplicates = 0
    for feature in payload['features']:
        if not isinstance(feature, dict) or feature.get('type') != 'Feature':
            reasons['invalid_feature'] += 1
            continue
        p, g = feature.get('properties'), feature.get('geometry')
        if not isinstance(p, dict) or not isinstance(g, dict) or g.get('type') != 'Point':
            reasons['invalid_geometry_or_properties'] += 1
            continue
        coords = g.get('coordinates')
        if not isinstance(coords, list) or len(coords) < 2 or not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in coords[:2]):
            reasons['invalid_coordinates'] += 1
            continue
        lon, lat = coords[:2]
        # This collector's query is explicitly bounded to this Korean service region.
        if not (120 <= lon <= 135 and 30 <= lat <= 45):
            reasons['out_of_service_bounds'] += 1
            continue
        number = p.get('trn_no')
        departure = planned_time(p.get('dpt_pln_dttm'))
        if not isinstance(number, str) or not number.strip() or departure is None:
            reasons['missing_stable_identity'] += 1
            continue
        number = number.strip()
        origin, destination = label(p.get('dpt_stn_nm')), label(p.get('arv_stn_nm'))
        # Route endpoints disambiguate simultaneous services; opaque feature.id is ignored.
        identity = json.dumps([number, departure.isoformat(), origin, destination], ensure_ascii=False)
        train_id = 'train-' + hashlib.sha256(identity.encode()).hexdigest()[:24]
        delay = p.get('delay')
        if isinstance(delay, bool) or not isinstance(delay, (int, float)) or not math.isfinite(delay) or delay < 0:
            delay = None
        now = p.get('now_stn') if isinstance(p.get('now_stn'), str) else ''
        next_part = p.get('next_stn') if isinstance(p.get('next_stn'), str) else ''
        train = TrainPosition(
            id=train_id, number=number, kind=label(p.get('trn_case')), origin=origin,
            destination=destination, planned_departure=departure,
            planned_arrival=planned_time(p.get('arv_pln_dttm')),
            position_label=(now + next_part).strip() or '위치 문구 없음',
            coordinates=(lon, lat), delay_minutes=delay,
            delay_status='unknown' if delay is None else 'on_time' if delay == 0 else 'delayed',
            received_at=received_at, source_timestamp=source_timestamp,
        )
        if train_id in records:
            if records[train_id] == train:
                duplicates += 1
            else:
                collisions.add(train_id)
                reasons['conflicting_duplicate'] += 1
        else:
            records[train_id] = train
    for train_id in collisions:
        records.pop(train_id, None)
    if payload['features'] and not records:
        raise InvalidPayload('No usable records; retaining last successful snapshot')
    result = sorted(records.values(), key=lambda t: (t.number.zfill(8), t.id))
    return ParsedSnapshot(result, source_timestamp, DataQuality(
        input_count=len(payload['features']), accepted_count=len(result),
        rejected_count=len(payload['features']) - len(result) - duplicates,
        duplicate_count=duplicates, conflicting_ids=len(collisions), reasons=dict(reasons),
    ))
