"""Regressions for timetable stops, identity, calendar, and incomplete sheets."""
from dataclasses import replace
from datetime import date, datetime, time, timedelta
import unittest

from openpyxl import Workbook

from import_service_timetable import (
    Pattern, build_catalog, operates_on, parse_ktx, parse_regular,
    record_key, station_id, station_name, time_seconds,
)


DAY = date(2026, 10, 26)  # Monday, matching the stored location snapshots.


def record(number='31', identity='test-31', **changes):
    value = {
        'id': identity, 'number': number, 'origin': '서울', 'destination': '부산',
        'planned_departure': '2026-10-26T11:58:00+09:00',
        'planned_arrival': '2026-10-26T14:42:00+09:00',
    }
    return {**value, **changes}


def pattern(**changes):
    value = Pattern(
        number='31', line='경부선', origin='서울', destination='부산',
        departure=11 * 3600 + 58 * 60, arrival=14 * 3600 + 42 * 60,
        stops=('서울', '울산', '부산'), source_id='korail-ktx-20260901',
        sheet='경부선', cell='B50', calendar='매일', complete=True,
    )
    return replace(value, **changes)


def archive(latest, earlier=None):
    return {'latest': {'trains': latest}, 'earlier': {'trains': latest if earlier is None else earlier}}


class TimetableImportTests(unittest.TestCase):
    def test_hidden_zero_is_not_a_stop_but_next_day_midnight_is(self):
        for value in (0, 0.0, time(0), timedelta(0), None, '', '통과'):
            with self.subTest(value=value):
                self.assertIsNone(time_seconds(value))
        self.assertEqual(time_seconds(1), 86400)
        self.assertEqual(time_seconds(datetime(1900, 1, 1)), 86400)
        self.assertEqual(time_seconds(timedelta(days=1)), 86400)
        self.assertEqual(time_seconds(time(14, 20, 30)), 14 * 3600 + 20 * 60 + 30)

    def test_calendar_excludes_weekend_and_unrecognized_notes(self):
        for note in (None, '', '매일', '월화수목', '월 수 금'):
            self.assertTrue(operates_on(note, DAY), note)
        for note in ('금토일', '토일', '공휴일', '임시운행'):
            self.assertFalse(operates_on(note, DAY), note)
        self.assertTrue(operates_on('금토일', date(2026, 10, 25)))

    def test_named_aliases_do_not_merge_different_pangyo_stations(self):
        self.assertEqual(station_name('울산 (통도사)'), '울산')
        self.assertEqual(station_id(station_name('울산(통도사)')), 'ulsan')
        self.assertEqual(station_name('천안아산(온양온천)'), '천안아산')
        self.assertEqual(station_name('김천(구미)'), '김천구미')
        self.assertEqual(station_name('홍성(도착)'), '홍성')
        self.assertNotEqual(station_name('판교(경기)'), station_name('판교'))

    def test_ktx_layout_distinguishes_stopping_and_passing_same_route(self):
        workbook = Workbook()
        sheet = workbook.active
        sheet.title = '경부선'
        for column, value in enumerate(['열차번호', '편성', '서울', '울산', '부산', '비고'], 2):
            sheet.cell(1, column, value)
        for row, number, ulsan in ((4, 31, time(14, 20, 30)), (5, 35, time(0))):
            sheet.cell(row, 2, number)
            sheet.cell(row, 3, 'KTX')
            sheet.cell(row, 4, time(11, 58))
            sheet.cell(row, 5, ulsan).number_format = 'h:mm;;'
            sheet.cell(row, 6, time(14, 42))
            sheet.cell(row, 7, '매일')
        sheet.cell(6, 2, 99)
        sheet.cell(6, 4, time(11, 58))
        sheet.cell(6, 6, time(14, 42))
        sheet.cell(6, 7, '금토일')
        parsed = {item.number: item for item in parse_ktx(workbook, DAY)}
        self.assertEqual(set(parsed), {'31', '35'})
        self.assertEqual(parsed['31'].stops, ('서울', '울산', '부산'))
        self.assertEqual(parsed['35'].stops, ('서울', '부산'))

    def test_regular_layout_marks_offsheet_route_section_incomplete(self):
        workbook = Workbook()
        sheet = workbook.active
        sheet.title = '경부선'
        for row, name in {1: '시발역', 6: '열차번호', 7: '서울', 8: '울산',
                          9: '부산', 10: '비고', 11: '종착역'}.items():
            sheet.cell(row, 1, name)
        for column, number in ((2, 1001), (3, 1003)):
            sheet.cell(1, column, '서울')
            sheet.cell(4, column, time(11, 58))
            sheet.cell(6, column, number)
            sheet.cell(7, column, time(11, 58))
            sheet.cell(8, column, time(14, 20))
            sheet.cell(9, column, time(14, 42))
            sheet.cell(11, column, '부산')
            sheet.cell(14, column, time(14, 42))
        sheet.cell(8, 3, '경전선 경유')
        parsed = {item.number: item for item in parse_regular(workbook, DAY)}
        self.assertTrue(parsed['1001'].complete)
        self.assertEqual(parsed['1001'].stops, ('서울', '울산', '부산'))
        self.assertFalse(parsed['1003'].complete)

    def test_matching_requires_endpoints_and_both_times_not_just_number(self):
        matched = build_catalog(archive([record(number='00031')]), [pattern()], DAY)
        self.assertEqual(len(matched['services']), 1)
        self.assertEqual(matched['services'][0]['number'], '00031')
        for change in ({'origin': '용산'}, {'destination': '서울'},
                       {'planned_departure': '2026-10-26T11:59:00+09:00'},
                       {'planned_arrival': '2026-10-26T14:43:00+09:00'}):
            with self.subTest(change=change):
                result = build_catalog(archive([record(**change)]), [pattern()], DAY)
                self.assertEqual(result['services'], [])
                self.assertEqual(result['unmatched'][0]['reason'], 'endpoint_or_time_mismatch')

    def test_other_service_date_and_missing_arrival_are_unmapped(self):
        for change in ({'planned_departure': '2026-10-27T11:58:00+09:00'},
                       {'planned_arrival': None}):
            with self.subTest(change=change):
                item = record(**change)
                self.assertIsNone(record_key(item, DAY))
                result = build_catalog(archive([item]), [pattern()], DAY)
                self.assertEqual(result['services'], [])
                self.assertEqual(result['unmatched'][0]['reason'], 'invalid_service_date_or_endpoints')

    def test_incomplete_tables_never_supply_a_partial_stop_list(self):
        result = build_catalog(archive([record()]), [pattern(complete=False)], DAY)
        self.assertEqual(result['services'], [])
        self.assertEqual(result['unmatched'][0]['reason'], 'incomplete_cross_line_table')

    def test_conflicting_complete_patterns_are_not_arbitrarily_selected(self):
        result = build_catalog(archive([record()]), [pattern(), pattern(stops=('서울', '부산'))], DAY)
        self.assertEqual(result['services'], [])
        self.assertEqual(result['unmatched'][0]['reason'], 'ambiguous_complete_patterns')
        repeated = build_catalog(archive([record()]), [pattern(), pattern(cell='B51')], DAY)
        self.assertEqual(len(repeated['services']), 1)

    def test_snapshot_coverage_and_repeated_loop_stations_are_preserved(self):
        loop = record('1244', 'test-loop', origin='홍성', destination='홍성')
        loop_pattern = pattern(number='1244', origin='홍성', destination='홍성',
                               line='서해선', stops=('홍성', '합덕', '홍성'))
        result = build_catalog(archive([record(), loop], [record()]), [pattern(), loop_pattern], DAY)
        self.assertEqual(result['summary']['matched_by_snapshot'], {'earlier': 1, 'latest': 2})
        service = next(item for item in result['services'] if item['number'] == '1244')
        self.assertEqual(service['stop_station_ids'], ['홍성', '합덕', '홍성'])


if __name__ == '__main__':
    unittest.main()
