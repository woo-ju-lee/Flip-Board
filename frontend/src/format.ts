import type { Train } from "./types";

export const formatTime = (value: string | null | undefined) =>
  value
    ? new Intl.DateTimeFormat("ko-KR", {
        timeZone: "Asia/Seoul",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(new Date(value))
    : "—";
export const delayText = (t: Train) =>
  t.delay_minutes === null
    ? "미확인"
    : t.delay_minutes === 0
      ? "정상"
      : `+${t.delay_minutes}분`;
