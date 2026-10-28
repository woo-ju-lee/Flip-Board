"""Exercise the real extracted EXE, Tk controls, single-instance guard and browser.

No KORAIL request leaves the runner: the packaged collector uses a closed local proxy.
Only processes and temporary files created by this test are terminated or removed.
"""
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from urllib.request import build_opener, ProxyHandler
import zipfile

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'artifacts/windows'
HTTP = build_opener(ProxyHandler({}))


def wait_for(check, timeout=30):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        result = check()
        if result:
            return result
        time.sleep(0.1)
    raise AssertionError(f'Timed out: {check}')


def fetch(url, json_response=True):
    try:
        with HTTP.open(url, timeout=0.5) as response:
            content = response.read()
            return json.loads(content) if json_response else content
    except (OSError, ValueError):
        return None


def instance_at(profile):
    try:
        data = json.loads((profile / 'FlipBoard/instance.json').read_text(encoding='utf-8'))
        with HTTP.open(data['url'] + '/api/health', timeout=0.5) as response:
            if response.headers.get('X-FlipBoard-Instance') == data['instance']:
                return data
    except (OSError, ValueError, KeyError):
        pass
    return None


def main():
    if os.name != 'nt':
        raise SystemExit('This checks an actual Windows build; run on Windows.')
    OUT.mkdir(parents=True, exist_ok=True)
    archives = list((ROOT / 'dist').glob('FlipBoard-*-windows-x64.zip'))
    assert len(archives) == 1, archives
    archive = archives[0]
    with archive.open('rb') as stream:
        actual_hash = hashlib.file_digest(stream, 'sha256').hexdigest()
    assert archive.with_suffix('.zip.sha256').read_text().split()[0] == actual_hash
    work = Path(tempfile.mkdtemp(prefix='FlipBoard 한글 '))
    processes, profiles, checks = [], [], []
    busy = socket.socket()
    report = {}

    user32 = ctypes.WinDLL('user32', use_last_error=True)
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user32.EnumWindows.argtypes = (callback_type, wintypes.LPARAM)
    user32.GetWindowThreadProcessId.argtypes = (wintypes.HWND, ctypes.POINTER(wintypes.DWORD))
    user32.GetWindowTextW.argtypes = (wintypes.HWND, wintypes.LPWSTR, ctypes.c_int)
    user32.PostMessageW.argtypes = (wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)
    user32.GetWindow.argtypes = (wintypes.HWND, wintypes.UINT)
    user32.GetWindow.restype = wintypes.HWND
    user32.MapVirtualKeyW.argtypes = (wintypes.UINT, wintypes.UINT)
    user32.MapVirtualKeyW.restype = wintypes.UINT

    def window_for(process):
        handles = []
        @callback_type
        def found(handle, _):
            pid = wintypes.DWORD()
            user32.GetWindowThreadProcessId(handle, ctypes.byref(pid))
            title = ctypes.create_unicode_buffer(256)
            user32.GetWindowTextW(handle, title, len(title))
            if pid.value == process.pid and title.value == 'FlipBoard':
                handles.append(handle)
            return True
        user32.EnumWindows(found, 0)
        return handles[0] if handles else None

    def key(process, virtual_key):
        handle = wait_for(lambda: window_for(process))
        handle = user32.GetWindow(handle, 5) or handle  # Tk client window inside the Win32 wrapper.
        scan = user32.MapVirtualKeyW(virtual_key, 0)
        assert user32.PostMessageW(handle, 0x0100, virtual_key, 1 | (scan << 16))
        assert user32.PostMessageW(handle, 0x0101, virtual_key, 1 | (scan << 16) | (3 << 30))

    def close(process, profile, url=None):
        handle = wait_for(lambda: window_for(process))
        assert user32.PostMessageW(handle, 0x0010, 0, 0)  # WM_CLOSE
        assert process.wait(timeout=12) == 0
        assert not (profile / 'FlipBoard/instance.json').exists()
        if url:
            with socket.socket() as connection:
                connection.settimeout(0.5)
                assert connection.connect_ex(('127.0.0.1', int(url.rsplit(':', 1)[1]))) != 0

    def environment(profile):
        env = dict(os.environ)
        for name in ('PYTHONHOME', 'PYTHONPATH', 'VIRTUAL_ENV', 'PROJ_DATA', 'PROJ_LIB', 'SSL_CERT_FILE', 'SSL_CERT_DIR'):
            env.pop(name, None)
        env['PATH'] = os.environ['SystemRoot'] + ';' + os.path.join(os.environ['SystemRoot'], 'System32')
        env['LOCALAPPDATA'] = str(profile)
        env['HTTP_PROXY'] = env['HTTPS_PROXY'] = 'http://127.0.0.1:1'
        env['NO_PROXY'] = '127.0.0.1,localhost'
        return env

    other_cwd = work / '다른 작업 위치'
    other_cwd.mkdir()

    def launch(executable, profile):
        if profile not in profiles:
            profiles.append(profile)
        process = subprocess.Popen([str(executable), '--no-browser'], cwd=other_cwd,
            env=environment(profile), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        processes.append(process)
        return process

    try:
        folder = work / '중첩 폴더' / '첫 번째 버전'
        with zipfile.ZipFile(archive) as compressed:
            compressed.extractall(folder)
        bundle, exe = folder / 'FlipBoard', folder / 'FlipBoard/FlipBoard.exe'
        profile = work / '한글 사용자' / 'App Data'
        diagnostic = OUT / 'bundle-resources.json'
        process = subprocess.run([str(exe), '--diagnostics', str(diagnostic)], cwd=other_cwd,
            env=environment(profile), timeout=45, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        data = json.loads(diagnostic.read_text(encoding='utf-8'))
        assert process.returncode == 0, data
        assert data['frozen'] and data['frontend'] and data['font_count'] > 0
        assert data['audio_bytes'] == 2608 and data['stations'] > 0 and data['snapshots'] == 2
        assert data['projection'] and data['geos'] and data['ca_count'] > 0 and data['tcl']
        assert Path(data['proj_data']).is_relative_to(bundle)
        assert Path(data['certifi']).is_relative_to(bundle)
        checks.append('ZIP checksum and bundled Python/Tcl, Korean data, fonts, audio, GEOS/PROJ and certificates')

        try:
            busy.bind(('127.0.0.1', 8000))
            busy.listen(1)
        except OSError:
            pass  # A pre-existing listener is also a valid port-conflict case; never kill it.
        process = launch(exe, profile)
        first = wait_for(lambda: instance_at(profile))
        assert first['pid'] == process.pid and not first['url'].endswith(':8000')
        status = wait_for(lambda: fetch(first['url'] + '/api/status'))
        assert status['collection_enabled']
        wait_for(lambda: (fetch(first['url'] + '/api/status') or {}).get('state') == 'error')
        assert fetch(first['url'] + '/', False)
        assert fetch(first['url'] + '/api/trains?source=archive')['count'] == 148
        audio = fetch(first['url'] + '/audio/vestaboard-flip.mp3', False)
        assert hashlib.sha256(audio).hexdigest() == '3f14839d3179ab73d778456c0fa1be5c1d571099313a242a9fd48ec2cf28036f'
        checks.append('First run enables live collection; offline upstream still opens the real board on a free loopback port')

        log = profile / 'FlipBoard/logs/flipboard.log'
        wait_for(lambda: 'Open board requested:' in log.read_text(encoding='utf-8'))
        opened = log.read_text(encoding='utf-8').count('Open board requested:')
        key(process, 0x75)  # F6: toggle the real Tk checkbox
        key(process, 0x74)  # F5: invoke the actual Apply/restart handler
        wait_for(lambda: (fetch(first['url'] + '/api/status') or {}).get('collection_enabled') is False)
        assert instance_at(profile)['pid'] == first['pid']
        assert instance_at(profile)['url'] == first['url']
        assert log.read_text(encoding='utf-8').count('Open board requested:') == opened
        checks.append('Real Tk settings control restarts one server at the same URL without opening another tab')

        duplicate = launch(exe, profile)
        assert duplicate.wait(timeout=35) == 0
        assert instance_at(profile)['pid'] == first['pid']
        checks.append('Repeated EXE launch reuses the running instance')

        browser_env = dict(os.environ, KORAIL_TEST_URL=first['url'])
        for name in ('KORAIL_BROWSER_EXECUTABLE', 'KORAIL_BROWSER_MODULE'):
            browser_env.pop(name, None)
        for script in ('browser_smoke.mjs', 'browser_audio.mjs'):
            subprocess.run([shutil.which('node'), str(ROOT / 'scripts' / script)],
                cwd=ROOT, env=browser_env, timeout=180, check=True)
        checks.append('Existing browser layout and actual decoded audio checks pass against the packaged EXE')
        saved = (profile / 'FlipBoard/.env').read_bytes()
        close(process, profile, first['url'])
        checks.append('Closing the launcher removes instance state and releases the server port')

        replacement = work / '새 버전 폴더' / 'FlipBoard'
        shutil.copytree(bundle, replacement)
        (replacement / '.env').write_text('KORAIL_LIVE_ENABLED=true\nKORAIL_POLL_SECONDS=90\n', encoding='utf-8')
        process = launch(replacement / 'FlipBoard.exe', profile)
        updated = wait_for(lambda: instance_at(profile))
        assert fetch(updated['url'] + '/api/status')['collection_enabled'] is False
        assert (profile / 'FlipBoard/.env').read_bytes() == saved
        close(process, profile, updated['url'])
        checks.append('Moving to a new extracted version preserves saved settings and ignores replacement .env')

        migrated_profile = work / '기존 설정 가져오기'
        process = launch(replacement / 'FlipBoard.exe', migrated_profile)
        migrated = wait_for(lambda: instance_at(migrated_profile))
        status = fetch(migrated['url'] + '/api/status')
        assert status['collection_enabled'] and status['poll_seconds'] == 90
        close(process, migrated_profile, migrated['url'])
        checks.append('First-run .env import preserves collection and custom polling settings')

        (replacement / '_internal/frontend/dist/index.html').unlink()
        broken_profile = work / '불완전한 압축 해제'
        process = launch(replacement / 'FlipBoard.exe', broken_profile)
        broken_log = broken_profile / 'FlipBoard/logs/flipboard.log'
        wait_for(lambda: broken_log.exists() and 'Startup failed:' in broken_log.read_text(encoding='utf-8'))
        assert instance_at(broken_profile) is None
        close(process, broken_profile)
        checks.append('Missing frontend produces a logged startup failure and remains cleanly closable')
        report = {'checks': checks, 'zip': archive.name, 'sha256': actual_hash, 'passed': True}
    finally:
        busy.close()
        for process in processes:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=10)
        for i, profile in enumerate(profiles):
            log_dir = profile / 'FlipBoard/logs'
            if log_dir.exists():
                shutil.copytree(log_dir, OUT / f'case-{i}-logs', dirs_exist_ok=True)
        (OUT / 'validation.json').write_text(json.dumps(report or {'passed': False, 'completed': checks}, ensure_ascii=False, indent=2), encoding='utf-8')
        shutil.rmtree(work, ignore_errors=True)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
