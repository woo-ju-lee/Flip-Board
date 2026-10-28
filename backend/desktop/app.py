"""Small Windows control window; no web UI or collection logic is duplicated here."""
import argparse
import ctypes
from ctypes import wintypes
import json
import logging
import os
from pathlib import Path
import sys
import time
import webbrowser

from .instance import SingleInstance
from .server import BoardServer, existing_url, healthy
from .settings import (application_directory, atomic_text, clear_instance, configure_logging,
                       initialize_settings, read_settings, save_collection, user_directory, write_instance)

LOG = logging.getLogger(__name__)


def open_board(url: str, disabled: bool = False) -> bool:
    LOG.info('Open board requested: %s', url)
    if disabled:
        return True
    try:
        return webbrowser.open(url, new=2)
    except Exception:
        LOG.exception('Could not open default browser')
        return False


class Launcher:
    def __init__(self, root, directory: Path, settings_path: Path, log_path: Path, no_browser=False):
        import tkinter as tk
        from tkinter import ttk

        self.root, self.directory, self.settings_path = root, directory, settings_path
        self.log_path, self.no_browser = log_path, no_browser
        self.settings = read_settings(settings_path)
        self.server = BoardServer()
        self.phase, self.closing, self.pending_restart = 'starting', False, None
        self.opened = False
        root.title('FlipBoard')
        root.geometry('500x300')
        root.minsize(460, 280)
        root.option_add('*Font', ('맑은 고딕', 10))
        root.protocol('WM_DELETE_WINDOW', self.close)
        root.report_callback_exception = self.callback_error
        root.bind('<Escape>', lambda _: self.close())
        root.bind('<F5>', lambda _: self.apply())
        root.bind('<F6>', lambda _: self.enabled.set(not self.enabled.get()) if self.phase in ('running', 'failed') else None)

        frame = ttk.Frame(root, padding=20)
        frame.pack(fill='both', expand=True)
        ttk.Label(frame, text='FlipBoard', font=('맑은 고딕', 18, 'bold')).pack(anchor='w')
        self.status = tk.StringVar(value='전광판을 시작하고 있습니다…')
        ttk.Label(frame, textvariable=self.status, wraplength=445).pack(anchor='w', pady=(10, 6))
        self.address = tk.StringVar(value=self.server.url)
        ttk.Entry(frame, textvariable=self.address, state='readonly').pack(fill='x')
        settings_row = ttk.Frame(frame)
        settings_row.pack(fill='x', pady=14)
        self.enabled = tk.BooleanVar(value=self.settings.live_enabled)
        self.checkbox = ttk.Checkbutton(settings_row, text='실시간 수집 (F6)', variable=self.enabled)
        self.checkbox.pack(side='left')
        self.apply_button = ttk.Button(settings_row, text='적용 후 재시작 (F5)', command=self.apply)
        self.apply_button.pack(side='right')
        buttons = ttk.Frame(frame)
        buttons.pack(fill='x')
        self.open_button = ttk.Button(buttons, text='브라우저 열기', command=self.open)
        self.open_button.pack(side='left')
        ttk.Button(buttons, text='로그 폴더', command=lambda: os.startfile(log_path.parent)).pack(side='left', padx=8)
        ttk.Button(buttons, text='종료', command=self.close).pack(side='right')
        ttk.Label(frame, text='이 창을 닫으면 전광판과 실시간 수집도 종료됩니다.').pack(anchor='w', pady=(14, 0))
        self.start()
        root.after(100, self.tick)

    def controls(self, ready: bool):
        state = 'normal' if ready else 'disabled'
        self.checkbox.configure(state=state)
        self.apply_button.configure(state=state)
        self.open_button.configure(state='normal' if self.phase == 'running' else 'disabled')

    def start(self):
        self.phase, self.deadline = 'starting', time.monotonic() + 30
        self.status.set('전광판을 시작하고 있습니다…')
        self.controls(False)
        self.server.start(self.settings)

    def open(self):
        if self.phase == 'running' and not open_board(self.server.url, self.no_browser):
            self.status.set('브라우저를 열지 못했습니다. 위 주소를 브라우저에 입력하세요.')

    def apply(self):
        from tkinter import messagebox
        if self.phase not in ('running', 'failed') or self.closing:
            return
        try:
            self.pending_restart = save_collection(self.settings_path, self.enabled.get())
        except Exception as error:
            LOG.exception('Settings could not be saved')
            messagebox.showerror('설정 저장 실패', f'{error}\n\n로그: {self.log_path}', parent=self.root)
            return
        self.begin_stop()

    def begin_stop(self):
        self.phase, self.deadline = 'stopping', time.monotonic() + 6
        self.status.set('종료하고 있습니다…' if self.closing else '수집 설정을 적용하고 있습니다…')
        self.controls(False)
        self.server.request_stop()

    def close(self):
        if self.closing:
            return
        self.closing, self.pending_restart = True, None
        self.begin_stop()

    def fail(self, message: str):
        LOG.error('Startup failed: %s', message)
        self.server.request_stop()
        clear_instance(self.directory, self.server.instance)
        self.phase = 'failed'
        self.status.set(f'{message}\n로그: {self.log_path}')
        self.controls(not self.server.alive)

    def finish(self, force=False):
        clear_instance(self.directory, self.server.instance)
        self.server.listener.close()
        self.root.destroy()
        if force:
            LOG.error('Forced process exit after shutdown deadline')
            logging.shutdown()
            os._exit(1)  # No child server can survive this process.

    def tick(self):
        if self.phase == 'starting':
            if self.server.error:
                self.fail(self.server.error)
            elif healthy(self.server.url, self.server.instance, timeout=0.15):
                self.phase = 'running'
                write_instance(self.directory, self.server.url, self.server.instance)
                self.status.set('전광판 실행 중 · 실시간 수집 ' + ('켜짐' if self.settings.live_enabled else '꺼짐'))
                self.controls(True)
                LOG.info('Board ready at %s; collection=%s', self.server.url, self.settings.live_enabled)
                if not self.opened:
                    self.opened = True
                    self.open()
            elif time.monotonic() >= self.deadline:
                self.fail('30초 안에 시작하지 못했습니다. 로그를 확인하고 다시 실행하세요.')
        elif self.phase == 'running' and not self.server.alive:
            self.fail(self.server.error or '서버가 종료되었습니다. 다시 실행하세요.')
        elif self.phase == 'failed':
            self.controls(not self.server.alive)
        elif self.phase == 'stopping':
            if not self.server.alive:
                if self.closing:
                    self.finish()
                    return
                self.settings = self.pending_restart
                self.pending_restart = None
                self.start()
            elif time.monotonic() >= self.deadline:
                if not self.closing:
                    from tkinter import messagebox
                    messagebox.showerror('재시작 실패', '서버 종료가 지연되어 프로그램을 종료합니다. 다시 실행해 주세요.', parent=self.root)
                self.finish(force=True)
                return
        self.root.after(100, self.tick)

    def callback_error(self, kind, value, traceback):
        LOG.error('Window callback failed', exc_info=(kind, value, traceback))
        self.fail('실행 중 오류가 발생했습니다. 로그 폴더를 확인하세요.')


def diagnostics(destination: Path):
    """Offline bundle checks used by Windows CI; no user settings or collection."""
    import math
    import ssl
    import certifi
    import pyproj
    import tkinter
    from zoneinfo import ZoneInfo
    from shapely.geometry import Point
    from backend.app.config import DATA_DIR
    from backend.app.catalog import Catalog
    from backend.app.matcher import PROJECT

    root = Path(__file__).resolve().parents[2]
    dist = root / 'frontend' / 'dist'
    coordinate = PROJECT.transform(127, 37)
    report = {
        'frozen': bool(getattr(sys, 'frozen', False)), 'root': str(root),
        'frontend': (dist / 'index.html').is_file(),
        'font_count': len(list((dist / 'assets').glob('*.woff2'))),
        'audio_bytes': (dist / 'audio' / 'vestaboard-flip.mp3').stat().st_size,
        'stations': len(Catalog(DATA_DIR).stations),
        'snapshots': len(list((DATA_DIR / 'snapshots').glob('*.json'))),
        'projection': all(math.isfinite(v) for v in coordinate),
        'proj_data': pyproj.datadir.get_data_dir(),
        'geos': Point(0, 0).distance(Point(3, 4)) == 5,
        'certifi': certifi.where(),
        'ca_count': len(ssl.create_default_context(cafile=certifi.where()).get_ca_certs()),
        'tcl': tkinter.Tcl().eval('info patchlevel'),
        'timezone': ZoneInfo('Asia/Seoul').key,
    }
    atomic_text(destination, json.dumps(report, ensure_ascii=False, indent=2))


def main() -> int:
    parser = argparse.ArgumentParser(description='FlipBoard Windows launcher')
    parser.add_argument('--no-browser', action='store_true', help='Keep the control window without automatically opening a browser')
    parser.add_argument('--diagnostics', type=Path, metavar='JSON', help='Check bundled resources offline and exit')
    args = parser.parse_args()
    if args.diagnostics:
        try:
            diagnostics(args.diagnostics)
            return 0
        except Exception:
            import traceback
            atomic_text(args.diagnostics, json.dumps({'error': traceback.format_exc()}, ensure_ascii=False))
            return 1
    directory = None
    try:
        directory = user_directory()
        directory.mkdir(parents=True, exist_ok=True)
        with SingleInstance(directory) as instance:
            if not instance.acquired:
                url = existing_url(directory)
                if not url:
                    raise RuntimeError('이미 실행 중인 FlipBoard가 응답하지 않습니다. 실행 창에서 종료한 뒤 다시 실행하세요.')
                open_board(url, args.no_browser)
                return 0
            # Only the owner may rotate logs, migrate settings, or start a collector.
            log_path = configure_logging(directory)
            LOG.info('Launcher starting from %s', application_directory())
            settings_path = initialize_settings(directory, application_directory())
            import tkinter as tk
            ctypes.windll.shcore.SetProcessDpiAwareness(1)
            root = tk.Tk()
            launcher = None
            try:
                launcher = Launcher(root, directory, settings_path, log_path, args.no_browser)
                root.mainloop()
            finally:
                if launcher:
                    if not launcher.server.close():
                        logging.shutdown()
                        os._exit(1)
                    clear_instance(directory, launcher.server.instance)
        return 0
    except Exception as error:
        LOG.exception('Launcher failed')
        message = str(error)
        if directory:
            message += f'\n\n로그: {directory / "logs" / "flipboard.log"}'
        if os.name == 'nt':
            show_error = ctypes.windll.user32.MessageBoxW
            show_error.argtypes = (wintypes.HWND, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.UINT)
            show_error.restype = ctypes.c_int
            show_error(None, message, 'FlipBoard 실행 오류', 0x10)
        elif sys.stderr:
            print(message, file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
