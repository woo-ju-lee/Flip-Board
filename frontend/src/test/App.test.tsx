import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import App from "../App";
import { flapAudio } from "../audio";
import type { TrainResponse } from "../types";

function fixture(source = "archive"): TrainResponse {
  return {
    trains: Array.from({ length: 9 }, (_, i) => ({
      id: `test-only-${i}`,
      number: `${i + 1}`,
      kind: "KTX",
      origin: "시험 출발",
      destination: "시험 도착",
      planned_departure: "2026-10-26T12:00:00+09:00",
      planned_arrival: null,
      position_label: `시험 위치 ${i + 1}`,
      coordinates: [127, 37],
      delay_minutes: i === 1 ? null : 0,
      delay_status: i === 1 ? "unknown" : "on_time",
      received_at: "2026-10-26T05:15:36Z",
      source_timestamp: "2026-10-26T05:15:36Z",
      match: {
        status: "unknown",
        line_id: null,
        confidence: 0,
        distance_m: null,
        reason: "no_verified_geometry",
      },
    })),
    count: 9,
    total_received: 9,
    unknown_count: 9,
    ambiguous_count: 0,
    status: {
      source: source as "archive" | "live",
      state: source === "archive" ? "archive" : "disabled",
      message: "수집 대기",
      freshness: source === "archive" ? "historical" : "none",
      last_received_at: "2026-10-26T05:15:36Z",
      source_timestamp: "2026-10-26T05:15:36Z",
      source_age_seconds: 1000,
      next_attempt_at: null,
      poll_seconds: 60,
      stale_after_seconds: 150,
      error_code: null,
      geometry_available: false,
      quality: { accepted_count: 9, rejected_count: 0, duplicate_count: 0 },
    },
    filter: {
      station_id: null,
      line_id: null,
      state: "all",
      message: "",
      available_line_ids: [],
    },
  };
}

function mockServer(
  options: { fail?: boolean; response?: TrainResponse; multi?: boolean } = {},
) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    let json;
    if (url === "/api/lines")
      json = {
        lines: [
          { id: "gyeongbu-hsr", name: "경부고속선", coverage: "unavailable" },
          { id: "honam-hsr", name: "호남고속선", coverage: "unavailable" },
        ],
      };
    else if (url === "/api/stations")
      json = {
        stations: [
          {
            id: "ulsan",
            name: "울산(통도사)",
            aliases: ["울산"],
            line_ids: options.multi
              ? ["gyeongbu-hsr", "honam-hsr"]
              : ["gyeongbu-hsr"],
          },
        ],
      };
    else {
      if (options.fail) throw new Error("전광판 서버에 연결할 수 없습니다.");
      json =
        options.response ??
        fixture(url.includes("source=archive") ? "archive" : "live");
      if (url.includes("station_id") || url.includes("line_id"))
        json = {
          ...json,
          trains: [],
          count: 0,
          filter: {
            station_id: "ulsan",
            line_id: "gyeongbu-hsr",
            state: "unavailable",
            message: "검증된 선로 도형이 없습니다.",
            available_line_ids: ["gyeongbu-hsr"],
          },
        };
    }
    return { ok: true, json: async () => JSON.parse(JSON.stringify(json)) } as Response;
  });
}

describe("board interactions", () => {
  it("labels historical data and paginates without upstream requests", async () => {
    window.history.replaceState(null, "", "/?source=archive");
    const fetcher = mockServer();
    render(<App />);
    await screen.findByRole("row", { name: /KTX 1,/ });
    expect(screen.getByText(/현재 운행 정보가 아닙니다/)).toBeInTheDocument();
    expect(
      screen.getByRole("row", { name: /KTX 2,.*미확인/ }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
    expect(screen.getByRole("row", { name: /KTX 8,/ })).toBeInTheDocument();
    expect(
      fetcher.mock.calls.every(([url]) => String(url).startsWith("/api/")),
    ).toBe(true);
    expect(
      fetcher.mock.calls.filter(([url]) => String(url).includes("/api/trains")),
    ).toHaveLength(1);
  });

  it("uses station membership and displays unavailable geometry", async () => {
    const fetcher = mockServer();
    render(<App />);
    await screen.findByRole("row", { name: /KTX 1,/ });
    fireEvent.click(screen.getByRole("tab", { name: "역 선택" }));
    await screen.findByText("노선 판별을 준비하고 있습니다");
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("station_id=ulsan"),
      expect.anything(),
    );
    expect(
      screen.queryByRole("row", { name: /KTX 1,/ }),
    ).not.toBeInTheDocument();
  });

  it("offers a line choice when a station has multiple mappings", async () => {
    mockServer({ multi: true });
    render(<App />);
    await screen.findByRole("row", { name: /KTX 1,/ });
    fireEvent.click(screen.getByRole("tab", { name: "역 선택" }));
    expect(
      screen.getByRole("combobox", { name: "노선 선택" }),
    ).toBeInTheDocument();
  });

  it("starts muted and requests audio only after a click", async () => {
    const toggle = vi.spyOn(flapAudio, "toggle").mockResolvedValue(true);
    mockServer();
    render(<App />);
    expect(screen.getByRole("button", { name: "소리 켜기" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(toggle).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "소리 켜기" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "소리 끄기" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
  });

  it("requests fullscreen and reports browser failure", async () => {
    Object.defineProperty(document.documentElement, "requestFullscreen", {
      configurable: true,
      value: vi.fn().mockRejectedValue(new Error("denied")),
    });
    mockServer();
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "전체 화면" }));
    await screen.findByText("전체 화면으로 전환하지 못했습니다.");
  });

  it("shows connection failure and lets the user retry", async () => {
    mockServer({ fail: true });
    render(<App />);
    await screen.findByText("전광판 서버에 연결하지 못했습니다");
    expect(screen.getByRole("button", { name: "다시 조회" })).toBeEnabled();
    expect(screen.getByText("연결 실패")).toBeInTheDocument();
  });

  it("opens full train data and closes the detail dialog", async () => {
    window.history.replaceState(null, "", "/?source=archive");
    mockServer();
    render(<App />);
    fireEvent.click(await screen.findByRole("row", { name: /KTX 1,/ }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("127.000000, 37.000000")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "상세 닫기" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("reflects a new delay when the server cache is refreshed", async () => {
    const response = fixture();
    window.history.replaceState(null, "", "/?source=archive");
    mockServer({ response });
    render(<App />);
    await screen.findByRole("row", { name: /KTX 1,.*정상/ });
    response.trains[0].delay_minutes = 4;
    response.trains[0].delay_status = "delayed";
    fireEvent.click(
      screen.getByRole("button", { name: "서버 캐시 다시 조회" }),
    );
    await screen.findByRole("row", { name: /KTX 1,.*\+4분/ });
  });

  it("disables a departed train during its exit and then removes it", async () => {
    const response = fixture();
    window.history.replaceState(null, "", "/?source=archive");
    mockServer({ response });
    render(<App />);
    const row = await screen.findByRole("row", { name: /KTX 1,/ });
    response.trains.shift();
    response.count--;
    fireEvent.click(screen.getByRole("button", { name: "서버 캐시 다시 조회" }));
    await waitFor(() => expect(row).toBeDisabled());
    await waitFor(() => expect(row).not.toBeInTheDocument());
  });
});
