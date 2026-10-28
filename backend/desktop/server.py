"""One loopback listener, reusable across orderly single-worker restarts."""
import json
import logging
from pathlib import Path
import socket
import threading
import time
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, build_opener
import uuid

from backend.app.config import Settings

LOG = logging.getLogger(__name__)
class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


LOCAL_HTTP = build_opener(ProxyHandler({}), NoRedirects())


def valid_local_url(url: str) -> bool:
    try:
        parts = urlsplit(url)
        return (parts.scheme == 'http' and parts.hostname == '127.0.0.1' and
                parts.port is not None and 0 < parts.port < 65536 and
                not parts.username and not parts.password and parts.path in ('', '/') and
                not parts.query and not parts.fragment)
    except (ValueError, TypeError, AttributeError):
        return False


def healthy(url: str, instance: str, timeout: float = 0.4) -> bool:
    if not valid_local_url(url):
        return False
    try:
        with LOCAL_HTTP.open(url.rstrip('/') + '/api/health', timeout=timeout) as response:
            data = json.loads(response.read(8192))
            return (response.status == 200 and isinstance(data, dict) and data.get('status') == 'ok' and
                    data.get('service') == 'korail-live-board' and
                    response.headers.get('X-FlipBoard-Instance') == instance)
    except (OSError, URLError, ValueError):
        return False


def existing_url(directory: Path, timeout: float = 30) -> str | None:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        try:
            data = json.loads((directory / 'instance.json').read_text(encoding='utf-8'))
            if healthy(data['url'], data['instance']):
                return data['url']
        except (OSError, ValueError, KeyError, TypeError):
            pass
        time.sleep(0.2)
    return None


def reserve_socket(preferred_port: int = 8000) -> socket.socket:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        if hasattr(socket, 'SO_EXCLUSIVEADDRUSE'):
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        try:
            listener.bind(('127.0.0.1', preferred_port))
        except OSError:
            if preferred_port == 0:
                raise
            listener.bind(('127.0.0.1', 0))
        listener.listen(128)
        listener.setblocking(False)
        return listener
    except BaseException:
        listener.close()
        raise


class BoardServer:
    def __init__(self, preferred_port: int = 8000, frontend_dir: Path | None = None):
        self.frontend_dir = frontend_dir if frontend_dir is not None else Path(__file__).resolve().parents[2] / 'frontend' / 'dist'
        self.listener = reserve_socket(preferred_port)
        self.url = f'http://127.0.0.1:{self.listener.getsockname()[1]}'
        self.instance = uuid.uuid4().hex
        self.thread = None
        self.server = None
        self.error = None
        self.stop_requested = threading.Event()

    @property
    def alive(self) -> bool:
        return self.thread is not None and self.thread.is_alive()

    def start(self, settings: Settings, transport=None) -> None:
        if self.alive:
            raise RuntimeError('이전 서버가 종료되기 전에 새 서버를 시작할 수 없습니다.')
        self.server = None
        self.error = None
        self.stop_requested.clear()
        self.thread = threading.Thread(target=self._run, args=(settings, transport),
                                       name='flipboard-server', daemon=True)
        self.thread.start()

    def _run(self, settings: Settings, transport) -> None:
        owned_socket = None
        try:
            import uvicorn
            from backend.app.factory import create_app
            if not (self.frontend_dir / 'index.html').is_file():
                raise RuntimeError('화면 파일이 없습니다. ZIP 전체를 다시 압축 해제하세요.')
            app = create_app(settings, transport=transport, frontend_dir=self.frontend_dir)

            @app.middleware('http')
            async def desktop_identity(request, call_next):
                response = await call_next(request)
                if request.url.path == '/api/health':
                    response.headers['X-FlipBoard-Instance'] = self.instance
                return response

            config = uvicorn.Config(app, host='127.0.0.1', port=self.listener.getsockname()[1],
                loop='asyncio', http='h11', ws='none', workers=1, lifespan='on',
                log_config=None, access_log=False, timeout_graceful_shutdown=5)
            self.server = uvicorn.Server(config)
            if self.stop_requested.is_set():
                return
            # Uvicorn owns its duplicate; the master keeps the URL stable during restarts.
            owned_socket = self.listener.dup()
            self.server.run(sockets=[owned_socket])
            if not self.stop_requested.is_set():
                raise RuntimeError('서버가 예기치 않게 종료되었습니다. 로그를 확인하세요.')
        except BaseException as error:
            self.error = str(error) or type(error).__name__
            LOG.exception('Board server failed')
        finally:
            if owned_socket is not None:
                owned_socket.close()

    def request_stop(self) -> None:
        self.stop_requested.set()
        if self.server is not None:
            self.server.should_exit = True

    def stop(self, timeout: float = 6) -> bool:
        self.request_stop()
        if self.thread is not None:
            self.thread.join(timeout)
        return not self.alive

    def close(self) -> bool:
        stopped = self.stop()
        self.listener.close()
        return stopped
