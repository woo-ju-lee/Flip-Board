import App from "./App";
import archive from "./rotorDemoArchive.json";

// Reuse the actual board and its controls, with saved API responses.
const demoRequest: typeof fetch = async (input, init) => {
  if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const path = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(path, "http://localhost");
  let body: unknown;
  if (url.pathname === "/api/lines") body = archive.lines;
  else if (url.pathname === "/api/stations") body = archive.stations;
  else if (url.pathname === "/api/trains") {
    const snapshot = url.searchParams.get("source") === "live" ? archive.live
      : url.searchParams.get("archive") === "141445" ? archive.earlier : archive.latest;
    const station = url.searchParams.get("station_id");
    const line = url.searchParams.get("line_id");
    body = station || line ? { ...snapshot, trains: [], count: 0,
      filter: { ...archive.unavailable.filter, station_id: station,
        line_id: line || "gyeongbu-hsr", available_line_ids: station ? ["gyeongbu-hsr"] : [] } } : snapshot;
  } else return new Response(null, { status: 404 });
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
};

export default function RotorDemo({ homeHref = "?demo=rotors" }: { homeHref?: string } = {}) {
  return <App request={demoRequest} initialSource="archive" homeHref={homeHref} />;
}
