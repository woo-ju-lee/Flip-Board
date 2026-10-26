# KORAIL Live Split-Flap Board

React + TypeScript + Vite / FastAPI 기반의 기계식 열차 전광판입니다. 좌표 수집, 정규화, 공유 캐시, 보수적인 선로 매칭, 역·노선 필터와 공항식 문자별 플랩을 구현했습니다. 실제 Vestaboard 한 칸의 녹음을 앱에 포함하고 각 플랩의 착지에 맞춰 재생합니다.

**현재 배포본의 한계:** 실시간 수집 허용 조건을 확인하지 못했고 개발 환경에서 `gis.korail.com` 서버 통신이 허용되지 않습니다. 실시간 수집은 기본 OFF입니다. 또한 검증된 명명 선로 도형이 없어 경부고속선·호남고속선 필터는 `unavailable`입니다. **현재 실제 경부고속선 열차를 조회하는 최종 운영 목표까지 검증된 상태는 아닙니다.** 첨부된 2026-10-26 표본으로 전체 열차 전광판을 즉시 시연할 수 있습니다. 과거 자료가 자동으로 실시간 데이터로 대체되는 동작은 없습니다.

## 빠른 실행

권장 환경: Python 3.12, Node.js 22 이상, npm. 실제 검증: Linux / Python 3.12.14 / Node.js 24.19.0 / Chromium. 데이터베이스, Docker, 외부 호스팅은 필요하지 않습니다.

```bash
# 프로젝트 루트에서
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-lock.txt
.venv/bin/python -m pip install --no-deps -e .
cp .env.example .env
cd frontend
npm ci
npm run build
cd ..
.venv/bin/uvicorn backend.app.main:app --host 127.0.0.1 --port 8000 --workers 1
```

환경이 Linux와 다르면 플랫폼별 바이너리 의존성을 위해 잠금 파일 대신 `python -m pip install -e '.[test]'`를 사용할 수 있습니다. 이 경우 버전을 다시 검증하세요. Windows에서는 가상환경 실행 파일 경로가 `.venv/Scripts/`입니다.

- 앱: [http://localhost:8000](http://localhost:8000)
- 기록 표본 시연: [http://localhost:8000/?source=archive](http://localhost:8000/?source=archive)
- OpenAPI: [http://localhost:8000/docs](http://localhost:8000/docs)
- 상태: [http://localhost:8000/api/status](http://localhost:8000/api/status)

기본 설정의 첫 화면은 수집 꺼짐 상태입니다. **기록 표본**을 선택하면 148건의 과거 열차를 표시합니다. `수신 기록`을 14:14:45 / 14:15:36으로 바꾸면 두 실제 캡처를 비교할 수 있습니다. 자동 재생이나 가상의 열차 이동은 없습니다. 행을 누르면 전체 위치 문구, 좌표, 원본 기준 시각, 매칭 상태를 확인할 수 있습니다. 소리는 처음에 꺼져 있습니다.

## 공항식 전광판과 소리

외형은 [JFK TWA 호텔의 Solari 보드](https://www.twahotel.com/photos)와 [창이공항 구 터미널 2 전광판](https://www.roots.gov.sg/collection-landing/listing/1485619)을 참고했습니다. 검정 외함, 차콜 판, 따뜻한 흰 글자·노란 열 제목, 중앙 틈과 양쪽 축을 사용합니다. Noto Sans KR 600을 번들에 포함하며 외부 폰트 서버에 요청하지 않습니다. 출발·도착·현재 위치·지연을 포함한 7행과 수동 페이지 이동을 유지합니다.

변경된 문자는 한 장 160 ms로 6–12회 돌아가며 같은 값은 움직이지 않습니다. 칸마다 시작·정지가 다르고 영문·숫자·한글의 중간 문자를 구분합니다. 새 값, 탭 숨김, 동작 줄이기 설정은 기존 회전과 소리를 취소합니다.

음원은 **Robin Yang의 [react-split-flap-display](https://github.com/robonyong/react-split-flap-display#props)**에 포함된 Vestaboard 한 칸의 녹음이며 [MIT 라이선스](frontend/public/audio/LICENSE.txt)를 따릅니다. 원본 MP3를 번들에 포함하므로 별도 음원 다운로드 없이 바로 사용할 수 있습니다. 65 ms 샘플의 타격 지점을 판의 착지에 맞추고, 작은 속도 변화·좌우 패닝·동시 재생 제한으로 여러 칸의 소리를 조절합니다. [음원 문서](docs/AUDIO.md)에 출처·해시·재생 처리와 검증 절차를 기록했습니다.

소리는 기본 꺼짐·초기 음량 30%입니다. 전광판 우측의 사운드 설정에서 음량과 미리듣기를 조절합니다. 음원 누락 시 안내하며 전광판은 계속 동작합니다. 동작 줄이기를 켜면 효과음과 회전을 함께 생략합니다.

개발 중에는 터미널 두 개에서 각각 실행합니다.

```bash
# 터미널 A: 루트
make backend
# 터미널 B: 루트
make frontend
```

프런트엔드 개발 URL은 [http://localhost:5173](http://localhost:5173)입니다. Vite가 `/api`를 FastAPI로 프록시합니다. 운영 빌드는 FastAPI가 `frontend/dist`를 같은 출처에서 제공합니다. 빌드를 먼저 완료한 후 서버를 시작하세요. 외부 배포 시에도 Python ASGI 프로세스를 실행할 수 있는 호스트가 필요합니다.

## 데이터와 동작

```text
KORAIL GeoJSON → 공통 Collector → 검증·정규화 → EPSG:5179 선로 매칭
                                                      ↓
React 문자 플랩 ← 자체 DTO ← 역/노선 필터 ← 마지막 정상 메모리 캐시

별도 기록 표본 → 동일 정규화·매칭 경로 → source=archive 응답 (항상 historical)
```

- **Station**: ID, 명칭, 별칭, 좌표, 출처. 초기 역 목록은 근거가 있는 울산(통도사) 1개입니다.
- **RailLine**: 물리적 노선과 지원 범위. 운행 계통·열차 등급과 분리합니다.
- **RailSegment**: 원본 선로 geometry, 노선 ID, 검토자, 출처, 라이선스, 인접 선로 검토 상태.
- **StationLineMapping**: 울산(통도사) → 경부고속선 연결. 역 정차 여부 또는 역과의 거리로 열차를 필터링하지 않습니다.
- **TrainPosition**: 수신 좌표와 원본 응답 시각을 보존합니다. 시간표 보간이나 임의 위치 생성이 없습니다.
- **TrainLineMatch**: `matched / unknown / ambiguous`, 거리, 휴리스틱 점수, 사유, 후보 구간을 반환합니다.

좌표는 `[경도, 위도]`, EPSG:4326으로 받고 EPSG:5179 미터 좌표로 변환합니다. STRtree 공간 인덱스에서 후보를 찾고, 검증된 구간의 거리·경쟁 노선·이전 위치를 평가합니다. 인접 노선 후보가 비슷하면 `ambiguous`, 도형·근거가 부족하면 `unknown`입니다. 노선을 이탈하면 즉시 매칭을 해제합니다. 서로 다른 노선으로 바로 이동하는 관측은 기본 2회 연속 확인 후 반영합니다. 동일 원본 시각의 반복 응답은 확인 횟수를 늘리지 않습니다.

점수는 측정 정확도나 확률이 아닙니다. 현재 알고리즘은 방향 기반 선로망 경로 탐색/HMM이 아닙니다. 선로별 실제 현장 정확도는 측정하지 못했습니다. 자세한 데이터 등록 및 한계는 [GEOMETRY.md](docs/GEOMETRY.md)를 참고하세요.

## 실시간 수집 설정

1. 해당 GIS API의 자동 수집·재사용·호출 주기에 관한 허용 조건을 확인합니다. 일반 홈페이지 저작권 정책이나 다른 공개 API의 라이선스를 이 내부 GIS API의 허가로 간주하지 않습니다.
2. 실행 호스트에서 `gis.korail.com:443` HTTPS 접근이 허용되어야 합니다. 이 개발 환경의 도메인 허용 목록에는 해당 도메인이 없습니다. 프록시 우회는 구현하지 않았습니다.
3. `.env`에서 `KORAIL_LIVE_ENABLED=true`를 설정한 뒤 서버를 재시작합니다. `KORAIL_USAGE_POLICY_REFERENCE`는 선택 사항인 기록용 메모이며, 수집 활성화나 API 인증에 사용하지 않습니다. 비워 두어도 됩니다.
4. `/api/status`에서 원본·서버 시각과 상태를 확인합니다. 전체 열차 모드가 정상이어도 노선 도형이 없으면 노선 필터는 준비 상태입니다.

| 변수 | 기본값 | 역할 |
|---|---:|---|
| `KORAIL_LIVE_ENABLED` | `false` | 실시간 수집 활성화 |
| `KORAIL_USAGE_POLICY_REFERENCE` | 빈 문자열 | 이용 조건에 관한 선택 메모. 비워 두어도 수집 가능하며 API 인증에는 사용하지 않음 |
| `KORAIL_POLL_SECONDS` | `60` | 공통 수집 주기. 최소 60초 |
| `KORAIL_TIMEOUT_SECONDS` | `15` | 요청 타임아웃 |
| `KORAIL_STALE_SECONDS` | `150` | 원본 또는 수신 시각의 지연 판단 |
| `KORAIL_MAX_BACKOFF_SECONDS` | `900` | 지수 백오프 상한 |
| `KORAIL_MATCH_DISTANCE_METERS` | `70` | 후보 선로 검색 범위 |
| `KORAIL_AMBIGUITY_METERS` | `35` | 두 노선의 거리 차이가 이 값 이하면 모호 |
| `KORAIL_MIN_CONFIDENCE` | `0.65` | 거리 기반 점수 최소값 |
| `KORAIL_SWITCH_CONFIRMATIONS` | `2` | 직접 노선 변경의 연속 관측 횟수 |
| `KORAIL_MAX_SPEED_METERS_PER_SECOND` | `120` | 불가능한 위치 도약을 제외하는 설정 |
| `KORAIL_DATA_DIR` | `backend/data` | 카탈로그·선로 매핑 폴더 |

서버 프로세스 하나에서 수집 작업 하나만 실행합니다. **`--workers 1`, 서버 인스턴스 1개**가 초기 버전의 운영 조건입니다. 여러 워커·복제본은 각자 외부 요청을 보내므로 사용하지 않습니다. 프런트엔드의 15초 조회와 수동 새로고침은 메모리 캐시만 읽으며 코레일 요청을 유발하지 않습니다. 브라우저가 숨겨지면 조회를 멈춥니다.

401/403/429 또는 리디렉션은 접근 제한으로 취급하고 해당 프로세스의 자동 수집을 중단합니다. 인증 변경·헤더 회전·리디렉션 추적을 하지 않습니다. 일시적 연결·서버 오류는 120 → 240 → 480 → 900초로 재시도합니다. 마지막 정상 자료와 원본 시각은 유지됩니다. 원본 시각이 오래되면 새로 HTTP 200을 받아도 `stale`입니다. 원본 시각 누락은 `unverified_time`입니다. `/api/health`의 `ok`는 프로세스 상태이며 수집 성공과는 다릅니다.

## API

| 요청 | 내용 |
|---|---|
| `GET /api/health` | 서버 상태와 수집 상태 |
| `GET /api/status` | 신선도, 마지막 수신, 원본 시각, 실패 수, 다음 재시도, 자료 품질 |
| `GET /api/trains` | 전체 수신 열차 |
| `GET /api/trains?line_id=gyeongbu-hsr` | 현재 해당 선로에 매칭된 열차 |
| `GET /api/trains?station_id=ulsan` | 울산이 속한 노선에 매칭된 열차 |
| `GET /api/lines` | 노선 목록·실제 지원 범위 |
| `GET /api/stations?q=통도사` | 역명·별칭 검색 |
| `GET /api/trains?source=archive&archive=141536` | 별도 기록 시연. 기본 조회에 섞이지 않음 |

`/api/status`에도 `source`와 `archive`가 적용됩니다. 표본 키는 `141445`, `141536`뿐입니다. 열차 DTO에는 `id, number, kind, origin, destination, planned_departure, planned_arrival, position_label, coordinates, delay_minutes, delay_status, received_at, source_timestamp, match`가 있습니다. 응답 최상위 `status`가 자료 신선도를, `filter`가 필터 가능 여부를 나타냅니다.

여러 노선 역에 노선 지정 없이 요청하면 `filter.state=select_line`과 가능한 ID 목록을 반환합니다. 매핑 없는 알려진 역은 `unmapped`로 안내합니다. 알 수 없는 역·노선은 404, 연결되지 않은 역·노선 조합은 400입니다. `filter.state=unavailable`의 빈 배열은 운행 열차가 없음을 의미하지 않습니다.

## 식별과 정규화

- 식별자는 열차번호 문자열 + 계획 출발일시(KST 가정) + 시종착역의 SHA-256 기반 키입니다. 원본 `feature.id`와 응답 순서는 사용하지 않습니다. 선행 0도 보존합니다.
- 출발일시가 없는 행은 운행일 식별을 만들 수 없으므로 제외합니다. 같은 키의 동일한 행은 합치고 서로 충돌하는 행은 모두 제외합니다. 병결·분리·시종착 필드 변경에 따른 ID 분리는 실제 운영 검증이 더 필요합니다.
- `now_stn + next_stn`을 합친 표시 문구를 보존합니다. `next_stn`을 역명으로 해석하지 않습니다.
- `null` 지연은 미확인, 0은 정상, 양수는 지연입니다. 잘못된 지연값도 미확인입니다. 선택한 역의 ETA는 계산하지 않습니다.
- `timeStamp`는 응답 기준 시각이며 GPS 측정 시각이 아닙니다. 수신 좌표가 원시 GPS인지 제공자 측 보간인지도 검증되지 않았습니다.
- 비어 있는 정상 FeatureCollection은 빈 목록으로 반영합니다. 모든 항목이 무효인 응답은 정상 빈 목록으로 취급하지 않고 기존 캐시를 유지합니다.

## 테스트

```bash
make test
make validate
make build
```

백엔드는 실제 표본과 별도의 **합성 테스트 전용 도형**으로 검증합니다. 테스트 도형은 `backend/data`에 포함되지 않습니다. HTTP 오류는 `httpx.MockTransport`로 재현하며 외부 API를 호출하지 않습니다. 프런트엔드 테스트는 Vitest + Testing Library입니다.

실제 브라우저 검사는 [scripts/browser_smoke.mjs](scripts/browser_smoke.mjs)로 재현할 수 있습니다. 실행 방법과 확인 결과, 미검증 항목은 [VALIDATION.md](docs/VALIDATION.md)에 기록합니다.

## 파일 구성

```text
backend/app/          설정, DTO, 정규화, 수집기, 카탈로그, 선로 판별기, API
backend/data/         초기 카탈로그, 빈 선로 도형, 명시적인 과거 표본
backend/tests/        파싱·식별·수집·공간 판별·API 테스트
frontend/src/         React UI, 플랩, 오디오, 캐시 조회, 테스트
scripts/             오프라인 도형 준비·검증, 브라우저 검사
docs/                데이터 출처, 매핑 관리, 검증 결과
```

구현: 수집기/공유 캐시/상태/필터 엔진, 울산 연결, 판별 근거 DTO, 전체 기록 시연, 페이지/정렬/상세, 문자별 상·하 3D 플랩, 실제 녹음 샘플·음량·미리듣기, 기본 음소거, 축소 동작, 반응형 UI.

추가 확보·검증 필요: GIS API 수집 허가 및 현재 연결, 명명된 실제 선로 도형과 병행 일반선·분기점 검토, 전체 노선 커버리지, 실제 판별 정확도, 장시간 운용, 복수 서버 조정. 지도·공식 ETA·시간표 기반 위치 생성은 포함하지 않습니다.

데이터 출처와 권한 조사 기록: [SOURCES.md](docs/SOURCES.md). 음원 출처·가공 기록: [AUDIO.md](docs/AUDIO.md). Noto Sans KR는 [SIL Open Font License 1.1](frontend/public/licenses/Noto-Sans-KR-OFL.txt)을 따릅니다. 비공식 프로젝트이며 한국철도공사의 공식 서비스가 아닙니다.
