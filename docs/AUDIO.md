# Pragotron 음원 · 처리와 검증

## 선택한 원본과 현재 상태

matucha의 [pragotron_split-flap-display.wav](https://freesound.org/people/matucha/sounds/174056/)를 사용합니다. 원본 설명은 44.1 kHz / 24-bit / stereo / 약 20.807초입니다. 라이선스는 [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/)이며 개인·비상업 사용을 전제로 합니다. ngruber 샘플과 기존 합성 클릭음은 사용하지 않습니다.

현재 개발 환경에서 Freesound 바이너리 다운로드가 도메인 정책으로 차단되어 **원본, 가공 음원, 실제 오디오 미리듣기가 아직 없습니다.** 이 문서는 완료된 가공 기록이 아니라 원본 확보 후의 재현 절차입니다. 원본을 첨부받아 구간을 청음하고 출력물을 생성해야 합니다.

## 가공

1. 원본 WAV를 `artifacts/pragotron-original.wav`에 둡니다. 분석 명령은 5 ms 피크 엔벨로프와 타격 후보를 출력합니다. 후보는 자동 확정 구간이 아닙니다.

   ```bash
   python scripts/prepare_pragotron.py analyze artifacts/pragotron-original.wav > artifacts/pragotron-analysis.json
   ```

2. 청음으로 타격음 최소 3개(`flip`, 각 120 ms 이하), 회전 시작 구간(`roll`, 160 ms 이하), 마지막 타격(`stop`, 180 ms 이하)을 고릅니다. `artifacts/pragotron-cues.json`에 `[{"kind":"flip","start":실제시작초,"end":실제종료초}, ...]` 형식으로 기록합니다. 원본 시간은 임의로 추정하지 않습니다.

3. 다음 명령으로 앱용 뱅크를 만듭니다. 스크립트는 Python 표준 라이브러리만 사용하므로 Windows에서도 실행 가능합니다.

   ```bash
   python scripts/prepare_pragotron.py build artifacts/pragotron-original.wav --cues artifacts/pragotron-cues.json
   ```

   무음 트림(피크 대비 약 -38 dB, 여유 1 ms), 1 ms / 5 ms 페이드, RMS 정리와 -3 dBFS 피크 상한을 적용합니다. 원본 채널 수·샘플레이트를 유지한 16-bit PCM sprite WAV로 저장합니다. 구간 사이에는 25 ms 무음을 넣습니다. 원본 SHA-256·각 구간·가공 내역은 `frontend/public/audio/pragotron.json`에 함께 남습니다.

4. `cd frontend` 후 `npm run build`로 음원과 메타데이터를 포함합니다. 배포 시 `public/audio/README.md`의 제작자·출처·라이선스 표시를 유지합니다. 위의 미포함 상태 문구도 실제 검증 결과로 갱신합니다.

## 재생과 수명

- `flapMotion.ts`가 문자판과 소리의 공통 일정을 만듭니다. 한 장 160 ms, 6–12장, 칸별 0–180 ms 시작 차이. 회전 소리는 첫 장 시작, 타격은 각 장 착지, 마지막 타격은 최종 착지에 대응합니다. 짧은 잔향은 마지막 착지 이후 최대 약 186 ms입니다.
- `audio.ts`는 같은 출처의 로컬 WAV를 사용합니다. 기본 음소거·음량 30%, 칸 좌표에 따른 좌우 패닝, 0.97–1.03배 재생 속도, 동시 최대 24음, 활성 음 수에 따른 감쇠와 마스터 압축을 적용합니다. 회전 구간은 타격보다 작게 섞습니다.
- 20 ms 간격으로 90 ms 앞까지만 예약합니다. 값 변경·행 제거·페이지/필터 변경·음소거·음량 0·탭 숨김·오디오 컨텍스트 정지 시 대기 이벤트와 이미 예약한 노드를 취소합니다. 늦은 이벤트를 몰아서 재생하지 않습니다.
- 동작 줄이기 설정에서는 플랩과 효과음을 생략합니다. 미리듣기는 사용자가 누를 때만 재생하며 전광판 음소거를 해제하지 않습니다.

## 실제 음원 검증 후 남길 결과

원본 확보 후 다음을 확인하고 `docs/VALIDATION.md`에 결과를 기록합니다: 원본과 추출 구간 청음, 타격음의 첫 트랜지언트와 착지의 일치, 7행 동시 전환의 크기·클리핑, 한 칸 변경·연속 갱신에서 이전 소리가 남지 않음, 미리듣기 WAV와 전환 영상.

`FlapAudio.renderPreview()`는 실제 뱅크와 동일한 이벤트·믹서로 3초 `AudioBuffer`를 렌더링할 수 있습니다. 테스트 더블로 확인한 수명·노드 제한은 음질이나 실제 청음 검증을 대신하지 않습니다.

## 다른 프로젝트의 구현 조사

2026-10-26 UTC에 README와 구현 코드를 함께 확인했습니다. 아래 링크는 조사한 커밋에 고정했습니다. 소리를 직접 비교 청음한 결과가 아니라 코드·출처 조사입니다.

| 프로젝트 | 확인한 구현 | 이 전광판에 참고할 점 |
|---|---|---|
| [react-split-flap-display](https://github.com/robonyong/react-split-flap-display/blob/2b0daba04ab1b41d1347edc5f77d451a809ffd0a/src/Character/index.tsx) | `flip.mp3`를 Howler로 읽고 문자 변화마다 재생. 음원 길이가 한 장의 회전 시간 이하일 때만 재생하며 그 길이에 맞춰 시작을 늦춤. [README](https://github.com/robonyong/react-split-flap-display/blob/2b0daba04ab1b41d1347edc5f77d451a809ffd0a/README.md)는 제작자가 Vestaboard 한 칸을 직접 녹음했다고 명시 | 짧은 실제 모듈 녹음과 칸별 동기화의 직접적인 사례. 저장소는 [MIT](https://github.com/robonyong/react-split-flap-display/blob/2b0daba04ab1b41d1347edc5f77d451a809ffd0a/LICENSE)이며 실제 음원 파일도 포함되어 있어 대안 후보로 검토 가능 |
| [splitflap.org](https://github.com/mohdmahmodi/splitflap.org/blob/75a404442ff68f0a9621f13058b086f6c157b2d3/public/index.html#L1326) | `click.wav`가 있으면 Web Audio 버퍼로 재생, 없으면 35 ms 합성 클릭. 재생 속도 ±0.2 변화, 동시 8음·최소 25 ms 간격 제한, 중간 회전은 3번에 한 번 소리 요청 | 많은 칸이 동시에 돌아갈 때 소리의 밀도와 반복감을 조절하는 방법. 해당 커밋에는 WAV가 포함되어 있지 않음 |
| [Solari split-flap](https://github.com/hardikpandya/solari-split-flap/blob/909c6dd8cd7fe684ab02a176b18222072fdb8deb/src/solari.js#L399) | 12 ms 잡음을 3–4 kHz 대역 필터와 짧은 감쇠로 합성. 칸의 플립 시작마다 재생 | 외부 음원 없이 타이밍을 맞추기 쉬운 방식. 특정 실제 기계의 녹음은 아님 |
| [clackboard](https://github.com/Varnasus/split-flap-display/blob/8466a11e89d45a554327087ab8ec7793b6131b46/src/sound.ts) | `clack`은 잡음·저음 충격·걸쇠 클릭을 겹쳐 합성. `click`·`soft` 변형도 제공. 사용자 음원은 별도 HTML Audio 경로로 재생 | 기계음의 충격과 몸체 울림을 나눠 생각할 수 있는 사례 |
| [FlipOff](https://github.com/magnum6actual/flipoff/blob/ebd8f2633d97cfde6c48ea0d386c1bfff3093347/js/SoundEngine.js#L41) | Base64로 포함한 전환 녹음을 메시지가 바뀔 때 한 번 재생. 새 전환은 기존 재생을 중지 | 전체 전광판 분위기를 간단히 낼 수 있음. 한 글자만 바뀌어도 전체 클립을 재생하는 구조라 이 앱의 부분 갱신에는 맞추기 어려움 |
| [SplitFlapDigit](https://github.com/StephanWald/SplitFlapDigit/blob/796f8da339ba076014b36b0c1380b36e3e66f542/split-flap-digit.js#L139) | Base64 음원을 HTML Audio로 재생하며 시작 위치를 0–50 ms 바꿈. 코드 주석은 전등 스위치 소리라고 설명 | 기계식 보드 예제라고 해서 반드시 실제 플랩 녹음을 쓰는 것은 아님 |

이 앱에는 **짧은 실제 기계 녹음을 칸별 공통 일정에 맞춰 재생하는 방식**이 적합합니다. 지연 숫자 하나만 바뀌는 경우와 7행이 함께 바뀌는 경우의 소리 크기·종료를 각각 제어할 수 있기 때문입니다. 현재 엔진의 샘플 변주·동시 재생 제한·밀도 감쇠는 이 방향과 맞습니다.

조사한 다른 프로젝트의 코드나 음원은 복사하지 않았고, 선택한 Pragotron 음원도 변경하지 않았습니다. Vestaboard 단일 모듈 녹음은 원본과 제작자 설명을 확인할 수 있는 대안 후보이며, 채택 여부와 실제 음색 비교는 별도 작업입니다. 이번 커밋에는 Pragotron 원본 WAV가 아직 포함되지 않습니다.
