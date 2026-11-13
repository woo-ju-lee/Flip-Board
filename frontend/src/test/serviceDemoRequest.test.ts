import { describe, expect, it } from "vitest";
import { createServiceDemoRequest, serviceDemoRequest, type ServiceTimetable } from "../serviceDemoRequest";
import type { Train, TrainResponse } from "../types";

function train(id: string, number: string): Train {
  return {
    id, number, kind: "시험 열차", origin: "시험 출발", destination: "시험 도착",
    planned_departure: "2026-10-26T12:00:00+09:00",
    planned_arrival: "2026-10-26T15:00:00+09:00",
    position_label: "시험 중간역 접근", coordinates: [127, 37],
    delay_minutes: null, delay_status: "unknown",
    received_at: "2026-10-26T05:15:36Z", source_timestamp: "2026-10-26T05:15:36Z",
    match: { status: "unknown", line_id: null, confidence: 0, distance_m: null, reason: "no_verified_geometry" },
  };
}

function snapshot(trains: Train[], live = false): TrainResponse {
  return {
    trains, count: trains.length, total_received: trains.length,
    unknown_count: trains.length, ambiguous_count: 0,
    status: {
      source: live ? "live" : "archive", state: live ? "disabled" : "archive",
      message: "시험 자료", freshness: live ? "none" : "historical",
      last_received_at: live ? null : "2026-10-26T05:15:36Z",
      source_timestamp: live ? null : "2026-10-26T05:15:36Z",
      source_age_seconds: null, next_attempt_at: null, poll_seconds: 60,
      stale_after_seconds: 150, error_code: null, geometry_available: false,
      quality: { accepted_count: trains.length, rejected_count: 0, duplicate_count: 0 },
    },
    filter: { station_id: null, line_id: null, state: "all", message: "", available_line_ids: [] },
  };
}

function fixture() {
  const records = [train("stops-a", "001"), train("passes-a", "002"), train("stops-b", "003"), train("unmapped", "004")];
  const catalog: ServiceTimetable = {
    schema_version: 1, service_date: "2026-10-26",
    sources: [{ id: "test-source", title: "시험용 시간표", url: "https://example.test/timetable", effective_from: "2026-09-01", sha256: "test-only" }],
    lines: ["a", "b"].map((id) => ({ id, name: `시험 노선 ${id}`, type: "service", coverage: "partial", note: "시험", source: "시험" })),
    stations: [
      { id: "start", name: "시험 출발", aliases: [], line_ids: ["a", "b"] },
      { id: "middle", name: "시험 중간역", aliases: [], line_ids: ["a", "b"] },
      { id: "end", name: "시험 도착", aliases: [], line_ids: ["a", "b"] },
    ],
    services: records.slice(0, 3).map((record, i) => ({
      train_id: record.id, number: record.number, origin: record.origin, destination: record.destination,
      planned_departure: record.planned_departure, planned_arrival: record.planned_arrival,
      line_id: i === 2 ? "b" : "a", stop_station_ids: i === 1 ? ["start", "end"] : ["start", "middle", "end"],
      source_id: "test-source", source_sheet: "시험 시트",
    })),
  };
  const snapshots = { latest: snapshot(records), earlier: snapshot(records.slice(0, 2)), live: snapshot([], true) };
  return { catalog, snapshots };
}

async function read(fetcher: typeof fetch, query = "") {
  const response = await fetcher(`/api/trains?${query}`);
  expect(response.ok).toBe(true);
  return response.json();
}

describe("timetable demo filtering", () => {
  it("uses explicit stopping patterns across routes, excluding passing and unclassified trains", async () => {
    const { catalog, snapshots } = fixture();
    const result = await read(createServiceDemoRequest(catalog, snapshots), "station_id=middle");
    expect(result.trains.map((item: Train) => item.id)).toEqual(["stops-a", "stops-b"]);
    expect(result.filter).toMatchObject({ line_id: null, available_line_ids: ["a", "b"], mapped_count: 3, unmapped_count: 1, state: "partial" });
    expect(result.trains[0].service.stop_names).toEqual(["시험 출발", "시험 중간역", "시험 도착"]);
  });

  it("filters a service route independently, then intersects it with the selected stop", async () => {
    const { catalog, snapshots } = fixture();
    const fetcher = createServiceDemoRequest(catalog, snapshots);
    expect((await read(fetcher, "line_id=a")).trains.map((item: Train) => item.id)).toEqual(["stops-a", "passes-a"]);
    expect((await read(fetcher, "station_id=middle&line_id=a")).trains.map((item: Train) => item.id)).toEqual(["stops-a"]);
    expect((await read(fetcher, "station_id=middle&line_id=b")).trains.map((item: Train) => item.id)).toEqual(["stops-b"]);
  });

  it.each([
    { train_id: "different-id" }, { number: "1" }, { origin: "다른 출발" }, { destination: "다른 도착" },
    { planned_departure: "2026-10-27T12:00:00+09:00" }, { planned_arrival: "2026-10-26T15:01:00+09:00" },
    { source_id: "missing-source" }, { stop_station_ids: [] }, { stop_station_ids: ["unknown-station"] },
    { line_id: "unknown-route" },
  ])("does not classify a service with mismatched identity or missing evidence: %j", async (change) => {
    const { catalog, snapshots } = fixture();
    Object.assign(catalog.services[0], change);
    const result = await read(createServiceDemoRequest(catalog, snapshots), "station_id=middle&line_id=a");
    expect(result.trains).toEqual([]);
    expect(result.filter.unmapped_count).toBe(2);
  });

  it("rejects a different service date, inapplicable timetable, and ambiguous mappings", async () => {
    for (const variant of ["date", "future", "expired", "duplicate"] as const) {
      const { catalog, snapshots } = fixture();
      if (variant === "date") catalog.service_date = "2026-10-27";
      else if (variant === "future") catalog.sources[0].effective_from = "2026-11-01";
      else if (variant === "expired") catalog.sources[0].effective_until = "2026-10-26";
      else catalog.services.push({ ...catalog.services[0], stop_station_ids: ["start", "end"] });
      const result = await read(createServiceDemoRequest(catalog, snapshots), "station_id=middle&line_id=a");
      expect(result.trains).toEqual([]);
    }
  });

  it("uses the official 31/35 stopping-pattern distinction for Ulsan", async () => {
    const station = await read(serviceDemoRequest, "source=archive&station_id=ulsan");
    const stoppingNumbers = station.trains.map((item: Train) => item.number);
    expect(stoppingNumbers).toContain("31");
    expect(stoppingNumbers).not.toContain("35");
    const line = await read(serviceDemoRequest, "source=archive&line_id=service-gyeongbu");
    expect(line.trains.map((item: Train) => item.number)).toEqual(expect.arrayContaining(["31", "35"]));
    const all = await read(serviceDemoRequest);
    for (const number of ["426", "520"]) {
      const unclassified = all.trains.find((item: Train) => item.number === number);
      expect(unclassified).toBeDefined();
      expect(unclassified.service).toBeUndefined();
    }
  });

  it("compares the operating date in Korea even when the timestamp is UTC", async () => {
    const { catalog, snapshots } = fixture();
    const departure = "2026-10-25T15:00:00Z";
    snapshots.latest.trains[0].planned_departure = departure;
    catalog.services[0].planned_departure = departure;
    const result = await read(createServiceDemoRequest(catalog, snapshots), "station_id=middle&line_id=a");
    expect(result.trains.map((item: Train) => item.id)).toEqual(["stops-a"]);
    expect(result.trains[0].service.service_date).toBe("2026-10-26");
  });

  it("keeps unmatched trains in the all view and preserves physical matching and source records", async () => {
    const { catalog, snapshots } = fixture();
    const before = JSON.stringify(snapshots);
    const fetcher = createServiceDemoRequest(catalog, snapshots);
    const result = await read(fetcher);
    expect(result.count).toBe(4);
    expect(result.unknown_count).toBe(4);
    expect(result.trains[3].service).toBeUndefined();
    expect(result.trains[0].match).toEqual(snapshots.latest.trains[0].match);
    await read(fetcher, "station_id=middle");
    expect(JSON.stringify(snapshots)).toBe(before);
  });

  it("uses the requested snapshot and keeps disabled live mode empty", async () => {
    const { catalog, snapshots } = fixture();
    const fetcher = createServiceDemoRequest(catalog, snapshots);
    const earlier = await read(fetcher, "source=archive&archive=141445&station_id=middle");
    expect(earlier.trains.map((item: Train) => item.id)).toEqual(["stops-a"]);
    expect(earlier.total_received).toBe(2);
    expect(earlier.filter).toMatchObject({ mapped_count: 2, unmapped_count: 0, state: "ready" });
    const live = await read(fetcher, "source=live&station_id=middle");
    expect(live.trains).toEqual([]);
    expect(live.status.state).toBe("disabled");
    expect(live.filter).toMatchObject({ mapped_count: 0, unmapped_count: 0 });
  });

  it("rejects unknown selections, unsupported sources, writes, and aborted reads", async () => {
    const { catalog, snapshots } = fixture();
    const fetcher = createServiceDemoRequest(catalog, snapshots);
    for (const query of ["station_id=unknown", "line_id=unknown", "source=unknown", "archive=unknown", "unsupported=true"])
      expect((await fetcher(`/api/trains?${query}`)).ok).toBe(false);
    expect((await fetcher("/api/trains", { method: "POST" })).status).toBe(405);
    expect((await fetcher("/missing")).status).toBe(404);
    const controller = new AbortController();
    controller.abort();
    await expect(fetcher("/api/trains", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
});
