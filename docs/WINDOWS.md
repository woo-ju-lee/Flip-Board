# Windows 실행본 개발과 검증

Windows 10/11 x64용 **폴더형 PyInstaller 배포**입니다. 사용자는 ZIP 전체를 풀고 `FlipBoard.exe`를 실행합니다. Tcl/Tk 실행 창, Python 3.12, 빌드한 프런트엔드, 음원·폰트, 원본 기록, GEOS/PROJ 및 인증서를 포함합니다. 설치 프로그램·트레이·자동 업데이트는 포함하지 않습니다.

## Windows에서 빌드

빌드 환경에만 Python 3.12 x64와 Node.js 22가 필요합니다. PowerShell에서 프로젝트 루트를 기준으로 실행합니다.

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --only-binary=:all: -r requirements-windows-lock.txt
.\.venv\Scripts\python.exe -m pip install --no-deps --no-build-isolation -e .
cd frontend
npm ci
npm test
npm run build
cd ..
.\.venv\Scripts\python.exe -m pytest -q
.\.venv\Scripts\python.exe scripts/build_windows.py
```

결과는 `dist/FlipBoard-0.2.0-windows-x64.zip`과 `.zip.sha256`입니다. 릴리스 버전은 `pyproject.toml`에서 읽습니다. 소스나 Linux 가상환경을 압축해서 대신 배포하지 않습니다. 빌드는 Windows에서 수행해야 합니다.

기존 `requirements-lock.txt`는 Linux 검증용이며 `uvloop`를 포함합니다. Windows용 파일은 CPython 3.12/win_amd64 휠로 해석한 별도 고정 버전 목록이고 런타임·테스트·패키징 도구를 포함합니다. 변경 시 Windows에서 `pip check`, 기존 테스트와 EXE 검사를 다시 수행해야 합니다.

## 실행 구조

- `backend.desktop`가 실행 창·사용자 설정·단일 인스턴스를 관리합니다. 사용자 설정 경로를 바탕으로 Windows 세션 내 사용자별 뮤텍스를 생성합니다. `instance.json`은 발견용 주소이며 잠금을 대신하지 않습니다.
- 첫 실행의 EXE 옆 `.env`를 UTF-8(BOM 허용)로 가져옵니다. 상대 `KORAIL_DATA_DIR`는 원래 실행 폴더에 대한 절대 경로로 바꿉니다. 이후 설정은 사용자 폴더만 사용하고, 데스크톱 설정은 상속된 터미널 환경 변수보다 우선합니다. 일반 ASGI 설정 우선순위는 유지합니다.
- 서버는 동일 프로세스의 스레드 하나와 수집기 하나를 사용합니다. `asyncio`·`h11`, localhost IPv4, 단일 워커로 동작합니다. 재시작 동안 원래 소켓을 보유해 URL을 유지하고, 종료 시에는 소켓과 수집 작업을 정리합니다.
- `/api/health` 응답 본문은 유지하며 데스크톱 실행에서만 인스턴스 식별 헤더를 추가합니다. 준비 확인은 프록시·리디렉션을 사용하지 않는 localhost 요청이며, 30초 이후에는 실패를 안내합니다.
- 실행 창은 서버 종료를 최대 6초 기다립니다. 종료가 지연되면 자신의 프로세스를 종료하므로 별도의 서버 프로세스를 남기지 않습니다. 다른 프로그램이나 포트를 강제로 종료하지 않습니다.
- 화면 자원과 철도 데이터는 번들 경로를 기준으로 읽습니다. 로그는 UTF-8, 파일당 최대 5 MB, 이전 파일 3개까지 보관합니다. UI 예외와 시작 실패도 로그에 남깁니다.

## 배포본 검증

```powershell
cd frontend
npm install --no-save --package-lock=false playwright@1.57.0
npx playwright install chromium
cd ..
.\.venv\Scripts\python.exe scripts/test_windows_bundle.py
```

검사는 ZIP을 한글·공백·중첩 경로에 실제로 풉니다. EXE의 PATH에는 Windows 시스템 폴더만 남기고, 다른 작업 폴더에서 실행합니다. 사용자 설정도 테스트용 임시 폴더로 분리합니다. 첫 실행·설정 가져오기·이사한 새 버전의 설정 보존·중복 실행·8000번 충돌·실제 Tk 키보드 조작(F6/F5)·재시작 주소 유지·창 닫기·불완전한 압축 해제를 검사합니다.

Windows 검사에서 외부 코레일 요청은 닫힌 localhost 프록시로 차단합니다. 연결 실패 상태에서도 전광판을 사용할 수 있어야 합니다. 실제 수집 성공은 검증 결과에 포함하지 않습니다. 기존 Chromium 화면·오디오 검사도 패키지 서버를 대상으로 실행합니다.

`--diagnostics <JSON>`은 번들 자원을 오프라인에서 확인하고 종료합니다. `--no-browser`는 브라우저 자동 열기를 생략하는 검증용 옵션이며 일반 더블클릭에는 필요하지 않습니다. 결과는 `artifacts/windows/validation.json`, 자원 진단 JSON과 케이스별 로그에 저장합니다.

GitHub Actions의 **Windows portable build**는 main 변경, PR, 수동 실행, `v*` 태그에서 빌드합니다. 검사 통과 후에만 ZIP과 SHA-256을 Artifacts에 올립니다. 버전 태그는 `pyproject.toml`과 일치해야 하며, 검증된 동일 ZIP을 GitHub Release에 첨부합니다. 태그 Release의 자동 게시 외에는 수동 빌드가 Release를 만들지 않습니다.

이 문서의 절차 자체는 Windows 검증 성공을 의미하지 않습니다. 실제 실행 결과는 해당 커밋의 Actions 실행과 업로드된 검증 기록을 확인하세요.
