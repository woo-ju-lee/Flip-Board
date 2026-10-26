import asyncio
from datetime import datetime, timedelta, timezone

import httpx

from .config import Settings
from .matcher import RailwayMatcher
from .models import DataQuality, SourceStatus
from .normalizer import InvalidPayload, normalize

TRAIN_URL = 'https://gis.korail.com/api/train'
REFERER = 'https://gis.korail.com/korailTalk/entrance?route=main'


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Collector:
    """One lifespan task and one cache for every browser. GETs never poll upstream."""

    def __init__(self, settings: Settings, matcher: RailwayMatcher, client: httpx.AsyncClient):
        self.settings, self.matcher, self.client = settings, matcher, client
        self.trains = []
        self.quality = DataQuality()
        self.last_received_at = None
        self.source_timestamp = None
        self.last_attempt_at = None
        self.next_attempt_at = None
        self.failures = 0
        self.error_code = None
        self.blocked = False
        self.lock = asyncio.Lock()

    def status(self, now: datetime | None = None) -> SourceStatus:
        now = now or utcnow()
        source_age = max(0, (now - self.source_timestamp).total_seconds()) if self.source_timestamp else None
        cache_age = (now - self.last_received_at).total_seconds() if self.last_received_at else None
        freshness = ('none' if self.last_received_at is None else 'unknown' if source_age is None
                     else 'stale' if source_age > self.settings.stale_seconds or cache_age > self.settings.stale_seconds else 'fresh')
        if not self.settings.collection_allowed:
            state, message = 'disabled', '실시간 수집 대기 · 이용 조건 및 접근 허용 확인 후 활성화합니다.'
        elif self.blocked:
            state, message = 'blocked', '접근 제한으로 자동 수집을 중단했습니다. 운영자가 접근 조건을 확인해야 합니다.'
        elif self.failures:
            state, message = ('stale', '갱신 실패 · 마지막 정상 수신 자료를 표시합니다.') if self.last_received_at else ('error', '연결 실패 · 아직 수신한 열차 자료가 없습니다.')
        elif self.last_received_at is None:
            state, message = 'connecting', '코레일 응답을 기다리고 있습니다.'
        elif freshness == 'stale':
            state, message = 'stale', '갱신 지연 · 원본 응답 또는 서버 수신 시각이 오래되었습니다.'
        elif freshness == 'unknown':
            state, message = 'unverified_time', '원본 기준 시각 미확인 · 최신 정보 여부를 확인할 수 없습니다.'
        elif not self.trains:
            state, message = 'empty', '정상 수신 · 원본 응답의 열차 목록이 비어 있습니다.'
        else:
            state, message = 'ok', '정상 수신 · 코레일 응답에 포함된 열차를 표시합니다.'
        return SourceStatus(source='live', state=state, message=message, freshness=freshness,
            last_received_at=self.last_received_at, source_timestamp=self.source_timestamp,
            source_age_seconds=source_age, last_attempt_at=self.last_attempt_at,
            next_attempt_at=self.next_attempt_at, poll_seconds=self.settings.poll_seconds,
            stale_after_seconds=self.settings.stale_seconds,
            consecutive_failures=self.failures, error_code=self.error_code,
            collection_enabled=self.settings.collection_allowed,
            geometry_available=bool(self.matcher.verified_line_ids), quality=self.quality)

    async def refresh(self) -> None:
        if not self.settings.collection_allowed or self.blocked or self.lock.locked():
            return
        async with self.lock:
            self.last_attempt_at = utcnow()
            try:
                response = await self.client.get(TRAIN_URL, params={'bbox': '120,30,135,45'},
                    headers={'Referer': REFERER, 'Accept': 'application/json'})
                # No header rotation, authentication workaround, redirect, or 403 retry.
                if response.status_code in (401, 403, 429) or 300 <= response.status_code < 400:
                    self.blocked = True
                    self.failures += 1
                    self.error_code = f'access_restricted_{response.status_code}'
                    self.next_attempt_at = None
                    return
                response.raise_for_status()
                parsed = normalize(response.json(), utcnow())
                if self.source_timestamp and parsed.source_timestamp and parsed.source_timestamp < self.source_timestamp:
                    raise InvalidPayload('Source timestamp moved backwards')
                matched = self.matcher.match_snapshot(parsed.trains)
                # Commit one complete snapshot after validation; a failed request never erases it.
                self.trains, self.quality = matched, parsed.quality
                self.last_received_at = utcnow()
                self.source_timestamp = parsed.source_timestamp
                self.failures, self.error_code = 0, None
            except httpx.TimeoutException:
                self.failures += 1
                self.error_code = 'timeout'
            except httpx.HTTPStatusError as exc:
                self.failures += 1
                self.error_code = f'http_{exc.response.status_code}'
            except httpx.RequestError:
                self.failures += 1
                self.error_code = 'connection_error'
            except (ValueError, TypeError):
                self.failures += 1
                self.error_code = 'invalid_response'
            delay = min(self.settings.max_backoff_seconds, self.settings.poll_seconds * 2 ** min(self.failures, 10))
            self.next_attempt_at = utcnow() + timedelta(seconds=delay)

    async def run(self) -> None:
        if not self.settings.collection_allowed:
            return
        while not self.blocked:
            await self.refresh()
            if self.blocked:
                return
            await asyncio.sleep(max(0, (self.next_attempt_at - utcnow()).total_seconds()))
