import asyncio
import json
from contextlib import asynccontextmanager, suppress
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles

from .catalog import Catalog
from .collector import Collector
from .config import DATA_DIR, Settings
from .matcher import RailwayMatcher
from .models import SourceStatus, TrainResponse
from .normalizer import normalize, response_time

ARCHIVES = {
    '141445': ('trains_20261026_141445_KST.json', '2026-10-26T05:14:46.648510+00:00'),
    '141536': ('trains_20261026_141536_KST.json', '2026-10-26T05:15:36.999404+00:00'),
}


def create_app(settings: Settings | None = None, transport=None) -> FastAPI:
    settings = settings or Settings()
    catalog = Catalog(settings.data_dir)
    matcher = RailwayMatcher(settings.data_dir / 'segments.geojson', set(catalog.lines), settings)
    for line in catalog.lines.values():
        if line['id'] not in matcher.verified_line_ids:
            line['coverage'] = 'unavailable'
        elif line['coverage'] != 'verified' or not line.get('coverage_evidence'):
            line['coverage'] = 'partial'
    archives = {}
    for key, (filename, received_at) in ARCHIVES.items():
        parsed = normalize(json.loads((DATA_DIR / 'snapshots' / filename).read_text()), response_time(received_at))
        archive_matcher = RailwayMatcher(settings.data_dir / 'segments.geojson', set(catalog.lines), settings)
        archives[key] = (archive_matcher.match_snapshot(parsed.trains), parsed, response_time(received_at))

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        async with httpx.AsyncClient(timeout=settings.timeout_seconds, follow_redirects=False, transport=transport) as client:
            collector = Collector(settings, matcher, client)
            app.state.collector = collector
            task = asyncio.create_task(collector.run(), name='korail-shared-collector')
            try:
                yield
            finally:
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task

    app = FastAPI(title='KORAIL Live Split-Flap Board', version='0.1.0', lifespan=lifespan)
    app.state.catalog = catalog

    def snapshot(source: str, archive: str):
        if source == 'live':
            c = app.state.collector
            return c.trains, c.status()
        trains, parsed, received_at = archives[archive]
        return trains, SourceStatus(source='archive', state='archive', freshness='historical',
            message='2026년 10월 26일 수신 기록 · 현재 운행 정보가 아닙니다.',
            last_received_at=received_at, source_timestamp=parsed.source_timestamp,
            source_age_seconds=max(0, (datetime.now(timezone.utc) - parsed.source_timestamp).total_seconds()) if parsed.source_timestamp else None,
            poll_seconds=settings.poll_seconds, collection_enabled=False,
            geometry_available=bool(matcher.verified_line_ids), quality=parsed.quality)

    @app.get('/api/health')
    def health():
        return {'status': 'ok', 'service': 'korail-live-board', 'collector_state': app.state.collector.status().state}

    @app.get('/api/status', response_model=SourceStatus)
    def status(source: Literal['live', 'archive'] = 'live', archive: Literal['141445', '141536'] = '141536'):
        return snapshot(source, archive)[1]

    @app.get('/api/lines')
    def lines():
        return {'lines': list(catalog.lines.values()), 'matching_crs': 'EPSG:5179',
                'confidence_kind': 'heuristic_score_not_probability'}

    @app.get('/api/stations')
    def stations(q: str = Query(default='', max_length=100)):
        from .catalog import canonical_station_name
        query = canonical_station_name(q)
        return {'stations': [{**s, 'line_ids': catalog.station_lines(s['id'])} for s in catalog.stations.values()
                            if any(query in canonical_station_name(alias) for alias in [s['name'], *s['aliases']])]}

    @app.get('/api/trains', response_model=TrainResponse)
    def trains(line_id: str | None = Query(default=None, max_length=100), station_id: str | None = Query(default=None, max_length=100),
               source: Literal['live', 'archive'] = 'live', archive: Literal['141445', '141536'] = '141536'):
        try:
            selected = catalog.resolve(station_id, line_id)
        except KeyError as exc:
            raise HTTPException(404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(400, detail=str(exc)) from exc
        data, source_status = snapshot(source, archive)
        if selected.state in ('unavailable', 'unmapped', 'select_line'):
            filtered = []
        elif selected.line_id:
            filtered = [t for t in data if t.match.status == 'matched' and t.match.line_id == selected.line_id]
        else:
            filtered = data
        return TrainResponse(trains=filtered, count=len(filtered), total_received=len(data),
            unknown_count=sum(t.match.status == 'unknown' for t in data),
            ambiguous_count=sum(t.match.status == 'ambiguous' for t in data), status=source_status, filter=selected)

    # Production: build frontend first and serve from the same origin. /api needs no CORS.
    dist = Path(__file__).resolve().parents[2] / 'frontend' / 'dist'
    if dist.is_dir():
        app.mount('/', StaticFiles(directory=dist, html=True), name='frontend')
    return app


app = create_app()
