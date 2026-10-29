# 10행 흑백 전광판 레이아웃

기본 앱 `/`와 기록 데모 `?demo=rotors`가 같은 10행 레이아웃을 사용합니다. 기존 서버와 Windows 런처를 유지하면서 데모에서 확정한 외형을 적용했습니다.

## 구성

- 번호 앞에 흰색 종별 로고 플랩. KTX-청룡 포함, 전용 로고가 없으면 계열 로고 또는 차종명 표시.
- 기존 5개 정보 열과 상단 필터, 한 페이지 10행, 마지막 페이지 빈 칸 채움.
- 바탕 `#000000`, 플랩의 위·아래 면 `#212121`, IBM Plex Sans KR Regular(400), 검정 중앙 분할선. 흰 가로 구분선 없음.
- 전체 화면에서는 전광판만 표시하며 ‘전체 열차’ 제목·건수·수신 시각을 숨김. 화면 너비와 높이에 맞춰 10행을 배치.
- 모바일 기본 화면은 로고를 열차번호 위에 배치. 세로 전체 화면도 10행에 맞춤.
- 문자·로고 회전, 효과음, 음소거, 동작 줄이기, 페이지 이동, 정렬, 필터, 상세 보기.

## 실행과 적용

Windows 실행본은 [README의 실행 방법](../README.md#실행-방법)을 따릅니다. 소스 개발 환경은 Python 3.12, Node.js 22 이상을 권장합니다. Linux/macOS에서 프로젝트 루트를 기준으로 실행하려면:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -e '.[test]'
cp .env.example .env
cd frontend
npm ci
npm run build
cd ..
.venv/bin/uvicorn backend.app.main:app --host 127.0.0.1 --port 8000 --workers 1
```

브라우저에서 `http://localhost:8000`을 엽니다. 소스를 갱신한 경우 프런트엔드를 다시 빌드하고 서버를 재시작합니다. 기존 `.env` 설정은 유지됩니다. Windows 소스 실행에서는 가상환경의 실행 파일 경로가 `.venv/Scripts/`입니다.

글자 플랩은 로컬 WOFF2를 사용하며 필터·버튼과 로고의 표시 방식은 유지합니다. IBM Plex와 Noto의 OFL은 `frontend/public/licenses`에 있고 Windows ZIP과 단일 HTML에도 포함됩니다. 프런트엔드 빌드 후 `node scripts/package_rotor_demo.mjs`로 폰트·로고·음원·기록 표본을 내장한 `artifacts/rotor-demo-character-layout.html`을 만듭니다.

백엔드·공개 API·데이터 형식·수집 설정·기존 Windows 런처를 유지합니다. `/`는 실제 서버 API를 조회하며, `?source=archive`는 서버의 저장 표본, `?demo=rotors`는 외부 수집 없는 기록 데모입니다. API가 실패해도 저장 표본을 실시간으로 표시하지 않습니다.

실시간 수집은 기존 설정에 따라 동작합니다. 소스 실행에서 켜려면 `.env`의 `KORAIL_LIVE_ENABLED=true`를 설정한 뒤 서버를 다시 시작하세요. 역·노선 필터의 도형 준비 상태 등 기존 데이터 범위도 유지됩니다.

## 검증

```bash
make test
make build
make validate
# 별도 터미널에서 수집을 끈 로컬 서버 실행 후
node scripts/browser_smoke.mjs
node scripts/browser_layout.mjs
node scripts/browser_audio.mjs
```

브라우저 스크립트에는 Playwright/Chromium이 필요합니다. `KORAIL_BROWSER_MODULE`, `KORAIL_BROWSER_EXECUTABLE`, `KORAIL_TEST_URL`로 설치 위치와 로컬 서버 주소를 지정할 수 있습니다. 변경된 디자인에 원래 7행 화면의 픽셀 좌표 일치 검사를 적용하지 않습니다.

Windows 빌드 검사는 압축 해제한 EXE를 실행해 런처의 재시작·종료, 글꼴·라이선스 포함 여부와 화면·소리를 검사합니다. 로컬 검증 환경의 네트워크 제한으로 코레일 실시간 수신 성공은 확인하지 못했습니다.
