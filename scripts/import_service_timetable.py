#!/usr/bin/env python3
"""Build the fixed-date service demo from the two pinned official KORAIL XLSX files.

Requires openpyxl. This is an offline importer: it never requests live train data.
Zero-valued timetable cells are blank/non-stops, not midnight calls. A positive
Excel day value at midnight remains a real call. Partial cross-line tables and
conflicting complete patterns are left unmapped rather than combined by guess.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
import hashlib
import json
from pathlib import Path
import re
from zoneinfo import ZoneInfo

from openpyxl import load_workbook

ROOT = Path(__file__).resolve().parents[1]
KST = ZoneInfo('Asia/Seoul')
SERVICE_DATE = date(2026, 10, 26)
SOURCES = {
    'ktx': {
        'id': 'korail-ktx-20260901',
        'title': '코레일 KTX 열차시간표 (2026.9.1. 시행)',
        'url': 'https://www.korail.com/file/cubedata/COMMON/jfile/202608/25/202608251a036897009480.xlsx',
        'effective_from': '2026-09-01',
        'effective_until': '2026-11-01',
        'sha256': 'cf69ea35e0b6ad9fb82c0e0b44f60833e34eadab55ea610eaf6784622351e9d0',
    },
    'regular': {
        'id': 'korail-regular-20260901',
        'title': '코레일 일반열차 시간표 (2026.9.1. 시행)',
        'url': 'https://www.korail.com/file/cubedata/COMMON/jfile/202608/25/202608251a036890aa0430.xlsx',
        'effective_from': '2026-09-01',
        'effective_until': '2026-11-01',
        'sha256': '2c1531ebce6ffd9aa18f51cc91d8fe4bffd7d95093dc970e21f5cc1964d3b61d',
    },
}
LINE_IDS = dict(zip(
    ['경부선', '경전선', '동해선', '호남선', '전라선', '강릉선', '중앙선',
     '중부내륙선', '장항선', '충북선', '목포보성선', '대구선', '영동선',
     '태백선', '경북선', '교외선', '서해선'],
    ['gyeongbu', 'gyeongjeon', 'donghae', 'honam', 'jeolla', 'gangneung', 'jungang',
     'jungbu-naeryuk', 'janghang', 'chungbuk', 'mokpo-boseong', 'daegu', 'yeongdong',
     'taebaek', 'gyeongbuk', 'gyoe', 'seohae'],
))
# Named aliases only: 판교(경기) and 판교 on the 장항선 are different stations.
ALIASES = {
    '울산(통도사)': '울산', '천안아산(온양온천)': '천안아산',
    '김천(구미)': '김천구미', '진부(오대산)': '진부',
    '홍성(출발)': '홍성', '홍성(도착)': '홍성',
}


def text(value) -> str:
    return re.sub(r'\s+', '', str(value)) if value is not None else ''


def station_name(value) -> str:
    name = text(value)
    return ALIASES.get(name, name)


def station_id(name: str) -> str:
    return 'ulsan' if name == '울산' else name


def train_number(value) -> str | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and value == int(value) and value > 0:
        return str(int(value))
    value = text(value)
    return str(int(value)) if value.isdigit() and int(value) > 0 else None


def time_seconds(value) -> int | None:
    """Preserve positive Excel days (e.g. next-day midnight); drop literal zero."""
    if isinstance(value, datetime):
        seconds = int((value - datetime(1899, 12, 31)).total_seconds())
    elif isinstance(value, timedelta):
        seconds = round(value.total_seconds())
    elif isinstance(value, time):
        seconds = value.hour * 3600 + value.minute * 60 + value.second
    elif isinstance(value, (float, int)) and not isinstance(value, bool):
        seconds = round(value * 86400)
    else:
        return None
    return seconds if seconds > 0 else None


def operates_on(note, service_date: date) -> bool:
    # Blank regular-timetable remark means daily; non-calendar notes fail closed.
    note = text(note)
    if note in ('', '매일', '00:00:00'):
        return True
    return bool(re.fullmatch('[월화수목금토일]+', note)) and '월화수목금토일'[service_date.weekday()] in note


@dataclass(frozen=True)
class Pattern:
    number: str
    line: str
    origin: str
    destination: str
    departure: int
    arrival: int
    stops: tuple[str, ...]
    source_id: str
    sheet: str
    cell: str
    calendar: str
    complete: bool


def ordered_stops(cells: list[tuple[str, object]]) -> list[tuple[str, int]]:
    result: list[tuple[str, int]] = []
    for name, value in cells:
        seconds = time_seconds(value)
        if seconds is None:
            continue
        while result and seconds < result[-1][1]:
            seconds += 86400
        result.append((station_name(name), seconds))
    return result


def parse_ktx(workbook, service_date: date) -> list[Pattern]:
    result = []
    for sheet in workbook:
        line = sheet.title.split('(')[0]
        if line not in LINE_IDS:
            raise ValueError(f'Unsupported KTX line: {sheet.title}')
        for row in sheet:
            for header in row:
                if text(header.value) != '열차번호':
                    continue
                station_cols = []
                note_col = None
                for col in range(header.column + 2, sheet.max_column + 1):
                    name = sheet.cell(header.row, col).value
                    if text(name).startswith('비고'):
                        note_col = col
                        break
                    if not name:
                        break
                    station_cols.append((col, name))
                if note_col is None:
                    raise ValueError(f'Missing KTX calendar column: {sheet.title} {header.coordinate}')
                for row_no in range(header.row + 3, sheet.max_row + 1):
                    cell = sheet.cell(row_no, header.column)
                    number = train_number(cell.value)
                    note = sheet.cell(row_no, note_col).value
                    if not number or not operates_on(note, service_date):
                        continue
                    stops = ordered_stops([(name, sheet.cell(row_no, col).value) for col, name in station_cols])
                    if len(stops) < 2:
                        continue
                    result.append(Pattern(number, line, stops[0][0], stops[-1][0],
                                          stops[0][1], stops[-1][1], tuple(name for name, _ in stops),
                                          SOURCES['ktx']['id'], sheet.title, cell.coordinate,
                                          text(note) or '매일', stops[-1][1] - stops[0][1] < 86400))
    return result


def parse_regular(workbook, service_date: date) -> list[Pattern]:
    result = []
    for sheet in workbook:
        if sheet.title == '보는방법':
            continue
        if sheet.title not in LINE_IDS:
            raise ValueError(f'Unsupported regular line: {sheet.title}')
        for row in sheet:
            for header in row:
                if text(header.value) != '열차번호':
                    continue
                note_row = next((r for r in range(header.row + 1, sheet.max_row + 1)
                                 if text(sheet.cell(r, header.column).value) == '비고'), None)
                if note_row is None or text(sheet.cell(header.row - 5, header.column).value) != '시발역':
                    raise ValueError(f'Unknown regular table layout: {sheet.title} {header.coordinate}')
                if text(sheet.cell(note_row + 1, header.column).value) != '종착역':
                    raise ValueError(f'Missing terminal row: {sheet.title} {header.coordinate}')
                for col in range(header.column + 1, sheet.max_column + 1):
                    cell = sheet.cell(header.row, col)
                    number = train_number(cell.value)
                    if not number:
                        break
                    note = sheet.cell(note_row, col).value
                    if not operates_on(note, service_date):
                        continue
                    origin = station_name(sheet.cell(header.row - 5, col).value)
                    destination = station_name(sheet.cell(note_row + 1, col).value)
                    departure = time_seconds(sheet.cell(header.row - 2, col).value)
                    arrival = time_seconds(sheet.cell(note_row + 4, col).value)
                    if departure is None or arrival is None:
                        continue
                    while arrival < departure:
                        arrival += 86400
                    cells = [(sheet.cell(r, header.column).value, sheet.cell(r, col).value)
                             for r in range(header.row + 1, note_row)]
                    stops = ordered_stops(cells)
                    # Off-sheet route sections do not establish a complete stop list.
                    has_offsheet_section = any(isinstance(v, str) and text(v) for _, v in cells)
                    complete = bool(stops) and not has_offsheet_section and (
                        stops[0] == (origin, departure) and stops[-1] == (destination, arrival)
                        and arrival - departure < 86400)
                    result.append(Pattern(number, sheet.title, origin, destination, departure,
                                          arrival, tuple(name for name, _ in stops), SOURCES['regular']['id'],
                                          sheet.title, cell.coordinate, text(note) or '매일', complete))
    return result


def record_key(train: dict, service_date: date) -> tuple | None:
    try:
        departure = datetime.fromisoformat(train['planned_departure']).astimezone(KST)
        arrival = datetime.fromisoformat(train['planned_arrival']).astimezone(KST)
    except (KeyError, TypeError, ValueError):
        return None
    if departure.date() != service_date:
        return None
    midnight = datetime.combine(service_date, time(), tzinfo=KST)
    return (train_number(train['number']), station_name(train['origin']), station_name(train['destination']),
            int((departure - midnight).total_seconds()), int((arrival - midnight).total_seconds()))


def pattern_key(pattern: Pattern) -> tuple:
    return pattern.number, pattern.origin, pattern.destination, pattern.departure, pattern.arrival


def build_catalog(archive: dict, patterns: list[Pattern], service_date: date) -> dict:
    trains = {t['id']: t for key in ('earlier', 'latest') for t in archive[key]['trains']}
    indexed = defaultdict(list)
    numbers = set()
    for pattern in patterns:
        indexed[pattern_key(pattern)].append(pattern)
        numbers.add(pattern.number)
    services, unmatched = [], []
    stations: dict[str, dict] = {}
    used_lines = set()
    for train in sorted(trains.values(), key=lambda t: (int(t['number']), t['id'])):
        key = record_key(train, service_date)
        candidates = indexed.get(key, [])
        complete = [p for p in candidates if p.complete]
        unique = {(p.line, p.stops) for p in complete}
        if key is None:
            reason = 'invalid_service_date_or_endpoints'
        elif not candidates:
            reason = 'endpoint_or_time_mismatch' if train_number(train['number']) in numbers else 'not_in_timetables_for_service_day'
        elif not complete:
            reason = 'incomplete_cross_line_table'
        elif len(unique) != 1:
            reason = 'ambiguous_complete_patterns'
        else:
            pattern = complete[0]
            line_id = 'service-' + LINE_IDS[pattern.line]
            used_lines.add(pattern.line)
            for name in pattern.stops:
                sid = station_id(name)
                if sid not in stations:
                    aliases = [name, name + '역']
                    aliases.extend(alias for alias, canonical in ALIASES.items() if canonical == name)
                    stations[sid] = {'id': sid, 'name': name, 'aliases': sorted(set(aliases)), 'line_ids': []}
                if line_id not in stations[sid]['line_ids']:
                    stations[sid]['line_ids'].append(line_id)
            services.append({
                'train_id': train['id'], 'number': train['number'],
                'origin': train['origin'], 'destination': train['destination'],
                'planned_departure': train['planned_departure'], 'planned_arrival': train['planned_arrival'],
                'line_id': line_id, 'stop_station_ids': [station_id(name) for name in pattern.stops],
                'source_id': pattern.source_id, 'source_sheet': pattern.sheet,
                'source_cell': pattern.cell, 'operating_days': pattern.calendar,
            })
            continue
        unmatched.append({'train_id': train['id'], 'number': train['number'], 'reason': reason})
    lines = [{'id': 'service-' + LINE_IDS[name], 'name': name, 'type': 'service', 'coverage': 'partial',
              'note': '공식 시간표와 운행일·열차번호·출발/도착역·예정시각이 일치한 기록만 포함합니다.',
              'source': '코레일 2026.9.1. 시행 시간표의 노선별 시트'}
             for name in LINE_IDS if name in used_lines]
    for station in stations.values():
        station['line_ids'].sort()
    service_ids = {s['train_id'] for s in services}
    snapshot_counts = {key: sum(t['id'] in service_ids for t in archive[key]['trains'])
                       for key in ('earlier', 'latest')}
    return {
        'schema_version': 1, 'service_date': service_date.isoformat(), 'sources': list(SOURCES.values()),
        'lines': lines, 'stations': sorted(stations.values(), key=lambda s: s['name']),
        'services': services, 'unmatched': unmatched,
        'summary': {'record_count': len(trains), 'matched_count': len(services), 'unmatched_count': len(unmatched),
                    'matched_by_snapshot': snapshot_counts, 'unmatched_reasons': dict(Counter(x['reason'] for x in unmatched)),
                    'matched_by_line': dict(Counter(s['line_id'] for s in services))},
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ktx', type=Path, required=True)
    parser.add_argument('--regular', type=Path, required=True)
    parser.add_argument('--archive', type=Path, default=ROOT / 'frontend/src/rotorDemoArchive.json')
    parser.add_argument('--output', type=Path, default=ROOT / 'frontend/src/serviceTimetable.json')
    args = parser.parse_args()
    patterns = []
    for kind in ('ktx', 'regular'):
        path = getattr(args, kind)
        source = SOURCES[kind]
        if not date.fromisoformat(source['effective_from']) <= SERVICE_DATE < date.fromisoformat(source['effective_until']):
            raise ValueError('Timetable does not apply to the fixed demo service date')
        if hashlib.sha256(path.read_bytes()).hexdigest() != source['sha256']:
            raise ValueError(f'{kind}: bytes differ from the reviewed official timetable; review source metadata before importing')
        workbook = load_workbook(path, data_only=True)
        patterns.extend((parse_ktx if kind == 'ktx' else parse_regular)(workbook, SERVICE_DATE))
        workbook.close()
    catalog = build_catalog(json.loads(args.archive.read_text(encoding='utf-8')), patterns, SERVICE_DATE)
    args.output.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(catalog['summary'], ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
