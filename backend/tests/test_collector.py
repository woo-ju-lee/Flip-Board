import asyncio
from datetime import timedelta

import httpx
import pytest

from backend.app.collector import Collector, utcnow
from backend.app.config import Settings
from .conftest import AT


def enabled(**kwargs):
    return Settings(_env_file=None, live_enabled=True, **kwargs)


@pytest.mark.parametrize('code', [401, 403, 429, 302])
async def test_access_restriction_halts(code, matcher_factory):
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(code)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        c = Collector(enabled(), matcher_factory(), client)
        await c.refresh()
        await c.refresh()
        assert len(calls) == 1 and c.blocked
        assert c.status().state == 'blocked' and c.next_attempt_at is None


async def test_server_failure_backoff_and_cache(single, matcher_factory):
    responses = [httpx.Response(200, json=single), httpx.Response(503), httpx.Response(503), httpx.Response(200, json=single)]
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: responses.pop(0))) as client:
        c = Collector(enabled(), matcher_factory(), client)
        await c.refresh()
        original = c.trains
        received = c.last_received_at
        await c.refresh()
        assert c.trains == original and c.last_received_at == received
        assert c.status().state == 'stale'
        assert 118 < (c.next_attempt_at - utcnow()).total_seconds() <= 120
        await c.refresh()
        assert 238 < (c.next_attempt_at - utcnow()).total_seconds() <= 240
        await c.refresh()
        assert c.failures == 0 and c.error_code is None


async def test_timeout(matcher_factory):
    def timeout(request):
        raise httpx.ReadTimeout('test', request=request)
    async with httpx.AsyncClient(transport=httpx.MockTransport(timeout)) as client:
        c = Collector(enabled(), matcher_factory(), client)
        await c.refresh()
        assert c.error_code == 'timeout' and c.status().state == 'error'


async def test_disabled_never_requests(matcher_factory):
    def fail(request):
        pytest.fail('Disabled collection sent an upstream request')
    async with httpx.AsyncClient(transport=httpx.MockTransport(fail)) as client:
        for reference in ['', 'test-note']:
            settings = Settings(_env_file=None, usage_policy_reference=reference)
            c = Collector(settings, matcher_factory(), client)
            await c.refresh()
            await c.run()
            assert c.status().state == 'disabled'
            assert not c.status().collection_enabled


async def test_timestamp_age_not_reception_time(single, matcher_factory):
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200, json=single))) as client:
        c = Collector(enabled(), matcher_factory(), client)
        await c.refresh()
        assert c.status(AT + timedelta(hours=1)).freshness == 'stale'


async def test_missing_timestamp_not_live(single, matcher_factory):
    single.pop('timeStamp')
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200, json=single))) as client:
        c = Collector(enabled(), matcher_factory(), client)
        await c.refresh()
        assert c.status().state == 'unverified_time'


async def test_bad_payload_preserves_cache_then_valid_empty_clears(single, matcher_factory):
    responses = [single, {'wrong': 'shape'}, {'type': 'FeatureCollection', 'features': [], 'timeStamp': single['timeStamp']}]
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200, json=responses.pop(0)))) as client:
        c = Collector(enabled(), matcher_factory(), client)
        await c.refresh()
        await c.refresh()
        assert len(c.trains) == 1 and c.error_code == 'invalid_response'
        await c.refresh()
        assert not c.trains and c.failures == 0


async def test_concurrent_refresh_shared_request(single, matcher_factory):
    calls = 0
    async def handler(request):
        nonlocal calls
        calls += 1
        await asyncio.sleep(.01)
        return httpx.Response(200, json=single)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        c = Collector(enabled(), matcher_factory(), client)
        await asyncio.gather(*(c.refresh() for _ in range(20)))
        assert calls == 1
