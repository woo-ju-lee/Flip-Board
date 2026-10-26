import json
import re
from pathlib import Path

from .models import FilterInfo


def canonical_station_name(value: str) -> str:
    return re.sub(r'[\s()（）]', '', value.removesuffix('역')).casefold()


class Catalog:
    def __init__(self, data_dir: Path):
        raw = json.loads((data_dir / 'catalog.json').read_text())
        if raw.get('schema_version') != 1:
            raise ValueError('Unsupported catalog version')
        self.lines = {item['id']: item for item in raw['lines']}
        self.stations = {item['id']: item for item in raw['stations']}
        self.mappings = raw['station_line_mappings']
        if len(self.lines) != len(raw['lines']) or len(self.stations) != len(raw['stations']):
            raise ValueError('Duplicate catalog IDs')
        for m in self.mappings:
            if m['station_id'] not in self.stations or m['line_id'] not in self.lines or not m.get('source'):
                raise ValueError('Invalid station/line mapping')
        self.aliases = {}
        for s in self.stations.values():
            for alias in [s['id'], s['name'], *s['aliases']]:
                key = canonical_station_name(alias)
                if key in self.aliases and self.aliases[key] != s['id']:
                    raise ValueError('Ambiguous station alias')
                self.aliases[key] = s['id']

    def station_id(self, value: str) -> str | None:
        return self.aliases.get(canonical_station_name(value))

    def station_lines(self, station_id: str) -> list[str]:
        return sorted({m['line_id'] for m in self.mappings if m['station_id'] == station_id and m.get('verified') is True})

    def resolve(self, station: str | None, line: str | None) -> FilterInfo:
        sid = self.station_id(station) if station else None
        if station and sid is None:
            raise KeyError('알 수 없는 역입니다.')
        if line and line not in self.lines:
            raise KeyError('알 수 없는 노선입니다.')
        available = self.station_lines(sid) if sid else []
        if sid:
            if line and line not in available:
                raise ValueError('선택한 역에 연결된 노선이 아닙니다.')
            if not available:
                return FilterInfo(station_id=sid, state='unmapped', message='이 역에는 검증된 노선 연결 정보가 없습니다.')
            if not line and len(available) > 1:
                return FilterInfo(station_id=sid, state='select_line', available_line_ids=available, message='이 역이 속한 노선을 선택해 주세요.')
            line = line or available[0]
        if not line:
            return FilterInfo(state='all', message='수신된 전체 열차를 표시합니다. 노선 판별 상태와 관계없이 포함합니다.')
        coverage = self.lines[line]['coverage']
        return FilterInfo(station_id=sid, line_id=line, available_line_ids=available,
            state='ready' if coverage == 'verified' else 'partial' if coverage == 'partial' else 'unavailable',
            message='검증된 구간에 매칭된 열차만 표시합니다.' if coverage != 'unavailable' else '노선 판별 준비 중 · 검증된 선로 도형이 없습니다. 운행 열차가 없다는 뜻은 아닙니다.')
