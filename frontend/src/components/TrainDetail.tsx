import { useEffect } from "react";
import { X } from "lucide-react";
import { formatTime, delayText } from "../format";
import type { Train, Source } from "../types";

export function TrainDetail({
  train,
  source,
  onClose,
}: {
  train: Train;
  source: Source;
  onClose: () => void;
}) {
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector("dialog");
    dialog?.showModal();
    return () => {
      dialog?.close();
      previouslyFocused?.focus();
    };
  }, []);
  return (
    <dialog
      className="train-dialog"
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      aria-labelledby="train-title"
    >
      <div className="dialog-heading">
        <span className="eyebrow">
          {source === "archive"
            ? "HISTORICAL RECORD · 기록 표본"
            : "RECEIVED POSITION · 수신 위치"}
        </span>
        <button onClick={onClose} aria-label="상세 닫기">
          <X size={20} />
        </button>
      </div>
      <h2 id="train-title">
        {train.kind} <span>{train.number}</span>
      </h2>
      <p className="journey">
        {train.origin} <span>→</span> {train.destination}
      </p>
      <dl>
        <div>
          <dt>현재 위치 문구</dt>
          <dd>{train.position_label}</dd>
        </div>
        <div>
          <dt>지연</dt>
          <dd>{delayText(train)}</dd>
        </div>
        <div>
          <dt>수신 좌표 (경도, 위도)</dt>
          <dd>{train.coordinates.map((n) => n.toFixed(6)).join(", ")}</dd>
        </div>
        <div>
          <dt>노선 판별</dt>
          <dd>
            {train.match.status === "matched"
              ? `${train.match.line_id} · 도형 기준 추정`
              : train.match.status === "ambiguous"
                ? "모호 · 필터 제외"
                : "판별 불가"}
          </dd>
        </div>
        {train.match.distance_m !== null && (
          <div>
            <dt>선로 거리 / 점수</dt>
            <dd>
              {train.match.distance_m}m / {train.match.confidence.toFixed(2)}{" "}
              (확률 아님)
            </dd>
          </div>
        )}
        <div>
          <dt>원본 응답 기준</dt>
          <dd>{formatTime(train.source_timestamp)} KST</dd>
        </div>
        <div>
          <dt>서버 수신 시각</dt>
          <dd>{formatTime(train.received_at)} KST</dd>
        </div>
      </dl>
      <p className="dialog-note">
        {source === "archive"
          ? "2026.10.26 과거 수신 자료이며 현재 운행 정보가 아닙니다."
          : "원본 응답 시각은 개별 열차의 GPS 측정 시각이 아닙니다."}
      </p>
    </dialog>
  );
}
