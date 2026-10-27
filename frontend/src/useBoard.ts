import { useCallback, useEffect, useRef, useState } from "react";
import type { Mode, RailLine, Source, Station, TrainResponse } from "./types";

export function useCatalog(request: typeof fetch = fetch) {
  const [catalog, setCatalog] = useState<{
    lines: RailLine[];
    stations: Station[];
  }>({ lines: [], stations: [] });
  const [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    Promise.all(
      ["/api/lines", "/api/stations"].map(async (path) => {
        const response = await request(path, { signal: abort.signal });
        if (!response.ok)
          throw new Error("역·노선 목록을 불러오지 못했습니다.");
        return response.json();
      }),
    )
      .then(([l, s]) => setCatalog({ lines: l.lines, stations: s.stations }))
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, [request]);
  return { ...catalog, catalogError: error };
}

export function useBoard(
  source: Source,
  archive: string,
  mode: Mode,
  station: string,
  line: string,
  request: typeof fetch = fetch,
) {
  const params = new URLSearchParams({ source, archive });
  if (mode === "station" && station) params.set("station_id", station);
  if (mode !== "all" && line) params.set("line_id", line);
  const key = params.toString();
  const [stored, setStored] = useState<{
    key: string;
    data: TrainResponse;
  } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const refreshRef = useRef<() => void>(() => {});
  useEffect(() => {
    const abort = new AbortController();
    let active = true;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      setLoading(true);
      try {
        const response = await request(`/api/trains?${key}`, {
          signal: abort.signal,
        });
        if (!response.ok) throw new Error("전광판 서버에 연결할 수 없습니다.");
        const data: TrainResponse = await response.json();
        if (active) {
          setStored({ key, data });
          setError("");
        }
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : "연결 오류");
      } finally {
        inFlight = false;
        if (active) setLoading(false);
      }
    };
    setError("");
    refreshRef.current = refresh;
    void refresh();
    const interval = window.setInterval(() => {
      if (!document.hidden && source === "live") void refresh();
    }, 15000);
    const visible = () => {
      if (!document.hidden && source === "live") void refresh();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      active = false;
      abort.abort();
      clearInterval(interval);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [key, source, request]);
  return {
    data: stored?.key === key ? stored.data : null,
    error,
    loading,
    refresh: useCallback(() => refreshRef.current(), []),
  };
}
