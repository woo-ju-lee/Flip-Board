import { Clock } from "./components/Clock";
import { TrainRow } from "./components/TrainRow";
import { TrainDetail } from "./components/TrainDetail";
import { formatTime } from "./format";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUpRight,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Expand,
  Info,
  MapPin,
  Maximize2,
  Radio,
  RefreshCw,
  Route,
  TrainFront,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { SplitFlap, useReducedMotion } from "./components/SplitFlap";
import { useRowPresence } from "./components/useRowPresence";
import { flapAudio } from "./audio";
import { useBoard, useCatalog } from "./useBoard";
import type { Mode, Source, Train } from "./types";

const PAGE_SIZE = 7;
const STATE_LABELS: Record<string, string> = {
  disabled: "수집 꺼짐",
  connecting: "연결 중",
  ok: "정상 수신",
  stale: "갱신 지연",
  error: "연결 실패",
  blocked: "수집 중단",
  empty: "수신 목록 없음",
  archive: "기록 표본",
  unverified_time: "시각 미확인",
};
function usePositionLength() {
  const getLength = () =>
    window.innerWidth <= 480 ? 9 : window.innerWidth <= 760 ? 11 : 13;
  const [length, setLength] = useState(getLength);
  useEffect(() => {
    const resize = () => setLength(getLength());
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  return length;
}

export default function App() {
  const [source, setSource] = useState<Source>(() =>
    new URLSearchParams(window.location.search).get("source") === "archive"
      ? "archive"
      : "live",
  );
  const [archive, setArchive] = useState("141536");
  const [mode, setMode] = useState<Mode>("all");
  const [station, setStation] = useState("ulsan");
  const [line, setLine] = useState("");
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState("number");
  const [sound, setSound] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [notice, setNotice] = useState("");
  const [details, setDetails] = useState<Train | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const [clientNow, setClientNow] = useState(Date.now());
  const reduced = useReducedMotion();
  const positionLength = usePositionLength();
  const { lines, stations, catalogError } = useCatalog();
  const { data, error, loading, refresh } = useBoard(
    source,
    archive,
    mode,
    station,
    line,
  );
  useEffect(() => {
    const id = setInterval(() => setClientNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    const listener = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", listener);
    return () => document.removeEventListener("fullscreenchange", listener);
  }, []);
  useEffect(() => {
    setPage(0);
    setDetails(null);
  }, [mode, station, line, source, archive, sort]);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (source === "archive") url.searchParams.set("source", "archive");
    else url.searchParams.delete("source");
    window.history.replaceState(null, "", url);
  }, [source]);
  const trains = useMemo(
    () =>
      [...(data?.trains ?? [])].sort((a, b) => {
        if (sort === "delay")
          return (
            (b.delay_minutes ?? -1) - (a.delay_minutes ?? -1) ||
            a.number.localeCompare(b.number, "ko", { numeric: true })
          );
        if (sort === "position")
          return a.position_label.localeCompare(b.position_label, "ko");
        if (sort === "kind")
          return (
            a.kind.localeCompare(b.kind, "ko") ||
            a.number.localeCompare(b.number, "ko", { numeric: true })
          );
        return a.number.localeCompare(b.number, "ko", { numeric: true });
      }),
    [data, sort],
  );
  const pages = Math.max(1, Math.ceil(trains.length / PAGE_SIZE));
  const safePage = Math.min(page, pages - 1);
  const visible = trains.slice(
    safePage * PAGE_SIZE,
    (safePage + 1) * PAGE_SIZE,
  );
  const currentDetails = details
    ? data?.trains.find((t) => t.id === details.id)
    : null;
  const presentRows = useRowPresence(
    visible,
    [source, archive, mode, station, line, safePage, sort].join(":"),
    reduced,
  );
  const s = data?.status;
  const aged =
    source === "live" &&
    s &&
    s.freshness === "fresh" &&
    [s.source_timestamp, s.last_received_at].some(
      (t) =>
        t && clientNow - Date.parse(t) > (s.stale_after_seconds || 150) * 1000,
    );
  const state = error ? "error" : aged ? "stale" : (s?.state ?? "connecting");
  const good = state === "ok";
  const selectedStation = stations.find((x) => x.id === station);
  const selectedLine = lines.find(
    (x) => x.id === (line || data?.filter.line_id),
  );
  const title =
    mode === "all"
      ? "전체 열차"
      : mode === "station"
        ? `${selectedStation?.name ?? "울산(통도사)"}역`
        : (selectedLine?.name ?? "경부고속선");
  const lineOptions =
    mode === "station"
      ? lines.filter((l) => selectedStation?.line_ids.includes(l.id))
      : lines;
  const unavailable =
    data &&
    ["unavailable", "unmapped", "select_line"].includes(data.filter.state);
  const switchMode = (next: Mode) => {
    setMode(next);
    setLine(next === "line" ? "gyeongbu-hsr" : "");
  };
  async function toggleSound() {
    try {
      setSound(await flapAudio.toggle());
      setNotice("");
    } catch {
      setNotice("이 브라우저에서 소리를 재생할 수 없습니다.");
    }
  }
  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (document.documentElement.requestFullscreen)
        await document.documentElement.requestFullscreen();
      else setNotice("이 브라우저는 전체 화면을 지원하지 않습니다.");
    } catch {
      setNotice("전체 화면으로 전환하지 못했습니다.");
    }
  }
  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="KORAIL Live 홈">
          <span className="brand-mark">
            <TrainFront size={22} strokeWidth={1.7} />
          </span>
          <span>
            <strong>
              KORAIL<span className="brand-light"> LIVE</span>
            </strong>
            <small>RAILWAY OBSERVATORY</small>
          </span>
        </a>
        <div className="header-center">
          <span className="tiny-cross">+</span> 움직이는 지금을, 한눈에.{" "}
          <span className="tiny-cross">+</span>
        </div>
        <Clock />
      </header>

      <main>
        <section className="intro">
          <div>
            <div className="eyebrow">
              <span className="accent-line" /> THE RAILWAY, IN MOTION
            </div>
            <h1>
              기차가 지나는 순간<span>.</span>
            </h1>
            <p>선로 위의 움직임을 담은, 나만의 열차 전광판.</p>
          </div>
          <div className="intro-side">
            <span className="edition">LIVE TRAIN BOARD</span>
            <span className="edition-number">
              01 <span>/ 대한민국 철도</span>
            </span>
          </div>
        </section>

        <section className="controls" aria-label="열차 필터">
          <div className="mode-tabs" role="tablist" aria-label="조회 방식">
            {(
              [
                { id: "all", label: "전체 열차", Icon: TrainFront },
                { id: "station", label: "역 선택", Icon: MapPin },
                { id: "line", label: "노선 선택", Icon: Route },
              ] as const
            ).map(({ id, label, Icon }) => (
              <button
                key={id}
                role="tab"
                aria-selected={mode === id}
                onClick={() => switchMode(id)}
              >
                <Icon size={15} />
                {label}
              </button>
            ))}
          </div>
          <div className="selection-area">
            {mode === "all" ? (
              <span className="network-label">
                <span className="small-dot" /> 전국 운행 위치{" "}
                <span className="muted">/ 수신 목록 기준</span>
              </span>
            ) : (
              <>
                {mode === "station" && (
                  <label className="select-wrap">
                    <MapPin size={14} />
                    <select
                      aria-label="역 선택"
                      value={station}
                      onChange={(e) => {
                        setStation(e.target.value);
                        setLine("");
                      }}
                    >
                      <option value="ulsan">울산(통도사)역</option>
                      {stations
                        .filter((s) => s.id !== "ulsan")
                        .map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}역
                          </option>
                        ))}
                    </select>
                    <ChevronDown size={14} />
                  </label>
                )}
                {(mode === "line" ||
                  (selectedStation?.line_ids.length ?? 0) > 1) && (
                  <label className="select-wrap">
                    <Route size={14} />
                    <select
                      aria-label="노선 선택"
                      value={line}
                      onChange={(e) => setLine(e.target.value)}
                    >
                      <option value="" disabled>
                        노선을 선택하세요
                      </option>
                      {lineOptions.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.name}
                        </option>
                      ))}
                    </select>
                    <ChevronDown size={14} />
                  </label>
                )}
                {mode === "station" &&
                  (selectedStation?.line_ids.length ?? 0) <= 1 && (
                    <span className="linked-line">
                      → {selectedLine?.name ?? "경부고속선"}
                    </span>
                  )}
              </>
            )}
          </div>
          <div className="source-switch" aria-label="자료 종류">
            <button
              aria-pressed={source === "live"}
              onClick={() => setSource("live")}
            >
              실시간
            </button>
            <button
              aria-pressed={source === "archive"}
              onClick={() => setSource("archive")}
            >
              기록 표본
            </button>
          </div>
        </section>

        {(catalogError || notice) && (
          <div className="inline-message" role="alert">
            {catalogError || notice}
            <button onClick={() => setNotice("")} aria-label="알림 닫기">
              <X size={14} />
            </button>
          </div>
        )}
        <div
          className={`source-notice ${source === "archive" ? "archive-notice" : ""}`}
          role="status"
        >
          <Info size={14} />
          <span>
            {source === "archive"
              ? "기록 표본 모드 · 2026.10.26에 수신한 자료입니다. 현재 운행 정보가 아닙니다."
              : error ||
                (aged
                  ? "갱신 지연 · 마지막 수신 자료를 표시합니다."
                  : (s?.message ?? "전광판 서버에 연결하고 있습니다."))}
          </span>
          {source === "archive" ? (
            <label>
              수신 기록{" "}
              <select
                aria-label="표본 수신 시각"
                value={archive}
                onChange={(e) => setArchive(e.target.value)}
              >
                <option value="141445">14:14:45 KST</option>
                <option value="141536">14:15:36 KST</option>
              </select>
            </label>
          ) : (
            <button onClick={() => setSource("archive")}>
              기록 표본 살펴보기 <ArrowUpRight size={13} />
            </button>
          )}
        </div>

        <section className="board-housing" aria-label="열차 운행 전광판">
          <i className="screw screw-tl" />
          <i className="screw screw-tr" />
          <i className="screw screw-bl" />
          <i className="screw screw-br" />
          <div className="board-titlebar">
            <div className="board-title">
              <span className="board-icon">
                <TrainFront size={22} />
              </span>
              <h2>
                {title}
                <span>
                  {mode === "all"
                    ? "ALL TRAINS"
                    : mode === "station"
                      ? "STATION LINES"
                      : "PHYSICAL RAIL LINE"}
                </span>
              </h2>
              <span className="count-label">
                {unavailable ? "판별 대기" : `${data?.count ?? "—"} TRAINS`}
              </span>
            </div>
            <div className="board-tools">
              <span className={`connection-state ${good ? "connected" : ""}`}>
                <span />
                {STATE_LABELS[state] ?? state}
              </span>
              <span className="tool-divider" />
              <button
                className={sound ? "active-tool" : ""}
                onClick={toggleSound}
                aria-label={sound ? "소리 끄기" : "소리 켜기"}
                aria-pressed={sound}
                title={sound ? "소리 켜짐" : "소리 꺼짐"}
              >
                {sound ? <Volume2 size={18} /> : <VolumeX size={18} />}
              </button>
              <button
                onClick={toggleFullscreen}
                aria-label={fullscreen ? "전체 화면 종료" : "전체 화면"}
                aria-pressed={fullscreen}
              >
                {fullscreen ? <Maximize2 size={17} /> : <Expand size={18} />}
              </button>
            </div>
          </div>

          <div
            className="display-table"
            role="table"
            aria-label={`${title} 목록`}
          >
            <div className="board-columns" role="row">
              <span role="columnheader">
                열차 <small>TRAIN</small>
              </span>
              <span role="columnheader" className="origin-cell">
                출발 <small>FROM</small>
              </span>
              <span role="columnheader" className="destination-cell">
                도착 <small>TO</small>
              </span>
              <span role="columnheader">
                현재 위치 <small>POSITION</small>
              </span>
              <span role="columnheader">
                지연 <small>DELAY</small>
              </span>
            </div>
            <div className="rows" role="rowgroup">
              {presentRows.map(({ train, exiting }) => (
                <TrainRow
                  key={train.id}
                  train={train}
                  reduced={reduced}
                  positionLength={positionLength}
                  exiting={exiting}
                  onSelect={setDetails}
                />
              ))}
              {presentRows.length > 0 &&
                Array.from(
                  { length: Math.max(0, PAGE_SIZE - presentRows.length) },
                  (_, i) => (
                    <div
                      key={`empty-${i}`}
                      className="board-row empty-row"
                      aria-hidden="true"
                    >
                      <span className="train-cell">
                        <span className="train-type" />
                        <SplitFlap text="" length={4} reduced={true} />
                      </span>
                      <span className="origin-cell">
                        <SplitFlap text="" length={5} reduced={true} />
                      </span>
                      <span className="destination-cell">
                        <SplitFlap text="" length={5} reduced={true} />
                      </span>
                      <span className="position-cell">
                        <span className="position-indicator" />
                        <SplitFlap text="" length={13} reduced={true} />
                      </span>
                      <span>
                        <SplitFlap text="" length={5} reduced={true} />
                      </span>
                    </div>
                  ),
                )}
              {!presentRows.length && (
                <div className="empty-state">
                  <span className="empty-symbol">
                    {unavailable ? <Route size={30} /> : <Radio size={30} />}
                  </span>
                  <h3>
                    {unavailable
                      ? data.filter.state === "select_line"
                        ? "노선을 선택해 주세요"
                        : "노선 판별을 준비하고 있습니다"
                      : loading
                        ? "수신 자료를 확인하고 있습니다"
                        : error
                          ? "전광판 서버에 연결하지 못했습니다"
                          : state === "disabled"
                            ? "실시간 수집이 꺼져 있습니다"
                            : "표시할 열차 정보가 없습니다"}
                  </h3>
                  <p>
                    {unavailable
                      ? data.filter.message
                      : error
                        ? "서버 실행 상태를 확인한 뒤 다시 조회해 주세요."
                        : state === "disabled"
                          ? "서버 설정에서 실시간 수집을 활성화한 뒤 서버를 다시 시작해 주세요.\n기록 표본으로 전광판을 먼저 살펴보세요."
                          : "수신 상태와 선택한 노선의 지원 범위를 확인해 주세요."}
                  </p>
                  {unavailable ? (
                    <button onClick={() => switchMode("all")}>
                      전체 수신 열차 보기 <ArrowUpRight size={15} />
                    </button>
                  ) : error ? (
                    <button onClick={refresh}>
                      다시 조회 <RefreshCw size={14} />
                    </button>
                  ) : (
                    source === "live" && (
                      <button onClick={() => setSource("archive")}>
                        기록 표본으로 살펴보기 <ArrowUpRight size={15} />
                      </button>
                    )
                  )}
                  <div className="empty-flaps" aria-hidden="true">
                    <SplitFlap text="" length={10} reduced={true} />
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="board-footer">
            <div className="update-label">
              <Clock3 size={13} />
              <span>
                {source === "archive" ? "기록 수신" : "마지막 수신"}{" "}
                <strong>{formatTime(s?.last_received_at)}</strong>
                <span className="tz"> KST</span>
              </span>
              <button
                onClick={refresh}
                disabled={loading}
                aria-label="서버 캐시 다시 조회"
                title="서버에 저장된 최신 자료 다시 조회"
              >
                <RefreshCw
                  size={13}
                  className={loading && !reduced ? "spin" : ""}
                />
              </button>
            </div>
            <div className="pagination">
              <span>
                {trains.length
                  ? `${safePage * PAGE_SIZE + 1}–${Math.min((safePage + 1) * PAGE_SIZE, trains.length)}`
                  : "0"}{" "}
                <span className="muted">/ {trains.length}</span>
              </span>
              <button
                disabled={safePage === 0}
                onClick={() => setPage(safePage - 1)}
                aria-label="이전 페이지"
              >
                <ChevronLeft size={17} />
              </button>
              <strong>
                {String(safePage + 1).padStart(2, "0")}
                <span> / {String(pages).padStart(2, "0")}</span>
              </strong>
              <button
                disabled={safePage === pages - 1}
                onClick={() => setPage(safePage + 1)}
                aria-label="다음 페이지"
              >
                <ChevronRight size={17} />
              </button>
            </div>
          </div>
        </section>

        <div className="under-board">
          <span>
            <span className="legend-dot on-time" />
            정상 <span className="legend-dot late" />
            지연 <span className="legend-dot unknown" />
            미확인
          </span>
          <label>
            <ArrowDown size={13} /> 정렬{" "}
            <select
              aria-label="열차 정렬"
              value={sort}
              onChange={(e) => setSort(e.target.value)}
            >
              <option value="number">열차번호순</option>
              <option value="delay">지연시간순</option>
              <option value="kind">열차종류순</option>
              <option value="position">현재위치순</option>
            </select>
            <ChevronDown size={12} />
          </label>
        </div>

        <section className="info-strip">
          <div className="info-strip-title">
            <span className="small-dot" />
            <strong>위치로 보는 철도</strong>
            <span>ABOUT THIS BOARD</span>
          </div>
          <p>
            열차의 종류나 목적지가 아닌,{" "}
            <strong>수신 좌표와 검증된 선로</strong>를 기준으로 노선을
            판별합니다.
          </p>
          <button
            onClick={() => setShowInfo(!showInfo)}
            aria-expanded={showInfo}
          >
            데이터 안내 <Info size={14} />
          </button>
        </section>
        {showInfo && (
          <section className="data-info">
            <div>
              <h3>실제 수신 정보</h3>
              <p>
                위치는 코레일 응답의 좌표입니다. 원시 GPS인지 여부는 확인되지
                않았습니다. 원본 기준 시각은 {formatTime(s?.source_timestamp)}{" "}
                KST이며 개별 위치 측정 시각을 뜻하지 않습니다.
              </p>
            </div>
            <div>
              <h3>보수적인 노선 판별</h3>
              <p>
                {s?.geometry_available
                  ? "등록된 검증 구간만 판별합니다. 일부 구간 지원은 전체 노선의 검증을 뜻하지 않습니다."
                  : "현재 배포본은 검증된 노선 도형이 없어 노선 필터가 준비 상태입니다. 울산역의 노선 연결과 선로 도형 검증은 별개입니다."}{" "}
                판별 불가 {data?.unknown_count ?? 0}대 · 모호{" "}
                {data?.ambiguous_count ?? 0}대.
              </p>
            </div>
            <div>
              <h3>갱신과 자료 품질</h3>
              <p>
                수집 활성화 시 기본 {s?.poll_seconds ?? 60}초 간격으로 공통
                자료를 갱신합니다. 지연값이 없는 열차는 미확인으로 표시합니다.
                제외된 원본 항목 {s?.quality.rejected_count ?? 0}건.
              </p>
            </div>
          </section>
        )}
      </main>
      <footer className="page-footer">
        <span>
          KORAIL LIVE{" "}
          <span className="muted">/ A LITTLE NOSTALGIA. A MOVING WORLD.</span>
        </span>
        <span>
          비공식 프로젝트 <span>·</span> 데이터 출처{" "}
          <a
            href="https://gis.korail.com/korailTalk/entrance?route=main"
            target="_blank"
            rel="noreferrer"
          >
            한국철도공사 <ArrowUpRight size={11} />
          </a>
        </span>
      </footer>
      {currentDetails && (
        <TrainDetail
          train={currentDetails}
          source={source}
          onClose={() => setDetails(null)}
        />
      )}
    </div>
  );
}
