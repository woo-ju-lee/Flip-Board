import json
import os
from pathlib import Path
import socket
import threading
import time

import httpx
import pytest

from backend.app.config import DATA_DIR, Settings
from backend.desktop.instance import SingleInstance
from backend.desktop.server import BoardServer, existing_url, healthy, reserve_socket, valid_local_url
from backend.desktop.settings import (clear_instance, initialize_settings, read_settings,
                                      save_collection, write_instance)


def wait_until(predicate, timeout=10):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if predicate():
            return
        time.sleep(0.03)
    pytest.fail('Desktop operation timed out')


@pytest.fixture
def frontend_bundle(tmp_path):
    # Lifecycle unit tests do not require Node; Windows EXE smoke tests use the real build.
    dist = tmp_path / 'test frontend'
    (dist / 'audio').mkdir(parents=True)
    (dist / 'index.html').write_text('<!doctype html><title>Test-only frontend asset</title>', encoding='utf-8')
    recording = Path(__file__).resolve().parents[2] / 'frontend/public/audio/vestaboard-flip.mp3'
    (dist / 'audio/vestaboard-flip.mp3').write_bytes(recording.read_bytes())
    return dist


def test_first_run_and_new_archive_preserve_saved_settings(tmp_path, monkeypatch):
    application = tmp_path / '압축 폴더' / 'FlipBoard'
    application.mkdir(parents=True)
    user = tmp_path / '사용자 설정'
    path = initialize_settings(user, application)
    assert read_settings(path).live_enabled
    assert Settings(_env_file=None).live_enabled is False
    path.write_text('# 사용자 설정\nKORAIL_LIVE_ENABLED=false\nKORAIL_POLL_SECONDS=120\n', encoding='utf-8')
    replacement = tmp_path / '새 버전'
    replacement.mkdir()
    (replacement / '.env').write_text('KORAIL_LIVE_ENABLED=true\n', encoding='utf-8')
    monkeypatch.setenv('KORAIL_LIVE_ENABLED', 'true')
    assert initialize_settings(user, replacement) == path
    assert read_settings(path).live_enabled is False
    assert read_settings(path).poll_seconds == 120
    assert '# 사용자 설정' in path.read_text(encoding='utf-8')


def test_legacy_settings_import_once_and_rebase_relative_geometry(tmp_path):
    application = tmp_path / 'old app'
    application.mkdir()
    legacy = '# 설정\nKORAIL_LIVE_ENABLED=false\nKORAIL_DATA_DIR=선로 자료\nKORAIL_POLL_SECONDS=90\n'
    (application / '.env').write_text(legacy, encoding='utf-8-sig')
    path = initialize_settings(tmp_path / 'profile', application)
    settings = read_settings(path)
    assert settings.data_dir == application / '선로 자료'
    assert settings.poll_seconds == 90
    assert not settings.live_enabled
    assert (application / '.env').read_text(encoding='utf-8-sig') == legacy
    updated = save_collection(path, True)
    assert updated.live_enabled and read_settings(path).live_enabled
    assert updated.data_dir == settings.data_dir
    assert read_settings(path).poll_seconds == 90
    assert '# 설정' in path.read_text(encoding='utf-8')


def test_invalid_configuration_is_reported_without_overwriting_it(tmp_path):
    path = tmp_path / '.env'
    original = 'KORAIL_LIVE_ENABLED=true\nKORAIL_POLL_SECONDS=2\n'
    path.write_text(original, encoding='utf-8')
    with pytest.raises(ValueError):
        save_collection(path, False)
    assert path.read_text(encoding='utf-8') == original


def test_busy_port_does_not_stop_or_share_another_service():
    with reserve_socket(0) as busy:
        with reserve_socket(busy.getsockname()[1]) as chosen:
            assert chosen.getsockname()[0] == '127.0.0.1'
            assert chosen.getsockname()[1] != busy.getsockname()[1]
            assert busy.fileno() != -1


@pytest.mark.parametrize('url', ['https://example.org', 'http://localhost:8000',
    'http://127.0.0.1:8000/other', 'http://127.0.0.1:8000?next=bad',
    'http://user@127.0.0.1:8000', 'http://127.0.0.1:99999', None])
def test_instance_discovery_only_accepts_loopback_application_urls(url):
    assert not valid_local_url(url)


def test_instance_file_cleanup_does_not_delete_another_owner(tmp_path):
    write_instance(tmp_path, 'http://127.0.0.1:8000', 'owner')
    clear_instance(tmp_path, 'other')
    assert (tmp_path / 'instance.json').is_file()
    clear_instance(tmp_path, 'owner')
    assert not (tmp_path / 'instance.json').exists()


def test_real_server_keeps_url_on_restart_and_releases_listener(tmp_path, frontend_bundle):
    server = BoardServer(preferred_port=0, frontend_dir=frontend_bundle)
    try:
        settings = Settings(_env_file=None, live_enabled=False)
        server.start(settings)
        wait_until(lambda: healthy(server.url, server.instance))
        assert not healthy(server.url, 'wrong-instance')
        write_instance(tmp_path, server.url, server.instance)
        assert existing_url(tmp_path, timeout=1) == server.url
        with httpx.Client(base_url=server.url, trust_env=False) as client:
            assert client.get('/').status_code == 200
            assert client.get('/api/trains?source=archive').json()['count'] == 148
            assert client.get('/audio/vestaboard-flip.mp3').status_code == 200
        with pytest.raises(RuntimeError):
            server.start(settings)
        first_thread, url = server.thread, server.url
        assert server.stop()
        server.start(settings)
        wait_until(lambda: healthy(server.url, server.instance))
        assert server.url == url and server.thread is not first_thread
    finally:
        assert server.close()
    with socket.socket() as probe:
        assert probe.connect_ex(('127.0.0.1', int(server.url.rsplit(':', 1)[1]))) != 0


def test_offline_collection_does_not_prevent_board_readiness(frontend_bundle):
    requests = []
    def offline(request):
        requests.append(request)
        raise httpx.ConnectError('test-only offline')
    server = BoardServer(preferred_port=0, frontend_dir=frontend_bundle)
    try:
        server.start(Settings(_env_file=None, live_enabled=True), transport=httpx.MockTransport(offline))
        wait_until(lambda: healthy(server.url, server.instance))
        with httpx.Client(base_url=server.url, trust_env=False) as client:
            wait_until(lambda: client.get('/api/status').json()['state'] == 'error')
            assert client.get('/').status_code == 200
        assert len(requests) == 1
    finally:
        assert server.close()


def test_failed_server_stops_and_can_be_started_again(tmp_path, frontend_bundle):
    server = BoardServer(preferred_port=0, frontend_dir=frontend_bundle)
    try:
        server.start(Settings(_env_file=None, data_dir=tmp_path))
        wait_until(lambda: not server.alive)
        assert server.error
        server.start(Settings(_env_file=None, data_dir=DATA_DIR))
        wait_until(lambda: healthy(server.url, server.instance))
    finally:
        assert server.close()


def test_closing_during_initialization_cannot_start_a_late_collector(monkeypatch, frontend_bundle):
    from backend.app import factory
    original = factory.create_app
    entered, resume = threading.Event(), threading.Event()
    def slow_factory(*args, **kwargs):
        entered.set()
        assert resume.wait(3)
        return original(*args, **kwargs)
    monkeypatch.setattr(factory, 'create_app', slow_factory)
    server = BoardServer(preferred_port=0, frontend_dir=frontend_bundle)
    try:
        server.start(Settings(_env_file=None, live_enabled=False))
        assert entered.wait(3)
        server.request_stop()
        resume.set()
        assert server.stop()
        assert not server.server.started
        assert not healthy(server.url, server.instance, timeout=0.1)
    finally:
        resume.set()
        assert server.close()


@pytest.mark.skipif(os.name != 'nt', reason='Windows kernel mutex')
def test_windows_mutex_has_single_owner_and_no_stale_lock(tmp_path):
    with SingleInstance(tmp_path) as first:
        assert first.acquired
        with SingleInstance(tmp_path) as second:
            assert not second.acquired
    with SingleInstance(tmp_path) as after_exit:
        assert after_exit.acquired
