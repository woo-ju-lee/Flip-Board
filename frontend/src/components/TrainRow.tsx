import { ChevronRight } from "lucide-react";
import { SplitFlap } from "./SplitFlap";
import { DIGIT_ROTOR } from "../flapMotion";
import { STATION_CHARACTER_ROTOR } from "../stationCharacters";
import { delayText } from "../format";
import type { Train } from "../types";

export function TrainRow({
  train,
  rowIndex = 0,
  reduced,
  positionLength,
  exiting,
  onSelect,
}: {
  train: Train;
  rowIndex?: number;
  reduced: boolean;
  positionLength: number;
  exiting: boolean;
  onSelect: (t: Train) => void;
}) {
  const type = train.kind.startsWith("KTX")
    ? "ktx"
    : train.kind.startsWith("ITX")
      ? "itx"
      : "regular";
  return (
    <button
      type="button"
      role="row"
      className={`board-row${exiting ? " row-exiting" : ""}`}
      disabled={exiting}
      aria-hidden={exiting || undefined}
      onClick={() => onSelect(train)}
      aria-label={`${train.kind} ${train.number}, ${train.origin}에서 ${train.destination}, ${train.position_label}, ${delayText(train)}. 상세 보기`}
    >
      <span role="cell" className="train-cell">
        <span className="row-number" aria-hidden="true">{String(rowIndex + 1).padStart(2, "0")}</span>
        <span className={`train-type ${type}`} title={train.kind}>
          {train.kind}
        </span>
        <SplitFlap text={train.number} length={4} reduced={reduced} rotor={DIGIT_ROTOR} />
      </span>
      <span role="cell" className="origin-cell">
        <SplitFlap text={train.origin} length={5} reduced={reduced} rotor={STATION_CHARACTER_ROTOR} />
      </span>
      <span role="cell" className="destination-cell">
        <SplitFlap text={train.destination} length={5} reduced={reduced} rotor={STATION_CHARACTER_ROTOR} />
      </span>
      <span role="cell" className="position-cell">
        <span className="position-indicator" />
        <SplitFlap
          text={train.position_label.replaceAll(" > ", " › ")}
          length={positionLength}
          reduced={reduced}
          indexedDigits
        />
      </span>
      <span role="cell" className={`delay-cell delay-${train.delay_status}`}>
        <SplitFlap text={delayText(train)} length={5} reduced={reduced} indexedDigits />
        <ChevronRight size={14} className="row-more" />
      </span>
    </button>
  );
}
