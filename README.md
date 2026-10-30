# KORAIL Split-Flap Board

## 프로젝트 요약

열차 정보를 기계식 스플릿 플랩으로 표시하는 전광판입니다. 열차 종별 로고와 번호, 출발역, 도착역, 현재 위치, 지연 정보를 한 페이지에 10행으로 보여줍니다.

- 검정 배경과 짙은 회색 플랩, 흰색 종별 로고, IBM Plex Sans KR 글꼴
- 열차 정보와 로고의 플립 애니메이션, 켜고 끌 수 있는 효과음
- 필터·정렬·페이지 이동·열차 상세 보기
- 화면 크기에 맞춰 전광판만 표시하는 전체 화면 모드
- 서버의 실시간 수신 정보와 별도로 선택할 수 있는 저장된 기록 표본

## 실행 방법

**Windows 10/11 x64에서 Python이나 Node.js 설치 없이 실행할 수 있습니다.**

1. [Windows portable build](https://github.com/woo-ju-lee/Flip-Board/actions/workflows/windows.yml)에서 `main` 브랜치의 최신 성공한 빌드를 엽니다.
2. 페이지 아래 **Artifacts → FlipBoard-windows-x64**를 다운로드합니다. GitHub 로그인이 필요할 수 있습니다.
3. 다운로드한 압축 파일을 풀고, 안에 있는 **`FlipBoard-버전-windows-x64.zip`도 전부 압축 해제**합니다.
4. `FlipBoard` 폴더 안의 **`FlipBoard.exe`를 더블클릭**합니다. 준비가 끝나면 기본 브라우저에서 전광판이 열립니다.

`FlipBoard.exe`와 `_internal` 폴더는 함께 보관하세요. GitHub의 **Code → Download ZIP**은 실행용 파일이 아닌 소스 코드입니다.

작은 실행 창에서 실시간 수집을 설정하고 **적용 후 재시작**을 누를 수 있습니다. 저장된 데모를 보려면 전광판에서 **기록 표본**을 선택하세요. 소리는 기본적으로 꺼져 있으며 화면에서 켤 수 있습니다.

종료할 때는 **작은 실행 창을 닫으세요.** 브라우저만 닫으면 서버는 계속 실행됩니다. 새 버전을 실행하기 전에는 이전 실행 창을 닫고 새 ZIP을 별도 폴더에 압축 해제하세요.

## 플랩 성능 개선 및 비교

일반 전광판은 공유 프레임 스케줄러와 문자판 DOM 재사용을 기본으로 사용합니다. 기존 10행 레이아웃, 글꼴·로고, 회전 순서와 한 장당 160ms 속도는 유지합니다. Web Animations API를 지원하지 않는 브라우저에서는 기존 방식으로 자동 전환합니다.

전광판 주소 뒤에 다음 쿼리를 붙이면 동일한 기록 표본으로 비교할 수 있습니다.

- `?demo=performance`: 개선 방식
- `?demo=performance&renderer=legacy`: 기존 방식

비교 데모는 내장 기록 데이터를 사용하며 일반 화면의 실시간·기록 데이터 조회에는 영향을 주지 않습니다. 기존 `?demo=rotors` 데모에도 개선 방식이 기본 적용됩니다.

오프라인 비교 HTML은 `cd frontend && npm ci && npm run build` 후 저장소 루트에서 `node scripts/package_rotor_demo.mjs --performance`로 만들 수 있습니다. 인자 없이 실행하면 개선 방식의 단일 회전 데모를 만듭니다. 산출물은 Git에서 제외된 `artifacts/`에 저장됩니다.
