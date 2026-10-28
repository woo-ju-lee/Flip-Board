"""Persistent per-user settings, independent of the extracted application folder."""
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import sys
import tempfile

from dotenv import dotenv_values, set_key

from backend.app.config import Settings


class DesktopSettings(Settings):
    @classmethod
    def settings_customise_sources(cls, settings_cls, init_settings, env_settings,
                                  dotenv_settings, file_secret_settings):
        # A saved checkbox must not be silently overridden by an inherited shell variable.
        # Source/ASGI execution continues to use the regular Settings precedence.
        return init_settings, dotenv_settings


def application_directory() -> Path:
    if getattr(sys, 'frozen', False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parents[2]


def user_directory() -> Path:
    local = os.environ.get('LOCALAPPDATA')
    if not local:
        raise RuntimeError('Windows 사용자 설정 폴더(LOCALAPPDATA)를 찾지 못했습니다.')
    return Path(local).resolve() / 'FlipBoard'


def atomic_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix=f'.{path.name}.', dir=path.parent)
    try:
        with os.fdopen(handle, 'w', encoding='utf-8', newline='\n') as stream:
            stream.write(content)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def initialize_settings(directory: Path, application: Path) -> Path:
    target = directory / '.env'
    if not target.exists():
        legacy = application / '.env'
        if legacy.is_file():
            atomic_text(target, legacy.read_text(encoding='utf-8-sig'))
            # Preserve the meaning of a relative custom data directory after migration.
            data_path = dotenv_values(target, encoding='utf-8-sig').get('KORAIL_DATA_DIR')
            if data_path and not Path(data_path).is_absolute():
                set_key(target, 'KORAIL_DATA_DIR', str((application / data_path).resolve()), encoding='utf-8')
        else:
            atomic_text(target, '# FlipBoard Windows 사용자 설정\nKORAIL_LIVE_ENABLED=true\nKORAIL_POLL_SECONDS=60\n')
    return target


def read_settings(path: Path) -> DesktopSettings:
    settings = DesktopSettings(_env_file=path)
    if not settings.data_dir.is_absolute():
        settings = settings.model_copy(update={'data_dir': (path.parent / settings.data_dir).resolve()})
    return settings


def save_collection(path: Path, enabled: bool) -> DesktopSettings:
    # Validate before touching the user's file; python-dotenv rewrites atomically.
    current = read_settings(path)
    set_key(path, 'KORAIL_LIVE_ENABLED', 'true' if enabled else 'false',
            quote_mode='never', encoding='utf-8')
    return current.model_copy(update={'live_enabled': enabled})


def configure_logging(directory: Path) -> Path:
    path = directory / 'logs' / 'flipboard.log'
    path.parent.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(path, maxBytes=5 * 1024 * 1024, backupCount=3, encoding='utf-8')
    handler.setFormatter(logging.Formatter('%(asctime)s %(levelname)s %(name)s: %(message)s'))
    logging.basicConfig(level=logging.INFO, handlers=[handler], force=True)
    for name in ('uvicorn', 'uvicorn.error', 'uvicorn.access'):
        logger = logging.getLogger(name)
        logger.handlers.clear()
        logger.propagate = True
    return path


def write_instance(directory: Path, url: str, instance: str) -> None:
    atomic_text(directory / 'instance.json', json.dumps(
        {'pid': os.getpid(), 'url': url, 'instance': instance}, ensure_ascii=False))


def clear_instance(directory: Path, instance: str) -> None:
    path = directory / 'instance.json'
    try:
        if json.loads(path.read_text(encoding='utf-8')).get('instance') == instance:
            path.unlink(missing_ok=True)
    except (OSError, ValueError, AttributeError):
        pass
