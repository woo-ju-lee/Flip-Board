"""A kernel object, rather than a PID file, owns the single-instance lifetime."""
import ctypes
from ctypes import wintypes
import hashlib
import os
from pathlib import Path


class SingleInstance:
    def __init__(self, directory: Path):
        if os.name != 'nt':
            raise RuntimeError('Windows 실행 파일은 Windows에서 실행하세요.')
        identity = hashlib.sha256(os.path.normcase(str(directory.resolve())).encode('utf-8')).hexdigest()[:24]
        self.api = ctypes.WinDLL('kernel32', use_last_error=True)
        self.api.CreateMutexW.argtypes = (ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR)
        self.api.CreateMutexW.restype = wintypes.HANDLE
        self.api.CloseHandle.argtypes = (wintypes.HANDLE,)
        self.api.CloseHandle.restype = wintypes.BOOL
        ctypes.set_last_error(0)
        self.handle = self.api.CreateMutexW(None, False, f'Local\\FlipBoard-{identity}')
        error = ctypes.get_last_error()
        if not self.handle:
            raise ctypes.WinError(error)
        self.acquired = error != 183  # ERROR_ALREADY_EXISTS

    def close(self):
        if self.handle:
            self.api.CloseHandle(self.handle)
            self.handle = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()
