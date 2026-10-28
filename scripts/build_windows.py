"""Build a self-contained Windows folder, ZIP, checksum, and third-party notices."""
import hashlib
from importlib import metadata
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tomllib
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def collect_notices(destination: Path):
    destination.mkdir(parents=True, exist_ok=True)
    inventory = []
    for distribution in sorted(metadata.distributions(), key=lambda d: d.metadata['Name'].lower()):
        name = distribution.metadata['Name']
        files = []
        for entry in distribution.files or []:
            if not any(word in entry.name.lower() for word in ('license', 'licence', 'copying', 'notice', 'copyright')):
                continue
            source = Path(distribution.locate_file(entry))
            if source.is_file():
                relative = Path('python-packages') / name / str(entry).replace('..', '_')
                target = destination / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
                files.append(relative.as_posix())
        inventory.append({'name': name, 'version': distribution.version,
            'license': distribution.metadata.get('License-Expression') or distribution.metadata.get('License'),
            'files': files})
    python_root = Path(sys.base_prefix)
    for source in [python_root / 'LICENSE.txt', *list((python_root / 'tcl').rglob('license.terms'))]:
        if source.is_file():
            target = destination / 'python-runtime' / source.relative_to(python_root)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
    for package in ('react', 'react-dom', 'scheduler', 'lucide-react', '@fontsource/noto-sans-kr'):
        package_root = ROOT / 'frontend' / 'node_modules' / package
        for source in package_root.iterdir():
            if source.is_file() and any(word in source.name.lower() for word in ('license', 'licence', 'ofl')):
                target = destination / 'javascript' / package / source.name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
    shutil.copy2(ROOT / 'frontend/public/audio/LICENSE.txt', destination / 'Vestaboard-recording-MIT.txt')
    shutil.copy2(ROOT / 'frontend/public/licenses/Noto-Sans-KR-OFL.txt', destination / 'Noto-Sans-KR-OFL.txt')
    (destination / 'python-packages.json').write_text(json.dumps(inventory, ensure_ascii=False, indent=2), encoding='utf-8')


def main():
    if sys.platform != 'win32' or sys.maxsize <= 2**32 or sys.version_info[:2] != (3, 12):
        raise SystemExit('Build with Windows x64 and Python 3.12.')
    project = tomllib.loads((ROOT / 'pyproject.toml').read_text(encoding='utf-8'))['project']
    version = project['version']
    if not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise SystemExit('A three-part release version is required.')
    if os.environ.get('GITHUB_REF_TYPE') == 'tag' and os.environ.get('GITHUB_REF_NAME') != f'v{version}':
        raise SystemExit('The release tag must match the version in pyproject.toml.')
    if not (ROOT / 'frontend/dist/index.html').is_file():
        raise SystemExit('Build the frontend before packaging.')
    build = ROOT / 'build'
    build.mkdir(exist_ok=True)
    numbers = tuple(map(int, version.split('.'))) + (0,)
    (build / 'windows-version.txt').write_text(f'''VSVersionInfo(
  ffi=FixedFileInfo(filevers={numbers!r}, prodvers={numbers!r}, mask=0x3f,
                   flags=0x0, OS=0x40004, fileType=0x1, subtype=0x0, date=(0, 0)),
  kids=[StringFileInfo([StringTable('040904B0', [
    StringStruct('ProductName', 'FlipBoard'),
    StringStruct('FileDescription', 'FlipBoard Windows launcher'),
    StringStruct('FileVersion', '{version}'), StringStruct('ProductVersion', '{version}'),
    StringStruct('OriginalFilename', 'FlipBoard.exe')])]),
    VarFileInfo([VarStruct('Translation', [1033, 1200])])])
''', encoding='utf-8')
    subprocess.run([sys.executable, '-m', 'PyInstaller', '--clean', '--noconfirm',
        '--distpath', str(build / 'windows-bundle'), '--workpath', str(build / 'pyinstaller'),
        str(ROOT / 'packaging/windows/FlipBoard.spec')], cwd=ROOT, check=True)
    bundle = build / 'windows-bundle/FlipBoard'
    shutil.copy2(ROOT / 'docs/WINDOWS-QUICKSTART.txt', bundle / '사용법.txt')
    collect_notices(bundle / 'licenses')
    (bundle / 'build-info.json').write_text(json.dumps({
        'version': version, 'commit': os.environ.get('GITHUB_SHA'),
        'python': platform.python_version(), 'architecture': platform.machine(),
        'platform': 'Windows x64'}, indent=2), encoding='utf-8')
    output = ROOT / 'dist'
    output.mkdir(exist_ok=True)
    archive = output / f'FlipBoard-{version}-windows-x64.zip'
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as compressed:
        for path in sorted(bundle.rglob('*')):
            if path.is_file():
                compressed.write(path, Path('FlipBoard') / path.relative_to(bundle))
    with archive.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    archive.with_suffix('.zip.sha256').write_text(f'{digest}  {archive.name}\n', encoding='ascii')
    print(f'Built {archive.name} ({archive.stat().st_size:,} bytes), SHA-256 {digest}')


if __name__ == '__main__':
    main()
