# 플랩 녹음과 재생

## 포함한 원본

**Robin Yang (robonyong)**의 [react-split-flap-display](https://github.com/robonyong/react-split-flap-display/blob/2b0daba04ab1b41d1347edc5f77d451a809ffd0a/README.md)에서 제작자가 Vestaboard 한 칸을 직접 녹음했다고 설명한 `src/assets/flip.mp3`를 사용합니다. 원본 저장소의 [MIT 라이선스](https://github.com/robonyong/react-split-flap-display/blob/2b0daba04ab1b41d1347edc5f77d451a809ffd0a/LICENSE) 전문과 저작권 고지를 `frontend/public/audio/LICENSE.txt`에 함께 포함합니다.

- 앱 파일: `frontend/public/audio/vestaboard-flip.mp3` (2,608 bytes). **파일명만 바꿨으며 원본 MP3 바이트를 수정하거나 재인코딩하지 않았습니다.**
- 고정 원본: [flip.mp3](https://github.com/robonyong/react-split-flap-display/blob/2b0daba04ab1b41d1347edc5f77d451a809ffd0a/src/assets/flip.mp3)
- Git blob SHA-1: `711572ea81902d51d32dca0711c9644a14015641`
- SHA-256: `3f14839d3179ab73d778456c0fa1be5c1d571099313a242a9fd48ec2cf28036f`
- Chromium 디코딩: mono, 44,100 Hz, 2,887 samples, 약 65.465 ms. MP3 컨테이너의 길이에는 인코더 지연·패딩이 포함되어 이 값과 다를 수 있습니다.

출처·해시·라이선스·재생 구간은 `frontend/public/audio/split-flap.json`에 기록합니다. 일반 빌드에 실제 음원이 들어가므로 별도 다운로드나 음원 준비 단계 없이 사용할 수 있습니다.

## 재생과 동기화

`flapMotion.ts`가 문자판과 소리의 공통 일정을 만듭니다. 한 장 160 ms, 6–12장, 칸별 0–180 ms 시작 차이를 사용합니다. 한 칸이 바뀌면 각 착지에 짧은 녹음을 한 번씩 재생합니다. 전체 판에서는 동시 재생 제한에 따라 일부 타격을 생략합니다.

원본의 주 타격은 약 29.297 ms 지점에 있습니다. 파일의 시작을 착지에 맞추면 타격이 늦으므로 `impact / playbackRate`만큼 먼저 재생합니다. 효과음의 주 타격과 판의 착지가 같은 목표 시각을 사용합니다. 오디오 장치의 출력 지연까지 측정한 것은 아닙니다.

MP3의 처음 65 ms를 사용하고 런타임에 2 ms 어택·8 ms 릴리스 페이드를 적용합니다. 재생 속도는 0.97–1.03배, 마지막 착지는 같은 녹음에 조금 더 큰 게인을 적용합니다. 서로 다른 여러 녹음을 추출한 것으로 표시하지 않으며, 별도의 모터 회전음을 겹치지 않습니다. 가장 느린 재생 속도에서도 한 장의 160 ms 안에 들어오는 구간만 허용합니다.

- 기본 음소거·초기 음량 30%, 칸 좌표에 따른 좌우 패닝, 동시 최대 24음, 활성 음 수에 따른 감쇠와 마스터 압축을 적용합니다.
- 20 ms 간격으로 90 ms 앞까지만 예약합니다. 새 값·페이지/필터 변경·행 제거·음소거·음량 0·탭 숨김·오디오 컨텍스트 정지 시 대기 이벤트와 이미 예약한 노드를 정리합니다. 늦은 이벤트를 한꺼번에 재생하지 않습니다.
- 동작 줄이기 설정에서는 플랩과 효과음을 생략합니다. 미리듣기는 사용자가 누를 때만 재생하며 전광판 음소거를 해제하지 않습니다.
- 브라우저에서는 외부 음원 서버에 연결하지 않고 빌드에 포함된 MP3만 읽습니다. 다운로드 실패 시 안내하고 음소거를 유지합니다.

## 검증과 미리듣기

`scripts/browser_audio.mjs`는 운영 빌드에서 실제 MP3를 디코딩하고 실제 Web Audio 그래프를 검사합니다. 미리듣기 출력은 `artifacts/flap-preview.webm`에 녹음하며 WAV로도 변환할 수 있습니다. `scripts/record_transition.mjs`는 브라우저 프레임과 동일 믹서의 소리를 공통 시계로 맞춰 `artifacts/transition-with-audio.mp4`를 만듭니다. 두 스크립트의 계측 코드는 앱 번들에 포함되지 않습니다.

코드 검사, 실제 오디오 출력·종료·단일 문자 동기 측정, 클리핑 분석 결과는 [VALIDATION.md](VALIDATION.md)에 기록합니다. 실제 스피커·헤드폰에서의 청감 비교와 Safari/Firefox 검증은 별도입니다.

## 다른 프로젝트의 구현 조사

2026-10-26 UTC에 README와 구현 코드를 함께 확인했습니다. 아래 링크는 조사한 커밋에 고정했습니다. 소리를 직접 비교 청음한 결과가 아니라 코드·출처 조사입니다.

| 프로젝트 | 확인한 구현 | 이 전광판에 참고할 점 |
|---|---|---|
| [react-split-flap-display](https://github.com/robonyong/react-split-flap-display/blob/2b0daba04ab1b41d1347edc5f77d451a809ffd0a/src/Character/index.tsx) | `flip.mp3`를 Howler로 읽고 문자 변화마다 재생. 음원 길이가 한 장의 회전 시간 이하일 때만 재생하며 그 길이에 맞춰 시작을 늦춤. [README](https://github.com/robonyong/react-split-flap-display/blob/2b0daba04ab1b41d1347edc5f77d451a809ffd0a/README.md)는 제작자가 Vestaboard 한 칸을 직접 녹음했다고 명시 | 이 앱이 채택한 짧은 실제 모듈 녹음과 칸별 동기화 사례. 저장소는 [MIT](https://github.com/robonyong/react-split-flap-display/blob/2b0daba04ab1b41d1347edc5f77d451a809ffd0a/LICENSE)이며 실제 음원 파일도 포함되어 있음 |
| [splitflap.org](https://github.com/mohdmahmodi/splitflap.org/blob/75a404442ff68f0a9621f13058b086f6c157b2d3/public/index.html#L1326) | `click.wav`가 있으면 Web Audio 버퍼로 재생, 없으면 35 ms 합성 클릭. 재생 속도 ±0.2 변화, 동시 8음·최소 25 ms 간격 제한, 중간 회전은 3번에 한 번 소리 요청 | 많은 칸이 동시에 돌아갈 때 소리의 밀도와 반복감을 조절하는 방법. 해당 커밋에는 WAV가 포함되어 있지 않음 |
| [Solari split-flap](https://github.com/hardikpandya/solari-split-flap/blob/909c6dd8cd7fe684ab02a176b18222072fdb8deb/src/solari.js#L399) | 12 ms 잡음을 3–4 kHz 대역 필터와 짧은 감쇠로 합성. 칸의 플립 시작마다 재생 | 외부 음원 없이 타이밍을 맞추기 쉬운 방식. 특정 실제 기계의 녹음은 아님 |
| [clackboard](https://github.com/Varnasus/split-flap-display/blob/8466a11e89d45a554327087ab8ec7793b6131b46/src/sound.ts) | `clack`은 잡음·저음 충격·걸쇠 클릭을 겹쳐 합성. `click`·`soft` 변형도 제공. 사용자 음원은 별도 HTML Audio 경로로 재생 | 기계음의 충격과 몸체 울림을 나눠 생각할 수 있는 사례 |
| [FlipOff](https://github.com/magnum6actual/flipoff/blob/ebd8f2633d97cfde6c48ea0d386c1bfff3093347/js/SoundEngine.js#L41) | Base64로 포함한 전환 녹음을 메시지가 바뀔 때 한 번 재생. 새 전환은 기존 재생을 중지 | 전체 전광판 분위기를 간단히 낼 수 있음. 한 글자만 바뀌어도 전체 클립을 재생하는 구조라 이 앱의 부분 갱신에는 맞추기 어려움 |
| [SplitFlapDigit](https://github.com/StephanWald/SplitFlapDigit/blob/796f8da339ba076014b36b0c1380b36e3e66f542/split-flap-digit.js#L139) | Base64 음원을 HTML Audio로 재생하며 시작 위치를 0–50 ms 바꿈. 코드 주석은 전등 스위치 소리라고 설명 | 기계식 보드 예제라고 해서 반드시 실제 플랩 녹음을 쓰는 것은 아님 |

이 앱에는 **짧은 실제 기계 녹음을 칸별 공통 일정에 맞춰 재생하는 방식**이 적합합니다. 지연 숫자 하나만 바뀌는 경우와 7행이 함께 바뀌는 경우의 소리 크기·종료를 각각 제어할 수 있기 때문입니다. 현재 엔진의 샘플 변주·동시 재생 제한·밀도 감쇠는 이 방향과 맞습니다.

위 조사에서 Robin Yang의 `flip.mp3`를 채택했습니다. 음원은 MIT 고지와 함께 포함하고, 재생은 이 앱의 Web Audio 일정·패닝·음량·취소 로직으로 처리합니다. Howler나 다른 프로젝트의 구현 코드는 복사하지 않았습니다.
