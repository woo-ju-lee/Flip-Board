import archive from "./rotorDemoArchive.json";
import timetable from "./serviceTimetable.json";
import type { RailLine, Station, Train, TrainResponse } from "./types";

export interface TimetableSource {
  id: string;
  title: string;
  url: string;
  effective_from: string;
  effective_until?: string;
  sha256: string;
}

export interface TimetableService {
  train_id: string;
  number: string;
  origin: string;
  destination: string;
  planned_departure: string;
  planned_arrival: string | null;
  line_id: string;
  stop_station_ids: string[];
  source_id: string;
  source_sheet: string;
}

export interface ServiceTimetable {
  schema_version: number;
  service_date: string;
  sources: TimetableSource[];
  lines: RailLine[];
  stations: Station[];
  services: TimetableService[];
}

export interface TimetableTrainService {
  line_id: string;
  line_name: string;
  stop_names: string[];
  source_title: string;
  source_url: string;
  service_date: string;
}

type ServiceTrain = Train & { service?: TimetableTrainService };
type Snapshots = Pick<typeof archive, "latest" | "earlier" | "live">;
type SnapshotInput = { [K in keyof Snapshots]: TrainResponse };

function koreaDate(value: string): string | null {
  const at = Date.parse(value);
  return Number.isFinite(at)
    ? new Date(at + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)
    : null;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Use a separate adapter so timetable service routes never replace physical line matches. */
export function createServiceDemoRequest(
  catalog: ServiceTimetable,
  snapshots: SnapshotInput,
): typeof fetch {
  const stations = new Map(catalog.stations.map((station) => [station.id, station]));
  const lines = new Map(catalog.lines.map((line) => [line.id, line]));
  const sources = new Map(catalog.sources.map((source) => [source.id, source]));
  const mappings = new Map<string, TimetableService | null>();
  for (const service of catalog.services) {
    // Never pick an arbitrary stopping pattern when the same service has multiple mappings.
    mappings.set(service.train_id, mappings.has(service.train_id) ? null : service);
  }

  function enrich(train: Train): ServiceTrain {
    const mapping = mappings.get(train.id);
    const source = mapping && sources.get(mapping.source_id);
    const line = mapping && lines.get(mapping.line_id);
    if (
      catalog.schema_version !== 1 ||
      !mapping || !source || !line ||
      mapping.number !== train.number ||
      mapping.origin !== train.origin ||
      mapping.destination !== train.destination ||
      mapping.planned_departure !== train.planned_departure ||
      mapping.planned_arrival !== train.planned_arrival ||
      koreaDate(train.planned_departure) !== catalog.service_date ||
      !/^\d{4}-\d{2}-\d{2}$/.test(source.effective_from) ||
      source.effective_from > catalog.service_date ||
      (source.effective_until !== undefined && catalog.service_date >= source.effective_until) ||
      !source.title.trim() || !source.url.trim() ||
      !mapping.stop_station_ids.length ||
      mapping.stop_station_ids.some((id) => !stations.has(id))
    ) return train;

    return {
      ...train,
      service: {
        line_id: line.id,
        line_name: line.name,
        stop_names: mapping.stop_station_ids.map((id) => stations.get(id)!.name),
        source_title: source.title,
        source_url: source.url,
        service_date: catalog.service_date,
      },
    };
  }

  return async (input, init) => {
    const request = input instanceof Request ? input : null;
    if (init?.signal?.aborted || request?.signal.aborted)
      throw new DOMException("Aborted", "AbortError");
    if ((init?.method ?? request?.method ?? "GET").toUpperCase() !== "GET")
      return json({ detail: "조회 요청만 지원합니다." }, 405);
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      "http://localhost",
    );
    if (url.pathname === "/api/lines") return json({ lines: catalog.lines });
    if (url.pathname === "/api/stations") return json({ stations: catalog.stations });
    if (url.pathname !== "/api/trains") return json({ detail: "알 수 없는 경로입니다." }, 404);

    const allowed = new Set(["source", "archive", "station_id", "line_id"]);
    if ([...url.searchParams.keys()].some((key) => !allowed.has(key)))
      return json({ detail: "지원하지 않는 조회 조건입니다." }, 400);
    const source = url.searchParams.get("source") ?? "archive";
    const archiveId = url.searchParams.get("archive") ?? "141536";
    const stationId = url.searchParams.get("station_id") || null;
    const lineId = url.searchParams.get("line_id") || null;
    if (!["archive", "live"].includes(source) || !["141445", "141536"].includes(archiveId))
      return json({ detail: "지원하지 않는 기록 표본입니다." }, 400);
    if (stationId && !stations.has(stationId))
      return json({ detail: "알 수 없는 역입니다." }, 404);
    if (lineId && !lines.has(lineId))
      return json({ detail: "알 수 없는 운행 노선입니다." }, 404);

    const snapshot = source === "live" ? snapshots.live
      : archiveId === "141445" ? snapshots.earlier : snapshots.latest;
    const all: ServiceTrain[] = source === "live" ? snapshot.trains : snapshot.trains.map(enrich);
    const mapped = all.filter((train) => train.service).length;
    const unmapped = all.length - mapped;
    const trains = all.filter((train) => {
      const mapping = mappings.get(train.id);
      return (!stationId || Boolean(train.service && mapping?.stop_station_ids.includes(stationId))) &&
        (!lineId || train.service?.line_id === lineId);
    });
    const condition = stationId
      ? "선택한 역에 정차하는 열차만 표시합니다."
      : lineId ? "선택한 운행 노선의 열차를 표시합니다."
        : "수신된 전체 열차를 표시합니다.";
    return json({
      ...snapshot,
      trains,
      count: trains.length,
      filter: {
        station_id: stationId,
        line_id: lineId,
        state: unmapped ? "partial" : stationId || lineId ? "ready" : "all",
        message: `${condition} 정차역 확인 ${mapped}대 · 미확인 ${unmapped}대는 역·노선 필터에서 제외합니다.`,
        available_line_ids: stationId ? stations.get(stationId)!.line_ids : [],
        basis: "timetable",
        mapped_count: mapped,
        unmapped_count: unmapped,
      },
    });
  };
}

export const serviceDemoRequest = createServiceDemoRequest(
  timetable as ServiceTimetable,
  archive as unknown as SnapshotInput,
);
