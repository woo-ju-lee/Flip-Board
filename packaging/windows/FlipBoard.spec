# Build on Windows with Python 3.12 x64; no cross-compilation or one-file extraction.
from pathlib import Path
from PyInstaller.utils.hooks import (collect_data_files, collect_dynamic_libs,
    collect_submodules, collect_delvewheel_libs_directory, copy_metadata)

root = Path(SPECPATH).parents[1]
datas = [(str(root / 'backend' / 'data'), 'backend/data'),
         (str(root / 'frontend' / 'dist'), 'frontend/dist')]
binaries = []
hiddenimports = ['uvicorn.logging', 'uvicorn.loops.asyncio',
    'uvicorn.protocols.http.h11_impl', 'uvicorn.lifespan.on', 'anyio._backends._asyncio']
for package in ('pyproj', 'shapely', 'certifi', 'tzdata'):
    datas += collect_data_files(package)
    datas += copy_metadata(package)
    binaries += collect_dynamic_libs(package)
    hiddenimports += collect_submodules(package, filter=lambda name: '.tests' not in name)
    datas, binaries = collect_delvewheel_libs_directory(package, datas=datas, binaries=binaries)
datas += copy_metadata('korail-live-board')

a = Analysis([str(root / 'backend' / 'desktop' / '__main__.py')],
    pathex=[str(root)], binaries=binaries, datas=datas, hiddenimports=hiddenimports,
    excludes=['uvloop', 'pytest', 'IPython', 'matplotlib'], noarchive=False)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name='FlipBoard',
    debug=False, strip=False, upx=False, console=False,
    version=str(root / 'build' / 'windows-version.txt'), contents_directory='_internal')
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name='FlipBoard')
