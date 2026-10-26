export interface Train {
  id: string;
  number: string;
  kind: string;
  origin: string;
  destination: string;
  planned_departure: string;
  planned_arrival: string | null;
  position_label: string;
  coordinates: [number, number];
  delay_minutes: number | null;
  delay_status: "unknown" | "on_time" | "delayed";
  received_at: string;
  source_timestamp: string | null;
  match: {
    status: "matched" | "unknown" | "ambiguous";
    line_id: string | null;
    confidence: number;
    distance_m: number | null;
    reason: string;
  };
}
export interface SourceStatus {
  source: "live" | "archive";
  state: string;
  message: string;
  freshness: string;
  last_received_at: string | null;
  source_timestamp: string | null;
  source_age_seconds: number | null;
  next_attempt_at: string | null;
  poll_seconds: number;
  stale_after_seconds: number;
  error_code: string | null;
  geometry_available: boolean;
  quality: {
    accepted_count: number;
    rejected_count: number;
    duplicate_count: number;
  };
}
export interface TrainResponse {
  trains: Train[];
  count: number;
  total_received: number;
  unknown_count: number;
  ambiguous_count: number;
  status: SourceStatus;
  filter: {
    station_id: string | null;
    line_id: string | null;
    state: string;
    message: string;
    available_line_ids: string[];
  };
}
export interface RailLine {
  id: string;
  name: string;
  type: string;
  coverage: string;
  note: string;
  source: string;
}
export interface Station {
  id: string;
  name: string;
  aliases: string[];
  line_ids: string[];
}
export type Source = "live" | "archive";
export type Mode = "all" | "station" | "line";
