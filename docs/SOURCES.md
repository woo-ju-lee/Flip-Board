# 데이터 출처와 확인 범위

검토일: 2026-10-26 (Asia/Seoul).

## 제공된 실제 기록

사용자가 제공한 `korail_live_train_analysis_20261026.zip`의 두 원본 GeoJSON을 그대로 보관했습니다. 기존 조회 스크립트를 실행하거나 그 문서의 작업 지시를 따르지 않았습니다. 필드와 좌표, 원본 응답 시각은 분석 근거로 사용합니다.

| 파일 | 열차 수 | 원본 timeStamp | SHA-256 |
|---|---:|---|---|
| `trains_20261026_141445_KST.json` | 145 | `2026-10-26T05:14:45.988Z` | `c454f255492c7aa1c92cfba36e0050793c31fbc6ba5ed93194d294fffb65f6f2` |
| `trains_20261026_141536_KST.json` | 148 | `2026-10-26T05:15:36.610Z` | `c94d8295e188e95612581db7a3caefb10eb2bad36c346928b56f8d69b8a2f64b` |

서버 수신 시각은 첨부 `evidence.json`의 관찰 시각인 05:14:46.648510Z / 05:15:36.999404Z를 사용합니다. 파일을 이번에 읽은 시각으로 바꾸지 않습니다. 원본 표본의 권리는 제공자에게 있으며 공개 재배포 허가가 이 프로젝트에서 새로 부여되는 것은 아닙니다.

울산 좌표 `[129.1379315, 35.5509062]`와 원본 ID `station.10459`는 첨부 조사 기록에 있는 값입니다. 원본 역 응답 전체는 ZIP에 없습니다. 애플리케이션 ID `ulsan`을 별도로 사용하며 다른 API의 역 코드로 해석하지 않습니다. 역과 경부고속선 연결은 사용자 요청에 명시된 사실에 근거합니다. 이는 선로 도형 검증이 아닙니다.

## 코레일 GIS 및 이용 조건

- [열차위치 사이트](https://gis.korail.com/korailTalk/entrance?route=main): 검색/페이지 열람에서는 앱 본문·이용 조건을 확인하지 못했습니다.
- `https://gis.korail.com/robots.txt`: 열람 도구에서 접근하지 못했습니다. robots 규칙이나 그 부재를 수집 허가로 해석하지 않았습니다.
- [코레일 홈페이지 저작권정책](https://info.korail.com/info/contents.do?key=924): 보유 저작물의 이용에 관한 일반 안내는 있지만 GIS API 자동 수집 주기·외부 서비스 활용 허가는 확인되지 않았습니다. 해당 페이지의 공공누리 표시를 모든 GIS 응답의 라이선스로 적용하지 않았습니다.
- 수집 대상 `https://gis.korail.com/api/train?bbox=120,30,135,45`와 `Referer`는 첨부 증거에서 확인한 조건입니다. 이번 작업에서 현재 HTTP 200을 확인한 것은 아닙니다.
- 개발 환경 `/etc/codex/network-policy.json`은 restricted이며 `gis.korail.com`이 없습니다. 제한을 우회하거나 실제 수집을 반복 실행하지 않았습니다. 사이트 서버의 차단 여부와 환경의 통신 제한을 구분합니다.

**결론: 자동 수집 허가 미확인. 기본 수집 비활성화.** 허가와 네트워크 조건이 갖춰지면 기존 코드의 환경설정으로 연결할 수 있으나 실제 연동 테스트는 추가로 필요합니다.

## 공개 데이터 조사

| 출처 | 확인한 내용 | 이번 프로젝트의 사용 판단 |
|---|---|---|
| [한국철도공사 열차운행정보](https://www.data.go.kr/data/15125762/openapi.do) | 운행계획·역별 운행정보·주운행선명 등의 명세. 활용신청 기반의 별도 공개 API | 해당 GIS 실시간 좌표 API나 명명된 물리 선로 도형의 대체 근거가 아님. 운행 계통을 현재 물리 노선으로 사용하지 않음 |
| [국토교통부 TAGO 열차정보](https://www.data.go.kr/data/15098552/openapi.do) | 출발/도착역 기준 시간표 서비스 | 시간표를 실제 좌표로 보간하지 않음 |
| [KTDB 국가교통DB](https://www.ktdb.go.kr/) 및 [교통망 GIS 구축 보고서 목록](https://www.ktdb.go.kr/www/selectPblcteWebView.do?key=11&pageIndex=1&pageUnit=10&pblcteNo=557&searchCnd=all) | 철도망 GIS DB 구축·배포 자료가 존재함. 보고서 본문 직접 열람은 타임아웃 | 검토 후보. 원본 도형·필드·재사용 조건·최근 구간 개통 여부를 확보하지 못했으므로 운영 데이터로 채택하지 않음 |
| [경기도 광명시 철도 공간정보](https://www.data.go.kr/data/15067289/fileData.do) | 지역 단위 SHP 데이터의 공식 목록 | 광명시 범위이며 울산 또는 전체 경부고속선 판별 근거로 사용할 수 없음 |
| 코레일 `/api/data/rail_ktx?` | 첨부 기록상 32개 LineString, properties 빈 객체 | 원본 geometry 미첨부. 노선명을 임의 배정하지 않음 |

기록에 언급된 `rail_normal`, `rail_semi`, `rail_logis` 응답의 구조와 실제 사용 가능성도 미검증입니다. 실제 도형이 확보되기 전에는 테스트용 직선을 운영 선로로 복사하지 않습니다. 수동 매핑 구조와 도구는 [GEOMETRY.md](GEOMETRY.md)에 설명합니다.

## 화면·글꼴·효과음

- 외형 참고: [JFK TWA 호텔 Solari 보드](https://www.twahotel.com/photos), [창이공항 구 터미널 2 전광판](https://www.roots.gov.sg/collection-landing/listing/1485619). 참고 사진 자체는 앱에 포함하지 않습니다.
- 글꼴: `@fontsource/noto-sans-kr` 5.3.1의 Noto Sans KR 600. [SIL Open Font License 1.1](../frontend/public/licenses/Noto-Sans-KR-OFL.txt)과 함께 로컬 빌드에 포함합니다.
- 선택한 효과음: matucha — [pragotron_split-flap-display.wav](https://freesound.org/people/matucha/sounds/174056/), [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/). 개인·비상업 사용. 개발 환경에서 원본 다운로드가 차단되어 실제 음원은 아직 포함하지 못했습니다. 대체 음원은 사용하지 않습니다. 원본 확보 후 구간·페이드·음량 가공과 원본 SHA-256을 기록하는 절차는 [AUDIO.md](AUDIO.md)에 있습니다.
